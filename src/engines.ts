import { LazyCodexAppServerTransport } from "./app-server.js";
import { ClaudeCliControlPlane } from "./claude-control-plane.js";
import { ClaudeEngineInvocation, assertClaudeEffortSupported } from "./claude-engine.js";
import {
  assertFallbackModelSupported,
  requireRegisteredOpenCodeModel
} from "./engine-option-validation.js";
import { EngineShutdownError, InvalidAgentOptionValueError, OpenCodeModelRequiredError } from "./errors.js";
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
    | "claude-worker-diagnostic"
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

/** The one per-turn variation a session's engine sees: the turn's schema. */
export interface EngineSessionTurn {
  schema?: JsonSchema;
}

/**
 * One held worker on one engine, alive across turns. `beginTurn`
 * returns the invocation the runtime's shared bounded-retry loop drives for
 * that turn — turn invocations never own the session's lifetime, so they
 * carry no `close`; only the session's own `close()` (or the adapter's)
 * tears the held worker down. Engine, model, and effort were fixed at
 * creation; the turn brings only its prompt and schema.
 */
export interface EngineWorkerSession {
  beginTurn(prompt: string, turn: EngineSessionTurn): EngineInvocation;
  close(): Promise<void>;
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
  /**
   * Open a multi-turn worker session. Optional by design: an adapter
   * that does not implement it holds its engine at the one-shot surface,
   * and the runtime fails a session request loud before any worker spawns
   * (any engine that never considered sessions is safe by construction).
   * `options.schema` is ignored here — schema is per-turn, carried by each
   * `beginTurn`.
   */
  createSession?(options: EngineTurnOptions): EngineWorkerSession;
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

function codexThreadConfig(strip: readonly StrippableCapability[] | undefined): Record<string, unknown> | undefined {
  const strippedAgents = strip?.includes("agents") === true;
  if (!strippedAgents) {
    return undefined;
  }
  return { agents: { enabled: false } };
}

export class CodexEngineAdapter implements EngineAdapter {
  readonly name = "codex" satisfies EngineName;
  readonly concurrency: number;
  /**
   * Measured 2026-08-28 on codex-cli 0.149.1, at Codex's own wire to the
   * model provider:
   *
   * - `agents` strips through the per-thread `thread/start` config overlay:
   *   `{ agents: { enabled: false } }` removes the entire `collaboration`
   *   tool namespace from the tool schema Codex sends the model, per
   *   thread, without leaking between sibling threads on one app-server
   *   process. The key is `--strict-config`-validated but undocumented,
   *   and its failure mode on a Codex rename would be silent — the
   *   live proof is what re-arms this judgement per release.
   * - `skills` cannot be stripped completely, measured 2026-08-30 on
   *   codex-cli 0.151.0: a plugin-qualified `skills.config` name is denied
   *   when supplied explicitly, but `skills/list` has no plugin-discovery
   *   parameter and omits a plugin skill present on the worker's surface.
   *   Without a complete source for the per-name denies, a strip request
   *   fails loud before dispatch rather than opening a partially stripped
   *   worker.
   */
  readonly capabilities: EngineCapabilityTable = {
    skills: {
      route: "unsupported",
      detail:
        "measured 2026-08-30 on codex-cli 0.151.0: plugin-qualified skills.config denies work, but skills/list cannot establish the complete plugin skill set"
    },
    agents: {
      route: "config",
      detail:
        "measured 2026-08-28 on codex-cli 0.149.1: thread/start config overlay agents.enabled=false removes the collaboration tool namespace"
    }
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

  createSession(options: EngineTurnOptions): EngineWorkerSession {
    assertFallbackModelSupported(this.name, options.fallbackModel);
    return new CodexWorkerSession({ options, transport: this.#transport });
  }

  async close(): Promise<void> {
    this.#scheduler.close(new EngineShutdownError(this.name));
    await this.#transport.close();
  }
}

/**
 * One held Codex worker: one app-server thread, opened at the first turn and
 * reused by every later one, so the session's context — and its prompt
 * cache — accumulates on the server side. Retries stay in-session too: a
 * failed attempt's correction rides the same thread as a follow-up turn,
 * unlike the one-shot invocation whose retries open a fresh thread.
 */
class CodexWorkerSession implements EngineWorkerSession {
  #options: EngineTurnOptions;
  #transport: RuntimeTransport;
  #threadId: string | null = null;
  #opening: Promise<string> | null = null;

  constructor(options: { options: EngineTurnOptions; transport: RuntimeTransport }) {
    this.#options = options.options;
    this.#transport = options.transport;
  }

  beginTurn(prompt: string, turn: EngineSessionTurn): EngineInvocation {
    return {
      runAttempt: (context) => this.#runTurnAttempt(prompt, turn.schema, context)
    };
  }

  async #runTurnAttempt(
    prompt: string,
    schema: JsonSchema | undefined,
    context: EngineAttemptContext
  ): Promise<EngineAttemptResult> {
    const threadId = await this.#ensureThread();
    // In-session correction: the thread already holds the prompt and the
    // failed reply, so the correction names only the failure — restating
    // the whole prompt would spend cache re-reading what the thread knows.
    const message =
      context.previousFailure === undefined
        ? prompt
        : `A previous attempt failed (${context.previousFailure.kind}): ${context.previousFailure.message}. Correct it this time.`;
    return this.#transport.runTurn(threadId, message, {
      ...(this.#options.timeoutMs !== undefined ? { timeoutMs: this.#options.timeoutMs } : {}),
      ...(schema !== undefined ? { schema: normaliseForCodexOutputSchema(schema) } : {}),
      ...(this.#options.model !== undefined ? { model: this.#options.model } : {}),
      ...(this.#options.effort !== undefined ? { effort: this.#options.effort } : {}),
      ...(context.onLiveEvidence !== undefined ? { onFirstOutput: context.onLiveEvidence } : {})
    });
  }

  /**
   * Single-flight thread open, not failure-memoised: a failed open leaves
   * the session threadless so the bounded retry (or the next turn) may try
   * again — memoising the failure would terminalise a whole session on one
   * transient spawn error.
   */
  #ensureThread(): Promise<string> {
    if (this.#threadId !== null) {
      return Promise.resolve(this.#threadId);
    }
    this.#opening ??= (async () => {
      try {
        const threadConfig = codexThreadConfig(this.#options.strip);
        const threadId = await this.#transport.openThread({
          ...(this.#options.cwd !== undefined ? { cwd: this.#options.cwd } : {}),
          ...(this.#options.model !== undefined ? { model: this.#options.model } : {}),
          ...(threadConfig !== undefined ? { threadConfig } : {})
        });
        this.#threadId = threadId;
        return threadId;
      } finally {
        this.#opening = null;
      }
    })();
    return this.#opening;
  }

  async close(): Promise<void> {
    // An app-server thread needs no per-thread teardown: it is server-side
    // state that dies with the shared transport, which the adapter owns.
    this.#threadId = null;
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
    // The overlay is sent only when this dispatch strips: an unstripped
    // worker's thread/start stays byte-identical, keeping whatever default
    // tool surface the machine's own config.toml gives it (stripping is opt-in
    // in both directions — a strip removes nothing unasked, and its
    // absence grants nothing the machine had turned off).
    const threadConfig = codexThreadConfig(this.#options.strip);
    const threadId = await this.#transport.openThread({
      ...(cwd !== undefined ? { cwd } : {}),
      ...(this.#options.model !== undefined ? { model: this.#options.model } : {}),
      ...(threadConfig !== undefined ? { threadConfig } : {})
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
  /** Defaults to the fixed per-engine cap (12; see concurrency-defaults). */
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
   * mode, `--dangerously-skip-permissions` included — a live test
   * asserts that at the worker itself.
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
    // The engine's own effort domain, judged before any worker spawns: the
    // CLI silently runs an unknown value at its default, which would let an
    // author believe an unenforced level was in force.
    assertClaudeEffortSupported(options.effort);
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

  createSession(options: EngineTurnOptions): EngineWorkerSession {
    if (this.#closed) {
      throw new EngineShutdownError(this.name);
    }
    assertClaudeEffortSupported(options.effort);
    // A session is the invocation generalised across turns: same dispatch,
    // valve, and collection machinery, registered for cancellation like any
    // one-shot invocation so adapter close() tears held workers down too.
    const session = new ClaudeEngineInvocation({
      prompt: "",
      cwd: options.cwd ?? this.#cwd,
      options,
      multiTurn: true,
      controlPlane: this.#controlPlane,
      ...(this.#onEvent !== undefined ? { onEvent: this.#onEvent } : {}),
      ...(this.#config !== undefined ? { config: this.#config } : {}),
      onClose: (closed) => this.#activeInvocations.delete(closed)
    });
    this.#activeInvocations.add(session);
    return session;
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
   * Measured 2026-08-27 against opencode 1.18.4: its schema exposes
   * `permission.task` and `permission.skill`, and
   * `OPENCODE_CONFIG_CONTENT` is a per-process merge overlay. The surface
   * measurement is not worker-boundary proof, though: the available live
   * dispatches timed out before producing output, so this unit has not shown
   * that either explicit deny stops a worker. Both capabilities therefore
   * fail loud pre-spawn rather than dispatch a worker under a restriction the
   * author believes is in force. A successful deny witness re-opens this
   * judgement.
   */
  readonly capabilities: EngineCapabilityTable = {
    skills: {
      route: "unsupported",
      detail:
        "measured 2026-08-27 on opencode 1.18.4: OPENCODE_CONFIG_CONTENT merges permission.skill=deny, but worker-boundary enforcement is unproven"
    },
    agents: {
      route: "unsupported",
      detail:
        "measured 2026-08-27 on opencode 1.18.4: OPENCODE_CONFIG_CONTENT merges permission.task=deny, but worker-boundary enforcement is unproven"
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
    // The registry owns the variant domain as it owns the model list:
    // `opencode run` forwards an unknown variant silently, so an
    // out-of-domain effort must fail here, pre-spawn, or not at all.
    if (options.effort !== undefined && !model.variants.includes(options.effort)) {
      throw new InvalidAgentOptionValueError(
        "effort",
        options.effort,
        model.variants.length > 0
          ? `one of ${model.variants.join(" | ")} (the variants the registry declares for ${model.key})`
          : `absent — the registry entry for ${model.key} declares no served variants`
      );
    }
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
  firstOutputTimeoutMs?: number;
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
    ...(options.firstOutputTimeoutMs !== undefined ? { firstOutputTimeoutMs: options.firstOutputTimeoutMs } : {}),
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
