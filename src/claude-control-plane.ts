import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import path from "node:path";

import { withoutRunScopedVariables } from "./ambient-settings.js";
import { ClaudeDispatchError, ClaudeRegistrationTimeoutError } from "./errors.js";
import { HOLD_SCOPE_ENV, resolveHoldScope } from "./holds.js";
import { captureProcessOwner, judgeOwnerGone } from "./process-owner-evidence.js";
import { boundedEvidence } from "./operator-diagnosis.js";
import type { RuntimeEvent } from "./types.js";
import { NoWorkerScopes, RUN_SCOPE_GROUP, processTree, type WorkerScopeGrouping, type ScopePlacement, type WorkerScopes } from "./worker-scopes.js";

/**
 * Per-dispatch ownership tag. The variable rides the same settings-file `env`
 * block that delivers the declared worker environment, so every process the
 * worker spawns — however deeply, and however it is later reparented —
 * inherits it. That inheritance is what gives worker-spawned subprocesses a
 * named owner: `stop()` reaps any surviving process still carrying the
 * dispatch's tag, closing the gap where descendants of a daemon-hosted
 * worker escaped the cancellation plumbing entirely (witnessed as orphaned
 * children burning CPU for ~90 minutes after their worker died).
 */
export const WORKER_MARKER_VARIABLE = "ENSEMBLE_CLAUDE_WORKER";
/** Per-dispatch settings directories live under the temp root as `<prefix><dispatch name>-<random>`. */
const SETTINGS_DIR_PREFIX = "ensemble-claude-env-";
/** Each valve's private tmux socket lives at `<tmux's socket root>/<prefix><random>/tmux.sock`. */
const VALVE_DIR_PREFIX = "ensemble-claude-valve-";
/** The owner evidence written beside `settings.json`, judged by the next launcher's sweep. */
const OWNER_FILENAME = "owner.json";

/**
 * The seam between the Claude engine's orchestration brain and the actual
 * research-preview control plane (`claude --bg`, `claude agents --json`, the
 * on-disk transcript, the tmux reply valve). Everything that shells out lives
 * behind this interface, exactly as the Codex transport hides the app-server —
 * so the engine's dispatch/poll/correct logic is driven by a fake in
 * deterministic tests and by `ClaudeCliControlPlane` in anger.
 */
export interface ClaudeControlPlane {
  /** Spawn a background session and resolve once it is registered in the roster. */
  dispatch(options: ClaudeDispatchOptions): Promise<ClaudeSessionHandle>;
  /** One reading of the session's lifecycle state. */
  poll(handle: ClaudeSessionHandle): Promise<ClaudeSessionStatus>;
  /** Locate the session's JSONL transcript on disk, or null if not yet present. */
  transcriptPath(handle: ClaudeSessionHandle): Promise<string | null>;
  /**
   * Inject a message into the live session (the valve). A refusal names the
   * step that failed and what it said, so the turn's failure record carries
   * the cause rather than the bare fact of non-delivery.
   */
  steer(handle: ClaudeSessionHandle, message: string): Promise<ValveDelivery>;
  /** Tear the session down (stop + remove). Best-effort; never throws. */
  stop(handle: ClaudeSessionHandle): Promise<void>;
  /** Whether the tmux valve is usable; gates in-session correction and blocked recovery. */
  tmuxAvailable(): Promise<boolean>;
}

/** The valve's verdict on one injection: delivered, or refused with the failing step's account. */
export type ValveDelivery = { delivered: true } | { delivered: false; reason: string };

export interface ClaudeDispatchOptions {
  prompt: string;
  /** Unique per dispatch — how the freshly spawned session is found in the roster. */
  name: string;
  cwd: string;
  model?: string;
  effort?: string;
  /**
   * Permission deny rules for the worker session (capability stripping).
   * Delivered through the per-dispatch settings file — the surface
   * measured to reach the daemon-served session — as `permissions.deny`.
   * That deny rules outrank every allow layer and permission mode
   * (`--dangerously-skip-permissions` included) is a stated judgement
   * until a live test observes it at a real worker.
   */
  permissionDenyRules?: string[];
}

/**
 * Declares the workspace sandboxed to every `claude` process this control
 * plane launches. Claude Code (2.1.281 and later) gates background
 * dispatch on the directory's trust — accepted once, interactively, per
 * project directory, inherited by children but never by siblings — so a
 * scratch directory, a sibling checkout, or a generated worktree starts
 * untrusted.
 * With this variable set on the dispatching process the trust check answers
 * *sandboxed* for any resolvable directory and no dialog is owed; its only
 * other effect in the binary — project-declared permission rules no longer
 * gated on a person being present — is moot under the permission bypass
 * every worker already runs with. It is harness bookkeeping, not
 * configuration: it lands after the machine-declared worker environment,
 * like the ownership tag, and is never written to the operator's own Claude
 * configuration. A refusal that survives it is a substrate refusal
 * (`ClaudeDispatchError`), which the runtime treats as pre-spawn.
 */
export const SANDBOXED_WORKSPACE_VARIABLE = "CLAUDE_CODE_SANDBOXED";

export interface ClaudeSessionHandle {
  /** Short daemon id — used to attach/steer/stop. */
  id: string;
  /** Full session UUID — names the transcript file. */
  sessionId: string;
  name: string;
  cwd: string;
}

export type ClaudeSessionState = "working" | "blocked" | "done" | "unknown";

