import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import path from "node:path";

import { withoutRunScopedVariables } from "./ambient-settings.js";
import { ClaudeDispatchError, ClaudeRegistrationTimeoutError } from "./errors.js";
import { captureProcessOwner, judgeOwnerGone } from "./process-owner-evidence.js";
import { boundedEvidence } from "./operator-diagnosis.js";

/**
 * Per-dispatch ownership tag. The variable rides the same settings-file `env`
 * block that delivers the declared worker environment, so every process the
 * worker spawns — however deeply, and however it is later reparented —
 * inherits it. That inheritance is what gives worker-spawned subprocesses a
 * named owner: `stop()` reaps any surviving process still carrying the
 * dispatch's tag, closing the gap where descendants of a daemon-hosted
 * worker escaped the cancellation plumbing entirely (observed as orphaned
 * children burning CPU for ~90 minutes after their worker died).
 */
export const WORKER_MARKER_VARIABLE = "ENSEMBLE_CLAUDE_WORKER";
/** Per-dispatch settings directories live under the temp root as `<prefix><dispatch name>-<random>`. */
const SETTINGS_DIR_PREFIX = "ensemble-claude-env-";
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
  /**
   * Prompt-cache TTL for the worker session, in Claude Code's
   * settings value format ("1h"). Rides the same settings-file `env` block
   * as the declared worker environment, as
   * `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` — and a machine-declared value
   * for that variable wins over this one (the operator's word outranks the
   * harness default; see the spread order in the writer). Absent means the
   * engine's own default TTL.
   */
  cacheTtl?: string;
}

