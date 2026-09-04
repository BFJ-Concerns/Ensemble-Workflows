import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { CALLER_IDENTITY_ENV, resolveAmbientSettings } from "./ambient-settings.js";
import { STRIPPABLE_CAPABILITIES } from "./capability-stripping.js";
import { CompletionSentinel } from "./completion-sentinel.js";
import type { SentinelManifestAttestation, SentinelWorkerOutcomes } from "./completion-sentinel.js";
import { MAX_TIMER_DELAY_MS } from "./engine-option-validation.js";
import { describeError, HoldTimeoutError, PreSpawnAuthorError } from "./errors.js";
import { defaultHoldsDirectory, enumerateHolds, resolveHoldScope } from "./holds.js";
import { presentOperationalError, presentTerminalError } from "./operator-diagnosis.js";
import { createRuntime } from "./index.js";
import { readWorkflowMeta, readWorkflowScript, runWorkflowScript, WorkflowTimeoutError } from "./script-runner.js";
import { StatusFileWriter } from "./status-file.js";
import { RunRecordWriter } from "./run-record.js";

import type { EffectiveRunSettingsRecord, RuntimeAgentRecord } from "./run-record.js";
import { defaultWorkflowRegistryDirs, listSavedWorkflows } from "./workflow-registry.js";
import { harnessVersion } from "./harness-version.js";

import type { AmbientSettings } from "./ambient-settings.js";
import type { RunProgress } from "./progress.js";
import type { CompletedAgentOutput, EnsembleRuntime, ShutdownTally } from "./runtime.js";
import type { StrippableCapability } from "./capability-stripping.js";
import type { AgentOptions, EngineBudgetCeilings, EngineConcurrencyCaps, EngineName, JsonSchema } from "./types.js";
import type { Readable, Writable } from "node:stream";

type InterruptSignal = "SIGINT" | "SIGTERM";

const AGENT_INVOCATION_OPTIONS = {
  engine: { type: "string" },
  model: { type: "string" },
  effort: { type: "string" },
  label: { type: "string" },
  phase: { type: "string" },
  cwd: { type: "string" },
  isolation: { type: "string" },
  identity: { type: "boolean" },
  schema: { type: "string" },
  "max-attempts": { type: "string" },
  strip: { type: "string", multiple: true },
  task: { type: "string" },
  budget: { type: "string", multiple: true },
  "agent-ceiling": { type: "string" },
  concurrency: { type: "string", multiple: true },
  timeout: { type: "string" },
  "caller-identity": { type: "string" },
  "hold-scope": { type: "string" }
} as const;