export interface ClaudeSessionStatus {
  /** Raw daemon status string (`busy` / `idle` / …). */
  status: string;
  state: ClaudeSessionState;
  /** Present on a blocked session when the daemon records what it is waiting for. */
  waitingFor?: string;
  /** False once the session has left the roster (exited / removed). */
  present: boolean;
}

export interface ClaudeCliControlPlaneOptions {
  claudeBin?: string;
  tmuxBin?: string;
  /**
   * Machine-declared variables injected for every worker this control plane
   * dispatches. Delivery is per surface,
   * because Claude Code splits the worker across processes with unrelated
   * environments:
   *
   * - **The worker session itself** is served by the per-user daemon, which
   *   an earlier `claude` invocation may have started from an environment
   *   this run never saw — so process inheritance cannot reach it. The one
   *   measured route in (2026-08-07) is a settings file:
   *   `claude --bg --settings <file>` with an `env` block, whose variables
   *   Claude Code merges additively over the project and user settings and
   *   which win collisions — exactly the injected-over-inherited contract.
   *   `dispatch()` writes that file per dispatch and passes the flag.
   * - **Control-plane children** (dispatch, roster queries, stop) get the
   *   spread `#env`, because any of them can auto-start the daemon and the
   *   dispatch command itself may read gateway settings. That daemon
   *   outlives the run and serves every later session on the machine, so
   *   the run's own environment-layer settings (`ENSEMBLE_RUN_RECORD_DIR`,
   *   `ENSEMBLE_STATUS_DIR` and their siblings — `isRunScopedEnvironmentVariable`)
   *   are withheld from these children: a daemon homed on one run's
   *   relocated store would otherwise carry it into the operator's later
   *   sessions. Everything else inherits; a declared value for one of those
   *   names is still injected, since a declaration is the operator's word.
   *   The withholding is this control plane's alone — Codex and opencode
   *   children die with the run and inherit as before — so a nested
   *   `ensemble` run inside a Claude worker resolves those settings from
   *   the machine config and the defaults, except the hold scope, whose
   *   contract is inheritance and which the settings file carries.
   * - **The valve's `claude attach` client** runs in a tmux server of its
   *   own, started for that one valve from the same spread `#env`: a new
   *   server takes its starting client's environment as the one its panes
   *   inherit, whereas a pre-existing server starts pane commands from its
   *   *own* environment. Never as tmux arguments (`new-session -e`): any
   *   local user can read a process's argv, and the declared values are
   *   gateway credentials.
   *
   * The harness's own sandboxed-workspace declaration
   * (`SANDBOXED_WORKSPACE_VARIABLE`) rides the second and third surfaces
   * beside these declarations — every `claude` process the control plane
   * launches, never the settings file, whose worker session is already
   * running when it reads it.
   */
  workerEnv?: Record<string, string>;
  /**
   * The run's hold scope as the runtime resolved it (`resolveHoldScope`:
   * the `--hold-scope` flag or `holdScope` option outranking the inherited
   * `ENSEMBLE_HOLD_SCOPE`), delivered to every worker session by the
   * settings file — the contract is inheritance by every nested invocation,
   * and the session is served by a daemon process inheritance cannot reach.
   * `null` is the shared scope (nothing delivered). Omitted, the control
   * plane resolves the scope its own process would run under — the same
   * function, with no explicit input — so a control plane built outside a
   * runtime behaves as a bare invocation does. The control plane never
   * resolves precedence itself: a caller that has an explicit scope passes
   * the resolved value, or the flag's precedence is silently lost here.
   */
  holdScope?: string | null;
  /** Where Claude Code keeps session transcripts. Defaults to `projects` under `CLAUDE_CONFIG_DIR`, else `~/.claude/projects`. */
  projectsDir?: string;
  /** How long to wait for a dispatched session to register in the roster. */
  dispatchTimeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL when reaping tagged descendants at stop(). */
  reapGraceMs?: number;
  /** The proc filesystem root the reaper scans. Injectable for tests; on a platform without one the reap is a no-op. */
  procDir?: string;
  /** tmux valve settle times after attach, before submit and before kill. */
  valveAttachSettleMs?: number;
  valveSubmitSettleMs?: number;
  valveKillSettleMs?: number;
  /**
   * Places each dispatched session in a worker scope and launches every
   * `claude` and `tmux` process this control plane starts.
   *
   * Placement: the supervisor forks the session's process, so it starts in
   * the supervisor's cgroup, outside the launcher's box. The roster names
   * that process by `pid` shortly after the session registers; the moment
   * it does, the process and its live descendants are placed in a scope
   * named for the dispatch or shared by the run, according to `workerScope`.
   * A run-owned roster watch re-places restarted sessions even between turns.
   * Refusals are retried within the registration settle window and on later
   * polls, even at the same pid; refusal and recovery emit runtime notices.
   * Placement remains best-effort (`placementOf`): refusal does not fail dispatch.
   *
   * Launch: any `claude` command can start the per-user supervisor, which
   * then serves every Claude session on the machine and must not sit in
   * the launcher's own box — a memory limit or an ending there would take
   * them all — so the systemd manager runs each command in a transient
   * scope of its own, outside that box.
   *
   * Omitted, nothing is placed and commands are launched directly, as on a
   * machine without a systemd user manager.
   */
  scopes?: WorkerScopes;
  workerScope?: WorkerScopeGrouping;
  /** How long after registration to wait for a pid and successful placement before leaving retries to the next poll. */
  placementSettleMs?: number;
  /** Control-plane roster-watch cadence; defaults to 1,000 ms. */
  placementWatchIntervalMs?: number;
  /** Placement refusal and recovery notices, delivered through the runtime event channel. */
  onEvent?: (event: RuntimeEvent) => void;
}

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * The real control plane: drives `claude` and `tmux` as child processes. The
 * valve sequence (attach in a disposable tmux server, settle, type literally,
 * submit, kill) is retry-safe because the daemon owns the session, so a
 * botched injection costs a retry, never a worker.
 */
