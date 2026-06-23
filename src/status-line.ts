import { readFile } from "node:fs/promises";
import path from "node:path";

import { STATUS_FILENAME } from "./status-file.js";

import type { EngineProgressSnapshot, ProgressSnapshot } from "./progress.js";
import type { EngineName } from "./types.js";

// A snapshot whose last update is older than this is treated as a crashed or
// abandoned run — the renderer shows nothing rather than a frozen line.
const STALE_MS = 30_000;

const ENGINE_NAMES: readonly EngineName[] = ["codex", "claude"];

/**
 * Renders one compact line from a progress snapshot — a faithful one-line
 * compression of Claude Code's `/workflows` tree:
 *
 *   ensemble ▸ Verify · codex ⚡3⏳2 48k/100k · claude ⚡1 · ✓12 ✗1 · 2m14s
 *
 * Per-engine spend is kept separate, never summed: the engines denominate
 * different, non-comparable cost models (Codex per-token, Claude allowance).
 */
export function formatStatusLine(snapshot: ProgressSnapshot, nowMs: number): string {
  const parts: string[] = ["ensemble"];

  const head = snapshot.currentPhase ?? snapshot.workflow;
  if (head !== null && head.length > 0) {
    parts.push(`▸ ${head}`);
  }

  for (const engine of ENGINE_NAMES) {
    const segment = engineSegment(engine, snapshot.engines[engine]);
    if (segment !== null) {
      parts.push(segment);
    }
  }

  const { done, failed } = snapshot.totals;
  if (done > 0 || failed > 0) {
    parts.push(failed > 0 ? `✓${done} ✗${failed}` : `✓${done}`);
  }

  const endedAt = snapshot.finishedAt ?? nowMs;
  parts.push(formatDuration(Math.max(0, endedAt - snapshot.startedAt)));

  return parts.join(" · ");
}

/**
 * Reads the published snapshot from `dir` and renders its status line. Returns
 * `null` — print nothing — when the side-channel is off, the live file is
 * absent/corrupt, or the snapshot is stale.
 */
export async function readStatusLine(dir: string | null, now: () => number): Promise<string | null> {
  if (dir === null || dir.length === 0) {
    return null;
  }

  let raw: string;
  try {
    raw = await readFile(path.join(dir, STATUS_FILENAME), "utf8");
  } catch {
    return null;
  }

  let snapshot: unknown;
  try {
    snapshot = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isProgressSnapshot(snapshot)) {
    return null;
  }

  const nowMs = now();
  // Finished snapshots should not be present after normal completion, but keep
  // the guard so stale files from older versions or interrupted writes stay quiet.
  if (snapshot.state === "finished") {
    return null;
  }
  if (nowMs - snapshot.updatedAt > STALE_MS) {
    return null;
  }
  return formatStatusLine(snapshot, nowMs);
}

function engineSegment(engine: EngineName, progress: EngineProgressSnapshot | undefined): string | null {
  // The snapshot is parsed from an untrusted file; a missing engine is possible.
  if (progress === undefined) {
    return null;
  }
  const busy = progress.active > 0 || progress.queued > 0;
  const spent = progress.spent > 0;
  if (!busy && !spent) {
    return null;
  }

  let segment = engine;
  if (busy) {
    segment += ` ⚡${progress.active}`;
    if (progress.queued > 0) {
      segment += `⏳${progress.queued}`;
    }
  }
  if (spent) {
    segment += ` ${formatTokens(progress.spent)}`;
    if (progress.ceiling !== null) {
      segment += `/${formatTokens(progress.ceiling)}`;
    }
  }
  return segment;
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) {
    return String(tokens);
  }
  const thousands = tokens / 1_000;
  // One decimal under 10k (4.8k), whole thousands above (48k).
  return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) {
    return `${hours}h${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

function isProgressSnapshot(value: unknown): value is ProgressSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schema === 1 &&
    typeof candidate.runId === "string" &&
    (candidate.state === "running" || candidate.state === "finished") &&
    typeof candidate.startedAt === "number" &&
    typeof candidate.updatedAt === "number" &&
    typeof candidate.totals === "object" &&
    candidate.totals !== null &&
    typeof candidate.engines === "object" &&
    candidate.engines !== null
  );
}
