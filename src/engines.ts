import { randomUUID } from "node:crypto";
import { parseWorkerScopeGrouping } from "./ambient-settings.js";
import type { TurnProgressObserver } from "./app-server.js";
import type { LiveTranscriptObserver } from "./types.js";
import { LazyCodexAppServerTransport } from "./app-server.js";
import { ClaudeCliControlPlane } from "./claude-control-plane.js";
import { CommandContainment } from "./contained-command.js";
import { createWorkerScopes, RUN_SCOPE_GROUP, type WorkerScopeGrouping, type WorkerScopes } from "./worker-scopes.js";
import { ClaudeEngineInvocation, claudeNativeEffort } from "./claude-engine.js";
import { ClaudeStripPreparer } from "./claude-strip-preparation.js";
import { requireRegisteredOpenCodeModel } from "./engine-option-validation.js";
import { engineResourceRequirements } from "./engine-resources.js";
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
import { createOpenCodeModelRegistry, defaultOpenCodeModelRegistry } from "./opencode-model-registry.js";
import { Scheduler } from "./scheduler.js";
import { normaliseForCodexOutputSchema } from "./schema.js";
import {
  defaultClaudeConcurrency,
  defaultCodexConcurrency,
  defaultOpenCodeConcurrency
} from "./concurrency-defaults.js";

import type { EngineCapabilityTable, PreparedStrip, StrippableCapability } from "./capability-stripping.js";
import type { ClaudeControlPlane } from "./claude-control-plane.js";
import type { WorkerExitStatus } from "./errors.js";
import type { ClaudeEngineConfig } from "./claude-engine.js";
import type { OpenCodeRunner } from "./opencode-engine.js";
import type { OpenCodeModelRegistry, OpenCodeModelRegistryEntry, OpenCodeModelSource } from "./opencode-model-registry.js";
import type { ResourceRequirement } from "./resource-preflight.js";
import type {
  BackgroundTaskWaitSnapshot,
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
  /**
   * This dispatch's strip as the adapter's `prepareStrip` settled it, handed
   * back unchanged. Present exactly when the adapter prepares strips and
   * `strip` is non-empty; the adapter's dispatch applies this and nothing
   * re-derived.
   */
  preparedStrip?: PreparedStrip;
}

/** What a strip preparation is judged against: the dispatch's resolved inputs that can change the tool surface. */
export interface StripPreparationContext {
  /** The attempt's resolved placement (a worktree's root under isolation). */
  cwd: string;
  model?: string;
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
    | "claude-delivery-error"
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

export interface EngineAttemptContext extends LiveTranscriptObserver, TurnProgressObserver {
  attempt: number;
  previousFailure?: PreviousAttemptFailure;
  /**
   * Called at the first observed sign of worker output — a transcript
   * appearing, a streamed frame, a first stdout chunk. Engines may call it
   * more than once (per attempt, or per frame kind); the consumer keeps the
   * earliest observation, so callers need no dedup of their own.
   */
  onLiveEvidence?: () => void;
  /**
   * Called whenever what the worker is waiting on changes: a background
   * task the session started and is not yet woken for (`wait`), or nothing
   * (`null`) once it ends. Observability for the live status only — the
   * durable account rides the result's `backgroundWaits`.
   */
  onWaiting?: (wait: BackgroundTaskWaitSnapshot | null) => void;
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
  /**
   * Settle one dispatch's strip against what is live, for an engine whose
   * declared table says only that a route exists. Optional: an adapter
   * without it dispatches on its table alone. The runtime still judges the
   * table pre-admission, synchronously, so dispatch order stays the
   * admission order. Then, for a non-empty strip, it awaits this once per
   * target, after the placement opens and before the invocation or
   * session is created. That covers each chain target and a held
   * session's creating turn; retries reuse the result and later turns keep
   * it. The record's strip entry takes the returned `enforcement`, and
   * `EngineTurnOptions.preparedStrip` carries the object to the dispatch.
   * A rejection with `CapabilityStripUnsupportedError` refuses the worker
   * before it spawns. A substrate refusal is recorded as an availability
   * failure and advances a remaining chain entry without requesting a worker.
   */
  prepareStrip?(strip: readonly StrippableCapability[], context: StripPreparationContext): Promise<PreparedStrip>;
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
   *
   * An adapter whose workers run a command it contained
   * (`CommandContainment.contain`) stops that command itself, as part of
   * cancelling the worker, and never waits for the registry's shared
   * resources to end it: the registry closes those only after every
   * adapter's close has settled, so an adapter waiting on them — on a pipe a
   * contained descendant holds open, say — would never settle. A stop made
   * here is the run's teardown, and the adapter reports nothing for it: the
   * containment's own close, which follows, names every command whose end
   * the run could not establish. What a stop made earlier, for one attempt,
   * could not establish rides that attempt's result instead
   * (`unestablishedStopDiagnostics`).
   */
  close(): Promise<void>;
}

/** A resource the engines share and the registry therefore owns. */
export interface SharedEngineResource {
  /**
   * The run has begun to end and is about to cancel its workers: whatever
   * the resource does for an engine from here on is done for the run's
   * teardown, not for an attempt of a script still running. Synchronous, so
   * it holds before the first cancellation; may be called more than once.
   * A resource that draws no such line omits it.
   */
  runEnding?(): void;
  close(): Promise<void>;
}

export class EngineRegistry {
  #engines = new Map<EngineName, EngineAdapter>();
  /** Closed after every engine has, in the order given. */
  #shared: readonly SharedEngineResource[];

