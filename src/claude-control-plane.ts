import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import { claudeConfigDirectory, claudeValveDirectory, temporaryDirectory } from "./engine-resources.js";
import { launchEnvironment, SANDBOXED_WORKSPACE_VARIABLE } from "./engine-environment.js";
import { attachFailedTurnResult, ClaudeDispatchError, ClaudeRegistrationTimeoutError, EngineShutdownError } from "./errors.js";
import { HOLD_SCOPE_ENV, resolveHoldScope } from "./holds.js";
import { captureProcessOwner, judgeOwnerGone } from "./process-owner-evidence.js";
import { boundedEvidence } from "./operator-diagnosis.js";
import { claudeToolSurfaceProbePrompt, readClaudeToolSurface, type ClaudeToolSurface } from "./claude-tool-surface.js";
import { startCaptureProvider } from "./provider-capture.js";
import { DEFAULT_COMMAND_BOUNDS, runOwnedCommand, type CommandBounds, type CommandResult } from "./owned-command.js";
import type { JsonObject, RuntimeEvent } from "./types.js";
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
  /**
   * Launch a background session and submit the opening prompt to it. Like
   * the valve, a launch attests submission and never delivery: whether the
   * prompt arrived as sent is the opening's receipt (`submissionReceipt`),
   * which the engine reads from the session's transcript.
   *
   * - Resolves — a session is registered and the prompt was submitted to
   *   it, by whatever route the launch uses. A launch that has a registered
   *   session and cannot tell whether it took the prompt resolves too: a
   *   wrong rejection hands the prompt to a second worker while the first
   *   may be running it, and a wrong resolution costs one missing receipt.
   * - Rejects — no session holds the prompt, and nothing the launch started
   *   is left running. Only then may the same prompt be launched again, on
   *   this target or on the next entry of the call's fallback chain, which
   *   is what classing a rejection as the target being unavailable relies on
   *   (`ClaudeDispatchError`, `ClaudeRegistrationTimeoutError`). A failure
   *   that leaves a session holding any part of the prompt is never
   *   reported by rejecting.
   * - Rejects with the reason of `options.signal` — the caller cancelled
   *   before the opening was submitted. No session holds the prompt, but
   *   the launch may still be running or about to register a session:
   *   that residue stays the control plane's to end (see `close`), and the
   *   caller's wait does not carry it. Cancellation is the caller's
   *   choice, not the target's failure, so it advances no fallback chain.
   */
  dispatch(options: ClaudeDispatchOptions): Promise<ClaudeSessionHandle>;
  /** One reading of the session's lifecycle state. */
  poll(handle: ClaudeSessionHandle): Promise<ClaudeSessionStatus>;
  /** Locate the session's JSONL transcript on disk, or null if not yet present. */
  transcriptPath(handle: ClaudeSessionHandle): Promise<string | null>;
  /**
   * Type a message into the live session and submit it (the valve). The
   * result says whether the message was submitted, never whether it arrived:
   * see `ValveSubmission`.
   */
  steer(handle: ClaudeSessionHandle, message: string): Promise<ValveSubmission>;
  /** Tear the session down (stop + remove). Best-effort; never throws. */
  stop(handle: ClaudeSessionHandle): Promise<void>;
  /** Whether the tmux valve is usable; gates in-session correction and blocked recovery. */
  tmuxAvailable(): Promise<boolean>;
  /**
   * Read the tool surface a worker dispatched with these inputs would be
   * offered (see `claude-tool-surface.ts`). Optional: a control plane
   * without it cannot prepare a strip, so every Claude strip refuses
   * before spawn.
   *
   * The CLI control plane launches the probe exactly as `dispatch` launches
   * a worker: the same executable, daemon, `cwd`, model pin, launch
   * environment, and per-dispatch settings file with the declared worker
   * variables and these deny rules and `env` variables, written as
   * `dispatch` writes a strip's. The probe has no effort pin, since
   * effort does not change the tool surface. One variable is added to the
   * settings `env` block: `ANTHROPIC_BASE_URL`, set to the `origin` of a
   * capture provider (`startCaptureProvider`) that this probe owns. A
   * declared value for that variable is overridden, because the probe must
   * not reach a real provider. A worker environment that routes Claude
   * through Bedrock, Vertex or another provider switch would bypass the
   * capture provider, so the probe rejects it rather than send a request
   * there. The opening prompt is `claudeToolSurfaceProbePrompt(nonce)`.
   * The probe waits until the session stops sending requests: its turn has
   * ended, or one second has passed with no new capture. It then stops the
   * session with `stop`'s full teardown, closes the provider, and returns
   * `readClaudeToolSurface(requests, nonce)`. When `signal` aborts, it tears
   * everything down and rejects.
   */
  probeToolSurface?: ClaudeToolSurfaceProbe;
  /**
   * End what cancelled launches left behind: every dispatch whose caller
   * cancelled before its session was accepted. A session registered under
   * such a dispatch's name is stopped and removed with its settings, as
   * `stop` does. Bounded; never throws; a second call awaits the first.
   * What cannot be confirmed within the bound is reported, never waited
   * for (`ClaudeCliControlPlane.close` states the unconfirmed case).
   * Called once, when the engine that owns this control plane closes.
   */
  close(): Promise<void>;
}

