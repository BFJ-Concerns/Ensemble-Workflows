import { LazyCodexAppServerTransport } from "./app-server.js";
import { ClaudeCliControlPlane } from "./claude-control-plane.js";
import { ClaudeEngineInvocation, claudeNativeEffort } from "./claude-engine.js";
import { requireRegisteredOpenCodeModel } from "./engine-option-validation.js";
import {
  AppServerExitedError,
  AppServerStartupTimeoutError,
  attachWorkerExitStatus,
  CapabilityStripUnsupportedError,
  CodexSubstrateRefusedError,
  EngineShutdownError,
  InvalidAgentOptionValueError,
  OpenCodeModelRequiredError,
  workerExitStatusOf
} from "./errors.js";
import { OpenCodeCliRunner, OpenCodeEngineInvocation } from "./opencode-engine.js";
import { presentOperationalError } from "./operator-diagnosis.js";
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

/**
 * A failure an engine observed and *returned* on the attempt result, in the
 * engine's own vocabulary. A refused Claude dispatch is not among them: it is
 * thrown (`ClaudeDispatchError`, pre-spawn) rather than returned.
 */
export interface EngineAttemptFailure {
  kind:
    | "empty-output"
    | "invalid-json"
    | "schema-validation"
    | "claude-worker-error"
    | "claude-poll-timeout"
    | "claude-first-life-timeout"
    | "claude-registration-timeout"
    | "claude-blocked"
    | "claude-valve-error"
    | "claude-transcript-error"
    | "claude-collection-error"
    | "claude-worker-diagnostic"
    | "opencode-run-error";
  message: string;
}

/**
 * What a retry carries back to the worker (one retry rule on every engine):
 * the previous attempt's failure as the record holds it — an engine's returned
 * failure under its own kind, or a thrown one under the error's class name
 * (`TurnTimeoutError`, `AppServerSystemError`). Engines render it as prose
 * in the correction, so the kind is open here and nowhere else.
 */
export interface PreviousAttemptFailure {
  kind: string;
  message: string;
}

export interface EngineAttemptContext {
  attempt: number;
  previousFailure?: PreviousAttemptFailure;
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
   * (opencode, which is held at the one-shot surface, and any future engine
   * that never considered sessions, are safe by construction).
   * `options.schema` is ignored here — schema is per-turn, carried by each
   * `beginTurn`.
   */
  createSession?(options: EngineTurnOptions): EngineWorkerSession;
  /**
   * Tear the adapter down, cancelling active invocations. Contract: every
   * active invocation's attempt must settle (resolve or reject) as a
   * consequence of close — even when close itself rejects — because the
   * runtime's shutdown accounting waits on those settlements before it
   * publishes the run's tally. An adapter that rejects without settling
   * its legs would stall the run's close.
   */
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
    // allSettled first: one adapter's close failure must not stop the
    // caller waiting for — and therefore observing — the others' teardown.
    // The failures are then rethrown together, once every adapter has
    // settled: an engine cancel that failed silently would make the run's
    // cancellation promise unattributable. The async wrapper converts a
    // synchronously-throwing close into a rejection, so one bad adapter
    // cannot stop the others from being closed at all.
    const results = await Promise.allSettled([...this.#engines.values()].map(async (engine) => engine.close()));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length === 1) {
      throw failures[0]!.reason;
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "engine teardown failed"
      );
    }
  }
}

export interface CodexEngineAdapterOptions {
  transport: RuntimeTransport;
  concurrency: number;
}

async function codexThreadConfig(
  strip: readonly StrippableCapability[] | undefined,
  transport: RuntimeTransport,
  cwd: string | undefined
): Promise<Record<string, unknown> | undefined> {
  const strippedAgents = strip?.includes("agents") === true;
  const strippedSkills = strip?.includes("skills") === true;
  if (!strippedAgents && !strippedSkills) {
    return undefined;
  }
  return {
    ...(strippedAgents ? { agents: { enabled: false } } : {}),
    ...(strippedSkills
      ? {
          skills: {
            bundled: { enabled: false },
            config: (await discoveredCodexSkillNames(transport, cwd)).map((name) => ({ name, enabled: false }))
          }
        }
      : {})
  };
}

