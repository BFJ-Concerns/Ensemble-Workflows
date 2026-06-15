import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { ClaudeDispatchError } from "./errors.js";

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
  /** Inject a message into the live session (the valve). Returns false if it could not. */
  steer(handle: ClaudeSessionHandle, message: string): Promise<boolean>;
  /** Tear the session down (stop + remove). Best-effort; never throws. */
  stop(handle: ClaudeSessionHandle): Promise<void>;
  /** Whether the tmux valve is usable; gates in-session correction and blocked recovery. */
  tmuxAvailable(): Promise<boolean>;
}

export interface ClaudeDispatchOptions {
  prompt: string;
  /** Unique per dispatch — how the freshly spawned session is found in the roster. */
  name: string;
  cwd: string;
  model?: string;
  effort?: string;
}

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
  /** Defaults to `~/.claude/projects`. */
  projectsDir?: string;
  /** How long to wait for a dispatched session to register in the roster. */
  dispatchTimeoutMs?: number;
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
  #valveAttachSettleMs: number;
  #valveSubmitSettleMs: number;
  #valveKillSettleMs: number;
  #valveCounter = 0;

  constructor(options: ClaudeCliControlPlaneOptions = {}) {
    this.#claudeBin = options.claudeBin ?? "claude";
    this.#tmuxBin = options.tmuxBin ?? "tmux";
    this.#projectsDir = options.projectsDir ?? path.join(homedir(), ".claude", "projects");
    this.#dispatchTimeoutMs = options.dispatchTimeoutMs ?? 30_000;
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
    args.push(options.prompt);

    const dispatch = await this.#run(this.#claudeBin, args, options.cwd);
    // `claude --bg` prints the short id and returns; if it failed outright there
    // is no session to wait for, so surface immediately with its stderr.
    if (!dispatch.ok && (await this.#findByName(options.name)) === null) {
      throw new ClaudeDispatchError(
        `claude --bg failed to dispatch '${options.name}': ${dispatch.stderr.trim() || dispatch.stdout.trim()}`
      );
    }

    const deadline = Date.now() + this.#dispatchTimeoutMs;
    for (;;) {
      const handle = await this.#findByName(options.name);
      if (handle !== null) {
        return handle;
      }
      if (Date.now() >= deadline) {
        throw new ClaudeDispatchError(
          `dispatched session '${options.name}' did not register within ${this.#dispatchTimeoutMs}ms`
        );
      }
      await delay(500);
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

  async steer(handle: ClaudeSessionHandle, message: string): Promise<boolean> {
    if ((await this.poll(handle)).present === false) {
      return false;
    }

    this.#valveCounter += 1;
    const valve = `ensemble-valve-${handle.id}-${this.#valveCounter}`;

    try {
      const created = await this.#run(this.#tmuxBin, [
        "new-session",
        "-d",
        "-s",
        valve,
        `${this.#claudeBin} attach ${handle.id}`
      ]);
      if (!created.ok) {
        return false;
      }

      // The TUI needs a beat to attach and take focus before input lands.
      await delay(this.#valveAttachSettleMs);
      // `-l` sends the message literally — no key-name interpretation, no quoting
      // hazards. Submit follows as its own keystroke.
      await this.#run(this.#tmuxBin, ["send-keys", "-t", valve, "-l", message]);
      await delay(this.#valveSubmitSettleMs);
      await this.#run(this.#tmuxBin, ["send-keys", "-t", valve, "Enter"]);
      await delay(this.#valveKillSettleMs);
      return true;
    } finally {
      await this.#run(this.#tmuxBin, ["kill-session", "-t", valve]);
    }
  }

  async stop(handle: ClaudeSessionHandle): Promise<void> {
    // Best-effort teardown; `stop`/`rm` can mishandle an already-exited session,
    // so failures are swallowed rather than allowed to mask the real result.
    await this.#run(this.#claudeBin, ["stop", handle.id]);
    await this.#run(this.#claudeBin, ["rm", handle.id]);
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
        { ...(cwd !== undefined ? { cwd } : {}), maxBuffer: 32 * 1024 * 1024, env: process.env },
        (error, stdout, stderr) => {
          resolve({ ok: error === null, stdout, stderr });
        }
      );
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

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
