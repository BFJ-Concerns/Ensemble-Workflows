import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKER_STANDING_INSTRUCTIONS,
  inSessionCorrection,
  laterTurnPrompt,
  openingPrompt,
  previousFailureNotice,
  schemaContract
} from "../../src/worker-instructions.js";

const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };

test("an opening prompt leads with the standing instructions and ends with the task under its own label", () => {
  const failure = { kind: "TurnTimeoutError", message: "turn timed out after 50ms" };

  assert.equal(openingPrompt({ task: "Count the files.\n" }), `${WORKER_STANDING_INSTRUCTIONS}\n\nTask:\nCount the files.\n`);
  assert.equal(
    openingPrompt({ task: "Count the files.", schema, previousFailure: failure }),
    [WORKER_STANDING_INSTRUCTIONS, schemaContract(schema, "opening"), previousFailureNotice(failure), "", "Task:", "Count the files."].join("\n")
  );
});

test("a later turn carries its own schema contract ahead of the task, and nothing but the task without one", () => {
  assert.equal(laterTurnPrompt({ task: "And the directories?" }), "And the directories?");
  assert.equal(laterTurnPrompt({ task: "And the directories?", schema }), `${schemaContract(schema, "later")}\n\nAnd the directories?`);
});

test("the schema contract says which turn it binds and allows the answer inside prose or fences", () => {
  const opening = schemaContract(schema, "opening");
  const later = schemaContract(schema, "later");

  assert.ok(opening.startsWith("When finished, include in your FINAL message a JSON value that conforms to this JSON Schema."));
  assert.ok(later.startsWith("For this reply, include in your FINAL message a JSON value that conforms to this JSON Schema."));
  for (const contract of [opening, later]) {
    assert.match(contract, /You may surround the value with prose, explanation, or markdown code fences:\n/);
    assert.ok(contract.endsWith(`\n${JSON.stringify(schema)}`));
  }
});

test("an in-session correction has a sentence for each failure every engine shares, and reports any other as observed", () => {
  const shared = ["schema-validation", "invalid-json", "empty-output", "WhitespaceStreamError", "TurnTimeoutError"];
  const corrections = shared.map((kind) => inSessionCorrection({ kind, message: "the harness's account" }));

  assert.equal(new Set(corrections).size, shared.length);
  assert.match(corrections[0]!, /Validation errors: the harness's account\./);
  assert.match(corrections[4]!, /time limit .*\(the harness's account\)/);
  assert.match(
    inSessionCorrection({ kind: "agy-request-error", message: "session/prompt failed (-32000)" }),
    /did not complete \(agy-request-error: session\/prompt failed \(-32000\)\)/
  );
});
