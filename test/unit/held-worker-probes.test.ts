import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { partialOutputProbePrompt, probePaths, waitForPath } from "../live/held-worker-probes.js";

test("a partial-output probe asks for its line before readiness, and readiness before the hold", () => {
  const paths = probePaths("/probe", "partial");
  const probe = { paths, announcement: "PARTIAL_LINE", token: "RELEASED_TOKEN" };
  const prompt = partialOutputProbePrompt(probe);
  const order = [probe.announcement, paths.ready, paths.release, probe.token].map((part) => prompt.indexOf(part));
  assert.ok(order.every((index) => index >= 0), prompt);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), prompt);
  assert.equal(prompt.includes(paths.evidence), false, "a partial-output probe writes no evidence file");

  for (const announcement of ["", "   ", "two\nlines"]) {
    assert.throws(() => partialOutputProbePrompt({ ...probe, announcement }), /single non-empty line/);
  }
});

test("a probe observation stops with its owner's failure when readiness never arrives", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-probe-wait-"));
  try {
    const controller = new AbortController();
    const failure = new Error("turn failed before signalling readiness");
    const waiting = waitForPath(path.join(directory, "never.ready"), 420_000, controller.signal);
    const rejected = assert.rejects(waiting, (error) => error === failure);
    controller.abort(failure);
    await rejected;

    const ready = path.join(directory, "already.ready");
    await writeFile(ready, "");
    await assert.rejects(waitForPath(ready, 420_000, controller.signal), (error) => error === failure);
    await waitForPath(ready, 420_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