export class ClaudeCliControlPlane implements ClaudeControlPlane {
  #claudeBin: string;
  #tmuxBin: string;
  #projectsDir: string;
  #dispatchTimeoutMs: number;
  #reapGraceMs: number;
  #procDir: string;
  #valveAttachSettleMs: number;
  #valveSubmitSettleMs: number;
  #valveKillSettleMs: number;
  #scopes: WorkerScopes;
  #workerScope: WorkerScopeGrouping;
  #placementSettleMs: number;
  #placementWatchIntervalMs: number;
  #onEvent: ((event: RuntimeEvent) => void) | undefined;
  /** Last placement attempt per session: refused attempts remain eligible at the same pid. */
  #placements = new Map<string, { pid: number; outcome: ScopePlacement }>();
  /** Session ownership lasts through idle gaps, independently of turn polling. */
  #watchedSessions = new Map<string, ClaudeSessionHandle>();
  #placementTimer: NodeJS.Timeout | null = null;
  #placementSweep: Promise<void> | null = null;
  #placing = new Map<string, Promise<ScopePlacement>>();
  #valveCounter = 0;
  /**
   * Where each valve's socket directory is made: where tmux keeps its own
   * sockets, by the launcher's own TMUX_TMPDIR (else /tmp). Never a
   * declared worker variable, so no declared value reaches a valve's
   * `-S` argument.
   */
  #valveSocketRoot: string;
  #env: NodeJS.ProcessEnv;
  #workerEnv: Record<string, string>;
  /** The resolved hold scope every dispatched session inherits by its settings file; null for the shared scope. */
  #holdScope: string | null;
  /** Per-session settings directories, removed when the session stops. */
  #settingsDirs = new Map<string, string>();
  /** The one-time sweep of settings directories earlier launchers left behind, run before this control plane's first dispatch. */
  #orphanSweep: Promise<void> | null = null;

  constructor(options: ClaudeCliControlPlaneOptions = {}) {
    this.#claudeBin = options.claudeBin ?? "claude";
    this.#tmuxBin = options.tmuxBin ?? "tmux";
    // Declared variables sit above inherited ones; everything undeclared
    // still inherits, so a configured parent keeps working unchanged. The
    // declared map is also kept separately: the per-dispatch settings file
    // carries it to the worker session (see #writeWorkerSettings()).
    this.#workerEnv = options.workerEnv ?? {};
    this.#holdScope = options.holdScope === undefined ? resolveHoldScope(undefined, process.env) : options.holdScope;
    // Inherit the operator's environment minus the run's own settings: a
    // child here can start the per-user daemon, and the daemon must not be
    // homed on this run's record or status directories (see `workerEnv`).
    // The sandboxed-workspace declaration is harness bookkeeping and lands
    // last, above any machine declaration of the same name: every `claude`
    // this control plane launches must see it, or dispatch fails on trust.
    this.#env = {
      ...withoutRunScopedVariables(process.env),
      ...this.#workerEnv,
      [SANDBOXED_WORKSPACE_VARIABLE]: "1"
    };
    const configDir = this.#env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
    this.#projectsDir = options.projectsDir ?? path.join(configDir, "projects");
    this.#dispatchTimeoutMs = options.dispatchTimeoutMs ?? 30_000;
    this.#reapGraceMs = options.reapGraceMs ?? 5_000;
    this.#procDir = options.procDir ?? "/proc";
    this.#valveAttachSettleMs = options.valveAttachSettleMs ?? 4_000;
    this.#valveSubmitSettleMs = options.valveSubmitSettleMs ?? 1_000;
    this.#valveKillSettleMs = options.valveKillSettleMs ?? 2_000;
    this.#valveSocketRoot = process.env.TMUX_TMPDIR || "/tmp";
    this.#workerScope = options.workerScope ?? "worker";
    this.#scopes = options.scopes ?? new NoWorkerScopes();
    this.#placementSettleMs = options.placementSettleMs ?? 10_000;
    this.#placementWatchIntervalMs = options.placementWatchIntervalMs ?? 1_000;
    if (!Number.isInteger(this.#placementWatchIntervalMs) || this.#placementWatchIntervalMs < 1 || this.#placementWatchIntervalMs > 2_147_483_647) {
      throw new RangeError("placementWatchIntervalMs must be an integer from 1 to 2147483647");
    }
    this.#onEvent = options.onEvent;
  }

  /** How the session's process was last placed, or null before the roster has named a pid for it. */
  placementOf(handle: ClaudeSessionHandle): ScopePlacement | null {
    return this.#placements.get(handle.sessionId)?.outcome ?? null;
  }

