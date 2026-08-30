/* global process */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The dead-vs-live reading a cold archive consumer makes for itself.
 *
 * A durable `in-progress` manifest says nothing about whether its writer is
 * still running: a SIGKILLed run and a live one are byte-identical until
 * some later writer's reap sweeps the namespace, and no consumer should
 * have to wait for that (or start a run to trigger it). The evidence is
 * already in the manifest's `owner` block, so a consumer answers the
 * question from that block on the same conservative terms the reaper uses:
 * only a provably-gone owner on this host is `dead`; an owner on another
 * machine, one recorded without proc evidence, and a proc filesystem this
 * consumer cannot read all yield `undecidable`.
 *
 * `live` means the recorded pid is present with matching start ticks — the
 * writer is running now. A terminal manifest is `settled`: its own status
 * already answers the question. The reading is evidence-only: it reads the
 * archive and the process table, and rewrites nothing.
 */
export async function judgeArchivedRunLiveness(manifest, { procDir = "/proc", host = os.hostname() } = {}) {
  if (manifest.status !== "in-progress") {
    return { verdict: "settled", reason: null };
  }
  const owner = manifest.owner;
  if (owner === null || owner === undefined) {
    return { verdict: "dead", reason: "manifest-predates-owner-recording" };
  }
  if (typeof owner !== "object" || typeof owner.pid !== "number" || owner.host !== host) {
    return { verdict: "undecidable", reason: null };
  }
  if (typeof owner.start_ticks !== "string") {
    // Recorded without proc evidence (a platform with no readable proc
    // filesystem): liveness is unjudgeable from this block.
    return { verdict: "undecidable", reason: null };
  }
  const liveTicks = await readProcessStartTicks(procDir, owner.pid);
  if (liveTicks === owner.start_ticks) {
    return { verdict: "live", reason: null };
  }
  // The judging side needs a readable proc filesystem too: distinguish "the
  // pid is gone" from "proc itself is unreadable here" by probing this
  // reader's own pid before treating an absent stat as evidence of death.
  if (liveTicks === null && (await readProcessStartTicks(procDir, process.pid)) === null) {
    return { verdict: "undecidable", reason: null };
  }
  return { verdict: "dead", reason: "owner-process-gone" };
}

/**
 * The process's start time in clock ticks since boot — field 22 of
 * `/proc/<pid>/stat`, parsed after the parenthesised comm field (which may
 * itself contain spaces and parentheses, hence the last-close-paren split).
 * Null where the stat file cannot be read: pid gone, or no proc filesystem.
 */
async function readProcessStartTicks(procDir, pid) {
  try {
    const statLine = await readFile(path.join(procDir, String(pid), "stat"), "utf8");
    const afterComm = statLine.slice(statLine.lastIndexOf(")") + 2);
    return afterComm.split(" ")[19] ?? null;
  } catch {
    return null;
  }
}