  /** What each engine needs at the attempt's resolved placement, judged before dispatch (`EngineResourceGate`). */
  #resources: (name: EngineName, cwd: string) => readonly ResourceRequirement[];

  /**
   * `resources` resolves an engine's filesystem requirements at each
   * attempt's resolved placement, so a run resolves only the engines it
   * uses. Omitted, no engine declares any, which is what a registry of
   * test doubles wants; the default registry declares every engine's
   * (`createDefaultEngineRegistry`).
   */
  constructor(
    engines: EngineAdapter[],
    shared: readonly SharedEngineResource[] = [],
    resources: (name: EngineName, cwd: string) => readonly ResourceRequirement[] = () => []
  ) {
    for (const engine of engines) {
      this.#engines.set(engine.name, engine);
    }
    this.#shared = shared;
    this.#resources = resources;
  }

  get(name: EngineName): EngineAdapter | undefined {
    return this.#engines.get(name);
  }

  resourceRequirements(name: EngineName, cwd: string): readonly ResourceRequirement[] {
    return this.#resources(name, cwd);
  }

  names(): EngineName[] {
    return [...this.#engines.keys()];
  }

  /**
   * Tell the shared resources the run has begun to end
   * (`SharedEngineResource.runEnding`). Whoever ends the run calls this
   * before it cancels any worker by any route — a held session closed ahead
   * of the engines included — and `close()` calls it for a caller that
   * cancels through the registry alone.
   */
  runEnding(): void {
    for (const resource of this.#shared) {
      resource.runEnding?.();
    }
  }

  async close(): Promise<void> {
    this.runEnding();
    // allSettled first: one adapter's close failure must not stop the
    // caller waiting for — and therefore observing — the others' teardown.
    // The failures are then rethrown together, once every adapter has
    // settled: an engine cancel that failed silently would make the run's
    // cancellation promise unattributable. The async wrapper converts a
    // synchronously-throwing close into a rejection, so one bad adapter
    // cannot stop the others from being closed at all.
    const results = await Promise.allSettled([...this.#engines.values()].map(async (engine) => engine.close()));
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
    // Shared resources go after the engines that used them: a worker scope
    // stopped while its engine is still tearing a worker down would end the
    // worker under the engine's feet. Engines never wait on them in turn
    // (`EngineAdapter.close`), so the order cannot deadlock. They close one
    // after another, in the order given, each attempted whatever the one
    // before did. Their closes are where the run confirms that what it
    // owns has ended, so a failure there is the run's as much as an
    // engine's and is rethrown with the rest.
    for (const resource of this.#shared) {
      try {
        await resource.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "engine teardown failed");
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
   * Provider-wire boundary coverage on codex-cli 0.160.0 and 0.167.0:
   * test/integration/codex-strip-boundary-estate.test.ts dispatches real
   * Codex workers against a credential-free capture provider. Unstripped
   * siblings before and after a stripped thread establish the controls;
   * each request is matched to its archived thread and turn.
   *
   * - `agents`: the per-thread `agents.enabled=false` overlay removes the
   *   `multi_agent_v1` tool group, including spawn and messaging tools.
   * - `skills`: there is no dedicated skill tool on these versions. Skills
   *   appear as an instruction listing; a `$name` mention invokes a skill
   *   by injecting its body. Disabling bundled skills and every discovered
   *   name removes both the listing and the invoked body, including a
   *   seeded body token. Shell reads are outside this capability boundary.
   *
   * Discovery still has no protocol-level completion signal. Fresh
   * `skills/list` calls must grow then repeat, or remain unchanged across
   * every sample (up to 10 at 1000 ms spacing). A shrink after growth is
   * rejected. This timing heuristic can under-strip a future multi-stage
   * discovery; the boundary test must keep running on Codex upgrades.
   */
  readonly capabilities: EngineCapabilityTable = {
    skills: {
      route: "config",
      detail:
        "provider-wire boundary tested on codex-cli 0.160.0 and 0.167.0: thread/start disables bundled skills and denies every discovered name, removing the skill listing and invoked body; discovery grows then repeats or stays unchanged across every sample, including plugin scope (up to 10 samples at 1000 ms spacing; re-verify per codex-cli upgrade)"
    },
    agents: {
      route: "config",
      detail:
        "provider-wire boundary tested on codex-cli 0.160.0 and 0.167.0: thread/start config overlay agents.enabled=false removes the multi_agent_v1 tool group"
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
      ...codexProgressObservers(context),
      ...(context.onTranscriptEvent !== undefined ? { onTranscriptEvent: context.onTranscriptEvent } : {}),
      ...(context.onTranscriptPath !== undefined ? { onTranscriptPath: context.onTranscriptPath } : {})
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
    return this.#runTurnInCwd(prompt, this.#options.cwd, context);
  }

  async #runTurnInCwd(
    prompt: string,
    cwd: string | undefined,
    context: EngineAttemptContext
  ): Promise<TurnResult> {
    const threadId = await openCodexThread(this.#transport, this.#options, cwd);

    return this.#transport.runTurn(threadId, prompt, {
      ...(this.#options.timeoutMs !== undefined ? { timeoutMs: this.#options.timeoutMs } : {}),
      ...(this.#options.schema !== undefined ? { schema: normaliseForCodexOutputSchema(this.#options.schema) } : {}),
      ...(this.#options.model !== undefined ? { model: this.#options.model } : {}),
      ...codexProgressObservers(context),
      ...(context.onTranscriptEvent !== undefined ? { onTranscriptEvent: context.onTranscriptEvent } : {}),
      ...(context.onTranscriptPath !== undefined ? { onTranscriptPath: context.onTranscriptPath } : {})
    });
  }

}

/** Preserve observer fields through RuntimeTransport's narrower public option type. */
function codexProgressObservers(context: EngineAttemptContext): TurnProgressObserver & {
  onFirstOutput?: () => void;
} {
  return {
    ...(context.onLiveEvidence !== undefined ? { onFirstOutput: context.onLiveEvidence } : {}),
    ...(context.onOutput !== undefined ? { onOutput: context.onOutput } : {}),
    ...(context.onIdentity !== undefined ? { onIdentity: context.onIdentity } : {}),
    ...(context.onUsage !== undefined ? { onUsage: context.onUsage } : {})
  };
}

export interface ClaudeEngineAdapterOptions {
  /** Defaults to the fixed per-engine cap (12; see concurrency-defaults). */
  concurrency?: number;
  /** Base working directory workers are dispatched from. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Injectable for tests; defaults to the real `claude`/`tmux` control
   * plane. The adapter owns the control plane it is given and closes it
   * when the adapter closes.
   */
  controlPlane?: ClaudeControlPlane;
  /** Routes best-effort transcript-derived token usage into the runtime budget recorder. */
  onEvent?: (event: RuntimeEvent) => void;
  config?: ClaudeEngineConfig;
}

const CLAUDE_STRIP_ROUTE =
  "permissions.deny in the per-dispatch settings file, derived from the served Claude Code's live tool surface";

export class ClaudeEngineAdapter implements EngineAdapter {
  readonly name = "claude" satisfies EngineName;
  readonly concurrency: number;
  /**
   * The route only. Which tools a strip denies is settled per dispatch by
   * `prepareStrip` from the served Claude Code's live tool surface, and the
   * record's detail is replaced by that preparation's.
   */
  readonly capabilities: EngineCapabilityTable = {
    skills: { route: "config", detail: CLAUDE_STRIP_ROUTE },
    agents: { route: "config", detail: CLAUDE_STRIP_ROUTE }
  };

  #scheduler: Scheduler;
  #cwd: string;
  #controlPlane: ClaudeControlPlane;
  #onEvent: ((event: RuntimeEvent) => void) | undefined;
  #config: ClaudeEngineConfig | undefined;
  #activeInvocations = new Set<ClaudeEngineInvocation>();
  #strips: ClaudeStripPreparer;
  #closed = false;

  constructor(options: ClaudeEngineAdapterOptions = {}) {
    this.concurrency = options.concurrency ?? defaultClaudeConcurrency();
    this.#scheduler = new Scheduler(this.concurrency);
    this.#cwd = options.cwd ?? process.cwd();
    this.#controlPlane = options.controlPlane ?? new ClaudeCliControlPlane();
    this.#onEvent = options.onEvent;
    this.#config = options.config;
    this.#strips = new ClaudeStripPreparer({
      probe: this.#controlPlane.probeToolSurface?.bind(this.#controlPlane)
    });
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.#scheduler.schedule(task);
  }

  prepareStrip(strip: readonly StrippableCapability[], context: StripPreparationContext): Promise<PreparedStrip> {
    return this.#strips.prepare({ strip, ...context });
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
      onVersion: (version) => this.#strips.retainVersion(version),
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
      onVersion: (version) => this.#strips.retainVersion(version),
      onClose: (closed) => this.#activeInvocations.delete(closed)
    });
    this.#activeInvocations.add(session);
    return session;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#scheduler.close(new EngineShutdownError(this.name));
    this.#strips.close();
    // Beside the workers' own teardown, not after it: an invocation's close
    // can wait on an attempt that is itself waiting on a dispatch, and only
    // the control plane's close cancels that dispatch.
    await Promise.allSettled([
      ...[...this.#activeInvocations].map((invocation) => invocation.close()),
      this.#controlPlane.close()
    ]);
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
  /** A strip refuses before dispatch until its worker-boundary enforcement is established. */
  readonly capabilities: EngineCapabilityTable = {
    skills: {
      route: "unsupported",
      detail:
        "worker-boundary enforcement of permission.skill=deny through OPENCODE_CONFIG_CONTENT is unproven"
    },
    agents: {
      route: "unsupported",
      detail:
        "worker-boundary enforcement of permission.task=deny through OPENCODE_CONFIG_CONTENT is unproven"
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
      throw new OpenCodeModelRequiredError(this.#modelRegistry);
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
  openCodeModels?: readonly OpenCodeModelRegistryEntry[];
  openCodeModelSource?: OpenCodeModelSource;
  /**
   * The run's resolved hold scope (null for the shared scope), handed to the
   * Claude control plane for delivery to every worker session. Omitted, the
   * control plane resolves the scope its own environment names.
   */
  holdScope?: string | null;
  /**
   * The scope manager the engines place and launch processes through.
   * Omitted, the machine's own is built here — the systemd one where a
   * user manager answers, the fallback otherwise — and the registry owns
   * its close.
   */
  workerScopes?: WorkerScopes;
  workerScope?: WorkerScopeGrouping;
  onEvent: (event: RuntimeEvent) => void;
  onClaudeEvent: (event: RuntimeEvent) => void;
  onOpenCodeEvent: (event: RuntimeEvent) => void;
}

export async function createDefaultEngineRegistry(
  options: CreateDefaultEngineRegistryOptions
): Promise<EngineRegistry> {
  // The one I/O here is the scope manager's probe of the systemd user
  // manager; the engines themselves stay lazy. The app-server spawns when
  // the first worker names Codex, so a run needs only the engines its
  // script actually uses (no engine is privileged).
  const grouping = parseWorkerScopeGrouping(options.workerScope ?? "worker", "workerScope");
  const ownsScopes = options.workerScopes === undefined;
  const workerScopes = options.workerScopes ?? (await createWorkerScopes({ label: `${process.pid}-${randomUUID()}` }));
  // The run's contained commands: an engine whose workers run a command of
  // their own starts it through this. It is the run's whoever owns the
  // scope manager, so the registry always closes it.
  const workerCommands = new CommandContainment(workerScopes);
  const transport = new LazyCodexAppServerTransport({
    cwd: options.cwd,
    codexBin: options.codexBin,
    scopes: workerScopes,
    scopeGroup: grouping === "run" ? RUN_SCOPE_GROUP : "codex",
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

  return new EngineRegistry(
    [
      new CodexEngineAdapter({
        transport,
        concurrency: options.concurrencyCaps?.codex ?? defaultCodexConcurrency()
      }),
      new ClaudeEngineAdapter({
        cwd: options.cwd,
        controlPlane: new ClaudeCliControlPlane({
          ...(options.workerEnvironment?.claude !== undefined ? { workerEnv: options.workerEnvironment.claude } : {}),
          ...(options.holdScope !== undefined ? { holdScope: options.holdScope } : {}),
          scopes: workerScopes,
          workerScope: grouping,
          ...(options.onClaudeEvent !== undefined ? { onEvent: options.onClaudeEvent } : {})
        }),
        ...(options.concurrencyCaps?.claude !== undefined ? { concurrency: options.concurrencyCaps.claude } : {}),
        // Claude deliberately emits the same usage event shape as Codex. Keep the
        // adapter sink labelled so accounting never has to infer engine from payload.
        onEvent: options.onClaudeEvent
      }),
      new OpenCodeEngineAdapter({
        cwd: options.cwd,
        ...(options.openCodeBin !== undefined ? { bin: options.openCodeBin } : {}),
        runner: new OpenCodeCliRunner(options.openCodeBin, {
          commands: workerCommands,
          ...(options.workerEnvironment?.opencode !== undefined ? { workerEnv: options.workerEnvironment.opencode } : {})
        }),
        ...(options.concurrencyCaps?.opencode !== undefined ? { concurrency: options.concurrencyCaps.opencode } : {}),
        ...(options.openCodeModels !== undefined || options.openCodeModelSource !== undefined
          ? { modelRegistry: createOpenCodeModelRegistry(options.openCodeModels ?? [], options.openCodeModelSource) }
          : {}),
        onEvent: options.onOpenCodeEvent
      })
    ],
    // Commands before scopes: a command's scope is one of the manager's, and
    // the manager's close would report a survivor by unit alone, where the
    // containment names the command and judges how it was stopped.
    [workerCommands, ...(ownsScopes ? [workerScopes] : [])],
    // The Codex app-server is shared and starts in the run base; Claude
    // and opencode launch a process in each invocation's placement.
    (engine, cwd) => engineResourceRequirements(engine, options.workerEnvironment?.[engine], engine === "codex" ? options.cwd : cwd)
  );
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