  async dispatch(options: ClaudeDispatchOptions): Promise<ClaudeSessionHandle> {
    const args = ["--bg", "--name", options.name, "--dangerously-skip-permissions"];
    if (options.model !== undefined) {
      args.push("--model", options.model);
    }
    if (options.effort !== undefined) {
      args.push("--effort", options.effort);
    }
    // The worker session runs under the per-user daemon, whose environment
    // predates this run — inheritance cannot deliver the declared variables
    // to it (measured 2026-08-07: an exported variable never reached a
    // dispatched worker). A per-dispatch settings file is the surface that
    // does: Claude Code merges its `env` block additively over the project
    // and user settings, declared keys winning collisions, so the file
    // carries only this run's declarations and never touches the operator's
    // own settings.
    // Directories an earlier launcher could not remove — it was killed, or
    // crashed — are swept before this run adds its own, so they never
    // accumulate across runs. Once per control plane: later dispatches
    // share the first one's sweep.
    this.#orphanSweep ??= this.#sweepOrphanedSettingsDirs();
    await this.#orphanSweep;
    const settingsDir = await this.#writeWorkerSettings(options.name, options.permissionDenyRules);
    args.push("--settings", path.join(settingsDir, "settings.json"));
    let registered: ClaudeSessionHandle | null = null;
    try {
      // Prompts routinely contain whole diffs and can exceed the platform's argv
      // ceiling. Claude's background mode accepts its initial prompt on stdin, so
      // keep argv small and stream the bytes without involving a shell.
      //
      // The roster is read while `claude --bg` is still running, not once it
      // has returned: the row registers, and names its pid, seconds before
      // the command exits (measured on Claude Code 2.1.318: pid at ~0.9 s,
      // exit at ~4 s), and Linux never moves memory already charged when a
      // process changes cgroup, so every moment the session spends outside
      // its scope is memory charged to the supervisor's cgroup for good.
      const dispatch: { result: ExecResult | null } = { result: null };
      void this.#runWithInput(this.#claudeBin, args, options.prompt, options.cwd).then(
        (result) => (dispatch.result = result),
        (error: unknown) => (dispatch.result = { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) })
      );

