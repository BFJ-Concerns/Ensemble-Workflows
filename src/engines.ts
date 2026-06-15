import { cpus } from "node:os";

import { CodexAppServerTransport } from "./app-server.js";
import { EngineNotImplementedError } from "./errors.js";
import { Scheduler } from "./scheduler.js";
import { GitWorktreeIsolationManager } from "./worktree-isolation.js";

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

export class ClaudeEngineAdapter implements EngineAdapter {
  readonly name = "claude" satisfies EngineName;
  readonly concurrency = 8;

  #scheduler = new Scheduler(this.concurrency);

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.#scheduler.schedule(task);
  }

  createInvocation(): EngineInvocation {
    return {
      async runAttempt(): Promise<TurnResult> {
        throw new EngineNotImplementedError("Claude engine not yet implemented");
      }
    };
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
    new ClaudeEngineAdapter()
  ]);
}

export function defaultCodexConcurrency(): number {
  return Math.max(1, Math.min(16, cpus().length - 2));
}
