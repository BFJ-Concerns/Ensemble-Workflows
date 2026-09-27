import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import type {
  EngineName,
  EngineTranscriptArtifact,
  FallbackTarget,
  JsonObject,
  JsonSchema,
  TokenUsageEvent
} from "./types.js";
import { DIGEST_RECIPE, canonicalJson, compareCodeUnits, sha256 } from "./canonical-document.js";
import { harnessVersion } from "./harness-version.js";
import { addUsageSummary, summariseUsage } from "./usage-summary.js";

import type { Resolved } from "./ambient-settings.js";
import type { DischargedEnforcement, StrippableCapability } from "./capability-stripping.js";
import type { FailureClassification } from "./failure-classification.js";
import type { UsageSummary } from "./usage-summary.js";

const execFileAsync = promisify(execFile);
/**
 * 4 (2026-09-04): the agent record's `fallback_model` is replaced by the
 * declared `fallback` chain and the `answered_by` target; every attempt
 * carries its `target` and, when failed, its `classification`; the
 * manifest gains script-recorded `tallies`. A breaking shape change on
 * the agent record, so the version moves.
 */
const SCHEMA_VERSION = 4;
const MANIFEST_PATH = "manifest.json";

/**
 * `incomplete` is writer-written only: the run itself reached a terminal
 * status, but at seal the archive could not account for every file its own
 * manifest declares (see `ManifestIntegrity.files_lost`) — so the manifest
 * refuses the completeness claim while `result.json` keeps the run's own
 * outcome. `abandoned` is reaper-written only (see `reapAbandonedRuns`): the terminal
 * status for a durable in-progress run whose owning process is provably
 * gone. A launcher that can still write chooses one of the other terminal
 * statuses itself.
 */
type RunStatus =
  | "in-progress"
  | "complete"
  | "failed"
  | "incomplete"
  | "timed-out"
  | "interrupted"
  | "abandoned";
type AgentStatus = "in-progress" | "complete" | "failed" | "timed-out" | "interrupted" | "abandoned";
type ParseRoute = "direct" | "object-fallback" | "array-fallback";

export interface CliFlagsRecord {
  budget?: Record<string, number | null>;
  agentCeiling?: number | null;
  concurrency?: Record<string, number>;
  timeoutMs?: number;
  strip?: string[];
  jsonArgs: boolean;
}

export interface RunRecordStartOptions {
  storeDir: string;
  cwd: string;
  runUuid: string;
  workflowPath: string;
  workflowSource: string;
  args: unknown;
  cliFlags: CliFlagsRecord;
  concurrency?: EffectiveConcurrencyRecord;
  effectiveSettings?: EffectiveRunSettingsRecord;
  /** Opaque identity supplied by the process that invoked this run, if any. */
  callerIdentity?: string;
  startedAt?: string;
  /** Proc filesystem root for owner liveness evidence; injectable for tests. */
  procDir?: string;
}

export interface EffectiveConcurrencyRecord {
  agentCeiling: Resolved<number | null>;
  engines: Partial<Record<EngineName, Resolved<number>>>;
}

/**
 * Effective per-engine token ceilings and the whole-run timeout, each with
 * the layer that won — the same auditable shape the agent ceiling and
 * concurrency caps already record, so a consumer reconstructs which layer
 * decided every run-shaping number without product knowledge. These two
 * settings take no env or config-file layer today, so their honest layers
 * are `flag` and `default`; the shape does not change if they ever gain
 * more.
 */
export interface EffectiveRunSettingsRecord {
  budgetCeilings: Partial<Record<EngineName, Resolved<number | null>>>;
  runTimeoutMs: Resolved<number | null>;
}

export interface RuntimeAgentAttemptRecord {
  attempt: number;
  status: "complete" | "failed";
  /**
   * The target this attempt was dispatched to: the call's own engine and
   * model until the chain advances, then the entry it advanced to. The
   * model is the *requested* pin (null when the call left it unpinned);
   * `resolvedModel` beside it is what the engine served.
   */
  target: { engine: EngineName; model: string | null };
  failure: { kind: string; message: string } | null;
  /**
   * How the harness classified this failed attempt: the class and the
   * classifier rule that matched, or `rule: null` for a diagnostic no rule
   * recognised. Null on a complete attempt. An `availability` class is what
   * advanced the chain, where one remained; the raw diagnostic stays in
   * `failure`, `appServerDiagnostic`, and `diagnostics` beside it.
   */
  classification: FailureClassification | null;
  /**
   * The transport symptom this attempt observed, when what `failure` names
   * is the run's own settlement rather than an engine fault. A shutdown or
   * whole-run timeout reaches an in-flight turn as whatever the transport
   * noticed first — a closed app-server, an aborted poll — which describes
   * the run's exit, not the attempt's cause, so `failure` names the cause
   * and the observation is kept here rather than discarded. Null whenever
   * `failure` is already the engine's own account.
   */
  observedFailure: { kind: string; message: string } | null;
  /**
   * How the attempt's worker process died, when the engine observed it —
   * the exit status or terminating signal, so a killed leg is
   * distinguishable from one that returned nothing. Null when the worker
   * returned normally or its engine has no process handle to observe.
   */
  workerExit: { exitCode: number | null; signal: string | null } | null;
  /**
   * The Codex app-server diagnostic observed for this failed attempt. Null
   * when the engine supplied no diagnostic, rather than an inferred cause.
   */
  appServerDiagnostic: { code: number | string | null; message: string; payload: string } | null;
  rawOutput: string | null;
  validatedOutput: unknown;
  /** The served model this attempt's engine reported, when it reported one. */
  resolvedModel: string | null;
  /**
   * The reasoning effort this attempt's turn actually ran at, as its engine
   * reported it — the resolved-option analogue of `resolvedModel`, and the
   * only durable trace of an unpinned turn's ambient default. Null where the
   * engine reports none, never the requested pin (which `effort` on the
   * agent record already carries).
   */
  resolvedEffort: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number | null;
  firstDeltaMs: number | null;
  tokenUsageEvents: TokenUsageEvent[];
  transcripts: EngineTranscriptArtifact[];
  diagnostics?: JsonObject;
}

/** Bounded evidence emitted when the Codex transport cannot decode an inbound frame. */
export interface DecodeFailureDiagnostic {
  byteLength: number;
  linePrefix: string;
}