/**
 * Discovery results cached per (transport, cwd) for the transport's — and
 * so the run's — life: the stabilisation loop is seconds of wall-clock paid
 * inside a held admission slot, and retries, sibling dispatches, and thread
 * re-opens must not re-pay it. A failed discovery clears its entry so the
 * next dispatch retries rather than inheriting the failure for ever; the
 * WeakMap keys on the transport instance, so a fresh run's transport never
 * sees a predecessor's set.
 */
const codexSkillDiscoveryCache = new WeakMap<RuntimeTransport, Map<string, Promise<readonly string[]>>>();

function discoveredCodexSkillNames(transport: RuntimeTransport, cwd: string | undefined): Promise<readonly string[]> {
  const listSkills = transport.listSkills;
  if (listSkills === undefined) {
    throw new CapabilityStripUnsupportedError(
      "codex",
      "skills",
      "the transport cannot retrieve the app-server's stabilised skill discovery result"
    );
  }
  let byCwd = codexSkillDiscoveryCache.get(transport);
  if (byCwd === undefined) {
    byCwd = new Map();
    codexSkillDiscoveryCache.set(transport, byCwd);
  }
  const key = cwd ?? "";
  const cached = byCwd.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const discovery = listSkills.call(transport, cwd);
  byCwd.set(key, discovery);
  discovery.catch(() => byCwd.delete(key));
  return discovery;
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
   *   and its failure mode on a Codex rename would be silent — a live test
   *   against a real worker is what re-checks this judgement per release.
   * - `skills` strips through the same per-thread overlay, measured
   *   2026-08-30 on codex-cli 0.151.0: fresh `skills/list` calls must show a
   *   growing filesystem-and-plugin set and then repeat it (sampled up to
   *   10 times at 1000 ms spacing by default; the transport's discovery
   *   deadline, checked between samples, stops the loop once its elapsed
   *   budget is spent — each call itself is bounded by the request
   *   timeout). This rejects a repeated cold state
   *   rather than mistaking it for complete discovery; bundled skills are
   *   disabled and every accepted name gets an exact `skills.config` deny.
   *   Discovery has no protocol-level completion signal — the
   *   grow-then-repeat heuristic is a measured judgement of one release's
   *   timing, so **re-verify it on every codex-cli upgrade**: a future
   *   multi-stage or slower-than-interval discovery would stabilise early
   *   and silently under-strip.
   */
  readonly capabilities: EngineCapabilityTable = {
    skills: {
      route: "config",
      detail:
        "measured 2026-08-30 on codex-cli 0.151.0: thread/start disables bundled skills and denies every name only after app-server discovery grows then repeats, including plugin scope (up to 10 samples at 1000 ms spacing; re-verify per codex-cli upgrade)"
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
    return new CodexEngineInvocation({
      prompt,
      options,
      transport: this.#transport
    });
  }

  createSession(options: EngineTurnOptions): EngineWorkerSession {
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
        const threadId = await openCodexThread(this.#transport, this.#options, this.#options.cwd);
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
    const threadId = await openCodexThread(this.#transport, this.#options, cwd);

    return this.#transport.runTurn(threadId, prompt, {
      ...(this.#options.timeoutMs !== undefined ? { timeoutMs: this.#options.timeoutMs } : {}),
      ...(this.#options.schema !== undefined ? { schema: normaliseForCodexOutputSchema(this.#options.schema) } : {}),
      ...(this.#options.model !== undefined ? { model: this.#options.model } : {}),
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
   * deny rules ride the per-dispatch settings file the control plane already
   * writes (the one surface measured to reach the daemon-served session).
   * Worker tool surface measured 2026-08-28 on Claude Code 2.1.250 used
   * `mcp__`-prefixed names; that session's skills pair showed the bare `Skill`
   * deny working (`Skill` absent under a skills strip, present in the
   * baseline). The agents deny set was witnessed 2026-08-30 on Claude Code
   * 2.1.251: `ListAgents` and `SendMessage` were absent at the stripped worker,
   * while the unstripped control demonstrated discovery and messaging.
   * `Agent` was also absent, but the witness cannot isolate it from the
   * machine-wide `Agent` deny. `Task` remains in the delivered deny set, which
   * the exact-set regression proves. Deny rules outrank every allow layer and
   * permission mode, `--dangerously-skip-permissions` included — a live test
   * asserts that at the worker itself.
   */
  readonly capabilities: EngineCapabilityTable = {
    skills: { route: "config", detail: "permissions deny rules in the per-dispatch settings file" },
    agents: {
      route: "config",
      detail:
        "worker tool surface measured 2026-08-28 on Claude Code 2.1.250 used mcp__-prefixed names; that session's skills pair showed the bare Skill deny working (Skill absent under a skills strip, present in the baseline). The agents deny set was witnessed 2026-08-30 on Claude Code 2.1.251: ListAgents and SendMessage were absent at the stripped worker, while the unstripped control demonstrated discovery and messaging. Agent was also absent, but the witness cannot isolate it from the machine-wide Agent deny. Task remains in the delivered deny set, which the exact-set regression proves."
    }
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
    // The canonical level clamps to the CLI's nearest native level here,
    // pre-spawn: the CLI silently runs an unknown value at its default, so
    // only the converted native value may reach it. The run record's
    // `resolved_effort` is not this value: it is the level the CLI's own
    // transcript reports serving (claude-transcript's `effortSince`).
    const effort = claudeNativeEffort(options.effort);
    const invocation = new ClaudeEngineInvocation({
      prompt,
      cwd: options.cwd ?? this.#cwd,
      options: effort === undefined ? options : { ...options, effort },
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
    // Same canonical clamp as createInvocation: a session fixes effort at
    // creation, so the conversion happens once, here.
    const effort = claudeNativeEffort(options.effort);
    // A session is the invocation generalised across turns: same dispatch,
    // valve, and collection machinery, registered for cancellation like any
    // one-shot invocation so adapter close() tears held workers down too.
    const session = new ClaudeEngineInvocation({
      prompt: "",
      cwd: options.cwd ?? this.#cwd,
      options: effort === undefined ? options : { ...options, effort },
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
  /**
   * The run's resolved hold scope (null for the shared scope), handed to the
   * Claude control plane for delivery to every worker session. Omitted, the
   * control plane resolves the scope its own environment names.
   */
  holdScope?: string | null;
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
      controlPlane: new ClaudeCliControlPlane({
        ...(options.workerEnvironment?.claude !== undefined ? { workerEnv: options.workerEnvironment.claude } : {}),
        ...(options.holdScope !== undefined ? { holdScope: options.holdScope } : {})
      }),
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

/**
 * Opens the thread a Codex attempt runs on: the strip overlay first, then
 * `thread/start`. The overlay is sent only when this dispatch strips: an
 * unstripped worker's thread/start stays byte-identical, keeping whatever
 * default tool surface the machine's own config.toml gives it (stripping is
 * opt-in in both directions — a strip removes nothing unasked, and its
 * absence grants nothing the machine had turned off).
 *
 * A substrate that never started or is already gone when asked — the
 * handshake timed out, the process exited or failed to spawn — is a
 * substrate refusal: no worker existed for this attempt, so it is raised as
 * `CodexSubstrateRefusedError` (pre-spawn) with the app-server's exit
 * evidence carried across. A `thread/start` the running server rejected is
 * the server answering and passes through as the attempt's own failure.
 *
 * The requested model and effort both ride the thread: `thread/start`'s
 * answer reports the model and reasoning effort the thread runs at, and
 * that answer is what the record's `resolved_model` / `resolved_effort`
 * carry (`ThreadStartOptions.effort`). Neither is re-sent on the turn.
 */
async function openCodexThread(
  transport: RuntimeTransport,
  options: Pick<EngineTurnOptions, "strip" | "model" | "effort">,
  cwd: string | undefined
): Promise<string> {
  try {
    const threadConfig = await codexThreadConfig(options.strip, transport, cwd);
    return await transport.openThread({
      ...(cwd !== undefined ? { cwd } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(threadConfig !== undefined ? { threadConfig } : {})
    });
  } catch (error) {
    if (error instanceof AppServerStartupTimeoutError || error instanceof AppServerExitedError) {
      // The refusal is what the run fails on, so it carries the cause as the
      // failure notice would have presented it — how the server died and its
      // last stderr, control-stripped — not just the class's one-liner.
      const refused = new CodexSubstrateRefusedError(cwd, error, presentOperationalError(error) ?? error.message);
      const exit = workerExitStatusOf(error);
      throw exit === null ? refused : attachWorkerExitStatus(refused, exit);
    }
    throw error;
  }
}

function promptWithFailureFeedback(prompt: string, failure: PreviousAttemptFailure | undefined): string {
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
