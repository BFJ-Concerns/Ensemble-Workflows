import type { PreviousAttemptFailure } from "./engines.js";
import type { JsonSchema } from "./types.js";

/**
 * The words the harness gives a worker beside its task. Every engine takes
 * them from here, so a worker reads the same sentences whichever engine
 * runs it, and a sentence is changed in one place.
 *
 * Four kinds of text, each with its own occasion:
 *
 * - **Standing instructions** (`WORKER_STANDING_INSTRUCTIONS`) are the
 *   worker's role, the same for every worker and every turn. They are given
 *   once per session: through the engine's system-prompt route where it has
 *   one, otherwise at the head of the session's first prompt
 *   (`openingPrompt`).
 * - **The schema contract** (`schemaContract`) tells a worker whose engine
 *   takes no JSON Schema what its final message must hold. The harness
 *   checks the answer itself — the last JSON value in the final message
 *   that validates is the answer, bare or inside prose or fences — so the
 *   contract asks for exactly that and no stricter shape. An engine that
 *   hands the schema to its backend sends no contract.
 * - **The previous-failure notice** (`previousFailureNotice`) goes to a
 *   worker that did not make the failed attempt: a retry on a fresh
 *   session, which holds none of the earlier conversation.
 * - **The in-session correction** (`inSessionCorrection`) goes to the
 *   worker that did make it, in the session that still holds the task, the
 *   contract and the failed reply, so it says only what went wrong and what
 *   to do now. Restating the task there would spend the session's cache on
 *   what it already knows.
 *
 * `openingPrompt` and `laterTurnPrompt` assemble a whole message for an
 * engine whose only channel is the prompt. An engine that places the parts
 * itself — Claude Code, whose opening must begin with the task so a leading
 * `/skill` runs — takes the parts singly.
 */

/** The worker's role: who dispatched it, and that nobody is there to answer a question. */
export const WORKER_STANDING_INSTRUCTIONS = [
  "You are an automated worker dispatched by the Ensemble orchestration harness.",
  "Work fully autonomously: never ask for confirmation or permission, and do not pause to ask questions — make a reasonable decision and finish the task."
].join("\n");

/**
 * Which turn of a session a schema contract is for. A later turn of a held
 * session says "for this reply", because each turn brings its own schema or
 * none and an earlier turn's contract must not be read as still in force.
 */
export type SchemaContractTurn = "opening" | "later";

const SCHEMA_CONTRACT_LEAD: Record<SchemaContractTurn, string> = {
  opening: "When finished, include",
  later: "For this reply, include"
};

/** The schema contract for one turn: the sentence, then the schema on a line of its own. */
export function schemaContract(schema: JsonSchema, turn: SchemaContractTurn): string {
  return [
    `${SCHEMA_CONTRACT_LEAD[turn]} in your FINAL message a JSON value that conforms to this JSON Schema. ` +
      "You may surround the value with prose, explanation, or markdown code fences:",
    JSON.stringify(schema)
  ].join("\n");
}

/** What a fresh worker is told of the attempt before it, which it cannot see. */
export function previousFailureNotice(failure: PreviousAttemptFailure): string {
  return `A previous attempt failed (${failure.kind}): ${failure.message}. Correct it this time.`;
}

/**
 * What the worker is told when its own last turn failed and the session is
 * still open. The kinds named here are the ones every engine shares: the
 * three answer failures the runtime's check returns, and the two stops an
 * engine makes of a turn it can cancel without losing the session. Any
 * other failure, an engine's own kinds included, is reported as the harness
 * observed it.
 */
export function inSessionCorrection(failure: PreviousAttemptFailure): string {
  switch (failure.kind) {
    case "schema-validation":
      return (
        `Your final JSON did not satisfy the required schema. Validation errors: ${failure.message}. ` +
        "Reply with a corrected JSON value that conforms to the schema. You may surround the value with prose or markdown fences."
      );
    case "invalid-json":
      return (
        "Your last final message was not valid JSON for the required schema. " +
        "Reply with a JSON value that conforms to the schema. You may surround the value with prose or markdown fences."
      );
    case "empty-output":
      return "Your last turn produced no final answer. Please complete the task and output your final answer now.";
    case "WhitespaceStreamError":
      return (
        "Your last turn was stopped because it had streamed nothing but whitespace for two minutes. " +
        "The work you had already done stands. Please continue the task from where it stopped and output your final answer."
      );
    case "TurnTimeoutError":
      return (
        `Your last turn was stopped at its time limit before it gave a final answer (${failure.message}). ` +
        "The work you had already done stands. Please finish what remains and output your final answer; this turn has the same limit."
      );
    default:
      return (
        `Your last turn did not complete (${failure.kind}: ${failure.message}). ` +
        "Please complete the task and output your final answer now."
      );
  }
}

/** What one message to a worker is assembled from. */
export interface WorkerPromptParts {
  /** The caller's prompt, as given. */
  task: string;
  /** The turn's schema, on an engine that rides it on the prompt. */
  schema?: JsonSchema;
}

/**
 * A session's first prompt on an engine whose only channel is the prompt:
 * the standing instructions, the turn's schema contract, the failure of an
 * earlier attempt this session never saw, then the task under a label of
 * its own, so everything after `Task:` is the caller's.
 */
export function openingPrompt(parts: WorkerPromptParts & { previousFailure?: PreviousAttemptFailure }): string {
  const lines = [WORKER_STANDING_INSTRUCTIONS];
  if (parts.schema !== undefined) lines.push(schemaContract(parts.schema, "opening"));
  if (parts.previousFailure !== undefined) lines.push(previousFailureNotice(parts.previousFailure));
  lines.push("", "Task:", parts.task);
  return lines.join("\n");
}

/**
 * A later turn's prompt in a held session, which already holds the standing
 * instructions: this turn's schema contract, when it has one, then the task.
 * A turn with no schema is the task alone.
 */
export function laterTurnPrompt(parts: WorkerPromptParts): string {
  return parts.schema === undefined ? parts.task : [schemaContract(parts.schema, "later"), "", parts.task].join("\n");
}