export interface RuntimeAgentRecord {
  id: number;
  engine: EngineName;
  /** The top-level engine, model, and effort describe the original request. */
  headerIdentity: "original_request";
  /** The dispatched prompt, recorded before the engine is called. */
  prompt: string;
  /** Options as the runtime resolved them at dispatch (defaults applied). */
  options: {
    timeoutMs: number | null;
    maxAttempts: number;
  };
  model: string | null;
  effort: string | null;
  /** The declared fallback chain, as the call or its engine defaults declared it; null when none. */
  fallback: FallbackTarget[] | null;
  /**
   * Which target answered: `entry` is -1 for the call's own target and
   * the chain index thereafter, beside that target's engine and model. Null
   * until an attempt completes — a failed agent names no answering target.
   */
  answeredBy: { entry: number; engine: EngineName; model: string | null } | null;
  resolvedModel: string | null;
  /** The served effort, last write wins across attempts; see the attempt field. */
  resolvedEffort: string | null;
  resolvedCwd: string;
  isolation: "worktree" | null;
  worktree: {
    branch: string;
    baseCommit: string;
    tipCommit: string | null;
    changed: boolean;
    removed: boolean;
  } | null;
  label: string | null;
  phase: string | null;
  status: AgentStatus;
  /**
   * Why this agent ended as it did, when the runtime ended it rather than
   * the engine — a run interrupt or a whole-run timeout reaches a worker as
   * whatever its transport happened to notice (a closed app-server, an
   * aborted poll), so the attempt's own failure names the symptom and this
   * names the cause — and, where the agent ended before any attempt was
   * observed, the account of that ending, since the attempts array has no
   * entry to carry it (an engine that refuses an unknown model at dispatch
   * is diagnosed here or nowhere). Null when an attempt's own failure is
   * the account, so one failure has one home and the two cannot disagree.
   * Never an inference: what is not observed reads as unavailable with its
   * reason, never as a manufactured cause.
   */
  terminationCause: TerminalErrorRecord | null;
  creationOrder: number;
  /** The engine group of the latest admitted target; initially the requested engine. */
  concurrencyGroup: string;
  schema: JsonSchema | null;
  /**
   * The call's effective capability strip: the requested names and the
   * per-capability route each resolved to on the dispatching engine's table
   * (`config` = stripped through engine configuration, `absent` = the
   * capability does not exist on that engine's tool surface). Null when
   * nothing was stripped — the archive then shows the worker kept its
   * engine's default tool surface.
   */
  strip: {
    requested: StrippableCapability[];
    enforcement: Partial<Record<StrippableCapability, DischargedEnforcement>>;
  } | null;
  /**
   * The multi-turn worker session this record is one turn of: the
   * run-scoped session ordinal and this record's 1-based turn number within
   * it. Null for a one-shot call. Grouping per-turn records by `session.id`
   * and ordering by `turn` reconstructs a held worker's whole conversation
   * from the archive alone — each turn's prompt, attempts, and usage are
   * this record's own fields, exactly as for a one-shot call.
   */
  session: { id: number; turn: number } | null;
  /**
   * What the engine's capture path observed for this turn. Null means this
   * engine has no capture-state observation, never that a capture was lost.
   */
  transcriptCapture: "retained" | "lost" | null;
  /** The successful schema parse route, once a schema agent has produced a valid value. */
  parseRoute: ParseRoute | null;
  /** Bounded evidence for the latest inbound Codex frame that could not be decoded. */
  decodeFailure: DecodeFailureDiagnostic | null;
  rawOutput: string | null;
  validatedOutput: unknown;
  queuedMs: number;
  executionMs: number;
  attempts: RuntimeAgentAttemptRecord[];
}

/**
 * The terminal error that ended a run, as a consumer holding only the
 * archive reads it. `kind` is the error's class name, which is what
 * discriminates a script bug (`WorkflowScriptError`) from an unknown-engine
 * typo (`UnknownEngineError`) from a whole-run timeout
 * (`WorkflowTimeoutError`) from a budget refusal (`BudgetExceededError`) —
 * four cases that otherwise all read as bare `failed`.
 */
export interface TerminalErrorRecord {
  kind: string;
  message: string;
}

export interface RunRecordFinishOptions {
  /**
   * The launcher's own terminal statuses. `abandoned` belongs to the reaper
   * alone, and `incomplete` to the writer alone — a launcher reporting a
   * clean run cannot also judge whether the archive that records it survived.
   */
  status: Exclude<RunStatus, "in-progress" | "abandoned" | "incomplete">;
  exitCode: number;
  result: unknown;
  /**
   * What ended the run, when it ended badly. Null on a clean finish and
   * where the launcher never saw an error — never an inferred cause.
   */
  error?: TerminalErrorRecord | null;
  endedAt?: string;
}

interface FileEntry {
  path: string;
  size: number;
  sha256: string;
}

/**
 * A file the manifest declares that the archive could not account for when
 * the run sealed. `missing` is the deleted-archive case (the file the
 * manifest promises is ENOENT); `size-mismatch` is a file replaced beneath
 * the writer. The reconciliation checks presence and size, not content —
 * the recorded `sha256` is the consumer's own walk, and re-hashing every
 * transcript at seal would buy nothing the consumer does not already do.
 */
interface FileLossRecord {
  path: string;
  reason: "missing" | "size-mismatch";
}

/**
 * What the archive says about its own wholeness — the answer to the two
 * questions the `files` table cannot answer about itself.
 *
 * `manifest_sha256` covers the manifest itself, which no entry in `files`
 * ever can: it is the sha256 of the manifest's own canonical form with this
 * field set to `null`. A consumer verifies it by parsing the manifest,
 * writing `null` over this field, re-canonicalising, and hashing — the same
 * two-space sorted-key JSON the writer emits. It is a self-attestation, not
 * a signature: it catches the edited field and the truncated write, and a
 * forger who recomputes it defeats it. There is no key material in the
 * archive with which to do better.
 *
 * `files_lost` is written at seal, when the writer reconciles the table
 * against the directory it describes. A run whose archive was deleted
 * mid-flight lands here rather than in a `complete` status over absent
 * files.
 */
interface ManifestIntegrity {
  algorithm: "sha256";
  /**
   * The verification rule for `manifest_sha256`, stated in the archive so
   * a cold consumer needs nothing from this codebase — the same
   * self-description discipline as the args' `canonical_archive_path`.
   * Always {@link DIGEST_RECIPE}; the sentinel's integrity block carries
   * the same rule for its own digest field.
   */
  recipe: string;
  manifest_sha256: string | null;
  files_lost: FileLossRecord[];
}

interface NamespaceRecord {
  strategy: "git-root-realpath-sha256";
  id: string;
  material: string;
  hash: string;
}

interface GitState {
  root: string | null;
  head: string | null;
  dirty: boolean | null;
  diffPath: string | null;
}

/**
 * Liveness evidence for the process that owns this manifest, written once at
 * start — the one write that makes a durable `in-progress` run decidable
 * after its writer dies without a heartbeat stream. A consumer (or the
 * reaper) checks the recorded pid against the live process table, with the
 * process start ticks discriminating pid reuse. `start_ticks` is
 * `/proc`-derived and null where no readable proc filesystem exists; a
 * null-ticks owner is never reaped — evidence that was never recorded
 * cannot be judged, so the conservative reading is "possibly live".
 */
interface RunOwnerRecord {
  pid: number;
  start_ticks: string | null;
  host: string;
}

/** Written by the reaper beside the flipped status: what it observed, when, and as whom. */
interface AbandonmentRecord {
  observed_at: string;
  reason: "owner-process-gone" | "manifest-predates-owner-recording";
  observed_by: { pid: number; run_uuid: string };
}

