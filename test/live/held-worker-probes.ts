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
 * The same text drives Claude and Codex workers. Both run shell commands
 * through a tool without approval prompts, and the procedure needs only a
 * POSIX shell, so neither engine gets its own wording. A held session's
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

function waitingSteps(probe: HeldProbe): string[] {
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