export interface EnsembleCliOptions {
  cwd?: string;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  createRuntime?: typeof createRuntime;
  timeoutMs?: number;
  /**
   * Directory for the live status side-channel. A non-empty string enables
   * writing the run's snapshot for external consumers to read directly.
   * `null` disables it. `undefined` resolves the ambient setting in this call.
   */
  statusDir?: string | null;
  /**
   * Directory for the durable run archive. A non-empty string enables recording;
   * null disables it. `undefined` resolves the default-on ambient policy.
   */
  runRecordDir?: string | null;
  /** Injectable environment for registry resolution; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export async function runEnsembleCli(argv: string[], options: EnsembleCliOptions = {}): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  // Discovery gestures for a cold arrival: help and version answer before
  // any invocation parsing, and each subcommand's --help prints its own
  // usage at exit 0 rather than a usage *error* at exit 2.
  if (argv[0] === "--help" || argv[0] === "-h") {
    // The help gesture answers with orientation, not just the flag grammar
    // the bare usage error already shows.
    stdout.write(usage());
    stdout.write(
      "\nRuns a JavaScript ensemble workflow over a fleet of engine-pinned agents,\n" +
        "or dispatches a single agent. Results are JSON on stdout; diagnostics on stderr.\n" +
        "Subcommands: agent (one worker on a named engine; prompt from argv or stdin),\n" +
        "workflows (list saved workflows), holds (list open decision holds).\n" +
        "Each subcommand answers its own --help.\n"
    );
    return 0;
  }
  if (argv[0] === "--version") {
    stdout.write(`${harnessVersion()}\n`);
    return 0;
  }

  if (argv[0] === "workflows") {
    if (argv[1] === "--help" || argv[1] === "-h") {
      stdout.write("Usage: ensemble workflows\nLists saved workflows from the project and user registries.\n");
      return 0;
    }
    if (argv.length > 1) {
      stderr.write("Usage: ensemble workflows\n");
      return 2;
    }
    const listing = await listSavedWorkflows({ cwd, env, readMeta: readWorkflowMeta });
    if (listing.entries.length === 0) {
      // An empty catalogue speaks: what was found (nothing) and where the
      // CLI looked, so a cold user learns the registry locations instead
      // of staring at silent exit 0.
      const dirs = defaultWorkflowRegistryDirs(cwd, env);
      stdout.write(`No saved workflows found. Looked in:\n  ${dirs.project}\n  ${dirs.user}\n`);
    }
    for (const entry of listing.entries) {
      const scope = entry.shadowed ? "user (shadowed by project)" : entry.scope;
      stdout.write(`${entry.name}\t${entry.description}\t${scope}\t${entry.scriptPath}\n`);
    }
    for (const note of listing.notes) {
      stderr.write(`[workflows] skipped ${note.scriptPath}: ${note.message}\n`);
    }
    return 0;
  }

  if (argv[0] === "agent" && (argv[1] === "--help" || argv[1] === "-h")) {
    stdout.write(usage());
    stdout.write(
      "\nDispatches one worker on the named engine (--engine codex|claude|opencode) and\n" +
        "prints its result as JSON on stdout. The prompt is the single positional\n" +
        "argument, or stdin when omitted; put flags before the prompt. --schema\n" +
        "validates the reply against a JSON Schema; --identity wraps the result as\n" +
        "{ label, phase, output, failure }.\n"
    );
    return 0;
  }

  if (argv[0] === "holds") {
    const holdsUsage =
      "Usage: ensemble holds [--json] [--scope <scope> | --all]\n" +
      "Lists open holds: the inherited scope's (ENSEMBLE_HOLD_SCOPE) or machine-wide when none is set;\n" +
      "--scope names a scope explicitly, --all forces the machine-wide view, --json emits the full records.\n";
    if (argv[1] === "--help" || argv[1] === "-h") {
      stdout.write(holdsUsage);
      return 0;
    }
    // The decision inbox, on its two listing contracts: one scope's
    // open holds (a lead's own view), or the machine-wide view across every
    // scope, the default shared scope included. Each listed hold carries the
    // content, accepted verdicts, and decision path a decider needs — so one
    // watcher can wake one orchestrator instead of a resident session per
    // run. `--json` is the machine-readable form; the answer is a JSON file
    // at `decision_path` carrying the hold's nonce and a listed verdict.
    let json = false;
    let all = false;
    let scopeFlag: string | undefined;
    const rest = argv.slice(1);
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index];
      if (arg === "--json") {
        json = true;
      } else if (arg === "--all") {
        all = true;
      } else if (arg === "--scope") {
        scopeFlag = rest[index + 1];
        index += 1;
        if (scopeFlag === undefined || scopeFlag.trim().length === 0) {
          stderr.write(holdsUsage);
          return 2;
        }
      } else if (arg !== undefined && arg.startsWith("--scope=")) {
        scopeFlag = arg.slice("--scope=".length);
        if (scopeFlag.trim().length === 0) {
          stderr.write(holdsUsage);
          return 2;
        }
      } else {
        stderr.write(holdsUsage);
        return 2;
      }
    }
    if (all && scopeFlag !== undefined) {
      stderr.write(holdsUsage);
      return 2;
    }
    // --scope names one scope; --all forces machine-wide; otherwise the
    // inherited variable scopes the view, and no key means machine-wide.
    const scope = scopeFlag ?? (all ? null : resolveHoldScope(undefined, env));
    let enumeration;
    try {
      enumeration = await enumerateHolds(defaultHoldsDirectory(env), scope !== null ? { scope } : {});
    } catch (error) {
      // An unreadable holds directory is not an empty one: say so, exit 1.
      stderr.write(
        `cannot enumerate holds under ${defaultHoldsDirectory(env)}: ${error instanceof Error ? error.message : String(error)}\n`
      );
      return 1;
    }
    if (json) {
      stdout.write(
        `${JSON.stringify({
          holds: enumeration.holds.map((hold) => hold.record),
          retired: enumeration.retired
        })}\n`
      );
      return 0;
    }
    for (const record of enumeration.retired) {
      stdout.write(`retired ${record.hold_id} — raiser provably gone; nothing could await its answer\n`);
    }
    if (enumeration.holds.length === 0) {
      const view = scope !== null ? `scope ${scope}` : "any scope";
      stdout.write(`No open holds for ${view} under ${defaultHoldsDirectory(env)}\n`);
      return 0;
    }
    for (const hold of enumeration.holds) {
      const { record } = hold;
      stdout.write(
        `${record.hold_id}\tscope ${record.scope ?? "(shared)"}\traised ${record.raised_at}` +
          `${record.timeout_at !== null ? `\ttimes out ${record.timeout_at}` : ""}\n`
      );
      stdout.write(`  verdicts: ${record.verdicts.join(" | ")}\n`);
      // A listed hold is answerable by construction: the enumeration retires
      // any whose raiser it can prove dead. The template spells a real
      // verdict so the decider copies a valid answer rather than the
      // placeholder.
      const [firstVerdict, ...otherVerdicts] = record.verdicts;
      stdout.write(
        `  answer:   write {"nonce":"${record.nonce}","verdict":${JSON.stringify(firstVerdict)}} to ${record.decision_path}` +
          `${otherVerdicts.length > 0 ? ` (or use ${otherVerdicts.map((verdict) => JSON.stringify(verdict)).join(" or ")})` : ""}\n`
      );
      if (record.answer_rejection !== undefined) {
        const attempted =
          record.answer_rejection.attempted_verdict === null
            ? record.answer_rejection.attempted_verdict_state
            : JSON.stringify(record.answer_rejection.attempted_verdict);
        stdout.write(`  rejected: ${record.answer_rejection.reason} (${attempted})\n`);
      }
      for (const line of record.content.split("\n")) {
        stdout.write(`  | ${line}\n`);
      }
    }
    return 0;
  }

  let invocation: ParsedInvocation;
  let ambientSettings: AmbientSettings;
  try {
    invocation = await parseInvocation(argv, cwd, stdin);
    ambientSettings = resolveAmbientSettings({
      env,
      cwd,
      flags: {
        ...(invocation.agentCeiling !== undefined ? { agentCeiling: invocation.agentCeiling } : {}),
        ...(invocation.concurrencyCaps !== undefined ? { concurrencyCaps: invocation.concurrencyCaps } : {})
      }
    });
  } catch (error) {
    // Usage policy, spanning every invocation kind: a rejected named option
    // is its own one-line diagnostic — appending the usage dump would bury
    // the line the author must act on. The usage text belongs to exactly
    // one failure: an invocation that named no work at all (below). An
    // ambient-configuration failure takes the same clean surface through
    // the shared operator seam — the stack behind it is harness interior.
    stderr.write(`${presentOperationalError(error) ?? formatError(error)}\n`);
    return 2;
  }

  if (invocation.kind === "workflow" && invocation.scriptArg === undefined) {
    stderr.write(usage());
    return 2;
  }

  let runtime: EnsembleRuntime | null = null;
  let progress: RunProgress | undefined;
  let statusWriter: StatusFileWriter | null = null;
  let runRecordWriter: RunRecordWriter | null = null;
  let finalRecord: { status: "complete" | "failed" | "timed-out" | "interrupted"; exitCode: number; result: unknown } | null = null;
  // What ended the run. The diagnostic exists on stderr already; a consumer
  // holding only the archive has no way to reconstruct it, so it is
  // resolved here — the one site that sees the terminal error — and carried
  // onto every durable surface (manifest, result envelope, sentinel).
  let terminalError: { kind: string; message: string } | null = null;
  // The launcher owns the sentinel: written on every terminal transition this
  // process can handle, even when recording is off.
  const sentinel = new CompletionSentinel();
  let interrupt: ReturnType<typeof watchWorkflowInterrupts> | null = null;
  const reportSentinelError = (error: unknown): void => {
    stderr.write(`[sentinel] ${formatError(error)}\n`);
  };
  // The exit code is settled by the body below but returned after teardown:
  // a teardown that fails after a clean body must be able to degrade it
  // rather than exit 0 under a `complete` sentinel.
  let exitCode = 1;

  try {
    const prepared = await prepareRun(invocation, cwd);
    // Flag outranks the inherited variable; resolved here against the
    // injectable env so a library-driven CLI call scopes consistently.
    const holdScope = resolveHoldScope(invocation.holdScope, env);
    runtime = await (options.createRuntime ?? createRuntime)({
      cwd,
      ...(invocation.budgetCeilings !== undefined ? { budgetCeilings: invocation.budgetCeilings } : {}),
      ...(holdScope !== null ? { holdScope } : {}),
      ...(invocation.strip !== undefined ? { strip: invocation.strip } : {}),
      ...(Object.keys(ambientSettings.workerEnvironment).length > 0
        ? { workerEnvironment: ambientSettings.workerEnvironment }
        : {}),
      ...runtimeConcurrencyOptions(ambientSettings)
    });
    // The CLI `--timeout` flag wins over a programmatically injected one; both
    // feed the same whole-workflow ceiling in `runWorkflowScript`.
    const timeoutMs = invocation.timeoutMs ?? options.timeoutMs;
    // Injected test runtimes may not carry a progress model; read it defensively.
    progress = (runtime as { progress?: RunProgress }).progress;

    const runRecordDir = options.runRecordDir !== undefined ? options.runRecordDir : ambientSettings.runRecordDir.value;
    const runtimeRunId = progress?.runId ?? "unknown-run";
    const callerIdentity = resolveCallerIdentity(invocation.callerIdentity, env);

    // Announce the sentinel path before any worker spawns. The store
    // directory resolves independently of the ambient record on/off switch:
    // the sentinel is supervision surface, not archive, so a *storage
    // preference* must not silently remove a supervisor's wake signal. An
    // explicit programmatic `runRecordDir: null` is a different thing — a
    // library caller opting out of the store entirely — and skips the
    // sentinel with it.
    const sentinelStoreDir =
      options.runRecordDir !== undefined
        ? options.runRecordDir
        : ambientSettings.runRecordStoreDir.value;
    if (sentinelStoreDir !== null && sentinelStoreDir.length > 0) {
      const sentinelPath = await sentinel.prepare(
        { storeDir: sentinelStoreDir, cwd, runUuid: runtimeRunId },
        reportSentinelError
      );
      if (sentinelPath !== null) {
        // Once this path is published, the launcher promises to honour it on
        // every signal it can handle. Arm before the synchronous stderr write
        // so no announced-path startup window remains.
        interrupt = watchWorkflowInterrupts();
        void interrupt.promise.catch(() => undefined);
        stderr.write(`[sentinel] will write ${sentinelPath} when the run ends\n`);
      }
    }
    if (runRecordDir !== null && runRecordDir.length > 0) {
      runRecordWriter = await RunRecordWriter.start({
        storeDir: runRecordDir,
        cwd,
        runUuid: runtimeRunId,
        workflowPath: prepared.workflowPath,
        workflowSource: prepared.source,
        args: prepared.recordArgs,
        cliFlags: cliFlags(invocation),
        ...(callerIdentity !== undefined ? { callerIdentity } : {}),
        concurrency: recordConcurrency(ambientSettings, progress),
        effectiveSettings: recordEffectiveSettings(invocation, options.timeoutMs)
      });
      (runtime as { setRunRecorder?: (recorder: RunRecordWriter | null) => void }).setRunRecorder?.(runRecordWriter);
      announceRunRecord(runRecordWriter, stderr);
    }

    const statusDir = options.statusDir !== undefined ? options.statusDir : ambientSettings.statusDir.value;
    if (progress !== undefined && statusDir !== null && statusDir.length > 0) {
      statusWriter = new StatusFileWriter({
        progress,
        dir: statusDir,
        onError: (error) => {
          stderr.write(`[status] failed to write progress snapshot: ${formatError(error)}\n`);
        }
      });
    }

    runtime.onEvent((event) => {
      if (event.method === "claude/unpinnedModel") {
        const agentId = typeof event.params.agentId === "number" ? event.params.agentId : "?";
        const label = typeof event.params.label === "string" ? ` (${event.params.label})` : "";
        stderr.write(`[claude] agent ${agentId}${label} runs unpinned — no model pinned; the ambient default applies\n`);
        return;
      }
      if (event.method === "claude/unpinnedModelResolved") {
        const agentId = typeof event.params.agentId === "number" ? event.params.agentId : "?";
        const label = typeof event.params.label === "string" ? ` (${event.params.label})` : "";
        const model = typeof event.params.model === "string" ? event.params.model : "unknown";
        stderr.write(`[claude] agent ${agentId}${label} runs unpinned — resolved ambient default: ${model}\n`);
        return;
      }
      if (event.method === "codex/unpinnedModelResolved") {
        const agentId = typeof event.params.agentId === "number" ? event.params.agentId : "?";
        const label = typeof event.params.label === "string" ? ` (${event.params.label})` : "";
        const model = typeof event.params.model === "string" ? event.params.model : "unknown";
        const effort = typeof event.params.effort === "string" ? ` (${event.params.effort} effort)` : "";
        stderr.write(`[codex] agent ${agentId}${label} runs unpinned — resolved ambient default: ${model}${effort}\n`);
        return;
      }
      if (event.method === "runRecord/writeFailed") {
        const message = typeof event.params.message === "string" ? event.params.message : "unknown error";
        stderr.write(`[run-record] failed to archive an agent record: ${message}\n`);
        return;
      }
      if (event.method === "worktree/finalisationFailed") {
        const worktreePath = typeof event.params.path === "string" ? event.params.path : "<unknown>";
        const branch = typeof event.params.branch === "string" ? event.params.branch : "<unknown>";
        const message = typeof event.params.message === "string" ? event.params.message : "unknown error";
        stderr.write(`[worktree] finalisation failed for ${worktreePath} (${branch}): ${message}\n`);
        return;
      }
      if (event.method !== "worktree/finished") {
        return;
      }
      const worktreePath = typeof event.params.path === "string" ? event.params.path : "<unknown>";
      const branch = typeof event.params.branch === "string" ? event.params.branch : "<unknown>";
      if (invocation.kind === "agent" && invocation.agentOptions.isolation === "worktree") {
        const outcome = event.params.changed === true ? "changed" : "unchanged and removed";
        stderr.write(`[worktree] ${outcome} ${worktreePath} (${branch})\n`);
        return;
      }
      if (event.params.changed !== true) {
        return;
      }
      stderr.write(`[worktree] changed ${worktreePath} (${branch})\n`);
    });
    const runnerOptions = {
      source: prepared.source,
      filename: prepared.workflowPath,
      cwd,
      runtime,
      args: prepared.runnerArgs,
      env,
      log: (message: string) => {
        stderr.write(`${message}\n`);
      },
      onMeta: async (meta: unknown) => {
        progress?.setWorkflow(workflowName(meta));
        await runRecordWriter?.noteMeta(meta);
      },
      onWorkflowInvocation: async (invocation: { scriptPath: string; source: string; args: unknown }) => {
        try {
          // Nesting is one level, so every recorded child's parent is the
          // root (ordinal 0). Deeper nesting would thread the ordinal back
          // through the runner; today there is nothing to thread.
          await runRecordWriter?.recordWorkflowInvocation({ ...invocation, parentOrdinal: 0 });
        } catch (error) {
          // Recording is observability: a failed provenance write must not
          // fail the composition it describes. Same contract as agent
          // records (`runRecord/writeFailed`).
          stderr.write(`[run-record] failed to archive a workflow invocation: ${formatError(error)}\n`);
        }
      }
    };
    interrupt ??= watchWorkflowInterrupts();
    void interrupt.promise.catch(() => undefined);
    try {
      const { result } = await Promise.race([
        runWorkflowScript(timeoutMs === undefined ? runnerOptions : { ...runnerOptions, timeoutMs }),
        interrupt.promise
      ]);
      // Under identity the resolution is an envelope, so the collapse
      // signal is the envelope's output — an exhausted identified worker
      // must still fail the run, not print `{output: null}` at exit 0.
      const directAgentOutput =
        invocation.kind === "agent" && invocation.agentOptions.identity === true && result !== null
          ? (result as { output: unknown }).output
          : result;
      if (invocation.kind === "agent" && directAgentOutput === null && !completedDirectAgentWithNull(runtime)) {
        throw new SingleAgentFailedError();
      }

      const serialised = serialiseResult(result);
      stdout.write(`${serialised}\n`);
      finalRecord = { status: "complete", exitCode: 0, result: JSON.parse(serialised) };
      exitCode = 0;
    } finally {
      interrupt.dispose();
    }
  } catch (error) {
    // A failed workflow would otherwise discard every completed worker's
    // output — whether it was stopped, timed out, or threw (a transport hiccup
    // an hour in counts). Emit a best-effort partial envelope to stdout so the
    // driver can recover the finished work; the error still goes to stderr and
    // the exit code stays non-zero, so callers that gate on it are unaffected.
    const status =
      error instanceof WorkflowTimeoutError ? "timed-out" : error instanceof WorkflowInterruptedError ? "interrupted" : "failed";
    const partial = partialResult(runtime, status);
    const serialised = serialiseResult(partial);
    stdout.write(`${serialised}\n`);
    finalRecord = { status, exitCode: 1, result: JSON.parse(serialised) };
    terminalError = describeError(error);
    // Operational failures present a cause-first operator diagnosis;
    // author errors keep their clean line, and only a genuinely unknown
    // error falls through to its stack — internals as evidence, never as
    // the default surface.
    const diagnosis = presentTerminalError(error, {
      archiveDir: runRecordWriter?.archiveDir ?? null,
      lastAgentRecord:
        (runtime as { lastAgentRecord?: () => RuntimeAgentRecord | null } | null)?.lastAgentRecord?.() ?? null
    });
    stderr.write(`${diagnosis ?? formatError(error)}\n`);
    exitCode = 1;
  } finally {
    // A teardown failure is the run's own failure to end cleanly: workers
    // may still be alive, the archive may be unsealed. It surfaces here —
    // on stderr, in the sentinel, and in the exit code — instead of
    // escaping past a `complete` sentinel that has already promised a clean
    // end. Surfacing only: nothing is retried.
    let teardownError: { kind: string; message: string } | null = null;
    try {
      try {
        interrupt?.dispose();
        // Tear workers down while the archive is still open so their terminal
        // status can replace the dispatch-time snapshot before the run is sealed.
        progress?.finish();
        if (statusWriter !== null) {
          await statusWriter.close();
        }
        if (runtime !== null) {
          const terminalStatus = finalRecord?.status;
          // A run whose body returned cleanly did not fail, so the workers it
          // tears down here were interrupted by the run ending — not failed
          // with a `run-failed` cause. The word is chosen here, the one site
          // that already knows the body's outcome; `abandoned` stays the
          // reaper's alone.
          await runtime.close(
            terminalStatus === "complete" ? "interrupted" : terminalStatus === undefined ? "failed" : terminalStatus
          );
        }
      } catch (error) {
        teardownError = describeError(error);
        // Through the shared seam first: a teardown-time engine or
        // app-server death must not be attributed to the author's own
        // calls with a stack into the bundle.
        stderr.write(`[teardown] the run failed to end cleanly: ${presentOperationalError(error) ?? formatError(error)}\n`);
      }
      // The seal runs even when worker teardown failed: close() rejects by
      // design when a cancellation cause must surface, and skipping the seal
      // for it would strand the archive in-progress — unattestable by the
      // sentinel and left for the reaper to misread as an abandoned run.
      try {
        if (runRecordWriter !== null) {
          // A teardown failure degrades the sealed status the same way it
          // degrades the sentinel below: the archive must not read
          // `complete` under a sentinel saying the run failed to end.
          await runRecordWriter.finish({
            ...(finalRecord ?? { status: "failed" as const, exitCode: 1, result: null }),
            ...(teardownError !== null ? { status: "failed" as const, exitCode: 1 } : {}),
            error: terminalError ?? teardownError
          });
        }
      } catch (error) {
        teardownError ??= describeError(error);
        stderr.write(`[teardown] the archive failed to seal: ${presentOperationalError(error) ?? formatError(error)}\n`);
      }
    } finally {
      // Last, so a supervisor woken by the sentinel finds the archive already
      // sealed — and in its own finally, so a teardown or archive-seal error
      // cannot skip the wake signal. Every terminal transition this launcher
      // can handle passes through here — success, failure, timeout,
      // interruption, salvage — and a missing finalRecord is itself a
      // failure outcome.
      const settled = finalRecord ?? { status: "failed" as const, exitCode: 1 };
      // A teardown failure degrades whatever the body earned: the outcome
      // the sentinel publishes and the code the process exits with both say
      // the run did not end cleanly. The reason rides the existing `error`
      // field, so the payload grows by nothing.
      const terminal = teardownError === null ? settled : { status: "failed" as const, exitCode: 1 };
      exitCode = terminal.exitCode;
      await sentinel.writeTerminal(terminal.status, terminal.exitCode, reportSentinelError, {
        workers: workerOutcomes(progress, runtime),
        error: terminalError ?? teardownError,
        // The sealed manifest's own digest, attested from outside the file
        // it covers. Absent recording, or a seal that never landed, says so
        // rather than omitting the field.
        manifest: manifestAttestation(runRecordWriter)
      });
    }
  }
  return exitCode;
}

/**
 * A failed run's recovered work, marked so a driver can tell it apart from a clean
 * return. The `partial: true` flag plus the non-zero exit code distinguish it
 * from a normal result (which is the script's raw return value); `reason` says
 * how the run ended.
 */
interface PartialResult {
  partial: true;
  reason: "interrupted" | "timed-out" | "failed";
  completed: readonly CompletedAgentOutput[];
}

function partialResult(runtime: EnsembleRuntime | null, reason: PartialResult["reason"]): PartialResult {
  // Injected test runtimes may not carry the collector; read it defensively,
  // mirroring how `progress` is read above.
  const completed =
    (runtime as { completedOutputs?: () => readonly CompletedAgentOutput[] } | null)?.completedOutputs?.() ?? [];
  return { partial: true, reason, completed };
}

/**
 * The run's worker tally as the launcher observed it, or null when there was
 * nothing to count (an injected test runtime with no progress model). It is
 * a partition of the run's legs: settled on their own account (`done`,
 * `failed`), cut short by the run ending with a record naming the run's
 * shutdown status (`cutShort`), or abandoned with no outcome ever observed
 * (`unsettled`).
 */
function workerOutcomes(progress: RunProgress | undefined, runtime: EnsembleRuntime | null): SentinelWorkerOutcomes | null {
  // The runtime's shutdown tally is the determinate figure: it was taken at
  // the instant the run ended, before teardown settled some in-flight legs
  // and not others. Reading the live progress model here would report
  // whichever stragglers happened to land first.
  const tally = (runtime as { shutdownTally?: () => ShutdownTally | null } | null)?.shutdownTally?.() ?? null;
  if (tally !== null) {
    return { done: tally.done, failed: tally.failed, cutShort: tally.cutShort, unsettled: tally.unsettled };
  }
  // An injected test runtime that never closed, or one with no progress
  // model at all, falls back to whatever the launcher itself can count.
  if (progress === undefined) {
    return null;
  }
  // An injected runtime that publishes no tally never told the launcher how
  // it disposed of its legs, so the launcher cannot claim any of them were
  // cut short with a record: what it observed is workers whose outcome it
  // never saw, which is exactly `unsettled`.
  const totals = progress.snapshot().totals;
  return { done: totals.done, failed: totals.failed, cutShort: 0, unsettled: totals.active + totals.queued };
}

function completedDirectAgentWithNull(runtime: EnsembleRuntime): boolean {
  const completed =
    (runtime as { completedOutputs?: () => readonly CompletedAgentOutput[] }).completedOutputs?.() ?? [];
  return completed.some((agent) => agent.output === null);
}

function workflowName(meta: unknown): string | null {
  if (typeof meta === "object" && meta !== null && "name" in meta) {
    const name = (meta as { name?: unknown }).name;
    return typeof name === "string" ? name : null;
  }
  return null;
}

interface InvocationTuning {
  budgetCeilings?: EngineBudgetCeilings;
  agentCeiling?: number | null;
  concurrencyCaps?: EngineConcurrencyCaps;
  timeoutMs?: number;
  /** Run-wide capability strip, united with each call's own list. */
  strip?: StrippableCapability[];
  /** Optional opaque identity of the process or session that invoked this run. */
  callerIdentity?: string;
  /** The scope this run's holds publish under; outranks the inherited env variable. */
  holdScope?: string;
}

interface ParsedWorkflowInvocation extends InvocationTuning {
  kind: "workflow";
  scriptArg: string | undefined;
  args: unknown;
  /** Whether args came through --json-args, independent of the parsed value's shape. */
  jsonArgsProvided: boolean;
}

interface ParsedAgentInvocation extends InvocationTuning {
  kind: "agent";
  prompt: string;
  agentOptions: AgentOptions;
  task?: string;
}

type ParsedInvocation = ParsedWorkflowInvocation | ParsedAgentInvocation;

interface PreparedRun {
  workflowPath: string;
  source: string;
  runnerArgs: unknown;
  recordArgs: unknown;
}

async function prepareRun(invocation: ParsedInvocation, cwd: string): Promise<PreparedRun> {
  if (invocation.kind === "agent") {
    return {
      workflowPath: path.join(cwd, "<ensemble-agent>"),
      source: singleAgentWorkflowSource(invocation),
      runnerArgs: [],
      recordArgs: {
        prompt: invocation.prompt,
        options: invocation.agentOptions
      }
    };
  }

  if (invocation.scriptArg === undefined) {
    throw new Error("workflow invocation has no script path");
  }
  const workflowPath = path.resolve(cwd, invocation.scriptArg);
  return {
    workflowPath,
    source: await readWorkflowScript(workflowPath),
    runnerArgs: invocation.args,
    recordArgs: invocation.args
  };
}

function singleAgentWorkflowSource(invocation: ParsedAgentInvocation): string {
  const meta = {
    name: "ensemble-agent",
    description: "Single worker invoked from the Ensemble CLI",
    ...(invocation.task !== undefined ? { task: invocation.task } : {})
  };
  return [
    `export const meta = ${JSON.stringify(meta)};`,
    `return await agent(${JSON.stringify(invocation.prompt)}, ${JSON.stringify(invocation.agentOptions)});`,
    ""
  ].join("\n");
}

function cliFlags(invocation: ParsedInvocation): {
  budget?: Record<string, number | null>;
  agentCeiling?: number | null;
  concurrency?: Record<string, number>;
  timeoutMs?: number;
  strip?: string[];
  jsonArgs: boolean;
} {
  return {
    ...(invocation.budgetCeilings !== undefined ? { budget: invocation.budgetCeilings } : {}),
    ...(invocation.agentCeiling !== undefined ? { agentCeiling: invocation.agentCeiling } : {}),
    ...(invocation.concurrencyCaps !== undefined ? { concurrency: invocation.concurrencyCaps } : {}),
    ...(invocation.timeoutMs !== undefined ? { timeoutMs: invocation.timeoutMs } : {}),
    ...(invocation.strip !== undefined ? { strip: invocation.strip } : {}),
    jsonArgs: invocation.kind === "workflow" && invocation.jsonArgsProvided
  };
}

function runtimeConcurrencyOptions(settings: AmbientSettings): {
  agentCeiling?: number | null;
  concurrencyCaps?: EngineConcurrencyCaps;
} {
  const concurrencyCaps: EngineConcurrencyCaps = {};
  for (const engine of ["codex", "claude", "opencode"] as const) {
    const resolved = settings.concurrencyCaps[engine];
    if (resolved.layer !== "default") {
      concurrencyCaps[engine] = resolved.value;
    }
  }
  return {
    ...(settings.agentCeiling.layer !== "default" ? { agentCeiling: settings.agentCeiling.value } : {}),
    ...(Object.keys(concurrencyCaps).length > 0 ? { concurrencyCaps } : {})
  };
}

function recordConcurrency(
  settings: AmbientSettings,
  progress: RunProgress | undefined
): {
  agentCeiling: AmbientSettings["agentCeiling"];
  engines: Partial<AmbientSettings["concurrencyCaps"]>;
} {
  const snapshot = progress?.snapshot();
  if (snapshot === undefined) {
    return { agentCeiling: settings.agentCeiling, engines: settings.concurrencyCaps };
  }
  const engines: Partial<AmbientSettings["concurrencyCaps"]> = {};
  for (const engine of ["codex", "claude", "opencode"] as const) {
    const cap = snapshot.engines[engine]?.cap;
    if (cap !== null && cap !== undefined) {
      engines[engine] = { value: cap, layer: settings.concurrencyCaps[engine].layer };
    }
  }
  return { agentCeiling: settings.agentCeiling, engines };
}

/**
 * Effective budget ceilings and whole-run timeout with their winning
 * layers, the shape `recordConcurrency` established. Both settings resolve
 * from the flag alone today, so absence is honestly `default` — never an
 * inferred env or config attribution. A programmatically injected timeout
 * (a library caller's `timeoutMs`) records under `default` too: it is the
 * baseline this run started from, not a layer the operator chose.
 */
function recordEffectiveSettings(
  invocation: ParsedInvocation,
  injectedTimeoutMs: number | undefined
): EffectiveRunSettingsRecord {
  const budgetCeilings: EffectiveRunSettingsRecord["budgetCeilings"] = {};
  for (const engine of ["codex", "claude", "opencode"] as const) {
    const flagged = invocation.budgetCeilings?.[engine];
    budgetCeilings[engine] =
      flagged !== undefined ? { value: flagged, layer: "flag" } : { value: null, layer: "default" };
  }
  const timeoutMs = invocation.timeoutMs ?? injectedTimeoutMs ?? null;
  return {
    budgetCeilings,
    runTimeoutMs: { value: timeoutMs, layer: invocation.timeoutMs !== undefined ? "flag" : "default" }
  };
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

class WorkflowInterruptedError extends Error {
  constructor(readonly signal: InterruptSignal) {
    super(`Workflow interrupted by ${signal}`);
    this.name = new.target.name;
  }
}

function watchWorkflowInterrupts(): { promise: Promise<never>; dispose: () => void } {
  const signals: readonly InterruptSignal[] = ["SIGINT", "SIGTERM"];
  const handlers = new Map<InterruptSignal, () => void>();

  const promise = new Promise<never>((_resolve, reject) => {
    for (const signal of signals) {
      const handler = () => {
        for (const [registeredSignal, registeredHandler] of handlers) {
          process.off(registeredSignal, registeredHandler);
        }
        handlers.clear();
        reject(new WorkflowInterruptedError(signal));
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
  });

  return {
    promise,
    dispose: () => {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
      handlers.clear();
    }
  };
}

class SingleAgentFailedError extends Error {
  constructor() {
    super("Agent exhausted its attempts without producing a result");
    this.name = new.target.name;
  }
}

async function parseInvocation(argv: string[], cwd: string, stdin: Readable): Promise<ParsedInvocation> {
  if (argv[0] === "agent") {
    return parseAgentInvocation(argv.slice(1), cwd, stdin);
  }
  return parseWorkflowInvocation(argv, cwd);
}

async function parseWorkflowInvocation(argv: string[], cwd: string): Promise<ParsedWorkflowInvocation> {
  const split = splitTuningFlags(argv);
  rejectDuplicateScalarFlags(split.tuningArgs);
  let parsed;
  try {
    parsed = parseArgs({
      args: split.tuningArgs,
      options: {
        "json-args": { type: "string" },
        budget: { type: "string", multiple: true },
        "agent-ceiling": { type: "string" },
        concurrency: { type: "string", multiple: true },
        timeout: { type: "string" },
        strip: { type: "string", multiple: true },
        "caller-identity": { type: "string" },
        "hold-scope": { type: "string" }
      },
      strict: true,
      allowPositionals: false
    });
  } catch (error) {
    // Same rendering contract as the agent path: a parseArgs rejection is
    // an author-facing usage error — one clean line, never a stack.
    const message = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(message);
  }

  const jsonArgs = parsed.values["json-args"];
  const positionalArgs = split.scriptArg === undefined ? [] : split.scriptArgs;
  const args = jsonArgs === undefined ? positionalArgs : await parseJsonArgs(jsonArgs, cwd);
  const budgetCeilings = parseEngineMap(parsed.values.budget, parseBudgetCeiling, "--budget");
  const agentCeiling = parseAgentCeiling(parsed.values["agent-ceiling"]);
  const concurrencyCaps = parseEngineMap(parsed.values.concurrency, parseConcurrencyCap, "--concurrency");
  const timeoutMs = parseTimeoutMs(parsed.values.timeout);
  const strip = parseStripList(parsed.values.strip);
  const callerIdentity = parseCallerIdentity(parsed.values["caller-identity"]);
  const holdScope = parseHoldScope(parsed.values["hold-scope"]);

  return {
    kind: "workflow",
    scriptArg: split.scriptArg,
    args,
    jsonArgsProvided: jsonArgs !== undefined,
    ...(budgetCeilings !== undefined ? { budgetCeilings } : {}),
    ...(agentCeiling !== undefined ? { agentCeiling } : {}),
    ...(concurrencyCaps !== undefined ? { concurrencyCaps } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(strip !== undefined ? { strip } : {}),
    ...(callerIdentity !== undefined ? { callerIdentity } : {}),
    ...(holdScope !== undefined ? { holdScope } : {})
  };
}

async function parseAgentInvocation(argv: string[], cwd: string, stdin: Readable): Promise<ParsedAgentInvocation> {
  rejectMisplacedAgentTuningFlags(argv);
  rejectDuplicateScalarFlags(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: AGENT_INVOCATION_OPTIONS,
      strict: true,
      allowPositionals: true
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(message);
  }

  if (parsed.positionals.length > 1) {
    throw new CliUsageError("ensemble agent accepts exactly one prompt argument, or reads the prompt from stdin");
  }
  const prompt = parsed.positionals[0] ?? (await readPrompt(stdin));
  if (prompt.trim().length === 0) {
    throw new CliUsageError("ensemble agent requires a prompt argument or a non-empty prompt on stdin");
  }

  const rawEngine = parsed.values.engine;
  if (rawEngine === undefined) {
    throw new CliUsageError("ensemble agent requires --engine");
  }
  const engine = parseEngineName(rawEngine, "--engine");
  const isolation = parseIsolation(parsed.values.isolation);
  const schema =
    parsed.values.schema === undefined
      ? undefined
      : ((await parseJsonValue(parsed.values.schema, cwd, "--schema")) as JsonSchema);
  const budgetCeilings = parseEngineMap(parsed.values.budget, parseBudgetCeiling, "--budget");
  const agentCeiling = parseAgentCeiling(parsed.values["agent-ceiling"]);
  const concurrencyCaps = parseEngineMap(parsed.values.concurrency, parseConcurrencyCap, "--concurrency");
  const timeoutMs = parseTimeoutMs(parsed.values.timeout);
  const maxAttempts = parseMaxAttempts(parsed.values["max-attempts"]);
  const strip = parseStripList(parsed.values.strip);
  const callerIdentity = parseCallerIdentity(parsed.values["caller-identity"]);
  const holdScope = parseHoldScope(parsed.values["hold-scope"]);
  const agentOptions: AgentOptions = {
    engine,
    ...(parsed.values.model !== undefined ? { model: parsed.values.model } : {}),
    ...(parsed.values.effort !== undefined ? { effort: parsed.values.effort } : {}),
    ...(parsed.values.label !== undefined ? { label: parsed.values.label } : {}),
    ...(parsed.values.phase !== undefined ? { phase: parsed.values.phase } : {}),
    ...(parsed.values.cwd !== undefined ? { cwd: parsed.values.cwd } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
    ...(parsed.values.identity === true ? { identity: true } : {}),
    ...(schema !== undefined ? { schema } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(strip !== undefined ? { strip } : {})
  };

  return {
    kind: "agent",
    prompt,
    agentOptions,
    ...(parsed.values.task !== undefined ? { task: parsed.values.task } : {}),
    ...(budgetCeilings !== undefined ? { budgetCeilings } : {}),
    ...(agentCeiling !== undefined ? { agentCeiling } : {}),
    ...(concurrencyCaps !== undefined ? { concurrencyCaps } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(callerIdentity !== undefined ? { callerIdentity } : {}),
    ...(holdScope !== undefined ? { holdScope } : {})
  };
}

async function readPrompt(stdin: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseIsolation(value: string | undefined): "worktree" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== "worktree") {
    throw new CliUsageError(`--isolation must be worktree; got ${value}`);
  }
  return value;
}

function parseStripList(values: string[] | undefined): StrippableCapability[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  for (const value of values) {
    if (!(STRIPPABLE_CAPABILITIES as readonly string[]).includes(value)) {
      throw new CliUsageError(
        `--strip must name a capability from: ${STRIPPABLE_CAPABILITIES.join(", ")}; got ${value}`
      );
    }
  }
  return [...new Set(values)] as StrippableCapability[];
}

function splitTuningFlags(argv: string[]): { tuningArgs: string[]; scriptArg: string | undefined; scriptArgs: string[] } {
  const tuningArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) {
      continue;
    }

    if (value === "--") {
      return {
        tuningArgs,
        scriptArg: argv[index + 1],
        scriptArgs: argv.slice(index + 2)
      };
    }

    if (value === "agent" && tuningArgs.length > 0) {
      throw new CliUsageError("Tuning flags must appear after ensemble agent, not before it");
    }

    if (isKnownInlineOption(value)) {
      tuningArgs.push(value);
      continue;
    }

    if (isKnownOption(value)) {
      const optionValue = argv[index + 1];
      if (optionValue === undefined) {
        throw new CliUsageError(`Option ${value} expects a value`);
      }
      tuningArgs.push(value, optionValue);
      index += 1;
      continue;
    }

    if (value.startsWith("-")) {
      throw new CliUsageError(`Unknown option before script path: ${value}`);
    }

    const scriptArgs = argv.slice(index + 1);
    const misplacedTuningFlag = scriptArgs.find((argument) => isKnownOption(argument) || isKnownInlineOption(argument));
    if (misplacedTuningFlag !== undefined) {
      throw new CliUsageError(
        `Tuning flag ${misplacedTuningFlag} appears after the script path; put tuning flags before the script, or put \`--\` before the script path to pass it through`
      );
    }

    return { tuningArgs, scriptArg: value, scriptArgs };
  }

  return { tuningArgs, scriptArg: undefined, scriptArgs: [] };
}

function rejectMisplacedAgentTuningFlags(argv: string[]): void {
  let promptSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) {
      continue;
    }
    if (value === "--") {
      return;
    }
    if (promptSeen && (isKnownOption(value) || isKnownInlineOption(value))) {
      throw new CliUsageError(`Tuning flag ${value} appears after the agent prompt; put tuning flags before the prompt`);
    }
    if (promptSeen && (isKnownAgentOption(value) || isKnownInlineAgentOption(value))) {
      // Same misplacement contract as the workflow form's post-script scan:
      // a flag after the prompt is a placement mistake to name, never an
      // option to quietly apply or a second positional to misroute.
      throw new CliUsageError(
        `Flag ${value} appears after the agent prompt; put flags before the prompt, or put \`--\` before a dash-leading prompt`
      );
    }
    // Whether a flag consumes the next token is the option map's `type`,
    // not a hand-kept flag list: a boolean flag declared in
    // AGENT_INVOCATION_OPTIONS takes no value, so the token after it may
    // be the prompt.
    if (isKnownInlineOption(value) || isBooleanAgentFlag(value)) {
      continue;
    }
    if (isKnownAgentOption(value) || isKnownOption(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith("-")) {
      promptSeen = true;
    }
  }
}

function rejectDuplicateScalarFlags(argv: string[]): void {
  const repeated = new Set<string>();
  for (const value of argv) {
    if (value === "--") {
      // Everything past the terminator is positional — a dash-leading
      // prompt repeating a pre-terminator flag's spelling is not a
      // duplicate option.
      return;
    }
    const flag = optionName(value);
    if (flag === undefined || isRepeatableOption(flag)) {
      continue;
    }
    if (repeated.has(flag)) {
      throw new CliUsageError(`Option ${flag} may only be specified once`);
    }
    repeated.add(flag);
  }
}

function optionName(value: string): string | undefined {
  if (!value.startsWith("--") || value === "--") {
    return undefined;
  }
  const equalsIndex = value.indexOf("=");
  return equalsIndex === -1 ? value : value.slice(0, equalsIndex);
}

function isRepeatableOption(flag: string): boolean {
  return flag === "--budget" || flag === "--concurrency" || flag === "--strip";
}

function isKnownAgentOption(value: string): boolean {
  return value.startsWith("--") && Object.hasOwn(AGENT_INVOCATION_OPTIONS, value.slice(2));
}

/** The `--flag=value` spelling of a declared agent option. */
function isKnownInlineAgentOption(value: string): boolean {
  if (!value.startsWith("--") || !value.includes("=")) {
    return false;
  }
  return Object.hasOwn(AGENT_INVOCATION_OPTIONS, value.slice(2, value.indexOf("=")));
}

/** A declared agent flag that consumes no value token, read off the option map's own `type`. */
function isBooleanAgentFlag(value: string): boolean {
  if (!isKnownAgentOption(value)) {
    return false;
  }
  const name = value.slice(2) as keyof typeof AGENT_INVOCATION_OPTIONS;
  return AGENT_INVOCATION_OPTIONS[name].type === "boolean";
}

function isKnownOption(value: string): boolean {
  return (
    value === "--json-args" ||
    value === "--budget" ||
    value === "--agent-ceiling" ||
    value === "--concurrency" ||
    value === "--timeout" ||
    value === "--strip" ||
    value === "--caller-identity" ||
    value === "--hold-scope"
  );
}

function isKnownInlineOption(value: string): boolean {
  return (
    value.startsWith("--json-args=") ||
    value.startsWith("--budget=") ||
    value.startsWith("--agent-ceiling=") ||
    value.startsWith("--concurrency=") ||
    value.startsWith("--timeout=") ||
    value.startsWith("--strip=") ||
    value.startsWith("--caller-identity=") ||
    value.startsWith("--hold-scope=")
  );
}

async function parseJsonArgs(value: string, cwd: string): Promise<unknown> {
  return parseJsonValue(value, cwd, "--json-args");
}

async function parseJsonValue(value: string, cwd: string, flagName: "--json-args" | "--schema"): Promise<unknown> {
  let source = value;
  let sourceDescription = "the argument";
  if (value.startsWith("@")) {
    const filename = value.slice(1);
    if (filename.length === 0) {
      throw new CliUsageError(`${flagName} @file requires a file path`);
    }
    const filePath = path.resolve(cwd, filename);
    sourceDescription = filePath;
    try {
      source = await readFile(filePath, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliUsageError(`${flagName} could not read ${filePath}: ${message}`);
    }
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnosticPrefix = flagName === "--json-args" ? `${flagName}: ` : `${flagName} `;
    throw new CliUsageError(`${diagnosticPrefix}${sourceDescription} must contain valid JSON: ${message}`);
  }
}

function parseEngineMap<T>(
  values: string[] | undefined,
  parseValue: (raw: string) => T,
  flagName: "--budget" | "--concurrency"
): Partial<Record<EngineName, T>> | undefined {
  if (values === undefined || values.length === 0) {
    return undefined;
  }

  const result: Partial<Record<EngineName, T>> = {};
  for (const entry of values) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
      throw new CliUsageError(`${flagName} expects engine=value`);
    }
    const engine = parseEngineName(entry.slice(0, separatorIndex), flagName);
    if (result[engine] !== undefined) {
      throw new CliUsageError(`${flagName} repeats ${engine}`);
    }
    result[engine] = parseValue(entry.slice(separatorIndex + 1));
  }

  return result;
}

function parseEngineName(value: string, flagName: string): EngineName {
  if (value === "codex" || value === "claude" || value === "opencode") {
    return value;
  }
  if (flagName === "--engine") {
    throw new CliUsageError(`${flagName} must be codex, claude, or opencode; got ${value}`);
  }
  throw new CliUsageError(`${flagName} engine must be codex, claude, or opencode; got ${value}`);
}

function parseBudgetCeiling(value: string): number {
  const ceiling = Number(value);
  if (!Number.isInteger(ceiling) || ceiling < 0) {
    throw new CliUsageError(`--budget value must be a non-negative integer; got ${value}`);
  }
  return ceiling;
}

function parseConcurrencyCap(value: string): number {
  const cap = Number(value);
  if (!Number.isInteger(cap) || cap < 1) {
    throw new CliUsageError(`--concurrency value must be a positive integer; got ${value}`);
  }
  return cap;
}

function parseAgentCeiling(value: string | undefined): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim() === "null") {
    return null;
  }
  const ceiling = Number(value);
  if (!Number.isInteger(ceiling) || ceiling < 1) {
    throw new CliUsageError(`--agent-ceiling value must be a positive integer or null; got ${value}`);
  }
  return ceiling;
}

// Whole-workflow timeout in milliseconds (the `runWorkflowScript` ceiling),
// distinct from the per-turn `agent()` timeoutMs set inside a script.
function parseTimeoutMs(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new CliUsageError(`--timeout value must be a positive integer of milliseconds; got ${value}`);
  }
  // Same 32-bit timer bound the per-agent timeoutMs enforces: above it the
  // platform coerces the delay (~1ms) or throws from Node internals — a limit
  // the author set but did not get, which is the fail-loud invariant's case.
  if (timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new CliUsageError(`--timeout value must be at most ${MAX_TIMER_DELAY_MS} milliseconds; got ${value}`);
  }
  return timeoutMs;
}