interface Manifest {
  schema_version: 4;
  kind: "run_manifest";
  run_id: string;
  run_uuid: string;
  /** The launching session's supplied identity; null means it was not supplied. */
  caller_identity: string | null;
  namespace: NamespaceRecord;
  status: RunStatus;
  owner: RunOwnerRecord;
  abandonment?: AbandonmentRecord;
  started_at: string;
  ended_at: string | null;
  workflow: {
    path: string;
    archive_path: string;
    sha256: string;
  };
  args: {
    archive_path: string;
    /**
     * The exact canonical JSON text whose bytes `sha256` covers. This is
     * archived separately from the descriptive args envelope so an archive
     * consumer can verify the digest without depending on writer behaviour.
     */
    canonical_archive_path: string;
    sha256: string;
  };
  meta: {
    task: unknown;
    raw: unknown;
  };
  cli_flags: CliFlagsRecord;
  concurrency: {
    agent_ceiling: Resolved<number | null>;
    engines: Partial<Record<EngineName, Resolved<number>>>;
  };
  /** See {@link EffectiveRunSettingsRecord}: values with their winning layers. */
  budget_ceilings: Partial<Record<EngineName, Resolved<number | null>>>;
  run_timeout_ms: Resolved<number | null>;
  git: {
    start: GitState;
    end: GitState | null;
  };
  environment: {
    os: {
      platform: string;
      release: string;
      arch: string;
    };
    node: string;
    tools: Record<string, string | null>;
  };
  harness: {
    package_name: string;
    package_version: string;
    commit: string | null;
  };
  result: {
    archive_path: string | null;
    exit_code: number | null;
  };
  /**
   * What ended the run: the terminal error's kind and message, or null when
   * the run ended cleanly (or ended badly with no error observed). The one
   * thing a consumer cannot reconstruct from the rest of the archive.
   */
  error: TerminalErrorRecord | null;
  /**
   * The root workflow and every composed child it invoked, in call order.
   * One run, one grouping identity: the root's `meta.task` remains the
   * consumer's key, and a child is an invocation inside the run, never a
   * second run.
   */
  workflow_invocations: WorkflowInvocationEntry[];
  /**
   * The run's hold lifecycle, append-only in event order: each raise,
   * accepted answer, rejected answer, and timeout, so a consumer holding
   * only the archive can reconstruct what the run waited on and how each
   * wait ended. The hold files themselves are transient coordination state;
   * this list is their durable trace.
   */
  hold_events: HoldEventEntry[];
  /**
   * Script-recorded counts: names the author chose, numbers the
   * script recorded through the `tally` hook, stored verbatim beside the
   * usage rollup — a name recorded again replaces its value. The runtime
   * validates the shape and knows nothing of the meaning.
   */
  tallies: Record<string, number>;
  cost_rollup: Record<string, Record<string, UsageRollup>>;
  files: FileEntry[];
  integrity: ManifestIntegrity;
}

interface HoldEventEntry {
  hold_id: string;
  event: "raised" | "answered" | "answer-rejected" | "timed-out" | "retired";
  /** The accepted verdict on `answered`; null elsewhere. */
  verdict: string | null;
  /** The rejection reason on `answer-rejected`; null elsewhere. */
  reason: string | null;
  /** The rejected file's submitted verdict; null only when the state explains why. */
  attempted_verdict: string | null;
  /** The evidence quality for `attempted_verdict`; null outside rejected answers. */
  attempted_verdict_state: "submitted" | "missing-or-non-string" | "unparseable" | null;
  at: string;
}

interface WorkflowInvocationEntry {
  /**
   * Recording order: 0 is the root; children take the next ordinal as their
   * pre-run record reaches the writer. Concurrent `workflow()` calls in one
   * `parallel()` are ordered by when each finished resolving, which is the
   * earliest moment provenance exists to record.
   */
  ordinal: number;
  /** The invoking entry's ordinal; null for the root. */
  parent: number | null;
  path: string;
  source: {
    /** sha256 of the archived source file's exact bytes. */
    archive_path: string;
    sha256: string;
  };
  args: {
    /**
     * sha256 of the exact canonical JSON text at `canonical_archive_path`,
     * matching the root manifest's `args.sha256` semantics. `archive_path`
     * remains the descriptive envelope with `{schema_version, kind, value}`.
     */
    archive_path: string;
    canonical_archive_path: string;
    sha256: string;
  };
}

export interface WorkflowInvocationRecord {
  /** The resolved script path the invocation ran. */
  scriptPath: string;
  source: string;
  args: unknown;
  /** The invoking invocation's ordinal — 0 when the root called it. */
  parentOrdinal: number;
}

interface UsageRollup {
  /** Summary usage in the declared vocabulary — see `src/usage-summary.ts`. */
  tokens: UsageSummary;
  /**
   * Money, in the absence-with-a-reason idiom the summary vocabulary uses:
   * the reported form only where an engine actually reported cost
   * with its usage, and otherwise the reason there is no figure. The
   * harness prices nothing itself, so the old shape — `amount: null` under
   * `source: "estimated"` — asserted an estimate that never existed and a
   * consumer could not tell from "this run cost nothing".
   */
  cost: ReportedCost | { unavailable: "no-provider-cost-reported" | "unlike-currencies" };
}

/** Provider-reported spend, summed across the bucket's own usage events. */
interface ReportedCost {
  amount: number;
  currency: string | null;
  /**
   * Always `provider-reported`: the harness has no pricing table, so the
   * only figure it can publish is one an engine handed it. The field stays
   * so a consumer reading a cost knows where it came from.
   */
  source: "provider-reported";
}

export class RunRecordWriter {
  readonly archiveDir: string;
  readonly manifest: Manifest;

  #cwd: string;
  #files = new Map<string, FileEntry>();
  #agents = new Map<number, RuntimeAgentRecord>();
  #tmpSeq = 0;
  #writeChain: Promise<unknown> = Promise.resolve();
  #sealed = false;

  private constructor(archiveDir: string, cwd: string, manifest: Manifest) {
    this.archiveDir = archiveDir;
    this.#cwd = cwd;
    this.manifest = manifest;
  }

