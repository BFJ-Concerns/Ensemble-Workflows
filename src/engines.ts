import { LazyCodexAppServerTransport } from "./app-server.js";
import { ClaudeCliControlPlane } from "./claude-control-plane.js";
import { ClaudeEngineInvocation } from "./claude-engine.js";
import {
  assertFallbackModelSupported,
  requireRegisteredOpenCodeModel
} from "./engine-option-validation.js";
import { EngineShutdownError, OpenCodeModelRequiredError } from "./errors.js";
import { OpenCodeCliRunner, OpenCodeEngineInvocation, rejectUnsupportedOpenCodeOptions } from "./opencode-engine.js";
import { defaultOpenCodeModelRegistry } from "./opencode-model-registry.js";
import { Scheduler } from "./scheduler.js";
import { normaliseForCodexOutputSchema } from "./schema.js";
import {
  defaultClaudeConcurrency,
  defaultCodexConcurrency,
  defaultOpenCodeConcurrency
} from "./concurrency-defaults.js";

import type { EngineCapabilityTable, StrippableCapability } from "./capability-stripping.js";
import type { ClaudeControlPlane } from "./claude-control-plane.js";
import type { WorkerExitStatus } from "./errors.js";
import type { ClaudeEngineConfig } from "./claude-engine.js";
import type { OpenCodeRunner } from "./opencode-engine.js";
import type { OpenCodeModelRegistry } from "./opencode-model-registry.js";
import type {
  EngineName,
  EngineConcurrencyCaps,
  EngineWorkerEnvironment,
  JsonSchema,
  RuntimeEvent,
  RuntimeTransport,
  TurnResult
} from "./types.js";

export interface EngineTurnOptions {
  schema?: JsonSchema;
  model?: string;
  effort?: string;
  /** Claude only: declared degradation when the pinned model is unavailable. */
  fallbackModel?: string;
  cwd?: string;
  // Omitted → unbounded per turn. No default; see the runtime's resolution below.
  timeoutMs?: number;
  /**
   * The call's effective capability strip (run-wide ∪ per-call), already
   * enforcement-checked by the runtime against this adapter's declared
   * table. Adapters act only on their `config`-routed capabilities;
   * `absent` ones need nothing by construction.
   */
  strip?: StrippableCapability[];
}

export interface EngineAttemptFailure {
  kind:
    | "empty-output"
    | "invalid-json"
    | "schema-validation"
    | "claude-dispatch-error"
    | "claude-poll-timeout"
    | "claude-first-life-timeout"
    | "claude-blocked"
    | "claude-valve-error"
    | "claude-transcript-error"
    | "claude-collection-error"
    | "opencode-run-error";
  message: string;
}

export interface EngineAttemptContext {
  attempt: number;
  previousFailure?: EngineAttemptFailure;
  /**
   * Called at the first observed sign of worker output — a transcript
   * appearing, a streamed frame, a first stdout chunk. Engines may call it
   * more than once (per attempt, or per frame kind); the consumer keeps the
   * earliest observation, so callers need no dedup of their own.
   */
  onLiveEvidence?: () => void;
}

export interface EngineAttemptResult extends TurnResult {
  /** Operational failure that should retain its identity through the shared retry loop. */
  attemptFailure?: EngineAttemptFailure;
  /**
   * How the worker process died, when the engine observed it — the same
   * evidence a thrown failure carries via `attachWorkerExitStatus`, riding a
   * failed result so classifying a failure engine-side never discards it.
   */
  workerExit?: WorkerExitStatus;
}

export interface EngineInvocation {
  runAttempt(context: EngineAttemptContext): Promise<EngineAttemptResult>;
  close?(): Promise<void>;
}

export interface EngineAdapter {
  readonly name: EngineName;
  readonly concurrency: number;
  /**
   * How this engine discharges each strippable capability. Absent
   * reads as "cannot enforce anything": the runtime fails a strip request
   * loud before the worker spawns, so an adapter that never considered
   * stripping can never silently dispatch an unrestricted worker.
   */
  readonly capabilities?: EngineCapabilityTable;
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