/** The settings-file variable Claude Code reads a background worker's prompt-cache TTL from. */
export const CLAUDE_CACHE_TTL_VARIABLE = "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL";

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
   * - **The valve's `claude attach` client** gets explicit tmux `-e` flags:
   *   a pre-existing tmux server starts pane commands from the *server's*
   *   environment, not this client's.
   *
   * The harness's own sandboxed-workspace declaration
   * (`SANDBOXED_WORKSPACE_VARIABLE`) rides the second and third surfaces
   * beside these declarations — every `claude` process the control plane
   * launches, never the settings file, whose worker session is already
   * running when it reads it.
   */
  workerEnv?: Record<string, string>;
  /** Defaults to `~/.claude/projects`. */
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
}

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * The real control plane: drives `claude` and `tmux` as child processes. The
 * valve sequence (attach in a disposable tmux pane, settle, type literally,
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
  #valveCounter = 0;
  #env: NodeJS.ProcessEnv;
  #workerEnv: Record<string, string>;
  /** The declared worker environment plus the harness's sandboxed-workspace declaration: what every launched `claude` process sees. */
  #launchEnv: Record<string, string>;
  /** Per-session settings directories, removed when the session stops. */
  #settingsDirs = new Map<string, string>();
  /** The one-time sweep of settings directories earlier launchers left behind, run before this control plane's first dispatch. */
  #orphanSweep: Promise<void> | null = null;

  constructor(options: ClaudeCliControlPlaneOptions = {}) {
    this.#claudeBin = options.claudeBin ?? "claude";
    this.#tmuxBin = options.tmuxBin ?? "tmux";
    // Declared variables sit above inherited ones; everything undeclared
    // still inherits, so a configured parent keeps working unchanged. The
    // declared map is also kept separately: the tmux valve needs it as
    // explicit -e flags (see steer()).
    this.#workerEnv = options.workerEnv ?? {};
    // The sandboxed-workspace declaration is harness bookkeeping and lands
    // last, above any machine declaration of the same name: every `claude`
    // this control plane launches must see it, or dispatch fails on trust.
    this.#launchEnv = { ...this.#workerEnv, [SANDBOXED_WORKSPACE_VARIABLE]: "1" };
    // Inherit the operator's environment minus the run's own settings: a
    // child here can start the per-user daemon, and the daemon must not be
    // homed on this run's record or status directories (see `workerEnv`).
    this.#env = { ...withoutRunScopedVariables(process.env), ...this.#launchEnv };
    this.#projectsDir = options.projectsDir ?? path.join(homedir(), ".claude", "projects");
    this.#dispatchTimeoutMs = options.dispatchTimeoutMs ?? 30_000;
    this.#reapGraceMs = options.reapGraceMs ?? 5_000;
    this.#procDir = options.procDir ?? "/proc";
    this.#valveAttachSettleMs = options.valveAttachSettleMs ?? 4_000;
    this.#valveSubmitSettleMs = options.valveSubmitSettleMs ?? 1_000;
    this.#valveKillSettleMs = options.valveKillSettleMs ?? 2_000;
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
    const settingsDir = await this.#writeWorkerSettings(options.name, options.permissionDenyRules, options.cacheTtl);
    args.push("--settings", path.join(settingsDir, "settings.json"));
    let registered: ClaudeSessionHandle | null = null;
    try {
      // Prompts routinely contain whole diffs and can exceed the platform's argv
      // ceiling. Claude's background mode accepts its initial prompt on stdin, so
      // keep argv small and stream the bytes without involving a shell.
      const dispatch = await this.#runWithInput(this.#claudeBin, args, options.prompt, options.cwd);
      // `claude --bg` prints the short id and returns; if it failed outright there
      // is no session to wait for, so surface immediately with its stderr.
      if (!dispatch.ok && (await this.#findByName(options.name)) === null) {
        // A refusal before any session exists: the directory is the
        // fact the operator needs, Claude Code's own words are the reason,
        // and the declaration is named so a refusal that survived it reads
        // as the substrate's, not as a lift the harness forgot. The text is
        // engine-controlled and lands on a one-line operator surface, so it
        // takes the bounded-evidence discipline: control stripped,
        // whitespace flattened, bounded.
        throw new ClaudeDispatchError(
          `Claude Code refused to dispatch worker '${options.name}' in ${options.cwd} ` +
            `(workspace declared sandboxed via ${SANDBOXED_WORKSPACE_VARIABLE}): ` +
            boundedEvidence(dispatch.stderr.trim() || dispatch.stdout.trim() || "claude --bg exited without a message")
        );
      }

      const deadline = Date.now() + this.#dispatchTimeoutMs;
      for (;;) {
        const handle = await this.#findByName(options.name);
        if (handle !== null) {
          registered = handle;
          break;
        }
        if (Date.now() >= deadline) {
          // The daemon took the dispatch and never surfaced the session: an
          // operational failure the retry loop spends an attempt on, not a
          // refusal — Claude Code did not decline.
          throw new ClaudeRegistrationTimeoutError(
            `dispatched session '${options.name}' in ${options.cwd} did not register within ${this.#dispatchTimeoutMs}ms`
          );
        }
        await delay(500);
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
  async #writeWorkerSettings(dispatchName: string, permissionDenyRules?: string[], cacheTtl?: string): Promise<string> {
    // Spread order is the precedence: the TTL is a harness default the
    // dispatch asks for, so a machine-declared worker_environment value for
    // the same variable (spread after it) wins, and the ownership tag —
    // harness bookkeeping, not configuration — always lands last.
    const env = {
      ...(cacheTtl !== undefined ? { [CLAUDE_CACHE_TTL_VARIABLE]: cacheTtl } : {}),
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
    const dir = await mkdtemp(path.join(tmpdir(), `${SETTINGS_DIR_PREFIX}${dispatchName}-`));
    try {
      await writeFile(path.join(dir, "settings.json"), `${JSON.stringify(settings)}\n`, {
        mode: 0o600
      });
      // Beside the settings file, never inside it: the file stays Claude
      // Code's single-purpose input, and the owner record is the harness's
      // own evidence — this launcher's pid and start ticks — so a later
      // launcher can judge the directory abandoned after an ending this one
      // could not handle (the same evidence the run manifest carries).
      await writeFile(
        path.join(dir, OWNER_FILENAME),
        `${JSON.stringify(await captureProcessOwner(this.#procDir, hostname()))}\n`,
        { mode: 0o600 }
      );
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
   * readable proc filesystem), and a directory with no owner record at all
   * predates owner recording and is judged abandoned under that reason. An
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
        const owner: unknown = await readFile(path.join(dir, OWNER_FILENAME), "utf8")
          .then((text) => JSON.parse(text) as unknown)
          .catch(() => null);
        if ((await judgeOwnerGone(owner, this.#procDir, host)) !== null) {
          await this.#removeSettingsDir(dir);
        }
      } catch {
        // One unjudgeable directory must not end the sweep.
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

    try {
      // A pre-existing tmux server starts the pane's command from the
      // *server's* environment, not this client's, so the declared worker
      // variables must ride explicit `-e` flags (tmux >= 3.2) to reach the
      // `claude attach` child. Without them the injection silently covers
      // only the server-started-here case.
      const environmentFlags = Object.entries(this.#launchEnv).flatMap(([name, value]) => [
        "-e",
        `${name}=${value}`
      ]);
      const created = await this.#run(this.#tmuxBin, [
        "new-session",
        "-d",
        ...environmentFlags,
        "-s",
        valve,
        `${this.#claudeBin} attach ${handle.id}`
      ]);
      if (!created.ok) {
        return refused("tmux new-session", created);
      }

      // The TUI needs a beat to attach and take focus before input lands.
      await delay(this.#valveAttachSettleMs);
      // `-l` sends the message literally — no key-name interpretation, no quoting
      // hazards. Each call carries one bounded slice: a follow-up turn routinely
      // holds whole diffs, and one command must fit both the platform's argv
      // element cap and tmux's own client-message cap (see VALVE_SLICE_BYTES),
      // so the bytes go to the same pane input in order across as many calls
      // as the message needs. Submit follows as its own keystroke.
      const slices = valveSlices(message);
      for (const [index, slice] of slices.entries()) {
        const typed = await this.#run(this.#tmuxBin, ["send-keys", "-t", valve, "-l", slice]);
        if (!typed.ok) {
          return refused(`tmux send-keys (slice ${index + 1} of ${slices.length})`, typed);
        }
      }
      await delay(this.#valveSubmitSettleMs);
      const submitted = await this.#run(this.#tmuxBin, ["send-keys", "-t", valve, "Enter"]);
      if (!submitted.ok) {
        return refused("tmux send-keys (submit)", submitted);
      }
      await delay(this.#valveKillSettleMs);
      return { delivered: true };
    } finally {
      await this.#run(this.#tmuxBin, ["kill-session", "-t", valve]);
    }
  }

  async stop(handle: ClaudeSessionHandle): Promise<void> {
    // Best-effort teardown; `stop`/`rm` can mishandle an already-exited session,
    // so failures are swallowed rather than allowed to mask the real result.
    await this.#run(this.#claudeBin, ["stop", handle.id]);
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

  async #findByName(name: string): Promise<ClaudeSessionHandle | null> {
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
      id,
      sessionId: match.sessionId,
      name,
      cwd: typeof match.cwd === "string" ? match.cwd : ""
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
    return new Promise<ExecResult>((resolve) => {
      execFile(
        file,
        args,
        { ...(cwd !== undefined ? { cwd } : {}), maxBuffer: 32 * 1024 * 1024, env: this.#env },
        (error, stdout, stderr) => {
          resolve({ ok: error === null, stdout, stderr });
        }
      );
    });
  }

  #runWithInput(file: string, args: string[], input: string, cwd?: string): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve) => {
      const child = spawn(file, args, {
        ...(cwd !== undefined ? { cwd } : {}),
        env: this.#env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const finish = (result: ExecResult): void => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
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
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
    });
  }
}

interface RosterRow {
  id?: unknown;
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
 * `VALVE_SLICE_BYTES` bytes each, cutting only between code points so no
 * character is torn across two sends. Exported for the delivery tests; a
 * message within the bound is one slice, and an empty message is none.
 */
export function valveSlices(message: string): string[] {
  const slices: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of message) {
    const characterBytes = Buffer.byteLength(character, "utf8");
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