  /**
   * Concurrent agents settle independently, but the manifest is one shared
   * read-modify-write document: interleaved writes would race each other (and
   * previously collided on same-millisecond temp names). Every mutating public
   * operation runs through this chain, so each snapshot on disk reflects all
   * operations before it. One failed write must not poison later ones.
   */
  #serialise<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#writeChain.then(task, task);
    this.#writeChain = next.catch(() => undefined);
    return next;
  }

  static async start(options: RunRecordStartOptions): Promise<RunRecordWriter> {
    const namespace = await deriveNamespace(options.cwd);
    const runId = `${namespace.id}:${options.runUuid}`;
    const archiveDir = runDirectoryFor(options.storeDir, namespace, options.runUuid);
    await mkdir(archiveDir, { recursive: true });

    const harnessRoot = (await findHarnessRoot()) ?? options.cwd;
    const packageInfo = await readPackageInfo(harnessRoot);
    const gitStart = await readGitState(options.cwd, "git/start.diff", archiveDir);
    const canonicalArgs = canonicalJson(options.args);
    const writer = new RunRecordWriter(archiveDir, options.cwd, {
      schema_version: SCHEMA_VERSION,
      kind: "run_manifest",
      run_id: runId,
      run_uuid: options.runUuid,
      caller_identity: options.callerIdentity ?? null,
      namespace,
      status: "in-progress",
      owner: {
        pid: process.pid,
        start_ticks: await readProcessStartTicks(options.procDir ?? "/proc", process.pid),
        host: os.hostname()
      },
      started_at: options.startedAt ?? new Date().toISOString(),
      ended_at: null,
      workflow: {
        path: options.workflowPath,
        archive_path: "workflow.js",
        sha256: sha256(options.workflowSource)
      },
      args: {
        archive_path: "args.json",
        canonical_archive_path: "args.canonical.json",
        sha256: sha256(canonicalArgs)
      },
      meta: {
        task: null,
        raw: null
      },
      cli_flags: options.cliFlags,
      concurrency: {
        agent_ceiling: options.concurrency?.agentCeiling ?? { value: null, layer: "default" },
        engines: options.concurrency?.engines ?? {}
      },
      budget_ceilings: options.effectiveSettings?.budgetCeilings ?? {},
      run_timeout_ms: options.effectiveSettings?.runTimeoutMs ?? { value: null, layer: "default" },
      git: {
        start: gitStart,
        end: null
      },
      environment: {
        os: {
          platform: os.platform(),
          release: os.release(),
          arch: os.arch()
        },
        node: process.version,
        tools: await toolVersions()
      },
      harness: {
        package_name: packageInfo.name,
        package_version: packageInfo.version,
        commit: await git(["rev-parse", "HEAD"], harnessRoot)
      },
      result: {
        archive_path: null,
        exit_code: null
      },
      error: null,
      workflow_invocations: [
        {
          ordinal: 0,
          parent: null,
          path: options.workflowPath,
          source: {
            archive_path: "workflow.js",
            sha256: sha256(options.workflowSource)
          },
          args: {
            archive_path: "args.json",
            canonical_archive_path: "args.canonical.json",
            sha256: sha256(canonicalArgs)
          }
        }
      ],
      hold_events: [],
      tallies: {},
      cost_rollup: {},
      files: [],
      integrity: {
        algorithm: "sha256",
        recipe: DIGEST_RECIPE,
        manifest_sha256: null,
        files_lost: []
      }
    });

    await writer.#writeText("workflow.js", options.workflowSource);
    await writer.#writeJson("args.json", {
      schema_version: SCHEMA_VERSION,
      kind: "run_args",
      value: options.args
    });
    await writer.#writeText("args.canonical.json", canonicalArgs);
    if (gitStart.diffPath !== null) {
      await writer.#trackFile(gitStart.diffPath);
    }
    await writer.#writeManifest();
    // A new writer starting in the namespace is the reap trigger: siblings
    // whose owner is provably gone become terminal now, so the store never
    // needs an age heuristic to tell abandoned from live. The sweep can
    // never fail this run (every failure path inside it is swallowed); it
    // is awaited, costing one or two manifest reads per sibling.
    await reapAbandonedRuns({
      namespaceDir: path.dirname(archiveDir),
      skipRunUuid: options.runUuid,
      procDir: options.procDir ?? "/proc",
      observer: { pid: process.pid, runUuid: options.runUuid }
    });
    return writer;
  }

  async noteMeta(meta: unknown): Promise<void> {
    await this.#serialise(async () => {
      if (this.#sealed) {
        return;
      }
      this.manifest.meta = {
        task: extractTask(meta),
        raw: meta
      };
      await this.#writeManifest();
    });
  }

  /**
   * Record a composed child's invocation: its source and args are archived
   * beside the root's (same hashing, same canonicalisation), the manifest
   * gains an ordered entry carrying the parent link, and the assigned
   * ordinal is returned so nested provenance (if a deeper level is ever
   * permitted) can name its parent. One run identity throughout — a child
   * never opens a second archive.
   */
  async recordWorkflowInvocation(invocation: WorkflowInvocationRecord): Promise<number> {
    // Snapshot at the boundary, like recordAgent: args may be a live object
    // a concurrent sibling mutates while this write waits on the chain.
    const args = structuredClone(invocation.args);
    return await this.#serialise(async () => {
      if (this.#sealed) {
        // Nothing was recorded, so no ordinal exists to return; -1 is the
        // honest non-value rather than a number that names a ghost entry.
        return -1;
      }
      const ordinal = this.manifest.workflow_invocations.length;
      const directory = `workflows/${padId(ordinal)}`;
      const sourcePath = `${directory}/workflow.js`;
      const argsPath = `${directory}/args.json`;
      const canonicalArgsPath = `${directory}/args.canonical.json`;
      const canonicalArgs = canonicalJson(args);
      await this.#writeText(sourcePath, invocation.source);
      await this.#writeJson(argsPath, {
        schema_version: SCHEMA_VERSION,
        kind: "workflow_args",
        value: args
      });
      await this.#writeText(canonicalArgsPath, canonicalArgs);
      this.manifest.workflow_invocations.push({
        ordinal,
        parent: invocation.parentOrdinal,
        path: invocation.scriptPath,
        source: {
          archive_path: sourcePath,
          sha256: sha256(invocation.source)
        },
        args: {
          archive_path: argsPath,
          canonical_archive_path: canonicalArgsPath,
          sha256: sha256(canonicalArgs)
        }
      });
      await this.#writeManifest();
      return ordinal;
    });
  }

  /**
   * Append one hold lifecycle event from the runtime's event stream.
   * Same intent-before-outcome principle as the dispatch-time agent write:
   * the raise is recorded when it happens, so a run that dies mid-hold
   * still shows what it was waiting on. Unrecognised methods are ignored —
   * the runtime forwards its hold events unfiltered.
   */
  async recordHoldEvent(event: { method: string; params: Record<string, unknown>; receivedAt: number }): Promise<void> {
    const kind = holdEventKind(event.method);
    if (kind === null || typeof event.params.holdId !== "string") {
      return;
    }
    const entry: HoldEventEntry = {
      hold_id: event.params.holdId,
      event: kind,
      verdict: kind === "answered" && typeof event.params.verdict === "string" ? event.params.verdict : null,
      reason: kind === "answer-rejected" && typeof event.params.reason === "string" ? event.params.reason : null,
      attempted_verdict:
        kind === "answer-rejected" && typeof event.params.attemptedVerdict === "string"
          ? event.params.attemptedVerdict
          : null,
      attempted_verdict_state:
        kind === "answer-rejected" && isAttemptedVerdictState(event.params.attemptedVerdictState)
          ? event.params.attemptedVerdictState
          : null,
      at: new Date(event.receivedAt).toISOString()
    };
    await this.#serialise(async () => {
      if (this.#sealed) {
        return;
      }
      this.manifest.hold_events.push(entry);
      await this.#writeManifest();
    });
  }

  /**
   * Record one named count from the script body. Last write wins per
   * name, and the write lands in the manifest at once — a count recorded
   * before the run ends by any handleable path is in the archive whether
   * or not `finish()` is ever reached.
   */
  async recordTally(name: string, value: number): Promise<void> {
    await this.#serialise(async () => {
      if (this.#sealed) {
        return;
      }
      // Names are the author's, reserved words included: a plain assignment
      // of `__proto__` would invoke the inherited setter and record nothing,
      // so the count is always defined as an own enumerable property.
      Object.defineProperty(this.manifest.tallies, name, { value, enumerable: true, writable: true, configurable: true });
      await this.#writeManifest();
    });
  }

  async recordAgent(record: RuntimeAgentRecord): Promise<void> {
    // Snapshot at the boundary: the runtime keeps mutating its live record
    // between the dispatch-time write and settlement, and the manifest
    // roll-up is recomputed from #agents on every later write — a retained
    // alias would let the manifest publish usage the agent's own persisted
    // JSON does not yet contain.
    const snapshot = structuredClone(record);
    await this.#serialise(async () => {
      if (this.#sealed) {
        return;
      }
      await this.#recordAgent(snapshot);
    });
  }

  async #recordAgent(record: RuntimeAgentRecord): Promise<void> {
    this.#agents.set(record.id, record);
    const agentDir = `agents/${padId(record.id)}`;
    const transcriptRefs = [];

    for (const attempt of record.attempts) {
      let index = 0;
      for (const transcript of attempt.transcripts) {
        // A reference is an assertion that a transcript exists. Codex held
        // sessions can honestly have no new transcript on a follow-up turn;
        // preserve that absence through transcripts_unavailable instead of
        // emitting a 0-byte artefact for consumers to discover later.
        if (transcript.content.length === 0) {
          continue;
        }
        index += 1;
        const suffix = transcript.format === "jsonl" ? "jsonl" : "txt";
        const relativePath = `${agentDir}/attempt-${padAttempt(attempt.attempt)}-${index}-${safeName(transcript.filename, suffix)}`;
        await this.#writeText(relativePath, transcript.content);
        transcriptRefs.push({
          attempt: attempt.attempt,
          path: relativePath,
          format: transcript.format,
          source: transcript.source,
          thread_id: transcript.threadId ?? null,
          session_id: transcript.sessionId ?? null
        });
      }
    }

    const agentJsonPath = `${agentDir}/agent.json`;
    await this.#writeJson(agentJsonPath, {
      schema_version: SCHEMA_VERSION,
      kind: "agent_record",
      id: record.id,
      engine: record.engine,
      header_identity: record.headerIdentity,
      prompt: record.prompt,
      options: {
        timeout_ms: record.options.timeoutMs,
        max_attempts: record.options.maxAttempts
      },
      model: record.model,
      effort: record.effort,
      fallback: record.fallback,
      answered_by: record.answeredBy,
      resolved_model: record.resolvedModel,
      resolved_effort: record.resolvedEffort,
      resolved_cwd: record.resolvedCwd,
      isolation: record.isolation,
      worktree:
        record.worktree === null
          ? null
          : {
              branch: record.worktree.branch,
              base_commit: record.worktree.baseCommit,
              tip_commit: record.worktree.tipCommit,
              changed: record.worktree.changed,
              removed: record.worktree.removed
            },
      label: record.label,
      phase: record.phase,
      status: record.status,
      termination_cause: record.terminationCause,
      creation_order: record.creationOrder,
      concurrency_group: record.concurrencyGroup,
      schema: record.schema,
      strip: record.strip,
      session: record.session,
      transcript_capture: record.transcriptCapture,
      parse_route: record.parseRoute,
      decode_failure:
        record.decodeFailure === null
          ? null
          : {
              byte_length: record.decodeFailure.byteLength,
              line_prefix: record.decodeFailure.linePrefix
            },
      raw_output: record.rawOutput,
      validated_output: record.validatedOutput,
      // Summary usage in the declared vocabulary, or the reason there is
      // none — an agent with no usage data must be legible as "unknown for
      // this reason", never indistinguishable from zero spend.
      usage: agentUsage(record),
      queued_ms: record.queuedMs,
      execution_ms: record.executionMs,
      attempts: record.attempts.map((attempt) => ({
        attempt: attempt.attempt,
        status: attempt.status,
        target: attempt.target,
        failure: attempt.failure,
        classification: attempt.classification,
        observed_failure: attempt.observedFailure,
        worker_exit:
          attempt.workerExit === null
            ? null
            : { exit_code: attempt.workerExit.exitCode, signal: attempt.workerExit.signal },
        app_server_diagnostic:
          attempt.appServerDiagnostic === null
            ? null
            : {
                code: attempt.appServerDiagnostic.code,
                message: attempt.appServerDiagnostic.message,
                payload: attempt.appServerDiagnostic.payload
              },
        raw_output: attempt.rawOutput,
        validated_output: attempt.validatedOutput,
        resolved_model: attempt.resolvedModel,
        resolved_effort: attempt.resolvedEffort,
        started_at: attempt.startedAt,
        ended_at: attempt.endedAt,
        duration_ms: attempt.durationMs,
        first_delta_ms: attempt.firstDeltaMs,
        token_usage_events: attempt.tokenUsageEvents,
        diagnostics: attempt.diagnostics ?? {}
      })),
      // Keep the documented v3 array shape in every outcome. Its sibling
      // preserves why it is empty, so a consumer can distinguish an absent
      // transcript from one lost by the archive.
      transcripts: transcriptRefs,
      transcripts_unavailable: transcriptRefs.length > 0 ? null : transcriptAbsenceReason(record)
    });
    this.manifest.cost_rollup = buildCostRollup([...this.#agents.values()]);
    await this.#writeManifest();
  }

  async finish(options: RunRecordFinishOptions): Promise<void> {
    await this.#serialise(async () => {
      if (this.#sealed) {
        return;
      }
      this.manifest.status = options.status;
      this.manifest.ended_at = options.endedAt ?? new Date().toISOString();
      this.manifest.git.end = await readGitState(this.#cwd, "git/end.diff", this.archiveDir);
      if (this.manifest.git.end.diffPath !== null) {
        await this.#trackFile(this.manifest.git.end.diffPath);
      }
      this.manifest.result = {
        archive_path: "result.json",
        exit_code: options.exitCode
      };
      // The terminal cause rides both surfaces: a consumer that reads only
      // the manifest and one that reads only the result envelope must each
      // be able to say why the run ended, without the other file.
      this.manifest.error = options.error ?? null;
      await this.#writeJson("result.json", {
        schema_version: SCHEMA_VERSION,
        kind: "run_result",
        // The run's own outcome as the launcher reported it. Where the
        // manifest later degrades to `incomplete`, the two are answering
        // different questions: this envelope says how the run ended, the
        // manifest says whether the archive recording it is whole.
        status: options.status,
        exit_code: options.exitCode,
        error: options.error ?? null,
        value: options.result
      });
      // Reconcile before the manifest is written, so the self-digest attests
      // a file table that has been checked against the directory it
      // describes — and so no manifest ever carries `complete` over files
      // that are not there. Losing files is a recording failure, never a run
      // failure (the exit code and the terminal error stand as the launcher
      // reported them); what changes is what the record claims about itself.
      this.manifest.integrity.files_lost = await this.#reconcileFiles();
      if (this.manifest.integrity.files_lost.length > 0 && this.manifest.status === "complete") {
        this.manifest.status = "incomplete";
      }
      await this.#writeManifest();
      // Calls queued after finish belong to workers that outlived the workflow.
      // The archive is now a coherent final snapshot; reopening it would race
      // cleanup and could silently change the published result after return.
      this.#sealed = true;
    });
  }

  async #writeJson(relativePath: string, value: unknown): Promise<void> {
    await this.#writeText(relativePath, `${canonicalJson(value)}\n`);
  }

  async #writeText(relativePath: string, content: string): Promise<void> {
    const destination = path.join(this.archiveDir, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}${this.#tmpSuffix()}`);
    await writeAndRename(temporary, destination, content);
    await this.#trackFile(relativePath);
  }

  async #writeManifest(): Promise<void> {
    // Code-unit order: the table's order feeds the digested bytes, so it
    // must be locale-independent like the canonical form's key order.
    this.manifest.files = [...this.#files.values()].sort((a, b) => compareCodeUnits(a.path, b.path));
    // Self-attestation last, over everything above it: null the field, hash
    // the canonical form, then write. Computed on every manifest write, not
    // only at seal, so a manifest read mid-run is verifiable too.
    this.manifest.integrity.manifest_sha256 = null;
    this.manifest.integrity.manifest_sha256 = sha256(canonicalJson(this.manifest));
    const destination = path.join(this.archiveDir, MANIFEST_PATH);
    const temporary = path.join(this.archiveDir, `.manifest${this.#tmpSuffix()}`);
    await writeAndRename(temporary, destination, `${canonicalJson(this.manifest)}\n`);
  }

  // pid + sequence keeps names unique within the process; Date.now() alone
  // collided when two agents settled in the same millisecond.
  #tmpSuffix(): string {
    this.#tmpSeq += 1;
    return `.${process.pid}.${this.#tmpSeq}.tmp`;
  }

  /**
   * Checks every file the manifest declares against the archive directory,
   * returning what is no longer accountable. Presence and size only: the
   * recorded digest is what a consumer walks, and re-hashing the whole
   * archive at seal would repeat that walk for no extra evidence.
   */
  async #reconcileFiles(): Promise<FileLossRecord[]> {
    const lost: FileLossRecord[] = [];
    for (const entry of [...this.#files.values()].sort((a, b) => compareCodeUnits(a.path, b.path))) {
      const metadata = await stat(path.join(this.archiveDir, entry.path)).catch(() => null);
      if (metadata === null) {
        lost.push({ path: entry.path, reason: "missing" });
      } else if (metadata.size !== entry.size) {
        lost.push({ path: entry.path, reason: "size-mismatch" });
      }
    }
    return lost;
  }

  /**
   * The sealed manifest's self-digest, for a consumer of this writer that
   * publishes an attestation elsewhere (the completion sentinel). Null
   * until the archive seals: a mid-run digest is real but perishable —
   * `finish()` rewrites the manifest — so publishing it outside the file
   * it covers would attest bytes the seal then replaces.
   */
  sealedManifestDigest(): string | null {
    return this.#sealed ? this.manifest.integrity.manifest_sha256 : null;
  }

  async #trackFile(relativePath: string): Promise<void> {
    const absolute = path.join(this.archiveDir, relativePath);
    const [metadata, contentHash] = await Promise.all([stat(absolute), hashFile(absolute)]);
    this.#files.set(relativePath, {
      path: relativePath,
      size: metadata.size,
      sha256: contentHash
    });
  }
}