/** One probe: what the probe session is launched with, and the bound that tears it down. */
export interface ClaudeToolSurfaceProbeRequest {
  cwd: string;
  model?: string;
  /** Empty for the inventory probe; the derived rules for the confirming one. */
  permissionDenyRules: readonly string[];
  /** Empty for the inventory probe; the derived strip's removal variables for the confirming one. */
  settingsEnv: Readonly<Record<string, string>>;
  signal: AbortSignal;
}

export type ClaudeToolSurfaceProbe = (request: ClaudeToolSurfaceProbeRequest) => Promise<ClaudeToolSurface>;

/**
 * What the valve can attest about one injection: whether it submitted the
 * message. Submission is not delivery. Once the submit keystroke is
 * accepted the session may run a turn on whatever text it received, and
 * only the session's transcript says what that text was — the receipt
 * (`submissionReceipt`), which the engine reads, not the valve.
 *
 * - `submitted: false` — nothing was submitted, the session's conversation
 *   is as it was, and the same message may be sent again. The reason names
 *   the step that failed and what it said, so the turn's failure record
 *   carries the cause.
 * - `submitted: true` — the submit keystroke was accepted. A failure the
 *   valve cannot place before that keystroke is reported this way too: a
 *   wrong "not submitted" invites a second copy of a message the session
 *   already holds, while a wrong "submitted" costs one missing receipt.
 */
export type ValveSubmission = { submitted: true } | { submitted: false; reason: string };

export interface ClaudeDispatchOptions {
  /** The opening text submitted by launch; the engine verifies its receipt. */
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
   * The rules come from a strip preparation (`ClaudeStripPreparer`), whose
   * confirming probe ran under these same rules and was offered none of
   * the denied tools.
   */
  permissionDenyRules?: readonly string[];
  /**
   * Settings `env` variables that remove tools the deny rules do not reach
   * (capability stripping; `CLAUDE_TOOL_REMOVAL_ENV`). Written to the same
   * settings file's `env` block after the declared worker variables, so no
   * declaration can give a stripped worker the tool back.
   */
  settingsEnv?: Readonly<Record<string, string>>;
  /**
   * Cancels the dispatch while it waits for its session — a caller's
   * deadline, or the engine closing. The launch command is ended within
   * the control plane's command bounds and the call rejects with the
   * signal's reason; once the opening has been submitted, the signal no
   * longer applies and the session is the caller's like any other.
   */
  signal?: AbortSignal;
}


export interface ClaudeSessionHandle {
  /** Short daemon id — used to attach/steer/stop. */
  id: string;
  /** Full session UUID — names the transcript file. */
  sessionId: string;
  name: string;
  cwd: string;
  /** A launch that could not be safely rejected retains its original account. */
  launchFailure?: { message: string; diagnostics: JsonObject };
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
  /**
   * How long a cancelled control command may take to end (`CommandBounds`:
   * SIGTERM, then SIGKILL after `stopGraceMs`, then `drainMs` for its
   * streams). Every `claude` and `tmux` command this control plane starts
   * runs under it. It is what a cancelled dispatch adds to its caller's
   * deadline before the launch command is gone: a caller that aborts at
   * its deadline has its rejection at once, and the command it owned is
   * ended no later than this bound after.
   */
  commandBounds?: CommandBounds;
  /**
   * Bound on `close()`'s reclamation of cancelled launches: their commands
   * settling, one roster read, and the teardown of every session found.
   * Defaults to 30 seconds. A session that registers only after that
   * read, or whose teardown the bound cuts short, is reported, not owned
   * any longer.
   */
  reclaimTimeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL when reaping tagged descendants at stop(). */
  reapGraceMs?: number;
  /** The proc filesystem root the reaper scans. Injectable for tests; on a platform without one the reap is a no-op. */
  procDir?: string;
  /** tmux valve settle times after attach, before submit and before kill. */
  valveAttachSettleMs?: number;
  valveSubmitSettleMs?: number;
  valveKillSettleMs?: number;
  /** Bound for the editor-copy wait; defaults to 30 seconds. */
  valveDeliveryTimeoutMs?: number;
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

/**
 * A dispatch whose caller cancelled before its session was accepted. The
 * dispatch's name is the authority over it: the name is unique per
 * dispatch, the roster lists a registered session under it, and every
 * process the session starts carries it (`WORKER_MARKER_VARIABLE`). The
 * settings directory stays while the launch may still read it.
 */
interface UnclaimedLaunch {
  name: string;
  settingsDir: string;
  /** The launch command's settlement, bounded by the command bounds. */
  command: Promise<CommandResult>;
}

/**
 * The real control plane: drives `claude` and `tmux` as child processes. The
 * reply valve loads a private UTF-8 file through the attached prompt editor,
 * submits once, and closes its private tmux server. The engine verifies
 * the native receipt; the daemon owns the held session.
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
  #valveDeliveryTimeoutMs: number;
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
  #commandBounds: CommandBounds;
  #reclaimTimeoutMs: number;
  /** Cancelled launches this control plane still owns, by dispatch name; `close()` ends them. */
  #unclaimed = new Map<string, UnclaimedLaunch>();
  /** Dispatches still waiting for their session: `close()` cancels them and waits for each to settle. */
  #inFlight = new Set<Promise<void>>();
  /** Aborted by `close()`; every dispatch listens to it beside its caller's own signal. */
  #closeController = new AbortController();
  #closing: Promise<void> | null = null;

