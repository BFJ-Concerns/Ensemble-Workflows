import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { waitForPath } from "../live/held-worker-probes.js";

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