/**
 * Why an agent record carries no transcript, in the same vocabulary shape as
 * `usage.unavailable`: the worker never ran, the runtime ended it before a
 * transcript existed, the Codex session client did not retain a follow-up
 * capture, or its engine produced none for the attempts that ran.
 */
function transcriptAbsenceReason(
  record: RuntimeAgentRecord
):
  | "no-attempt-ran"
  | "worker-interrupted"
  | "worker-timed-out"
  | "session-client-capture-gap"
  | "engine-produced-no-transcript" {
  if (record.attempts.length === 0) {
    return "no-attempt-ran";
  }
  if (record.status === "interrupted") {
    return "worker-interrupted";
  }
  if (record.status === "timed-out") {
    return "worker-timed-out";
  }
  if (record.transcriptCapture === "lost") {
    return "session-client-capture-gap";
  }
  return "engine-produced-no-transcript";
}

function agentUsage(
  record: RuntimeAgentRecord
): { summary: UsageSummary } | { unavailable: "no-attempt-ran" | "engine-reported-no-usage" } {
  // Summed attempt by attempt under each attempt's own engine: a fallback
  // chain can put one agent's attempts on two engines, and each engine's
  // native usage is read by its own inclusion rule before the summaries
  // fold together in the declared vocabulary.
  let summary: UsageSummary | null = null;
  for (const attempt of record.attempts) {
    const attemptSummary = summariseUsage(attempt.target.engine, attempt.tokenUsageEvents);
    if (attemptSummary !== null) {
      summary = summary === null ? attemptSummary : addUsageSummary(summary, attemptSummary);
    }
  }
  if (summary !== null) {
    return { summary };
  }
  return { unavailable: record.attempts.length === 0 ? "no-attempt-ran" : "engine-reported-no-usage" };
}

