import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createRuntime } from "../../src/index.js";
import { heldProbeFollowUpPrompt, heldProbePrompt, probePaths, waitForPath } from "./held-worker-probes.js";

import type { HeldProbe } from "./held-worker-probes.js";

const isLive = process.env.ENSEMBLE_LIVE === "1";

// One held session per engine, two turns: the first writes its shell's
// cgroup and holds, the second writes a marker and holds. Each turn is
// observed while the worker is still alive — ready file present, turn not
// settled, evidence readable — and released only then. The pattern a test
// of running workers copies: dispatch, wait on `ready`, observe, release,
// then judge the settled turn by its token. Each turn draws its engine's
// allowance, so the journey stays at two turns per engine.
for (const engine of ["claude", "codex"] as const) {
  test(
    `live ${engine} held probe writes its shell's cgroup, holds until released, and repeats on a follow-up turn`,
    { skip: !isLive, timeout: 1_200_000 },
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), `ensemble-held-probe-${engine}-`));
      const runtime = await createRuntime({
        cwd: directory,
        concurrencyCaps: { codex: 1, claude: 1, opencode: 1 },
        defaultTurnTimeoutMs: 600_000,
        defaultMaxAttempts: 1
      });
      const session = runtime.createWorkerSession({ engine, cwd: directory, label: `held-probe-${engine}` });
      const first: HeldProbe = {
        paths: probePaths(directory, "first"),
        evidence: { kind: "cgroup" },
        token: `RELEASED_FIRST_${randomUUID()}`
      };
      const marker = `HELD_PROBE_${randomUUID()}`;
      const second: HeldProbe = {
        paths: probePaths(directory, "second"),
        evidence: { kind: "marker", content: marker },
        token: `RELEASED_SECOND_${randomUUID()}`
      };

      try {
        const firstReply = await observeHeldTurn(session.send(heldProbePrompt(first)), first, async () => {
          const evidence = await readFile(first.paths.evidence, "utf8");
          // cgroup v2: one line, `0::<path>`; the path is where the worker's shell ran.
          assert.match(evidence, /^0::\/\S*$/m, `${engine} wrote no cgroup line to its evidence file: ${JSON.stringify(evidence)}`);
        });
        assert.match(firstReply ?? "", new RegExp(first.token), `${engine} did not reply with its first token`);

        const secondReply = await observeHeldTurn(session.send(heldProbeFollowUpPrompt(second)), second, async () => {
          const evidence = await readFile(second.paths.evidence, "utf8");
          assert.equal(evidence.trimEnd(), marker, `${engine} did not write the marker on its follow-up turn`);
        });
        assert.match(secondReply ?? "", new RegExp(second.token), `${engine} did not reply with its follow-up token`);
      } finally {
        // Release both probes whatever happened above, so a failed
        // observation never leaves a worker polling out its hold limit.
        await Promise.all([first, second].map((probe) => writeFile(probe.paths.release, "")));
        await session.close();
        await runtime.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
}

/**
 * Wait for the probe's ready file, run `observe` while the worker is still
 * holding, then release it and return the settled reply. The turn must not
 * have settled before release: a worker that answered early never held, and
 * the observation would have read a finished worker.
 */
async function observeHeldTurn(
  turn: Promise<string | null>,
  probe: HeldProbe,
  observe: () => Promise<void>
): Promise<string | null> {
  let settled = false;
  const tracked = turn.finally(() => {
    settled = true;
  });
  await waitForPath(probe.paths.ready, 420_000);
  assert.equal(settled, false, "the worker settled before it was released");
  await observe();
  await writeFile(probe.paths.release, "");
  return tracked;
}