      // The registration window opens when `claude --bg` returns: a slow
      // daemon start spends the command's own time, not the session's.
      let deadline: number | null = null;
      for (;;) {
        const found = await this.#findByName(options.name);
        if (found !== null) {
          registered = found.handle;
          // The row registers before it carries a pid (measured: about half
          // a second before), so the wait continues, bounded, for the pid
          // and placement, and the session is placed the moment it is named; past
          // the bound the next poll places it.
          // A no-op manager cannot use a PID, so registration is enough.
          if (this.#scopes instanceof NoWorkerScopes) break;
          const settled = Date.now() + this.#placementSettleMs;
          let pid = found.pid;
          for (;;) {
            if (pid !== null) {
              const outcome = await this.#place(registered, pid);
              if (outcome.kind !== "refused") break;
            }
            if (Date.now() >= settled) break;
            await delay(100);
            pid = (await this.#findByName(options.name))?.pid ?? null;
          }
          break;
        }
        if (dispatch.result !== null) {
          // `claude --bg` prints the short id and returns; if it failed outright there
          // is no session to wait for, so surface immediately with its stderr.
          if (!dispatch.result.ok) {
            // A refusal before any session exists: the directory is the
            // fact the operator needs, the launch command's stderr is the reason,
            // and the declaration is named so a refusal that survived it reads
            // as the substrate's, not as a lift the harness forgot. The text is
            // engine-controlled and lands on a one-line operator surface, so it
            // takes the bounded-evidence discipline: control stripped,
            // whitespace flattened, bounded.
            throw new ClaudeDispatchError(
              `Claude dispatch command failed for worker '${options.name}' in ${options.cwd} ` +
                `(workspace declared sandboxed via ${SANDBOXED_WORKSPACE_VARIABLE}): ` +
                boundedEvidence(dispatch.result.stderr.trim() || dispatch.result.stdout.trim() || "claude --bg exited without a message")
            );
          }
          deadline ??= Date.now() + this.#dispatchTimeoutMs;
          if (Date.now() >= deadline) {
            // The daemon took the dispatch and never surfaced the session: an
            // operational failure the retry loop spends an attempt on, not a
            // refusal — Claude Code did not decline.
            throw new ClaudeRegistrationTimeoutError(
              `dispatched session '${options.name}' in ${options.cwd} did not register within ${this.#dispatchTimeoutMs}ms`
            );
          }
        }
        await delay(dispatch.result === null ? 100 : 500);
      }
    } finally {
      if (registered === null) {
        // The dispatch never produced a session, so nothing will read the
        // file again. Best-effort: cleanup failure must never mask the
        // dispatch error being thrown past this block.
        await this.#removeSettingsDir(settingsDir);
      } else {
        // The session is live and Claude Code watches settings files for
        // changes, so the file keeps the session's own lifetime: stop()
        // removes it. Deleting it here — the moment the roster registers —
        // would risk the daemon observing a mid-session removal of the
        // very variables the file exists to hold.
        this.#settingsDirs.set(registered.sessionId, settingsDir);
        if (!(this.#scopes instanceof NoWorkerScopes)) {
          this.#watchedSessions.set(registered.sessionId, registered);
          this.#schedulePlacementWatch();
        }
      }
    }
    if (registered === null) {
      // Unreachable: every path that leaves the loop without a handle throws.
      throw new ClaudeRegistrationTimeoutError(`dispatched session '${options.name}' in ${options.cwd} was lost before registration`);
    }
    return registered;
  }

  /**
   * Write the per-dispatch settings file carrying the declared worker
   * environment plus the dispatch's ownership tag (`WORKER_MARKER_VARIABLE`).
   * Written on every dispatch: the tag is what lets `stop()` reap the
   * worker's surviving descendants, so an untagged worker would be an
   * unowned one. (This supersedes the earlier no-declaration-no-flag
   * behaviour, which predated descendant ownership.) The file can carry
   * credentials — gateway values among the declared variables — so it lives
   * in its own mkdtemp directory (0o700 by construction, unguessable name)
   * and the file itself is 0o600.
   */
  async #writeWorkerSettings(dispatchName: string, permissionDenyRules?: string[]): Promise<string> {
    // The ownership tag is harness bookkeeping and always lands last.
    // The hold scope is per-lead coordination state whose contract is
    // inheritance by every nested invocation (`HOLD_SCOPE_ENV`). It is
    // withheld from control-plane children like every run-level setting —
    // the daemon must not carry it — so it reaches the worker session by
    // the one route that does: this file, below the machine's declarations.
    // The value written is the run's *resolved* scope (the constructor
    // option), never a fresh read of this process's variable: a scope the
    // launcher took from `--hold-scope` exists nowhere in the environment.
    const env = {
      ...(this.#holdScope !== null ? { [HOLD_SCOPE_ENV]: this.#holdScope } : {}),
      ...this.#workerEnv,
      [WORKER_MARKER_VARIABLE]: dispatchName
    };
    // The deny block joins the same single-purpose file rather than a second
    // artefact. The measured additive layering (2026-08-07) covered the
    // env block; that deny rules likewise union across layers and beat
    // every allow is Claude Code's documented model, held as a judgement
    // until a live test observes it at a real worker. Either
    // way the file carries only this dispatch's rules and never touches the
    // operator's own permission configuration.
    const settings =
      permissionDenyRules !== undefined && permissionDenyRules.length > 0
        ? { env, permissions: { deny: permissionDenyRules } }
        : { env };
    // The owner record is captured before the directory exists and written
    // first: a concurrent launcher's sweep that finds a directory with no
    // readable owner record leaves it alone, so the only window in which
    // this directory could be misjudged — between mkdtemp and the owner
    // write — is one the sweep treats as unjudgeable, never as abandoned.
    const owner = `${JSON.stringify(await captureProcessOwner(this.#procDir, hostname()))}\n`;
    const dir = await mkdtemp(path.join(tmpdir(), `${SETTINGS_DIR_PREFIX}${dispatchName}-`));
    try {
      // Beside the settings file, never inside it: the file stays Claude
      // Code's single-purpose input, and the owner record is the harness's
      // own evidence — this launcher's pid and start ticks — so a later
      // launcher can judge the directory abandoned after an ending this one
      // could not handle (the same evidence the run manifest carries).
      await writeFile(path.join(dir, OWNER_FILENAME), owner, { mode: 0o600 });
      await writeFile(path.join(dir, "settings.json"), `${JSON.stringify(settings)}\n`, {
        mode: 0o600
      });
    } catch (error) {
      // A failed write means the caller never learns the directory exists,
      // so nothing else can clean it up — remove it (and any partial file)
      // here before surfacing the failure.
      await this.#removeSettingsDir(dir);
      throw error;
    }
    return dir;
  }

  async #removeSettingsDir(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * Remove every per-dispatch settings directory whose recorded owner is
   * provably gone — a launcher that died by SIGKILL or crashed never reached
   * `stop()`. Judgement is the run manifest's: same-host, evidence-only,
   * conservative on every unjudgeable case (a live owner, another host, no
   * readable proc filesystem). A directory with no readable owner record is
   * unjudgeable too and is left alone — unlike the manifest, whose owner
   * block is written atomically inside the artefact judged, a sidecar can
   * be observed before it lands, and a concurrent launcher between its
   * mkdtemp and its owner write must never lose a live directory. (The
   * directories launchers left before owner recording existed are
   * therefore not swept; they are the operator's to remove.) An
   * orphaned session the daemon is still serving loses its declared
   * variables when its file goes — an accepted cost: no launcher will ever
   * collect that session, and checking the roster here would itself start
   * the daemon. Best-effort throughout: this is housekeeping, and nothing
   * here may fail or delay a dispatch on its own account.
   */
  async #sweepOrphanedSettingsDirs(): Promise<void> {
    const root = tmpdir();
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const host = hostname();
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(SETTINGS_DIR_PREFIX)) {
        continue;
      }
      const dir = path.join(root, entry.name);
      try {
        const owner: unknown = JSON.parse(await readFile(path.join(dir, OWNER_FILENAME), "utf8"));
        if (owner !== null && typeof owner === "object" && (await judgeOwnerGone(owner, this.#procDir, host)) !== null) {
          await this.#removeSettingsDir(dir);
        }
      } catch {
        // No readable owner record, or one unjudgeable directory: leave it
        // as found; the sweep goes on.
      }
    }
  }

  async poll(handle: ClaudeSessionHandle): Promise<ClaudeSessionStatus> {
    const roster = await this.#roster();
    if (!roster.ok) {
      // The roster query itself failed (daemon busy, transient non-zero exit).
      // Do NOT read this as absence — that would tear down a live worker. Report
      // "unknown but present" so the caller keeps waiting (the transcript, read
      // independently of this query, remains the authoritative done-signal).
      return { status: "unknown", state: "unknown", present: true };
    }
    const record = roster.rows.find((row) => matchesHandle(row, handle)) ?? null;
    if (record === null) {
      return { status: "absent", state: "unknown", present: false };
    }
    // A session the supervisor restarted runs under a new pid, in the
    // supervisor's cgroup again: place it again. A refused move is still
    // pending even when the pid stays the same.
    const previous = this.#placements.get(handle.sessionId);
    if (typeof record.pid === "number" && (previous?.pid !== record.pid || previous.outcome.kind === "refused")) {
      await this.#place(handle, record.pid);
    }
    const waitingFor = typeof record.waitingFor === "string" ? record.waitingFor : undefined;
    return {
      status: typeof record.status === "string" ? record.status : "unknown",
      state: normaliseState(record.state),
      present: true,
      ...(waitingFor !== undefined ? { waitingFor } : {})
    };
  }

  async transcriptPath(handle: ClaudeSessionHandle): Promise<string | null> {
    const filename = `${handle.sessionId}.jsonl`;
    let projectDirs: string[];
    try {
      const entries = await readdir(this.#projectsDir, { withFileTypes: true });
      projectDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return null;
    }

    for (const dir of projectDirs) {
      const candidate = path.join(this.#projectsDir, dir, filename);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Not in this project dir; keep scanning. Locating by sessionId avoids
        // having to reconstruct the (lossy) cwd→dirname encoding.
      }
    }
    return null;
  }

  async steer(handle: ClaudeSessionHandle, message: string): Promise<ValveDelivery> {
    if ((await this.poll(handle)).present === false) {
      return { delivered: false, reason: "the session is no longer in the daemon's roster" };
    }

    this.#valveCounter += 1;
    const valve = `ensemble-valve-${handle.id}-${this.#valveCounter}`;

    // Each valve runs in a tmux server of its own, on a socket in a fresh
    // private directory. A new server's panes inherit the environment of
    // the client that started it, so the declared worker variables reach
    // the `claude attach` child through `#env` — a process environment only
    // this user can read — and never as `new-session -e` arguments, which
    // any local user can read in the process table. The server reads no
    // configuration file: the operator's tmux configuration, plugins
    // included, has no business running on every valve. The directory sits
    // where tmux keeps its own sockets (`#valveSocketRoot`), not under the
    // temp root: a socket path is bounded (about 108 bytes), and a deeply
    // nested TMPDIR overruns it.
    let socketDir: string;
    try {
      socketDir = await mkdtemp(path.join(this.#valveSocketRoot, VALVE_DIR_PREFIX));
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      return { delivered: false, reason: `valve socket directory failed: ${boundedEvidence(said)}` };
    }
    const server = ["-S", path.join(socketDir, "tmux.sock")];

    try {
      const created = await this.#run(this.#tmuxBin, [
        ...server,
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        valve,
        `${this.#claudeBin} attach ${handle.id}`
      ]);
      if (!created.ok) {
        return refused("tmux new-session", created);
      }

      // The TUI needs a beat to attach and take focus before input lands.
      await delay(this.#valveAttachSettleMs);
      // Complete Win32 terminal key records stay typed even when the reader
      // falls behind and coalesces input. Bound each literal send and never
      // split a record; submit follows the final batch as its own keystroke.
      const slices = valveSlices(message);
      for (const [index, slice] of slices.entries()) {
        const typed = await this.#run(this.#tmuxBin, [...server, "send-keys", "-t", valve, "-l", "--", slice]);
        if (!typed.ok) {
          return refused(`tmux send-keys (slice ${index + 1} of ${slices.length})`, typed);
        }
      }
      await delay(this.#valveSubmitSettleMs);
      const submitted = await this.#run(this.#tmuxBin, [...server, "send-keys", "-t", valve, "Enter"]);
      if (!submitted.ok) {
        return refused("tmux send-keys (submit)", submitted);
      }
      await delay(this.#valveKillSettleMs);
      return { delivered: true };
    } finally {
      // The server is this valve's alone, so ending it ends the pane too.
      // tmux leaves its socket file behind; the directory takes it.
      await this.#run(this.#tmuxBin, [...server, "kill-server"]);
      await rm(socketDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Place the session's process and its live descendants in the scope
   * chosen by the run's grouping. The tree, not the pid alone: helpers the
   * session forked before this moment (MCP servers, shells) would
   * otherwise stay in the supervisor's cgroup. Best-effort — the outcome
   * is recorded, never thrown.
   */
  async #place(handle: ClaudeSessionHandle, pid: number): Promise<ScopePlacement> {
    const pending = (this.#placing.get(handle.sessionId) ?? Promise.resolve()).then(() => this.#placeInTurn(handle, pid));
    this.#placing.set(handle.sessionId, pending);
    try {
      return await pending;
    } finally {
      if (this.#placing.get(handle.sessionId) === pending) this.#placing.delete(handle.sessionId);
    }
  }

  async #placeInTurn(handle: ClaudeSessionHandle, pid: number): Promise<ScopePlacement> {
    const previous = this.#placements.get(handle.sessionId);
    if (previous?.pid === pid && previous.outcome.kind !== "refused") return previous.outcome;
    const outcome = await this.#scopes.place(this.#workerScope === "run" ? RUN_SCOPE_GROUP : handle.name, await processTree(pid, this.#procDir));
    this.#placements.set(handle.sessionId, { pid, outcome });
    // Report a changed refusal once, and its recovery. Repeated polls still
    // retry a refused pid without repeating the same notice indefinitely.
    const changedRefusal = outcome.kind === "refused" &&
      (previous?.pid !== pid || previous.outcome.kind !== "refused" || previous.outcome.reason !== outcome.reason);
    const recovered = outcome.kind === "placed" && previous?.outcome.kind === "refused";
    if (changedRefusal || recovered) {
      this.#onEvent?.({
        method: "claude/workerScopePlacement",
        params: {
          sessionId: handle.sessionId, name: handle.name, pid, kind: outcome.kind,
          ...(outcome.kind === "refused" ? { reason: boundedEvidence(outcome.reason) } : {}),
          ...(outcome.kind === "placed" ? { unit: outcome.unit } : {})
        },
        receivedAt: Date.now()
      });
    }
    return outcome;
  }

  /** One roster read serves every owned session, including those between turns. */
  #schedulePlacementWatch(): void {
    if (this.#placementTimer !== null || this.#placementSweep !== null || this.#watchedSessions.size === 0) return;
    this.#placementTimer = setTimeout(() => {
      this.#placementTimer = null;
      this.#placementSweep = this.#refreshPlacements().catch((error: unknown) => {
        this.#onEvent?.({
          method: "claude/workerScopeWatchError",
          params: { reason: boundedEvidence(error instanceof Error ? error.message : String(error)) },
          receivedAt: Date.now()
        });
      }).finally(() => {
        this.#placementSweep = null;
        this.#schedulePlacementWatch();
      });
    }, this.#placementWatchIntervalMs);
    this.#placementTimer.unref();
  }

  async #refreshPlacements(): Promise<void> {
    const roster = await this.#roster();
    // An unavailable roster is not evidence that an owned session ended.
    if (!roster.ok) return;
    for (const handle of this.#watchedSessions.values()) {
      const row = roster.rows.find((entry) => matchesHandle(entry, handle));
      if (typeof row?.pid === "number") await this.#place(handle, row.pid);
    }
  }

