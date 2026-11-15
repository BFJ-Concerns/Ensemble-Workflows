import { access } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Prompts for live workers a test holds open until it has looked at them.
 *
 * A held probe is a worker told to write one piece of evidence to a path
 * the test owns, signal that it is ready, and then stay alive — polling in
 * short separate shell commands, so its transcript keeps growing — until
 * the test creates the release file. Release is a condition the test has
 * observed (the evidence read, the process inspected, a record checked),
 * never a sleep: the worker holds for exactly as long as the observation
 * takes, and a test that fails mid-observation releases it in `finally`
 * rather than leaving it to poll until its turn times out.
 *
 * A probe comes in two shapes, by what the worker leaves behind before it
 * holds: a {@link HeldProbe} leaves a file, for a claim about where or
 * whether a worker ran; a {@link PartialOutputProbe} leaves reply text on
 * the engine's transport, for a claim about text a worker had produced when
 * something happened to it mid-turn.
 *
 * The same text drives every engine's workers. Each runs shell commands
 * through a tool without approval prompts, and the procedure needs only a
 * POSIX shell, so no engine gets its own wording. A held session's
 * later turns use the follow-up form, which names the procedure as the one
 * the worker already ran and restates only what changes.
 *
 * The assertions belong to the test: a probe proves nothing about model
 * wording. The reply is a token the test chose, so a settled turn is matched
 * to its probe by that token alone, and the files carry the evidence.
 */

/** The three files a probe and its observer share; the test owns the directory. */
export interface ProbePaths {
  /** Written in full by the worker's shell before it signals readiness. */
  evidence: string;
  /** Created by the worker once the evidence is complete: it is alive and waiting. */
  ready: string;
  /** Created by the test once its observation is done: the worker may finish. */
  release: string;
}

/** The paths for one probe named `name` inside `directory`, which the test creates. */
export function probePaths(directory: string, name: string): ProbePaths {
  return {
    evidence: path.join(directory, `${name}.evidence`),
    ready: path.join(directory, `${name}.ready`),
    release: path.join(directory, `${name}.release`)
  };
}

/**
 * What the worker's shell writes to the evidence path.
 *
 * - `cgroup`: the raw bytes of `/proc/self/cgroup` as read by the shell
 *   running the command. That shell is a child of the worker and inherits
 *   its cgroup, so the file is the kernel's own statement of where the
 *   worker runs (`0::/user.slice/…/<unit>` under cgroup v2).
 * - `marker`: a line the test chose, for a turn whose point is that the
 *   worker ran and was held, not where it ran.
 */
export type ProbeEvidence = { kind: "cgroup" } | { kind: "marker"; content: string };

export interface HeldProbe {
  paths: ProbePaths;
  evidence: ProbeEvidence;
  /**
   * The worker's whole reply once released. Choose it fresh per turn
   * (`RELEASED_<uuid>`), so a reply is matched to its turn and never to an
   * earlier one still in the transcript.
   */
  token: string;
  /**
   * How long the worker keeps polling for the release file before it stops
   * and replies `UNRELEASED` instead of the token. Defaults to ten minutes;
   * the turn's own `timeoutMs` still bounds the turn.
   */
  holdLimitSeconds?: number;
}

/** The reply a probe gives when its hold limit passes with no release file. */
export const UNRELEASED_REPLY = "UNRELEASED";

const DEFAULT_HOLD_LIMIT_SECONDS = 600;
const POLL_INTERVAL_SECONDS = 5;

/** The first turn's text: the whole procedure, for a worker that has not seen it. */
export function heldProbePrompt(probe: HeldProbe): string {
  const { paths, token } = probe;
  return [
    "You are a probe in an automated test. Carry out the four steps below with your shell tool, running each command exactly as written, one command per tool call, and do nothing else.",
    "",
    `1. Write the evidence: run ${evidenceCommand(probe)}`,
    "   Run that command unchanged. The file must hold the command's raw output, not your own reading or summary of it.",
    "",
    `2. Signal that you are ready: run ${shell(`: > ${quote(paths.ready)}`)}`,
    "   Create this file only after step 1 has succeeded.",
    "",
    ...waitingSteps(probe),
    "",
    `4. Reply. Once the release file exists, reply with exactly ${token} and nothing else: no explanation, no punctuation, no formatting. If you stopped waiting because the time limit in step 3 passed, reply with exactly ${UNRELEASED_REPLY} instead.`
  ].join("\n");
}

/**
 * A later turn's text for a worker that already ran a probe in this
 * session: the same procedure with new paths, token and evidence, stated
 * briefly because the worker holds the earlier turn's context.
 */
export function heldProbeFollowUpPrompt(probe: HeldProbe): string {
  const { paths, token } = probe;
  return [
    "Run the probe procedure from your previous turn again, with these new files. As before: run each command exactly as written, one command per tool call, and do nothing else.",
    "",
    `1. Write the evidence: run ${evidenceCommand(probe)}`,
    `2. Signal that you are ready: run ${shell(`: > ${quote(paths.ready)}`)}`,
    ...waitingSteps(probe),
    `4. Reply with exactly ${token} once the release file exists, or exactly ${UNRELEASED_REPLY} if you stopped waiting because the time limit passed.`
  ].join("\n");
}

