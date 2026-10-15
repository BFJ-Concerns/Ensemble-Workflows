import assert from "node:assert/strict";
import test from "node:test";

import {
  DispatchRemapLedger,
  globMatches,
  parseDispatchRemap,
  parseDispatchRemapRule,
  splitDispatchRemapVariable
} from "../../src/dispatch-remap.js";
import { DispatchRemapRejectedError } from "../../src/errors.js";

test("a rule is read as its key kind and its target, exactly as written", () => {
  assert.deepEqual(parseDispatchRemapRule("label:propose:*=codex:gpt-6-astra"), {
    key: { kind: "label", glob: "propose:*" },
    target: { engine: "codex", model: "gpt-6-astra" },
    source: "label:propose:*=codex:gpt-6-astra"
  });
  assert.deepEqual(parseDispatchRemapRule(" phase:critique = codex ").key, { kind: "phase", glob: "critique" });
  assert.deepEqual(parseDispatchRemapRule("claude:opus=codex:gpt-6.1-sol").key, { kind: "model", engine: "claude", model: "opus" });
  assert.deepEqual(parseDispatchRemapRule("claude=codex"), {
    key: { kind: "engine", engine: "claude" },
    target: { engine: "codex" },
    source: "claude=codex"
  });
  // A model may itself carry a colon: only the first one splits the key.
  assert.deepEqual(parseDispatchRemapRule("opencode:provider/model:free=claude").key, {
    kind: "model",
    engine: "opencode",
    model: "provider/model:free"
  });
});

test("a rule the launcher cannot read is refused naming the rule and what is wrong with it", () => {
  for (const [rule, detail] of [
    ["claude", "no `=`"],
    ["=codex", "the key is empty"],
    ["claude=", "the target is empty"],
    ["gpt=codex", "neither an engine nor a label:, phase:, or engine:model key"],
    ["label:=codex", "the label glob is empty"],
    ["claude:=codex", "the model after \"claude\": is empty"],
    ["role:x=codex", "neither an engine nor label or phase"],
    ["claude=gpt", "the target engine \"gpt\" is not an engine"],
    ["claude=codex:", "the target model after \"codex\": is empty"]
  ] as const) {
    assert.throws(
      () => parseDispatchRemapRule(rule),
      (error: unknown) =>
        error instanceof DispatchRemapRejectedError && error.message.includes(JSON.stringify(rule)) && error.message.includes(detail),
      rule
    );
  }
  // The variable's comma-separated form skips blank entries; a bad entry still refuses.
  assert.equal(parseDispatchRemap(splitDispatchRemapVariable(" claude=codex , , phase:*=claude ")).length, 2);
  assert.throws(() => parseDispatchRemap(splitDispatchRemapVariable("claude=codex,bad")), DispatchRemapRejectedError);
});

test("a glob matches a label or phase whole, with * and ? the only pattern characters", () => {
  assert.equal(globMatches("propose:*", "propose:1"), true);
  assert.equal(globMatches("propose:*", "re-propose:1"), false, "anchored at the start");
  assert.equal(globMatches("*:1", "propose:1"), true);
  assert.equal(globMatches("critic?", "critic1"), true);
  assert.equal(globMatches("critic?", "critic12"), false);
  assert.equal(globMatches("a.b", "a.b"), true);
  assert.equal(globMatches("a.b", "axb"), false, "a dot is literal");
  assert.equal(globMatches("(x)+", "(x)+"), true, "regex metacharacters are literal");
  assert.equal(globMatches("*", ""), true);
  assert.equal(globMatches("ré*", "résumé"), true);
});

test("the most specific matching key moves a dispatch, and the ledger names the rules that caught nothing", () => {
  const ledger = new DispatchRemapLedger(
    parseDispatchRemap(["claude=codex", "claude:opus=codex:gpt-6.1-sol", "phase:crit*=codex:gpt-6-astra", "label:lead=claude:opus", "label:le*=codex"])
  );
  const base = { engine: "claude" as const, model: "opus", label: null, phase: null };
  // Engine key alone; the target names no model, so the move's model is undefined.
  assert.deepEqual(ledger.resolve({ ...base, model: "sonnet" })?.rule.source, "claude=codex");
  assert.equal(ledger.resolve({ ...base, model: "sonnet" })?.model, undefined);
  // A model key beats the engine key.
  assert.deepEqual(ledger.resolve(base)?.rule.source, "claude:opus=codex:gpt-6.1-sol");
  // A phase key beats both.
  assert.deepEqual(ledger.resolve({ ...base, phase: "critique" })?.rule.source, "phase:crit*=codex:gpt-6-astra");
  // A label key beats every other kind; among label keys the first declared wins.
  assert.deepEqual(ledger.resolve({ ...base, label: "lead", phase: "critique" })?.rule.source, "label:lead=claude:opus");
  // A request no key matches moves nowhere.
  assert.equal(ledger.resolve({ engine: "codex", model: undefined, label: "x", phase: null }), null);
  // The second label rule never won a match: it is the one reported.
  assert.deepEqual(ledger.unmatched(), ["label:le*=codex"]);
});
