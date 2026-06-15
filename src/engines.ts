import { cpus } from "node:os";

import { CodexAppServerTransport } from "./app-server.js";
import { ClaudeCliControlPlane } from "./claude-control-plane.js";
import { ClaudeEngineInvocation } from "./claude-engine.js";
import { ClaudeWorktreeIsolationUnsupportedError } from "./errors.js";
import { Scheduler } from "./scheduler.js";
import { GitWorktreeIsolationManager } from "./worktree-isolation.js";

import type { ClaudeControlPlane } from "./claude-control-plane.js";
import type { ClaudeEngineConfig } from "./claude-engine.js";
import type {
  EngineName,
  JsonSchema,
  RuntimeEvent,
  RuntimeTransport,
  SandboxMode,
  TurnResult
} from "./types.js";
import type {
  IsolatedWorktree,
  IsolatedWorktreeRecord,
  WorktreeIsolationManager
} from "./worktree-isolation.js";

export interface EngineTurnOptions {
  schema?: JsonSchema;
  model?: string;
  effort?: string;
  webSearch: boolean;
  isolation?: "worktree";
  sandbox?: SandboxMode;
  timeoutMs: number;
}

export interface EngineAttemptFailure {
  kind: "empty-output" | "invalid-json" | "schema-validation";
  message: string;
}

export interface EngineAttemptContext {
  attempt: number;
  previousFailure?: EngineAttemptFailure;
}

export interface EngineInvocation {
  runAttempt(context: EngineAttemptContext): Promise<TurnResult>;
  close?(): Promise<void>;
}

export interface EngineAdapter {
  readonly name: EngineName;
  readonly concurrency: number;
  schedule<T>(task: () => Promise<T>): Promise<T>;
  createInvocation(prompt: string, options: EngineTurnOptions): EngineInvocation;
  close(): Promise<void>;
}

export class EngineRegistry {
  #engines = new Map<EngineName, EngineAdapter>();

  constructor(engines: EngineAdapter[]) {
    for (const engine of engines) {
      this.#engines.set(engine.name, engine);
    }
  }

  get(name: EngineName): EngineAdapter | undefined {
    return this.#engines.get(name);
  }

  async close(): Promise<void> {
    await Promise.all([...this.#engines.values()].map((engine) => engine.close()));
  }
}

export interface CodexEngineAdapterOptions {
  transport: RuntimeTransport;
  concurrency: number;
  worktreeManager?: WorktreeIsolationManager;
  onEvent: (event: RuntimeEvent) => void;
  onWorktreeFinished: (record: IsolatedWorktreeRecord) => void;
}

export class CodexEngineAdapter implements EngineAdapter {
  readonly name = "codex" satisfies EngineName;
  readonly concurrency: number;

  #transport: RuntimeTransport;
  #scheduler: Scheduler;
  #worktreeManager: WorktreeIsolationManager;
  #onEvent: (event: RuntimeEvent) => void;
  #onWorktreeFinished: (record: IsolatedWorktreeRecord) => void;

  constructor(options: CodexEngineAdapterOptions) {
    this.concurrency = options.concurrency;
    this.#transport = options.transport;
    this.#scheduler = new Scheduler(options.concurrency);
    this.#worktreeManager = options.worktreeManager ?? new GitWorktreeIsolationManager(options.transport.cwd);
    this.#onEvent = options.onEvent;
    this.#onWorktreeFinished = options.onWorktreeFinished;
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.#scheduler.schedule(task);
  }

  createInvocation(prompt: string, options: EngineTurnOptions): EngineInvocation {
    return new CodexEngineInvocation({
      prompt,
      options,
      transport: this.#transport,
      worktreeManager: this.#worktreeManager,
      onEvent: this.#onEvent,
      onWorktreeFinished: this.#onWorktreeFinished
    });
  }

  async close(): Promise<void> {
    await this.#transport.close();
  }
}

interface CodexEngineInvocationOptions {
  prompt: string;
  options: EngineTurnOptions;
  transport: RuntimeTransport;
  worktreeManager: WorktreeIsolationManager;
  onEvent: (event: RuntimeEvent) => void;
  onWorktreeFinished: (record: IsolatedWorktreeRecord) => void;
}

class CodexEngineInvocation implements EngineInvocation {
  #prompt: string;
  #options: EngineTurnOptions;
  #transport: RuntimeTransport;
  #worktreeManager: WorktreeIsolationManager;
  #onEvent: (event: RuntimeEvent) => void;
  #onWorktreeFinished: (record: IsolatedWorktreeRecord) => void;

  constructor(options: CodexEngineInvocationOptions) {
    this.#prompt = options.prompt;
    this.#options = options.options;
    this.#transport = options.transport;
    this.#worktreeManager = options.worktreeManager;
    this.#onEvent = options.onEvent;
    this.#onWorktreeFinished = options.onWorktreeFinished;
  }

  async runAttempt(): Promise<TurnResult> {
    if (this.#options.isolation === "worktree") {
      return this.#runIsolatedWorktreeTurn();
    }

    return this.#runTurnInCwd({
      sandbox: this.#options.sandbox ?? "read-only"
    });
  }