function parseMaxAttempts(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const maxAttempts = Number(value);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new CliUsageError(`--max-attempts value must be a positive integer; got ${value}`);
  }
  return maxAttempts;
}

function parseCallerIdentity(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim().length === 0) {
    throw new CliUsageError("--caller-identity must be a non-empty string");
  }
  return value;
}

function parseHoldScope(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim().length === 0) {
    throw new CliUsageError("--hold-scope must be a non-empty string");
  }
  return value;
}

function resolveCallerIdentity(flag: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (flag !== undefined) {
    return flag;
  }
  const inherited = env[CALLER_IDENTITY_ENV];
  return inherited !== undefined && inherited.trim().length > 0 ? inherited : undefined;
}

/**
 * What the sentinel can say about the run manifest: its self-digest where
 * the archive sealed, and otherwise the reason there is none. The digest
 * is gated on sealing — a writer whose `finish()` never completed (or
 * threw) may hold a real mid-run digest, but the seal would rewrite the
 * manifest, so attesting it would vouch for bytes the archive no longer
 * claims are final. `manifest-unsealed` therefore means exactly that: the
 * manifest beside this sentinel, whatever its own self-digest says, is
 * not one this run sealed.
 */
function manifestAttestation(writer: RunRecordWriter | null): SentinelManifestAttestation {
  if (writer === null) {
    return { unavailable: "recording-disabled" };
  }
  const digest = writer.sealedManifestDigest();
  return digest === null ? { unavailable: "manifest-unsealed" } : { sha256: digest };
}