  constructor(options: ClaudeCliControlPlaneOptions = {}) {
    this.#claudeBin = options.claudeBin ?? "claude";
    this.#tmuxBin = options.tmuxBin ?? "tmux";
    // The declared map is kept beside the launch environment: the
    // per-dispatch settings file carries it to the worker session (see
    // #writeWorkerSettings()).
    this.#workerEnv = options.workerEnv ?? {};
    this.#holdScope = options.holdScope === undefined ? resolveHoldScope(undefined, process.env) : options.holdScope;
    // The operator's environment minus the run's own settings, the
    // declared variables above it, the sandboxed-workspace declaration last
    // (see `launchEnvironment`).
    this.#env = launchEnvironment("claude", this.#workerEnv);
    const configDir = claudeConfigDirectory(this.#env, process.cwd());
    this.#projectsDir = options.projectsDir ?? path.join(configDir, "projects");
    this.#dispatchTimeoutMs = options.dispatchTimeoutMs ?? 30_000;
    this.#commandBounds = options.commandBounds ?? DEFAULT_COMMAND_BOUNDS;
    this.#reclaimTimeoutMs = options.reclaimTimeoutMs ?? 30_000;
    this.#reapGraceMs = options.reapGraceMs ?? 5_000;
    this.#procDir = options.procDir ?? "/proc";
    this.#valveAttachSettleMs = options.valveAttachSettleMs ?? 4_000;
    this.#valveSubmitSettleMs = options.valveSubmitSettleMs ?? 0;
    this.#valveKillSettleMs = options.valveKillSettleMs ?? 0;
    this.#valveDeliveryTimeoutMs = options.valveDeliveryTimeoutMs ?? 30_000;
    this.#valveSocketRoot = claudeValveDirectory(process.env);
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

  async probeToolSurface(request: ClaudeToolSurfaceProbeRequest): Promise<ClaudeToolSurface> {
    const signal = AbortSignal.any([request.signal, this.#closeController.signal]);
    signal.throwIfAborted();
    // These provider switches ignore ANTHROPIC_BASE_URL. Refuse rather than
    // letting an inventory probe reach a hosted provider.
    for (const key of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) {
      const value = this.#env[key];
      if (value !== undefined && value !== "0" && value !== "false" && value !== "") {
        throw new Error(`tool-surface capture cannot override ${key}`);
      }
    }
    const provider = await startCaptureProvider();
    const nonce = randomUUID();
    let handle: ClaudeSessionHandle | undefined;
    try {
      handle = await this.dispatch({
        prompt: claudeToolSurfaceProbePrompt(nonce),
        name: `ensemble-tool-surface-${nonce}`,
        cwd: request.cwd,
        ...(request.model !== undefined ? { model: request.model } : {}),
        permissionDenyRules: [...request.permissionDenyRules],
        settingsEnv: { ...request.settingsEnv, ANTHROPIC_BASE_URL: provider.origin },
        signal
      });
      if (handle.launchFailure !== undefined) throw new Error(handle.launchFailure.message);
      let count = 0;
      let lastCapture = Date.now();
      for (;;) {
        signal.throwIfAborted();
        const captures = provider.requests();
        if (captures.length !== count) {
          count = captures.length;
          lastCapture = Date.now();
        }
        // Wait for at least one nonce-bearing Messages request. A title or
        // telemetry request alone cannot establish the worker's surface.
        let surface: ClaudeToolSurface | undefined;
        try { surface = readClaudeToolSurface(captures, nonce); } catch { /* Keep waiting for the worker's request. */ }
        if (surface !== undefined && Date.now() - lastCapture >= 1_000) return surface;
        const status = await this.#poll(handle, signal);
        signal.throwIfAborted();
        if (!status.present || status.state === "done") return readClaudeToolSurface(provider.requests(), nonce);
        await sleep(100, undefined, { signal });
      }
    } finally {
      try {
        if (handle !== undefined) {
          const cleanup = AbortSignal.timeout(this.#reclaimTimeoutMs);
          const confirmed = await this.#stopSession(handle, true, cleanup).catch(() => false);
          if (!confirmed) {
            this.#onEvent?.({
              method: "claude/launchUnreclaimed",
              params: { name: handle.name, reason: "tool-surface probe session cleanup was not confirmed within the reclamation bound" },
              receivedAt: Date.now()
            });
          }
        }
      } finally { await provider.close(); }
      signal.throwIfAborted();
    }
  }

  async dispatch(options: ClaudeDispatchOptions): Promise<ClaudeSessionHandle> {
    // The caller's cancellation and the control plane's own closing end the
    // wait alike; after close() every dispatch is refused here.
    const signal = options.signal === undefined
      ? this.#closeController.signal
      : AbortSignal.any([options.signal, this.#closeController.signal]);
    signal.throwIfAborted();
    const settled = Promise.withResolvers<void>();
    this.#inFlight.add(settled.promise);
    try {
      return await this.#dispatch(options, signal);
    } finally {
      this.#inFlight.delete(settled.promise);
      settled.resolve();
    }
  }

  async #dispatch(options: ClaudeDispatchOptions, signal: AbortSignal): Promise<ClaudeSessionHandle> {
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
    const settingsDir = await this.#writeWorkerSettings(options.name, options.permissionDenyRules, options.settingsEnv);
    args.push("--settings", path.join(settingsDir, "settings.json"));
    let registered: ClaudeSessionHandle | null = null;
    let candidate: { handle: ClaudeSessionHandle; pid: number | null; row: RosterRow } | null = null;
    const dispatch: { result: CommandResult | null } = { result: null };
    let accepted = false;
    let discarded = false;
    let unclaimed = false;
    let lastSeen: { handle: ClaudeSessionHandle; pid: number | null; row: RosterRow } | null = null;
    try {
      signal?.throwIfAborted();
      // Start an empty native session. The complete opening rides the same
      // file-backed editor as later turns, avoiding Claude's stdin reader,
      // duplicated dispatch-file payload and cold-spawn argument limit.
      // The launch command shares the dispatch's signal, so cancelling ends
      // the command itself within the command bounds.
      const launch = this.#launch(this.#claudeBin, args, { input: "", cwd: options.cwd, signal });
      void launch.then((result) => (dispatch.result = result));
      // Cancelled before the opening was submitted: no session holds the
      // prompt. Whether the launch already asked the supervisor for a
      // session cannot be known here — a registration can be one roster read
      // newer than the last, and a dying command may already have been
      // answered — so the name and its settings pass to the control plane,
      // which ends them at close(), and the caller's wait ends now.
      const releaseIfCancelled = (): void => {
        if (!signal.aborted) return;
        this.#unclaimed.set(options.name, { name: options.name, settingsDir, command: launch });
        unclaimed = true;
        signal.throwIfAborted();
      };
      let deadline: number | null = null;
      let placementDeadline: number | null = null;
      let placed = false;
      let placementPid: number | null = null;
      for (;;) {
        releaseIfCancelled();
        candidate = await this.#findByName(options.name, signal);
        // A roster read the signal cut short reads as no candidate, and a
        // command the signal ended reads as a failed launch: neither is
        // evidence about the target, so cancellation is judged first.
        releaseIfCancelled();
        if (candidate !== null) {
          registered = candidate.handle;
          lastSeen = candidate;
          // Placement still starts before the dispatch command returns.
          // A seeded row without a pid is not a running session.
          if (candidate.pid !== placementPid) {
            placed = false;
            placementDeadline = null;
            placementPid = candidate.pid;
          }
          if (candidate.pid !== null && !placed) {
            placementDeadline ??= Date.now() + this.#placementSettleMs;
            const outcome = await this.#observePlacement(this.#place(registered, candidate.pid), signal);
            placed = outcome.kind !== "refused" || Date.now() >= placementDeadline;
          }
        }
        if (dispatch.result !== null) {
          if (!dispatch.result.ok) {
            throw new ClaudeDispatchError(
              `Claude dispatch command failed for worker '${options.name}' in ${options.cwd} ` +
              `(workspace declared sandboxed via ${SANDBOXED_WORKSPACE_VARIABLE}): ` +
              launchAccount(dispatch.result)
            );
          }
          deadline ??= Date.now() + this.#dispatchTimeoutMs;
          if (candidate !== null && candidate.pid !== null && placed) break;
          if (Date.now() >= deadline) {
            throw new ClaudeRegistrationTimeoutError(
              `dispatched session '${options.name}' in ${options.cwd} did not start within ${this.#dispatchTimeoutMs}ms; ` +
              launchAccount(dispatch.result) + `; roster: ${boundedEvidence(JSON.stringify(lastSeen))}`
            );
          }
        }
        await delay(100, signal);
      }
      if (registered === null || dispatch.result === null) throw new Error("Claude dispatch lost its ready session");
      releaseIfCancelled();
      const handle = registered;
      // Register ownership before opening delivery so every failure can use
      // stop()'s complete teardown, including tagged descendants and settings.
      this.#settingsDirs.set(handle.sessionId, settingsDir);
      signal?.throwIfAborted();
      const delivery = await this.steer(handle, options.prompt);
      if (!delivery.submitted) {
        throw new ClaudeRegistrationTimeoutError(
          `Claude opening submission failed for worker '${options.name}' in ${options.cwd}: ${delivery.reason}; ` +
          launchAccount(dispatch.result)
        );
      }
      accepted = true;
      if (!(this.#scopes instanceof NoWorkerScopes)) {
        this.#watchedSessions.set(handle.sessionId, handle);
        this.#schedulePlacementWatch();
      }
      return handle;
    } catch (error) {
      // A cancellation's residue is the control plane's, and its reason is
      // the caller's own value: no launch account is attached to it.
      if (unclaimed) throw error;
      if (error instanceof Error) {
        const logs = registered === null ? null : await this.#run(this.#claudeBin, ["logs", registered.id]).catch(() => null);
        const file = registered === null ? null : await this.transcriptPath(registered).catch(() => null);
        const transcript = file === null ? null : await readFile(file, "utf8").catch(() => null);
        const diagnostics = { claudeLaunch: {
          failure: error.message,
          cleanupConfirmed: registered === null,
          command: dispatch.result === null ? null : { ...dispatch.result },
          roster: lastSeen === null ? null : JSON.parse(JSON.stringify(lastSeen.row)),
          logs: logs === null ? null : { ...logs }
        } };
        if (registered !== null) {
          discarded = await this.#stopSession(registered, true).catch(() => false);
          diagnostics.claudeLaunch.cleanupConfirmed = discarded;
          if (!discarded) {
            // No rejection may hand this prompt to another target while a
            // launch we could not remove still exists. The engine owns its
            // receipt and subsequent teardown, including the original account.
            registered.launchFailure = { message: error.message, diagnostics };
            accepted = true;
            this.#settingsDirs.set(registered.sessionId, settingsDir);
            if (!(this.#scopes instanceof NoWorkerScopes)) {
              this.#watchedSessions.set(registered.sessionId, registered);
              this.#schedulePlacementWatch();
            }
            return registered;
          }
        }
        attachFailedTurnResult(error, {
          text: "", deltaText: "", durationMs: null, firstDeltaMs: null, items: {}, tokenUsageEvents: [],
          diagnostics,
          ...(transcript === null ? {} : { transcripts: [{
            filename: "transcript.claude.jsonl", format: "jsonl", source: "claude-session-jsonl",
            sessionId: registered!.sessionId, content: transcript, partial: true
          }] })
        });
      }
      throw error;
    } finally {
      if (!accepted && !unclaimed) {
        if (registered !== null && !discarded) await this.stop(registered);
        await this.#removeSettingsDir(settingsDir);
      }
    }
  }

  /**
   * Write the per-dispatch settings file carrying the declared worker
   * environment, a strip's removal variables over it, and the dispatch's
   * ownership tag (`WORKER_MARKER_VARIABLE`).
   * Written on every dispatch: the tag is what lets `stop()` reap the
   * worker's surviving descendants, so an untagged worker would be an
   * unowned one. (This supersedes the earlier no-declaration-no-flag
   * behaviour, which predated descendant ownership.) The file can carry
   * credentials — gateway values among the declared variables — so it lives
   * in its own mkdtemp directory (0o700 by construction, unguessable name)
   * and the file itself is 0o600.
   */
  async #writeWorkerSettings(
    dispatchName: string,
    permissionDenyRules?: readonly string[],
    stripEnv?: Readonly<Record<string, string>>
  ): Promise<string> {
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
      ...stripEnv,
      [WORKER_MARKER_VARIABLE]: dispatchName
    };
    // The deny block joins the same single-purpose file rather than a second
    // artefact. The measured additive layering (2026-08-07) covered the
    // env block; that deny rules likewise union across layers and beat
    // every allow is Claude Code's documented model, held as a judgement
    // until a live test observes it at a real worker. Either
    // way the file carries only this dispatch's rules and never touches the
    // operator's own permission configuration.
    const settings = {
      env,
      // Ensemble owns placement: cwd is the caller's checkout, or the
      // worktree Ensemble created for isolation. Claude's default background
      // isolation would move edits into a second, hidden worktree instead.
      // This per-session setting reaches the daemon without changing the
      // operator's project or user settings (measured on Claude Code 2.1.321).
      worktree: { bgIsolation: "none" },
      ...(permissionDenyRules !== undefined && permissionDenyRules.length > 0
        ? { permissions: { deny: permissionDenyRules } }
        : {})
    };
    // The owner record is captured before the directory exists and written
    // first: a concurrent launcher's sweep that finds a directory with no
    // readable owner record leaves it alone, so the only window in which
    // this directory could be misjudged — between mkdtemp and the owner
    // write — is one the sweep treats as unjudgeable, never as abandoned.
    const owner = `${JSON.stringify(await captureProcessOwner(this.#procDir, hostname()))}\n`;
    const dir = await mkdtemp(path.join(temporaryDirectory(process.env, process.cwd()).path, `${SETTINGS_DIR_PREFIX}${dispatchName}-`));
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
    const root = temporaryDirectory(process.env, process.cwd()).path;
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
    return this.#poll(handle);
  }

  async #poll(handle: ClaudeSessionHandle, signal?: AbortSignal): Promise<ClaudeSessionStatus> {
    const roster = await this.#roster(signal);
    signal?.throwIfAborted();
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
      await this.#observePlacement(this.#place(handle, record.pid), signal);
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

  async steer(handle: ClaudeSessionHandle, message: string): Promise<ValveSubmission> {
    if ((await this.poll(handle)).present === false) {
      return { submitted: false, reason: "the session is no longer in the daemon's roster" };
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
      return { submitted: false, reason: `valve socket directory failed: ${boundedEvidence(said)}` };
    }
    const server = ["-S", path.join(socketDir, "tmux.sock")];

    let submitAttempted = false;
    try {
      const payload = path.join(socketDir, "prompt.txt");
      const editor = path.join(socketDir, "editor.cjs");
      const copied = path.join(socketDir, "copied");
      await writeFile(payload, message, { mode: 0o600 });
      // The helper takes only Claude's editor filename on argv. All payload
      // bytes remain in private files, independent of argv and tmux caps.
      await writeFile(editor, `#!${process.execPath}
        const fs = require("node:fs");
        fs.copyFileSync(${JSON.stringify(payload)}, process.argv.at(-1));
        fs.writeFileSync(${JSON.stringify(copied)}, "complete", { mode: 0o600 });
      `, { mode: 0o700 });
      const editorCommand = editor;
      const created = await this.#launch(this.#tmuxBin, [
        ...server, "-f", "/dev/null", "new-session", "-d", "-s", valve,
        `${shellQuote(this.#claudeBin)} attach ${shellQuote(handle.id)}`
      ], { input: null, env: { ...this.#env, VISUAL: editorCommand, EDITOR: editorCommand } });
      if (!created.ok) return refused("tmux new-session", created);

      await delay(this.#valveAttachSettleMs);
      const opened = await this.#run(this.#tmuxBin, [...server, "send-keys", "-t", valve, "C-g"]);
      if (!opened.ok) return refused("tmux send-keys (editor)", opened);
      const copyDeadline = Date.now() + this.#valveDeliveryTimeoutMs;
      for (;;) {
        try {
          await access(copied);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (Date.now() >= copyDeadline) {
          return { submitted: false, reason: `prompt editor did not finish copying within ${this.#valveDeliveryTimeoutMs}ms` };
        }
        await delay(50);
      }
      await delay(this.#valveSubmitSettleMs);
      submitAttempted = true;
      const submitted = await this.#run(this.#tmuxBin, [...server, "send-keys", "-t", valve, "Enter"]);
      if (!submitted.ok) return refused("tmux send-keys (submit)", submitted);

      await delay(this.#valveKillSettleMs);
      return { submitted: true };
    } catch (error) {
      return submitAttempted ? { submitted: true } : {
        submitted: false, reason: `reply valve failed before submission: ${boundedEvidence(error instanceof Error ? error.message : String(error))}`
      };
    } finally {
      // The server and all editor files belong to this delivery alone.
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
    if (this.#closeController.signal.aborted || this.#placementTimer !== null || this.#placementSweep !== null || this.#watchedSessions.size === 0) return;
    this.#placementTimer = setTimeout(() => {
      this.#placementTimer = null;
      this.#placementSweep = this.#refreshPlacements().catch((error: unknown) => {
        if (this.#closeController.signal.aborted) return;
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
    const signal = this.#closeController.signal;
    const roster = await this.#roster(signal);
    // An unavailable roster is not evidence that an owned session ended.
    if (!roster.ok) return;
    for (const handle of this.#watchedSessions.values()) {
      const row = roster.rows.find((entry) => matchesHandle(entry, handle));
      if (typeof row?.pid === "number") await this.#observePlacement(this.#place(handle, row.pid), signal);
    }
  }

  /** Observe shared placement work only while this caller still owns its wait. */
  async #observePlacement<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal === undefined) return pending;
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      pending.then(
        value => { signal.removeEventListener("abort", abort); resolve(value); },
        error => { signal.removeEventListener("abort", abort); reject(error); }
      );
      if (signal.aborted) abort();
    });
  }

  async stop(handle: ClaudeSessionHandle): Promise<void> {
    await this.#stopSession(handle).catch(() => false);
  }

  /**
   * Cancel every dispatch still waiting for its session, then end what
   * every cancelled launch left behind, all within `reclaimTimeoutMs`:
   *
   * 1. In-flight dispatches are cancelled and awaited, so a dispatch the
   *    close itself cancelled is among those reclaimed. One already past
   *    cancellation — submitting its opening — returns its session to its
   *    caller, which owns it from there.
   * 2. Each cancelled launch's command is awaited; each settles within the
   *    command bounds of its cancellation.
   * 3. One roster read. A session registered under a cancelled launch's
   *    name is stopped and removed as `stop` does, its settings with it.
   *
   * Unconfirmed, the launch is reported (`claude/launchUnreclaimed`, with
   * the reason) and no longer owned: the roster could not be read, a
   * session's teardown was not confirmed, the launch command's own exit
   * was never observed, or no session had registered by the read. The
   * settings directory is then left where it is, because a launch that is
   * still being served reads it; the next launcher's sweep removes it once
   * this launcher has ended. A session that registers later holds no
   * prompt — the opening is only ever submitted after registration — and
   * carries the dispatch's name in the roster and in its processes'
   * environment.
   */
  close(): Promise<void> {
    this.#closing ??= this.#reclaimUnclaimed();
    return this.#closing;
  }

  async #reclaimUnclaimed(): Promise<void> {
    const signal = AbortSignal.timeout(this.#reclaimTimeoutMs);
    const expired = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    this.#closeController.abort(new EngineShutdownError("claude"));
    await Promise.race([Promise.all(this.#inFlight), expired]);
    if (this.#unclaimed.size === 0) return;
    const launches = [...this.#unclaimed.values()];
    this.#unclaimed.clear();
    const endings = await Promise.race([Promise.all(launches.map((launch) => launch.command)), expired.then(() => null)]);
    const roster = await this.#roster(signal);
    for (const [index, launch] of launches.entries()) {
      const found = roster.ok ? backgroundSessionNamed(roster.rows, launch.name) : null;
      let reason: string | null;
      if (found !== null) {
        this.#settingsDirs.set(found.handle.sessionId, launch.settingsDir);
        reason = (await this.#stopSession(found.handle, true, signal).catch(() => false))
          ? null
          : "the registered session's teardown was not confirmed";
      } else if (!roster.ok) {
        reason = signal.aborted ? "the roster read did not finish within the reclamation bound" : "the roster could not be read";
      } else if (endings === null || endings[index]!.ending === "unconfirmed") {
        reason = "the launch command's exit was not observed";
      } else {
        reason = "no session had registered under the name when the roster was read";
      }
      if (reason !== null) {
        this.#onEvent?.({ method: "claude/launchUnreclaimed", params: { name: launch.name, reason }, receivedAt: Date.now() });
      }
    }
  }

  async #stopSession(handle: ClaudeSessionHandle, requireClean = false, signal?: AbortSignal): Promise<boolean> {
    this.#watchedSessions.delete(handle.sessionId);
    if (this.#watchedSessions.size === 0 && this.#placementTimer !== null) {
      clearTimeout(this.#placementTimer);
      this.#placementTimer = null;
    }
    // A roster read or placement already in flight must finish before teardown
    // removes session state or the registry closes its shared scope manager.
    await this.#observePlacement(Promise.all([this.#placementSweep, this.#placing.get(handle.sessionId)]), signal);
    // Best-effort teardown; `stop`/`rm` can mishandle an already-exited session,
    // so failures are swallowed rather than allowed to mask the real result.
    const stopped = await this.#run(this.#claudeBin, ["stop", handle.id], signal);
    signal?.throwIfAborted();
    this.#placements.delete(handle.sessionId);
    // The session is over; anything still carrying its tag is a descendant
    // the daemon will never reap (they reparent to the user session, not to
    // the harness). Ownership means killing them here, not warning about them.
    await this.#reapTaggedDescendants(handle.name, signal);
    const removed = await this.#run(this.#claudeBin, ["rm", handle.id], signal);
    const roster = await this.#roster(signal);
    const clean = stopped.ok && removed.ok && roster.ok && !roster.rows.some(row => matchesHandle(row, handle)) &&
      (await this.#findTaggedProcesses(handle.name)).length === 0;
    // The session is gone, so its settings file (which carries the declared
    // gateway values) goes with it. Same best-effort discipline as above.
    const settingsDir = this.#settingsDirs.get(handle.sessionId);
    if (settingsDir !== undefined && (clean || !requireClean)) {
      this.#settingsDirs.delete(handle.sessionId);
      await this.#removeSettingsDir(settingsDir);
    }
    return clean;
  }

  /**
   * Kill every surviving process tagged with this dispatch's marker:
   * SIGTERM first, then SIGKILL for anything still alive after the grace
   * period. Best-effort throughout — reaping is cleanup, and a scan or kill
   * failure must never mask the turn's real outcome. On a platform without
   * a readable proc filesystem the scan finds nothing and the reap is a
   * no-op.
   */
  async #reapTaggedDescendants(dispatchName: string, signal?: AbortSignal): Promise<void> {
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
    await delay(this.#reapGraceMs, signal);
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
  async #findByName(name: string, signal?: AbortSignal): Promise<RosterSession | null> {
    return backgroundSessionNamed((await this.#roster(signal)).rows, name);
  }

  // `ok: false` means the query could not be performed (process error, empty or
  // unparseable output, or cancelled by the signal) — distinct from "queried
  // fine, session not listed", which is `{ ok: true, rows: [...] }` with the
  // session simply absent.
  async #roster(signal?: AbortSignal): Promise<{ ok: boolean; rows: RosterRow[] }> {
    const result = await this.#run(this.#claudeBin, ["agents", "--json"], signal);
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

  #run(file: string, args: string[], signal?: AbortSignal): Promise<CommandResult> {
    return this.#launch(file, args, { input: null, ...(signal !== undefined ? { signal } : {}) });
  }

  /**
   * The one route every control-plane child takes: launched by the scope
   * manager (outside the launcher's box, where a systemd user manager is
   * reachable), under the spread `#env` unless the caller names another,
   * with its output collected and its exit status read as the verdict.
   * `input` is streamed to stdin and the stream then closed; null closes it
   * at once. A command given a signal is the caller's to cancel, and ends
   * within the command bounds (`runOwnedCommand`); one without runs to its
   * own end.
   */
  #launch(
    file: string,
    args: string[],
    options: { input: string | null; cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }
  ): Promise<CommandResult> {
    return runOwnedCommand(this.#scopes, file, args, { env: this.#env, ...options, bounds: this.#commandBounds });
  }
}

interface RosterRow {
  [key: string]: unknown;
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

/** A dispatch's roster row, as a handle plus the pid the row names (null until the supervisor reports one). */
interface RosterSession {
  handle: ClaudeSessionHandle;
  pid: number | null;
  row: RosterRow;
}

function backgroundSessionNamed(rows: readonly RosterRow[], name: string): RosterSession | null {
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
    pid: typeof match.pid === "number" && match.pid > 0 ? match.pid : null,
    row: match
  };
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

/** A refused valve step, named with the bounded text tmux gave for it. */
function refused(step: string, result: CommandResult): ValveSubmission {
  const said = result.stderr.trim() || result.stdout.trim() || "exited without a message";
  return { submitted: false, reason: `${step} failed: ${boundedEvidence(said)}` };
}

function launchAccount(result: CommandResult): string {
  return `dispatch exit ${result.exitCode ?? "unknown"}, signal ${result.signal ?? "none"}; ` +
    `stdout: ${boundedEvidence(result.stdout.trim() || "(empty)")}; ` +
    `stderr: ${boundedEvidence(result.stderr.trim() || "(empty)")}`;
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Wait `ms`, or less: an abort of `signal` ends the wait early and quietly, leaving the caller to judge it. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

