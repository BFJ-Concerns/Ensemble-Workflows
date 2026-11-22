import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { CommandContainment } from "../../src/contained-command.js";
import { EngineShutdownError, TurnTimeoutError, WhitespaceStreamError } from "../../src/errors.js";
import { openingPrompt } from "../../src/worker-instructions.js";
import { NoWorkerScopes } from "../../src/worker-scopes.js";
import { ZCodeCliRunner, ZCodeEngineAdapter } from "../../src/zcode-engine.js";

const model = "fixture/model";
const help = "Commands:\n  models  List models\nOptions:\n  --provider --model --reasoning-level --disallowed-tools";

async function standInZCode(t: TestContext, { stallListing = false } = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-zcode-runner-"));
  const bin = path.join(cwd, "zcode");
  const commands = new CommandContainment(new NoWorkerScopes());
  const runner = new ZCodeCliRunner(bin, { commands });
  const adapter = new ZCodeEngineAdapter({ cwd, runner });
  t.signal.addEventListener("abort", () => { void adapter.close(); }, { once: true });
  t.after(async () => {
    await adapter.close();
    await commands.close();
    await rm(cwd, { recursive: true, force: true });
  });
  await writeFile(bin, `#!${process.execPath}
const args = process.argv.slice(2);
const first = args[0];
if (first === "--help") {
  console.log(${JSON.stringify(help)});
} else if (first === "models" && ${stallListing}) {
  console.log("listing started");
  setInterval(() => {}, 1_000);
} else if (first === "models") {
  console.log(JSON.stringify({
    models: [{ provider: "fixture", model: "model", reasoningLevels: ["low"] }],
    listings: [{ provider: "fixture", status: "read" }]
  }));
} else if (first.endsWith("\\ndeadline")) {
  setInterval(() => {}, 1_000);
} else if (first.endsWith("\\nwhitespace")) {
  console.log(JSON.stringify({ type: "model.streaming", payload: { kind: "text_delta", delta: "   " } }));
  setInterval(() => {}, 1_000);
} else {
  console.log(JSON.stringify({
    type: "result", outcome: "finished", sessionId: "fixture-session", response: JSON.stringify(args)
  }));
}
`, { mode: 0o700 });
  return { adapter, cwd, commands };
}

test("a real ZCode runner passes model, prompt, directory, strip and resume arguments", { timeout: 10_000 }, async (t) => {
  const { adapter, cwd } = await standInZCode(t);
  const session = adapter.createSession({ model, strip: ["skills", "agents"] }, { onLost: () => assert.fail("lost session") });
  const flags = ["--output-format", "stream-json", "--provider", "fixture", "--model", "model",
    "--reasoning-level", "low", "--cwd", cwd];
  const strips = ["--disallowed-tools", "Skill", "Agent", "CreateWorkflow"];
  const opening = await session.beginTurn("first task", {}).runAttempt({ attempt: 1 });
  assert.deepEqual(JSON.parse(opening.text), [`--prompt=${openingPrompt({ task: "first task" })}`, ...flags, ...strips]);
  const followUp = await session.beginTurn("-next task", {}).runAttempt({ attempt: 1 });
  assert.deepEqual(JSON.parse(followUp.text), ["--prompt=-next task", ...flags, "--resume", "fixture-session", ...strips]);
});

test("a real ZCode runner stops its child at the dispatched turn deadline", { timeout: 10_000 }, async (t) => {
  const { adapter } = await standInZCode(t);
  const invocation = adapter.createInvocation("deadline", { model, timeoutMs: 250 });
  await assert.rejects(invocation.runAttempt({ attempt: 1 }), {
    name: TurnTimeoutError.name, message: /zcode turn timed out after 250ms/
  });
});

test("a real ZCode runner stops a child streaming only whitespace", { timeout: 10_000 }, async (t) => {
  const { adapter } = await standInZCode(t);
  const now = Date.now;
  let elapsed = 0;
  t.mock.method(Date, "now", () => now() + elapsed);
  const invocation = adapter.createInvocation("whitespace", { model });
  await assert.rejects(invocation.runAttempt({
    attempt: 1,
    // Age the turn when the real stdout arrives, before the watcher reads it.
    onLiveEvidence: () => { elapsed = 120_000; }
  }), WhitespaceStreamError);
});

test("closing the adapter stops a real ZCode model listing", { timeout: 10_000 }, async (t) => {
  const { adapter, commands } = await standInZCode(t, { stallListing: true });
  const started = Promise.withResolvers<void>();
  const contain = commands.contain.bind(commands);
  t.mock.method(commands, "contain", async (...args: Parameters<typeof contain>) => {
    const command = await contain(...args);
    if (args[0] === "zcode models") command.child.stdout?.once("data", () => started.resolve());
    return command;
  });
  const invocation = adapter.createInvocation("never dispatched", { model });
  const attempt = assert.rejects(invocation.runAttempt({ attempt: 1 }), EngineShutdownError);
  await started.promise;
  await adapter.close();
  await attempt;
});