function buildCostRollup(records: RuntimeAgentRecord[]): Record<string, Record<string, UsageRollup>> {
  const rollup: Record<string, Record<string, UsageRollup>> = {};
  // Cost is accumulated separately from the published shape because the
  // published shape is a statement, not a running total: a bucket that never
  // sees a provider-reported figure must publish the reason rather than a
  // zero, and one that sees unlike currencies must publish that reason
  // rather than a cross-currency sum.
  const accumulators = new Map<string, CostAccumulator>();
  for (const record of records) {
    // Spend is keyed under the engine and model that actually served each
    // attempt's turns — attempts can resolve different served models (a
    // retry opens a fresh thread) and, under a fallback chain,
    // different engines — so attribution is per attempt, falling back to
    // the agent-level answer and then to the literal "unresolved". Never
    // the requested pin: a rollup label is a claim about what ran, not
    // about what was asked for. A no-event attempt adds no bucket —
    // the agent's own record says why (its `usage.unavailable` reason); a
    // zero bucket would read as zero spend, which is a different claim.
    // An attempt that reported no served model of its own may borrow the
    // agent-level answer only when that answer came from its own engine:
    // the agent-level field is last-write-wins across attempts, and under
    // a cross-engine chain the last writer is the answering engine, whose
    // model must never label a refused engine's spend.
    const lastReporter = record.attempts.findLast((attempt) => attempt.resolvedModel !== null)?.target.engine ?? record.engine;
    for (const attempt of record.attempts) {
      const engine = attempt.target.engine;
      const summary = summariseUsage(engine, attempt.tokenUsageEvents);
      if (summary === null) {
        continue;
      }
      const borrowed = engine === lastReporter ? record.resolvedModel : null;
      const model = attempt.resolvedModel ?? borrowed ?? "unresolved";
      rollup[engine] ??= {};
      const existing = rollup[engine][model];
      const key = `${engine}\u0000${model}`;
      const accumulator = accumulators.get(key) ?? { amount: 0, currency: null, reported: false, unlike: false };
      accumulators.set(key, accumulator);
      for (const event of attempt.tokenUsageEvents) {
        addProviderCost(accumulator, event);
      }
      rollup[engine][model] = {
        tokens: existing === undefined ? summary : addUsageSummary(existing.tokens, summary),
        cost: publishedCost(accumulator)
      };
    }
  }
  return rollup;
}

interface CostAccumulator {
  amount: number;
  currency: string | null;
  reported: boolean;
  /** Latched once two events disagree on currency; never unlatched. */
  unlike: boolean;
}

function publishedCost(accumulator: CostAccumulator): UsageRollup["cost"] {
  if (accumulator.unlike) {
    return { unavailable: "unlike-currencies" };
  }
  if (!accumulator.reported) {
    return { unavailable: "no-provider-cost-reported" };
  }
  return { amount: accumulator.amount, currency: accumulator.currency, source: "provider-reported" };
}

function addProviderCost(target: CostAccumulator, event: TokenUsageEvent): void {
  if (target.unlike) {
    return;
  }
  const cost = event.raw.cost;
  if (typeof cost !== "number" || !Number.isFinite(cost)) {
    return;
  }
  const currency = typeof event.raw.currency === "string" ? event.raw.currency : null;
  // Unlike currencies cannot be summed; an explicit unknown beats a silent
  // cross-currency total, so the bucket degrades to token-only accounting.
  if (target.currency !== null && currency !== null && currency !== target.currency) {
    target.unlike = true;
    return;
  }
  target.amount += cost;
  target.reported = true;
  if (currency !== null && target.currency === null) {
    target.currency = currency;
  }
}

/**
 * The run's directory in the durable-record store. Exported for the
 * completion sentinel, which lands under the same derivable path whether or
 * not the archive itself is being written — one derivation, two consumers,
 * so a supervisor's watch path and the writer's archive path cannot drift.
 */