function announceRunRecord(writer: RunRecordWriter, stderr: Writable): void {
  try {
    stderr.write(`[run-record-archive] ${JSON.stringify({ run_id: writer.manifest.run_id, archive_path: writer.archiveDir })}\n`);
  } catch {
    // The archive already exists. A broken supervision stream must not turn a
    // durable-record success into a failed run.
  }
}

function usage(): string {
  return [
    "Usage: ensemble [--json-args '<json>|@file'] [--budget engine=N] [--agent-ceiling N|null] [--concurrency engine=N] [--timeout ms] [--strip capability] [--caller-identity <identity>] [--hold-scope <scope>] <script.js> [args...]",
    "       ensemble agent --engine <engine> [--model <model>] [--effort <effort>]",
    "                      [--label <label>] [--phase <phase>] [--cwd <path>]",
    "                      [--isolation worktree] [--identity] [--schema '<json>|@file'] [--max-attempts N] [--strip capability] [--task <identity>] [--caller-identity <identity>] [--hold-scope <scope>]",
    "                      [--budget engine=N] [--agent-ceiling N|null] [--concurrency engine=N] [--timeout ms] [prompt]",
    "       ensemble workflows",
    "       ensemble holds [--json] [--scope <scope> | --all]",
    ""
  ].join("\n");
}