/**
 * A held probe whose evidence is its own reply text: the worker writes one
 * line as assistant text, then signals readiness and holds exactly as a
 * {@link HeldProbe} does. It is for a claim about text a worker had produced
 * when something happened to it mid-turn — stopped, timed out, lost — where
 * the text must be on the engine's transport while the worker is certainly
 * still alive. How long a model goes on writing is the model's to decide, so
 * a test never asks for a length of output; it asks for one line and a hold
 * it controls.
 *
 * The test observes in this order. Wait on `ready`: the worker's shell
 * created it after the line was written, so the line's text part is complete
 * and the worker is alive in its hold. Then read the text off the transport
 * the test watches (an engine's output stream, a transcript), under a bound,
 * since the transport may trail the file by a moment. Then do what the test
 * came to do to a live worker. Create `release` in `finally` whatever
 * happened, as for any held probe: a worker the test did not stop finishes
 * with its token instead of polling out its hold limit.
 *
 * Judge the product by the text the transport carried, compared with what
 * the product then recorded. The announcement is what the worker was asked
 * to write; a worker that worded it differently has still produced partial
 * output, and only the absence of any text before `ready` leaves the test
 * with nothing to observe.
 */
export interface PartialOutputProbe {
  /** `ready` and `release` as for a held probe; this probe writes no evidence file. */
  paths: Pick<ProbePaths, "ready" | "release">;
  /**
   * The one line the worker writes as reply text before its first command.
   * Choose it fresh per turn (`PARTIAL_<uuid>`), so text seen on a transport
   * is this turn's.
   */
  announcement: string;
  /** The worker's whole final reply once released, as {@link HeldProbe.token}. */
  token: string;
  /** As {@link HeldProbe.holdLimitSeconds}. */
  holdLimitSeconds?: number;
}

/**
 * The turn's text for a {@link PartialOutputProbe}. Its steps keep the held
 * probe's numbering and share its waiting step, so the two procedures differ
 * only in what the worker leaves behind before it signals readiness.
 */
export function partialOutputProbePrompt(probe: PartialOutputProbe): string {
  const { paths, token } = probe;
  return [
    "You are a probe in an automated test. Carry out the four steps below in order and do nothing else. Step 1 is a line you write yourself; steps 2 and 3 are commands for your shell tool, each run exactly as written, one command per tool call.",
    "",
    `1. Announce yourself. Before you call any tool, write this line as ordinary reply text, exactly as shown: ${announcementLine(probe.announcement)}`,
    "   The test reads this line from your output while you are still working, so it comes ahead of your first tool call and is not saved for your final reply. Writing it does not finish your turn: go straight on to step 2 in the same response.",
    "",
    `2. Signal that you are ready: run ${shell(`: > ${quote(paths.ready)}`)}`,
    "   Create this file only after you have written the line in step 1.",
    "",
    ...waitingSteps(probe),
    "",
    `4. Reply. Once the release file exists, reply with exactly ${token} and nothing else: no explanation, no punctuation, no formatting. If you stopped waiting because the time limit in step 3 passed, reply with exactly ${UNRELEASED_REPLY} instead.`
  ].join("\n");
}

/**
 * Resolve once `target` exists, polling every quarter second; reject after
 * `timeoutMs` or when `signal` aborts. Wait on `ready` before reading the
 * evidence, so the read never races the worker's write.
 */
export async function waitForPath(target: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    try {
      await access(target);
      signal?.throwIfAborted();
      return;
    } catch (error) {
      signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`${target} did not appear within ${timeoutMs}ms`);
      }
      try {
        await delay(250, undefined, { signal });
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
    }
  }
}

function waitingSteps(probe: { paths: Pick<ProbePaths, "release">; holdLimitSeconds?: number }): string[] {
  const limitSeconds = probe.holdLimitSeconds ?? DEFAULT_HOLD_LIMIT_SECONDS;
  const limitMinutes = Math.max(1, Math.round(limitSeconds / 60));
  return [
    `3. Wait to be released. Until the file ${probe.paths.release} exists, repeat this one command as its own tool call: ${shell(`sleep ${POLL_INTERVAL_SECONDS}; test -e ${quote(probe.paths.release)} && echo released || echo waiting`)}`,
    `   Each repetition is a separate tool call; never combine them into a loop or a single longer wait, and do no other work between them. If the file has still not appeared after about ${limitMinutes} ${limitMinutes === 1 ? "minute" : "minutes"} of waiting, stop waiting.`
  ];
}

function evidenceCommand(probe: HeldProbe): string {
  const target = quote(probe.paths.evidence);
  switch (probe.evidence.kind) {
    case "cgroup":
      return shell(`cat /proc/self/cgroup > ${target}`);
    case "marker":
      return shell(`printf '%s\\n' ${quote(probe.evidence.content)} > ${target}`);
  }
}

/**
 * The announcement as the worker is shown it. The instruction calls it a
 * line, so an empty or multi-line value is a test defect, refused here
 * rather than sent to a worker as an instruction it cannot carry out.
 */
function announcementLine(announcement: string): string {
  if (announcement.trim().length === 0 || /[\r\n]/.test(announcement)) {
    throw new Error(`a probe announcement must be a single non-empty line: ${JSON.stringify(announcement)}`);
  }
  return announcement;
}

function shell(command: string): string {
  return `\`${command}\``;
}

/**
 * Single-quote a value for the worker's shell. The paths come from the
 * test's own temporary directory and the marker from the test, so a quote
 * character in either is a test defect, refused here rather than passed to
 * a worker as a command it would run differently.
 */
function quote(value: string): string {
  if (value.includes("'")) {
    throw new Error(`probe values must not contain a single quote: ${value}`);
  }
  return `'${value}'`;
}