export async function resolveRunDirectory(storeDir: string, cwd: string, runUuid: string): Promise<string> {
  return runDirectoryFor(storeDir, await deriveNamespace(cwd), runUuid);
}

export interface ReapAbandonedRunsOptions {
  /** The namespace directory whose run directories are swept. */
  namespaceDir: string;
  /** The sweeping run's own directory name, never judged. */
  skipRunUuid?: string;
  procDir?: string;
  /** Judged-same-host boundary; defaults to this machine's hostname. */
  host?: string;
  /** Recorded in each flipped manifest as the observation's provenance. */
  observer: { pid: number; runUuid: string };
}

/**
 * Rewrites every `in-progress` sibling manifest whose owning process is
 * provably gone to the terminal `abandoned` status, recording what was
 * observed. Judgement is evidence, never age: a recorded owner is dead when
 * its pid has left the process table or the pid's start ticks no longer
 * match (pid reuse); an owner on another host, or one recorded without
 * proc evidence, is never judged. The rewrite is made against a fresh
 * re-read taken after the judgement (see the loop): for an owner-bearing
 * manifest the owner's death precedes the judgement, so the fresh read
 * observes every write the dead process made — a landed finish() shows
 * terminal and is skipped — which closes the read-judge-write race for
 * every evidence-bearing manifest. A manifest with no owner block at all
 * predates owner recording and is reaped under its own recorded reason;
 * there no ordering argument exists, so a residual fresh-read-to-rename
 * window remains — confined to a pre-owner writer still running
 * mid-upgrade, and accepted as transition-era cost rather than claimed
 * away. The reaper resolves *statuses*, never content: beside the manifest
 * flip it rewrites the run's own still-`in-progress` agent records to
 * `abandoned` with the same abandonment provenance, because a dispatch-time
 * agent record frozen at `in-progress` reads to a consumer as "no attempt
 * ran, nothing spent" — a claim the run's death made undecidable, not
 * false. `abandoned` marks the recording as truncated: whatever attempts
 * and usage the record carries are what was recorded before the death,
 * and their absence is unobserved, never zero. Each rewritten record's
 * entry in the manifest's files table is refreshed in the same manifest
 * write as the status flip, so a reaped archive still verifies. The
 * reaper still never deletes, never invents usage or attempts, and never
 * touches a record whose own terminal status landed.
 * Never-fail throughout — a sweep failure must never fail the run that
 * triggered it (it is awaited, so its cost is bounded by the namespace's
 * own run and agent counts). Returns the run uuids it flipped.
 */
export async function reapAbandonedRuns(options: ReapAbandonedRunsOptions): Promise<string[]> {
  const procDir = options.procDir ?? "/proc";
  const host = options.host ?? os.hostname();
  const reaped: string[] = [];
  const entries = await readdir(options.namespaceDir, { withFileTypes: true }).catch(() => null);
  if (entries === null) {
    return reaped;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === options.skipRunUuid) {
      continue;
    }
    try {
      const manifestPath = path.join(options.namespaceDir, entry.name, MANIFEST_PATH);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        status?: unknown;
        owner?: unknown;
      };
      if (manifest.status !== "in-progress") {
        continue;
      }
      const reason = await judgeOwnerGone(manifest.owner, procDir, host);
      if (reason === null) {
        continue;
      }
      // Judge first, then rewrite a FRESH read — never the snapshot the
      // judgement was made from, which may predate the owner's own final
      // flush. For an owner-bearing manifest this ordering closes the race
      // outright: the owner was observed dead before this read, so every
      // write that process ever made is visible here, and a finish() that
      // landed shows terminal below and is skipped. For a no-owner
      // manifest no such ordering exists — a residual window between this
      // read and the rename remains, confined to a pre-owner-recording
      // writer still running mid-upgrade, accepted as transition-era cost.
      const fresh = JSON.parse(await readFile(manifestPath, "utf8")) as {
        status?: unknown;
        abandonment?: AbandonmentRecord;
        files?: FileEntry[];
        integrity?: { manifest_sha256?: string | null } | null;
      };
      if (fresh.status !== "in-progress") {
        continue;
      }
      const abandonment: AbandonmentRecord = {
        observed_at: new Date().toISOString(),
        reason,
        observed_by: { pid: options.observer.pid, run_uuid: options.observer.runUuid }
      };
      // Agent records first, manifest last: the manifest's files table
      // carries each agent.json's size and digest from the dead writer's
      // own tracking, so the one manifest write below must also carry the
      // rewritten records' refreshed entries or a reaped archive stops
      // verifying. A reaper dying between the two writes leaves the
      // manifest `in-progress` and the next sweep re-runs both —
      // resolution is idempotent (already-abandoned records are skipped).
      const rewritten = await resolveAbandonedAgentRecords(path.join(options.namespaceDir, entry.name), abandonment);
      if (Array.isArray(fresh.files)) {
        for (const fileEntry of fresh.files) {
          const update = rewritten.get(fileEntry.path);
          if (update !== undefined) {
            fileEntry.size = update.size;
            fileEntry.sha256 = update.sha256;
          }
        }
      }
      fresh.status = "abandoned";
      fresh.abandonment = abandonment;
      // The reaper changes an attested manifest itself, so renew its
      // self-attestation just as the writer does: null its field, hash the
      // canonical form, then let the standalone helper atomically replace it.
      // Pre-attestation manifests have no self-digest to renew, but remain
      // eligible for the established reap route.
      if (fresh.integrity !== undefined && fresh.integrity !== null && typeof fresh.integrity.manifest_sha256 === "string") {
        fresh.integrity.manifest_sha256 = null;
        fresh.integrity.manifest_sha256 = sha256(canonicalJson(fresh));
      }
      await writeStandaloneText(manifestPath, `${canonicalJson(fresh)}\n`);
      reaped.push(entry.name);
    } catch {
      // One unreadable or unwritable sibling must not end the sweep.
    }
  }
  return reaped;
}

/**
 * Resolve an abandoned run's own unsettled agent records: every
 * `in-progress` agent.json flips to `abandoned`, carrying the manifest's
 * abandonment provenance, so no record keeps asserting a dispatch-time
 * snapshot as an outcome. The same ordering argument as the manifest's
 * applies — the owner was observed dead before these reads, so every write
 * the dead process made is visible, and a settled record shows its
 * terminal status and is skipped. Status resolution only: nothing else in
 * the record changes, and a record that cannot be read or written is left
 * as it stands rather than ending the sweep. Returns the rewritten files'
 * refreshed table entries, keyed by archive-relative path, for the
 * caller's single manifest write.
 */
async function resolveAbandonedAgentRecords(
  runDir: string,
  abandonment: AbandonmentRecord
): Promise<Map<string, { size: number; sha256: string }>> {
  const rewritten = new Map<string, { size: number; sha256: string }>();
  const agentsDir = path.join(runDir, "agents");
  const agentEntries = await readdir(agentsDir, { withFileTypes: true }).catch(() => null);
  if (agentEntries === null) {
    return rewritten;
  }
  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) {
      continue;
    }
    try {
      const agentJsonPath = path.join(agentsDir, agentEntry.name, "agent.json");
      const agentRecord = JSON.parse(await readFile(agentJsonPath, "utf8")) as {
        status?: unknown;
        abandonment?: AbandonmentRecord;
      };
      if (agentRecord.status !== "in-progress") {
        continue;
      }
      agentRecord.status = "abandoned";
      agentRecord.abandonment = abandonment;
      const content = `${canonicalJson(agentRecord)}\n`;
      await writeStandaloneText(agentJsonPath, content);
      rewritten.set(`agents/${agentEntry.name}/agent.json`, {
        size: Buffer.byteLength(content),
        sha256: sha256(content)
      });
    } catch {
      // One unresolvable agent record must not end the sweep.
    }
  }
  return rewritten;
}