  async stop(handle: ClaudeSessionHandle): Promise<void> {
    this.#watchedSessions.delete(handle.sessionId);
    if (this.#watchedSessions.size === 0 && this.#placementTimer !== null) {
      clearTimeout(this.#placementTimer);
      this.#placementTimer = null;
    }
    // A roster read or placement already in flight must finish before teardown
    // removes session state or the registry closes its shared scope manager.
    await this.#placementSweep;
    await this.#placing.get(handle.sessionId);
    // Best-effort teardown; `stop`/`rm` can mishandle an already-exited session,
    // so failures are swallowed rather than allowed to mask the real result.
    await this.#run(this.#claudeBin, ["stop", handle.id]);
    this.#placements.delete(handle.sessionId);
    // The session is over; anything still carrying its tag is a descendant
    // the daemon will never reap (they reparent to the user session, not to
    // the harness). Ownership means killing them here, not warning about them.
    await this.#reapTaggedDescendants(handle.name);
    await this.#run(this.#claudeBin, ["rm", handle.id]);
    // The session is gone, so its settings file (which carries the declared
    // gateway values) goes with it. Same best-effort discipline as above.
    const settingsDir = this.#settingsDirs.get(handle.sessionId);
    if (settingsDir !== undefined) {
      this.#settingsDirs.delete(handle.sessionId);
      await this.#removeSettingsDir(settingsDir);
    }
  }

  /**
   * Kill every surviving process tagged with this dispatch's marker:
   * SIGTERM first, then SIGKILL for anything still alive after the grace
   * period. Best-effort throughout — reaping is cleanup, and a scan or kill
   * failure must never mask the turn's real outcome. On a platform without
   * a readable proc filesystem the scan finds nothing and the reap is a
   * no-op.
   */
  async #reapTaggedDescendants(dispatchName: string): Promise<void> {
    const tagged = await this.#findTaggedProcesses(dispatchName);
    if (tagged.length === 0) {
      return;
    }
    for (const pid of tagged) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone, or not ours to signal.
      }
    }
    await delay(this.#reapGraceMs);
    // Re-establish identity before escalating: a pid from the first scan can
    // exit during the grace period and be reused by an unrelated process, so
    // a bare liveness check is not authority for SIGKILL — only a process
    // still carrying the tag is.
    for (const pid of await this.#findTaggedProcesses(dispatchName)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone, or not ours to signal.
      }
    }
  }

  /** Pids (other than our own) whose environment carries this dispatch's tag. */
  async #findTaggedProcesses(dispatchName: string): Promise<number[]> {
    const needle = `${WORKER_MARKER_VARIABLE}=${dispatchName}`;
    let entries: string[];
    try {
      entries = await readdir(this.#procDir);
    } catch {
      return [];
    }
    const pids: number[] = [];
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) {
        continue;
      }
      const pid = Number(entry);
      if (pid === process.pid) {
        continue;
      }
      let environ: string;
      try {
        environ = await readFile(path.join(this.#procDir, entry, "environ"), "utf8");
      } catch {
        // Another user's process, or one that exited mid-scan.
        continue;
      }
      if (environ.split("\0").includes(needle)) {
        pids.push(pid);
      }
    }
    return pids;
  }

  async tmuxAvailable(): Promise<boolean> {
    return (await this.#run(this.#tmuxBin, ["-V"])).ok;
  }

  /** The roster's row for a dispatch, as a handle plus the pid the row names (null until the supervisor reports one). */
  async #findByName(name: string): Promise<{ handle: ClaudeSessionHandle; pid: number | null } | null> {
    const { rows } = await this.#roster();
    const match = rows.find(
      (row) => row.kind === "background" && row.name === name && typeof row.sessionId === "string"
    );
    if (match === undefined || typeof match.sessionId !== "string") {
      return null;
    }
    // The short id is preferred for steer/stop; fall back to sessionId if the
    // daemon has not yet surfaced one.
    const id = typeof match.id === "string" && match.id.length > 0 ? match.id : match.sessionId;
    return {
      handle: {
        id,
        sessionId: match.sessionId,
        name,
        cwd: typeof match.cwd === "string" ? match.cwd : ""
      },
      pid: typeof match.pid === "number" ? match.pid : null
    };
  }

  // `ok: false` means the query could not be performed (process error, empty or
  // unparseable output) — distinct from "queried fine, session not listed",
  // which is `{ ok: true, rows: [...] }` with the session simply absent.
  async #roster(): Promise<{ ok: boolean; rows: RosterRow[] }> {
    const result = await this.#run(this.#claudeBin, ["agents", "--json"]);
    if (!result.ok || result.stdout.trim().length === 0) {
      return { ok: false, rows: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return { ok: false, rows: [] };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, rows: [] };
    }
    return { ok: true, rows: parsed.filter((row): row is RosterRow => typeof row === "object" && row !== null) };
  }

  #run(file: string, args: string[], cwd?: string): Promise<ExecResult> {
    return this.#launch(file, args, null, cwd);
  }

  #runWithInput(file: string, args: string[], input: string, cwd?: string): Promise<ExecResult> {
    return this.#launch(file, args, input, cwd);
  }

  /**
   * The one route every control-plane child takes: launched by the scope
   * manager (outside the launcher's box, where a systemd user manager is
   * reachable), under the spread `#env`, with its output collected and its
   * exit status read as the verdict. `input` is streamed to stdin and the
   * stream then closed; null closes it at once.
   */
  async #launch(file: string, args: string[], input: string | null, cwd?: string): Promise<ExecResult> {
    const child = await this.#scopes.launch(file, args, {
      ...(cwd !== undefined ? { cwd } : {}),
      env: this.#env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    return new Promise<ExecResult>((resolve) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const finish = (result: ExecResult): void => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        finish({ ok: false, stdout: Buffer.concat(stdout).toString(), stderr: error.message });
      });
      child.on("close", (code) => {
        finish({
          ok: code === 0,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString()
        });
      });

      // A child that rejects input may close stdin before this write completes.
      // Its exit status/stderr above is the useful dispatch error; suppress the
      // stream's secondary EPIPE so it cannot become an unhandled exception.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input ?? undefined);
    });
  }
}