function serialiseResult(result: unknown): string {
  // A non-JSON return value fails the run at settlement (script-runner's
  // assertJsonSerialisable), so by the time a value reaches this point it
  // serialises cleanly. The guards remain for the values the check does not
  // gate: a bare `undefined` return (no top-level return statement) prints
  // as null, and the salvage envelope is harness-built JSON.
  try {
    const json = JSON.stringify(result);
    return json === undefined ? "null" : json;
  } catch {
    return "null";
  }
}

function formatError(error: unknown): string {
  if (error instanceof CliUsageError) {
    return error.message;
  }
  // The pre-spawn author-error family — rejected options, unresolvable
  // workflow() references, nesting violations, workflow-authoring errors
  // (WorkflowScriptError is a member) — is the author's to fix: one clean
  // line, no stack. A breached deadline is not an authoring mistake but
  // gets the same operator-facing surface.
  if (error instanceof PreSpawnAuthorError || error instanceof WorkflowTimeoutError || error instanceof HoldTimeoutError) {
    return `${error.name}: ${error.message}`;
  }
  if (isError(error)) {
    const stack: unknown = error.stack;
    return typeof stack === "string" && stack.trim().length > 0 ? stack : String(error);
  }
  return String(error);
}

function isError(error: unknown): error is Error {
  return (Error as ErrorConstructor & { isError(value: unknown): value is Error }).isError(error);
}