  async #runIsolatedWorktreeTurn(): Promise<TurnResult> {
    const worktree = await this.#worktreeManager.create();

    try {
      return await this.#runTurnInCwd({
        cwd: worktree.path,
        sandbox: "workspace-write"
      });
    } finally {
      await this.#finishWorktree(worktree);
    }
  }

  async #runTurnInCwd(location: { cwd?: string; sandbox: SandboxMode }): Promise<TurnResult> {
    const threadId = await this.#transport.openThread({
      webSearch: this.#options.webSearch,
      sandbox: location.sandbox,
      ...(location.cwd !== undefined ? { cwd: location.cwd } : {})
    });

    return this.#transport.runTurn(threadId, this.#prompt, {
      timeoutMs: this.#options.timeoutMs,
      ...(this.#options.schema !== undefined ? { schema: this.#options.schema } : {}),
      ...(this.#options.model !== undefined ? { model: this.#options.model } : {}),
      ...(this.#options.effort !== undefined ? { effort: this.#options.effort } : {})
    });
  }

  async #finishWorktree(worktree: IsolatedWorktree): Promise<void> {
    const record = await this.#worktreeManager.finish(worktree);
    this.#onWorktreeFinished(record);
    this.#onEvent({
      method: "worktree/finished",
      params: {
        path: record.path,
        branch: record.branch,
        changed: record.changed,
        removed: record.removed
      },
      receivedAt: Date.now()
    });
  }
}

export interface ClaudeEngineAdapterOptions {
  /** Defaults to 8 — the allowance/daemon is a scarcer resource than Codex's app-server. */
  concurrency?: number;
  /** Base working directory workers are dispatched from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Injectable for tests; defaults to the real `claude`/`tmux` control plane. */
  controlPlane?: ClaudeControlPlane;
  /** Routes best-effort transcript-derived token usage into the shared budget. */
  onEvent?: (event: RuntimeEvent) => void;
  config?: ClaudeEngineConfig;
}

export class ClaudeEngineAdapter implements EngineAdapter {
  readonly name = "claude" satisfies EngineName;
  readonly concurrency: number;

  #scheduler: Scheduler;
  #cwd: string;
  #controlPlane: ClaudeControlPlane;
  #onEvent: ((event: RuntimeEvent) => void) | undefined;
  #config: ClaudeEngineConfig | undefined;

  constructor(options: ClaudeEngineAdapterOptions = {}) {
    this.concurrency = options.concurrency ?? 8;
    this.#scheduler = new Scheduler(this.concurrency);
    this.#cwd = options.cwd ?? process.cwd();
    this.#controlPlane = options.controlPlane ?? new ClaudeCliControlPlane();
    this.#onEvent = options.onEvent;
    this.#config = options.config;
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.#scheduler.schedule(task);
  }

  createInvocation(prompt: string, options: EngineTurnOptions): EngineInvocation {
    if (options.isolation === "worktree") {
      // Claude background sessions own their own .claude/worktrees isolation; the
      // Codex git-worktree manager does not map onto them. Reject rather than
      // half-wire a foreign mechanism (see report → isolation:'worktree' on Claude).
      throw new ClaudeWorktreeIsolationUnsupportedError();
    }
    return new ClaudeEngineInvocation({
      prompt,
      cwd: this.#cwd,
      options,
      controlPlane: this.#controlPlane,
      ...(this.#onEvent !== undefined ? { onEvent: this.#onEvent } : {}),
      ...(this.#config !== undefined ? { config: this.#config } : {})
    });
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

export interface CreateDefaultEngineRegistryOptions {
  cwd: string;
  codexBin: string;
  requestTimeoutMs: number;
  clientName: string;
  clientVersion: string;
  codexConcurrency?: number;
  onEvent: (event: RuntimeEvent) => void;
  onWorktreeFinished: (record: IsolatedWorktreeRecord) => void;
}

export async function createDefaultEngineRegistry(
  options: CreateDefaultEngineRegistryOptions
): Promise<EngineRegistry> {
  const transport = await CodexAppServerTransport.start({
    cwd: options.cwd,
    codexBin: options.codexBin,
    requestTimeoutMs: options.requestTimeoutMs,
    clientName: options.clientName,
    clientVersion: options.clientVersion,
    onEvent: options.onEvent
  });

  return new EngineRegistry([
    new CodexEngineAdapter({
      transport,
      concurrency: options.codexConcurrency ?? defaultCodexConcurrency(),
      onEvent: options.onEvent,
      onWorktreeFinished: options.onWorktreeFinished
    }),
    new ClaudeEngineAdapter({
      cwd: options.cwd,
      // Same event sink as Codex: the runtime's recorder turns the synthetic
      // thread/tokenUsage/updated event into shared-budget spend.
      onEvent: options.onEvent
    })
  ]);
}

export function defaultCodexConcurrency(): number {
  return Math.max(1, Math.min(16, cpus().length - 2));
}