interface RosterRow {
  id?: unknown;
  /** The session's own process while it lives (Claude Code 2.1.318); absent for the first moments after registration. */
  pid?: unknown;
  name?: unknown;
  kind?: unknown;
  status?: unknown;
  state?: unknown;
  waitingFor?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
}

function matchesHandle(row: RosterRow, handle: ClaudeSessionHandle): boolean {
  return (
    (typeof row.id === "string" && row.id === handle.id) ||
    (typeof row.sessionId === "string" && row.sessionId === handle.sessionId)
  );
}

function normaliseState(state: unknown): ClaudeSessionState {
  if (state === "working" || state === "blocked" || state === "done") {
    return state;
  }
  return "unknown";
}

/**
 * Largest byte length of one `send-keys -l` argument. Two caps bound it: Linux
 * rejects a single argv element over 128 KiB (`spawn E2BIG`), and tmux's client
 * refuses any one command over its 16 KiB message size ("command too long",
 * measured on tmux 3.7c: 16000 bytes accepted, 20000 refused). This sits well
 * beneath both, so a valve message of any size reaches the pane as an ordered
 * sequence of literal sends.
 */
export const VALVE_SLICE_BYTES = 8 * 1024;

/** A refused valve step, named with the bounded text tmux gave for it. */
function refused(step: string, result: ExecResult): ValveDelivery {
  const said = result.stderr.trim() || result.stdout.trim() || "exited without a message";
  return { delivered: false, reason: `${step} failed: ${boundedEvidence(said)}` };
}

/**
 * Split a valve message into `send-keys -l` arguments of at most
 * `VALVE_SLICE_BYTES` bytes each, encoding each UTF-16 unit as a complete Win32
 * terminal key record. Tabs become four spaces; CR and CRLF become LF.
 * No record is torn across two sends. Exported for the delivery tests; an
 * encoded message within the bound is one slice, and an empty message is none.
 */
export function valveSlices(message: string): string[] {
  message = message.replace(/\r\n?/g, "\n").replaceAll("\t", "    ");
  const slices: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (let index = 0; index < message.length; index += 1) {
    // Vk;Sc;Unicode;KeyDown;ControlKeyState;RepeatCount, all ASCII.
    const character = `\u001b[0;0;${message.charCodeAt(index)};1;0;1_`;
    const characterBytes = character.length;
    if (currentBytes + characterBytes > VALVE_SLICE_BYTES) {
      slices.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += characterBytes;
  }
  if (current !== "") {
    slices.push(current);
  }
  return slices;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