async function judgeOwnerGone(
  owner: unknown,
  procDir: string,
  host: string
): Promise<AbandonmentRecord["reason"] | null> {
  if (owner === undefined || owner === null) {
    return "manifest-predates-owner-recording";
  }
  if (typeof owner !== "object") {
    return null;
  }
  const record = owner as Partial<RunOwnerRecord>;
  if (typeof record.pid !== "number" || record.host !== host) {
    return null;
  }
  if (typeof record.start_ticks !== "string") {
    // Recorded without proc evidence (a platform with no readable proc
    // filesystem): liveness is unjudgeable, so the run stays as written.
    return null;
  }
  const liveTicks = await readProcessStartTicks(procDir, record.pid);
  if (liveTicks === record.start_ticks) {
    return null;
  }
  // The judging side needs a readable proc filesystem too: distinguish
  // "the pid is gone" from "proc itself is unreadable here" by probing the
  // proc root before treating an absent stat as evidence of death.
  if (liveTicks === null && (await readProcessStartTicks(procDir, process.pid)) === null) {
    return null;
  }
  return "owner-process-gone";
}

/**
 * The process's start time in clock ticks since boot — field 22 of
 * `/proc/<pid>/stat`, parsed after the parenthesised comm field (which may
 * itself contain spaces and parentheses, hence the last-close-paren split).
 * Null where the stat file cannot be read: pid gone, or no proc filesystem.
 */
export async function readProcessStartTicks(procDir: string, pid: number): Promise<string | null> {
  try {
    const statLine = await readFile(path.join(procDir, String(pid), "stat"), "utf8");
    const afterComm = statLine.slice(statLine.lastIndexOf(")") + 2);
    return afterComm.split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

function runDirectoryFor(storeDir: string, namespace: NamespaceRecord, runUuid: string): string {
  // The path component is the same truncated hash the run id carries
  // (`namespace.id` is `cwd:<hash24>`), so the startup line's identifiers
  // carry to the filesystem without transformation: run id
  // `cwd:<hash24>:<uuid>` names `runs/cwd/<hash24>/<uuid>` verbatim. The
  // manifest's namespace block still records the full hash.
  return path.join(storeDir, "runs", "cwd", namespace.hash.slice(0, 24), runUuid);
}

async function deriveNamespace(cwd: string): Promise<NamespaceRecord> {
  const gitRoot = await git(["rev-parse", "--show-toplevel"], cwd);
  const material = await realpath(gitRoot ?? cwd);
  const hash = sha256(material);
  return {
    strategy: "git-root-realpath-sha256",
    id: `cwd:${hash.slice(0, 24)}`,
    material,
    hash
  };
}

async function readGitState(cwd: string, diffPath: string, archiveDir: string): Promise<GitState> {
  const root = await git(["rev-parse", "--show-toplevel"], cwd);
  const head = await git(["rev-parse", "HEAD"], cwd);
  const porcelain = await git(["status", "--porcelain"], cwd);
  const dirty = porcelain === null ? null : porcelain.length > 0;
  let archivedDiffPath: string | null = null;
  if (dirty === true) {
    // `diff HEAD` captures staged and unstaged changes — `status` counts both as
    // dirty, so the archived diff must too. Plain `diff` covers an unborn HEAD.
    const diff = (await git(["diff", "HEAD", "--binary"], cwd)) ?? (await git(["diff", "--binary"], cwd));
    if (diff !== null && diff.length > 0) {
      await writeStandaloneText(path.join(archiveDir, diffPath), diff);
      archivedDiffPath = diffPath;
    }
  }
  return { root, head, dirty, diffPath: archivedDiffPath };
}

async function readPackageInfo(cwd: string): Promise<{ name: string; version: string }> {
  try {
    const text = await readFile(path.join(cwd, "package.json"), "utf8");
    const parsed = JSON.parse(text) as { name?: unknown; version?: unknown };
    return {
      name: typeof parsed.name === "string" ? parsed.name : "ensemble-workflows",
      version: typeof parsed.version === "string" ? parsed.version : harnessVersion()
    };
  } catch {
    // The bundle ships with no package.json to find; its version is the
    // build-time-inlined constant rather than an off-disk read.
    return { name: "ensemble-workflows", version: harnessVersion() };
  }
}

async function findHarnessRoot(): Promise<string | null> {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const text = await readFile(path.join(current, "package.json"), "utf8");
      const parsed = JSON.parse(text) as { name?: unknown };
      if (parsed.name === "ensemble-workflows") {
        return current;
      }
    } catch {
      // Keep walking; bundled skill installs may not carry package metadata.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function toolVersions(): Promise<Record<string, string | null>> {
  const [gitVersion, codexVersion, claudeVersion, openCodeVersion] = await Promise.all([
    commandVersion("git", ["--version"]),
    commandVersion("codex", ["--version"]),
    commandVersion("claude", ["--version"]),
    commandVersion("opencode", ["--version"])
  ]);
  return { git: gitVersion, codex: codexVersion, claude: claudeVersion, opencode: openCodeVersion };
}

async function commandVersion(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 5_000 });
    return (stdout || stderr).trim() || null;
  } catch {
    return null;
  }
}

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 10_000, maxBuffer: 20 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

function holdEventKind(method: string): HoldEventEntry["event"] | null {
  switch (method) {
    case "hold/raised":
      return "raised";
    case "hold/answered":
      return "answered";
    case "hold/answerRejected":
      return "answer-rejected";
    case "hold/timedOut":
      return "timed-out";
    case "hold/retired":
      // A dead-raiser hold this run's own sweep retired: the observation is
      // this run's, even though the hold was another (dead) run's.
      return "retired";
    default:
      return null;
  }
}

function isAttemptedVerdictState(value: unknown): value is NonNullable<HoldEventEntry["attempted_verdict_state"]> {
  return value === "submitted" || value === "missing-or-non-string" || value === "unparseable";
}

function extractTask(meta: unknown): unknown {
  if (typeof meta !== "object" || meta === null || !("task" in meta)) {
    return null;
  }
  return (meta as { task?: unknown }).task ?? null;
}

async function hashFile(filePath: string): Promise<string> {
  const text = await readFile(filePath);
  return createHash("sha256").update(text).digest("hex");
}

async function writeStandaloneText(destination: string, content: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(path.dirname(destination), `.standalone.${process.pid}.${Date.now()}.tmp`);
  await writeAndRename(temporary, destination, content);
}

/** Atomic temp-then-rename write; a failed write never leaves its temp file behind. */
async function writeAndRename(temporary: string, destination: string, content: string): Promise<void> {
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function padId(id: number): string {
  return String(id).padStart(6, "0");
}

function padAttempt(attempt: number): string {
  return String(attempt).padStart(3, "0");
}

function safeName(filename: string, suffix: string): string {
  const cleaned = filename.replace(/[^a-zA-Z0-9._-]/g, "-");
  return cleaned.endsWith(`.${suffix}`) ? cleaned : `${cleaned}.${suffix}`;
}
