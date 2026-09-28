import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Liveness evidence for the process that owns a durable artefact — a run
 * manifest, a per-dispatch settings directory — written once when the
 * artefact is created, so that after the owner dies a later process can
 * decide, from evidence rather than age, whether the artefact is abandoned.
 * `start_ticks` is the discriminator against pid reuse; a null-ticks owner
 * (recorded where no proc filesystem was readable) is never judged gone,
 * because evidence that was never recorded cannot be judged.
 */
export interface ProcessOwnerRecord {
  pid: number;
  start_ticks: string | null;
  host: string;
}

/** Why an owner was judged gone: its process is provably absent, or the artefact predates owner recording altogether. */
export type OwnerGoneReason = "owner-process-gone" | "manifest-predates-owner-recording";

/** This process's own owner record, as an artefact it creates should carry it. */
export async function captureProcessOwner(procDir: string, host: string): Promise<ProcessOwnerRecord> {
  return {
    pid: process.pid,
    start_ticks: await readProcessStartTicks(procDir, process.pid),
    host
  };
}

/**
 * Same-host, evidence-only judgement of whether an artefact's recorded
 * owner is gone. Conservative on every unjudgeable case: another host, no
 * recorded ticks, or a proc filesystem the judging side itself cannot read
 * all answer null ("possibly live"). An artefact with no owner block at all
 * predates owner recording and is judged gone under its own reason — the
 * one non-evidential verdict, accepted as transition-era cost.
 */
export async function judgeOwnerGone(owner: unknown, procDir: string, host: string): Promise<OwnerGoneReason | null> {
  if (owner === undefined || owner === null) {
    return "manifest-predates-owner-recording";
  }
  if (typeof owner !== "object") {
    return null;
  }
  const record = owner as Partial<ProcessOwnerRecord>;
  if (typeof record.pid !== "number" || record.host !== host) {
    return null;
  }
  if (typeof record.start_ticks !== "string") {
    // Recorded without proc evidence (a platform with no readable proc
    // filesystem): liveness is unjudgeable, so the artefact stays as written.
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
