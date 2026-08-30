import test from "node:test";
import process from "node:process";

test("emits a coloured runner-facing marker", () => {
  process.stdout.write("\u001B[35mSUITE_RUNNER_SGR_MARKER\u001B[0m\n");
});