  names(): EngineName[] {
    return [...this.#engines.keys()];
  }

  async close(): Promise<void> {
    // allSettled: one adapter's close failure must not stop the caller
    // waiting for — and therefore observing — the others' teardown.
    await Promise.allSettled([...this.#engines.values()].map((engine) => engine.close()));
  }
}

export interface CodexEngineAdapterOptions {
  transport: RuntimeTransport;
  concurrency: number;
}

export class CodexEngineAdapter implements EngineAdapter {
  readonly name = "codex" satisfies EngineName;
  readonly concurrency: number;
  /**
   * Both named minimum capabilities are judged `absent` on Codex: the
   * app-server tool surface (shell, apply_patch, web search, view image,
   * MCP) has no skill system and no subagent tool, so there is nothing to
   * strip and the request is satisfied by construction. The judgement is
   * dated (2026-08-27, Codex CLI 0.5x app-server): a Codex release that
   * grows either capability re-opens it — the recorded `absent` route in
   * the archive is what makes that auditable.
   */
  readonly capabilities: EngineCapabilityTable = {
    skills: { route: "absent", detail: "the Codex app-server tool surface has no skill system" },
    agents: { route: "absent", detail: "the Codex app-server tool surface has no subagent tool" }
  };

  #transport: RuntimeTransport;
  #scheduler: Scheduler;

  constructor(options: CodexEngineAdapterOptions) {
    this.concurrency = options.concurrency;
    this.#transport = options.transport;
    this.#scheduler = new Scheduler(options.concurrency);
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.#scheduler.schedule(task);
  }

  createInvocation(prompt: string, options: EngineTurnOptions): EngineInvocation {
    assertFallbackModelSupported(this.name, options.fallbackModel);
    return new CodexEngineInvocation({
      prompt,
      options,
      transport: this.#transport
    });
  }

  async close(): Promise<void> {
    this.#scheduler.close(new EngineShutdownError(this.name));
    await this.#transport.close();
  }
}

interface CodexEngineInvocationOptions {
  prompt: string;
  options: EngineTurnOptions;
  transport: RuntimeTransport;
}

class CodexEngineInvocation implements EngineInvocation {
  #prompt: string;
  #options: EngineTurnOptions;
  #transport: RuntimeTransport;

  constructor(options: CodexEngineInvocationOptions) {
    this.#prompt = options.prompt;
    this.#options = options.options;
    this.#transport = options.transport;
  }

  async runAttempt(context: EngineAttemptContext): Promise<TurnResult> {
    // Codex retries open a fresh thread, so the correction rides the prompt —
    // the same degraded-correction shape the opencode engine uses.
    const prompt = promptWithFailureFeedback(this.#prompt, context.previousFailure);
    return this.#runTurnInCwd(prompt, this.#options.cwd, context.onLiveEvidence);
  }

  async #runTurnInCwd(
    prompt: string,
    cwd: string | undefined,
    onLiveEvidence: (() => void) | undefined
  ): Promise<TurnResult> {
    const threadId = await this.#transport.openThread({
      ...(cwd !== undefined ? { cwd } : {})
    });

    return this.#transport.runTurn(threadId, prompt, {
      ...(this.#options.timeoutMs !== undefined ? { timeoutMs: this.#options.timeoutMs } : {}),
      ...(this.#options.schema !== undefined ? { schema: normaliseForCodexOutputSchema(this.#options.schema) } : {}),
      ...(this.#options.model !== undefined ? { model: this.#options.model } : {}),
      ...(this.#options.effort !== undefined ? { effort: this.#options.effort } : {}),
      ...(onLiveEvidence !== undefined ? { onFirstOutput: onLiveEvidence } : {})
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
  /** Routes best-effort transcript-derived token usage into the runtime budget recorder. */
  onEvent?: (event: RuntimeEvent) => void;
  config?: ClaudeEngineConfig;
}

export class ClaudeEngineAdapter implements EngineAdapter {
  readonly name = "claude" satisfies EngineName;
  readonly concurrency: number;
  /**
   * Claude strips both named minimum capabilities mechanically: permission
   * deny rules ride the per-dispatch settings file the control plane
   * already writes (the one surface measured to reach the daemon-served
   * session), and deny rules outrank every allow layer and permission
   * mode, `--dangerously-skip-permissions` included — the live tests
   * assert that at the worker itself.
   */
  readonly capabilities: EngineCapabilityTable = {
    skills: { route: "config", detail: "permissions deny rules in the per-dispatch settings file" },
    agents: { route: "config", detail: "permissions deny rules in the per-dispatch settings file" }
  };

  #scheduler: Scheduler;
  #cwd: string;
  #controlPlane: ClaudeControlPlane;
  #onEvent: ((event: RuntimeEvent) => void) | undefined;
  #config: ClaudeEngineConfig | undefined;
  #activeInvocations = new Set<ClaudeEngineInvocation>();
  #closed = false;

  constructor(options: ClaudeEngineAdapterOptions = {}) {
    this.concurrency = options.concurrency ?? defaultClaudeConcurrency();
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
    if (this.#closed) {
      // A worker already past the scheduler when close() ran must not
      // register into a set nothing will ever cancel again.
      throw new EngineShutdownError(this.name);
    }
    const invocation = new ClaudeEngineInvocation({
      prompt,
      cwd: options.cwd ?? this.#cwd,
      options,
      controlPlane: this.#controlPlane,
      ...(this.#onEvent !== undefined ? { onEvent: this.#onEvent } : {}),
      ...(this.#config !== undefined ? { config: this.#config } : {}),
      onClose: (closed) => this.#activeInvocations.delete(closed)
    });
    this.#activeInvocations.add(invocation);
    return invocation;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#scheduler.close(new EngineShutdownError(this.name));
    await Promise.allSettled([...this.#activeInvocations].map((invocation) => invocation.close()));
  }
}

export interface OpenCodeEngineAdapterOptions {
  /** Defaults to 2: opencode providers have independent rate and resource limits. */
  concurrency?: number;
  /** Base working directory workers are dispatched from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** CLI binary. Defaults to `opencode`; tests can inject a runner instead. */
  bin?: string;
  runner?: OpenCodeRunner;
  modelRegistry?: OpenCodeModelRegistry;
  /** Routes opencode token usage into the runtime budget recorder. */
  onEvent?: (event: RuntimeEvent) => void;
}

export class OpenCodeEngineAdapter implements EngineAdapter {
  readonly name = "opencode" satisfies EngineName;
  readonly concurrency: number;
  /**
   * opencode has a real subagent/task surface (and a skills route via
   * plugins), but the harness has not yet measured a config route that
   * strips either — so both fail loud pre-spawn rather than dispatch an
   * unrestricted worker under a restriction the author believes is in
   * force. Wiring the config route flips these entries with evidence.
   */
  readonly capabilities: EngineCapabilityTable = {
    skills: {
      route: "unsupported",
      detail: "the harness does not yet deliver tool stripping through opencode's config surface"
    },
    agents: {
      route: "unsupported",
      detail: "the harness does not yet deliver tool stripping through opencode's config surface"
    }
  };

  #scheduler: Scheduler;
  #cwd: string;
  #runner: OpenCodeRunner;
  #modelRegistry: OpenCodeModelRegistry;
  #onEvent: ((event: RuntimeEvent) => void) | undefined;
  #activeInvocations = new Set<OpenCodeEngineInvocation>();
  #closed = false;

  constructor(options: OpenCodeEngineAdapterOptions = {}) {
    this.concurrency = options.concurrency ?? defaultOpenCodeConcurrency();
    this.#scheduler = new Scheduler(this.concurrency);
    this.#cwd = options.cwd ?? process.cwd();
    this.#runner = options.runner ?? new OpenCodeCliRunner(options.bin);
    this.#modelRegistry = options.modelRegistry ?? defaultOpenCodeModelRegistry;
    this.#onEvent = options.onEvent;
  }

  /**
   * The registry this adapter dispatches against — exposed so load-time
   * validation consults the same registry, never a parallel resolution of
   * the module default that an injected registry would silently disagree
   * with (rejecting before the body a model the runtime would run).
   */
  get modelRegistry(): OpenCodeModelRegistry {
    return this.#modelRegistry;
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.#scheduler.schedule(task);
  }

  createInvocation(prompt: string, options: EngineTurnOptions): EngineInvocation {
    if (this.#closed) {
      // A worker already past the scheduler when close() ran must not
      // register into a set nothing will ever cancel again.
      throw new EngineShutdownError(this.name);
    }
    rejectUnsupportedOpenCodeOptions(options);
    if (options.model === undefined) {
      throw new OpenCodeModelRequiredError(this.#modelRegistry.names());
    }
    const model = requireRegisteredOpenCodeModel(options.model, this.#modelRegistry);
    const invocation = new OpenCodeEngineInvocation({
      prompt,
      cwd: options.cwd ?? this.#cwd,
      providerModel: model.providerModel,
      modelKey: model.key,
      options,
      runner: this.#runner,
      ...(this.#onEvent !== undefined ? { onEvent: this.#onEvent } : {}),
      onClose: (closed) => this.#activeInvocations.delete(closed)
    });
    this.#activeInvocations.add(invocation);
    return invocation;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#scheduler.close(new EngineShutdownError(this.name));
    await Promise.allSettled([...this.#activeInvocations].map((invocation) => invocation.close()));
  }
}

export interface CreateDefaultEngineRegistryOptions {
  cwd: string;
  codexBin: string;
  openCodeBin?: string;
  requestTimeoutMs: number;
  retryPromiseSilenceTimeoutMs?: number;
  firstDeltaTimeoutMs?: number;
  startupHandshakeTimeoutMs: number;
  clientName: string;
  clientVersion: string;
  concurrencyCaps?: EngineConcurrencyCaps;
  workerEnvironment?: EngineWorkerEnvironment;
  onEvent: (event: RuntimeEvent) => void;
  onClaudeEvent: (event: RuntimeEvent) => void;
  onOpenCodeEvent: (event: RuntimeEvent) => void;
}

export async function createDefaultEngineRegistry(
  options: CreateDefaultEngineRegistryOptions
): Promise<EngineRegistry> {
  // Lazy: constructing the registry performs no I/O. The app-server spawns
  // when the first worker names Codex, so a run needs only the engines its
  // script actually uses (no engine is privileged).
  const transport = new LazyCodexAppServerTransport({
    cwd: options.cwd,
    codexBin: options.codexBin,
    ...(options.workerEnvironment?.codex !== undefined ? { workerEnv: options.workerEnvironment.codex } : {}),
    requestTimeoutMs: options.requestTimeoutMs,
    ...(options.retryPromiseSilenceTimeoutMs !== undefined
      ? { retryPromiseSilenceTimeoutMs: options.retryPromiseSilenceTimeoutMs }
      : {}),
    ...(options.firstDeltaTimeoutMs !== undefined ? { firstDeltaTimeoutMs: options.firstDeltaTimeoutMs } : {}),
    startupHandshakeTimeoutMs: options.startupHandshakeTimeoutMs,
    clientName: options.clientName,
    clientVersion: options.clientVersion,
    onEvent: options.onEvent
  });

  return new EngineRegistry([
    new CodexEngineAdapter({
      transport,
      concurrency: options.concurrencyCaps?.codex ?? defaultCodexConcurrency()
    }),
    new ClaudeEngineAdapter({
      cwd: options.cwd,
      ...(options.workerEnvironment?.claude !== undefined
        ? { controlPlane: new ClaudeCliControlPlane({ workerEnv: options.workerEnvironment.claude }) }
        : {}),
      ...(options.concurrencyCaps?.claude !== undefined ? { concurrency: options.concurrencyCaps.claude } : {}),
      // Claude deliberately emits the same usage event shape as Codex. Keep the
      // adapter sink labelled so accounting never has to infer engine from payload.
      onEvent: options.onClaudeEvent
    }),
    new OpenCodeEngineAdapter({
      cwd: options.cwd,
      ...(options.openCodeBin !== undefined ? { bin: options.openCodeBin } : {}),
      ...(options.workerEnvironment?.opencode !== undefined
        ? { runner: new OpenCodeCliRunner(options.openCodeBin, { workerEnv: options.workerEnvironment.opencode }) }
        : {}),
      ...(options.concurrencyCaps?.opencode !== undefined ? { concurrency: options.concurrencyCaps.opencode } : {}),
      onEvent: options.onOpenCodeEvent
    })
  ]);
}

function promptWithFailureFeedback(prompt: string, failure: EngineAttemptFailure | undefined): string {
  if (failure === undefined) {
    return prompt;
  }
  return `${prompt}\n\nA previous attempt failed (${failure.kind}): ${failure.message}. Correct it this time.`;
}

export {
  defaultClaudeConcurrency,
  defaultCodexConcurrency,
  defaultOpenCodeConcurrency
} from "./concurrency-defaults.js";
