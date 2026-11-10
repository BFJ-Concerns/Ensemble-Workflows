import assert from "node:assert/strict";

/** Poll a condition under a hang guard; the interval is not a performance bound. */
export async function waitForCondition(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 300_000, pollIntervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
