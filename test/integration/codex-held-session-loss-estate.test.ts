import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { removeTestDirectory } from "../failure-evidence.js";
import { executablePath, findOnlyFile, runNode } from "./estate-process.js";

const launcher = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const fixture = path.resolve("test/fixtures/codex/recording-app-server.mjs");

for (const ending of ["close", "unsettled", "signal", "mid-turn"] as const) {
  test(`Codex death ${ending === "mid-turn" ? "during a turn" : "while idle"} is observed and the run seals after ${ending}`, { timeout: 60_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ensemble-codex-held-loss-"));
    let testFailed = false;
    try {
      const bin = path.join(directory, "bin");
      const pidFile = path.join(directory, "server.pid");
      const records = path.join(directory, "records");
      const workflow = path.join(directory, "workflow.js");
      await mkdir(bin);
      await writeFile(path.join(bin, "codex"), `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv[2] === "app-server") writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
await import(${JSON.stringify(fixture)});
`);
      await chmod(path.join(bin, "codex"), 0o755);
      await writeFile(workflow, `export const meta = { name: "codex-held-loss" };
const fs = await import("node:fs/promises");
const held = session({ engine: "codex", label: "held-codex", maxAttempts: 3 });
const sibling = session({ engine: "codex", label: "sibling" });
const first = await held.send("first");
await sibling.send("sibling first");
${ending === "mid-turn" ? `
const pending = held.send("second turn");
let streamed = false;
const streamDeadline = Date.now() + 5000;
while (!streamed && Date.now() < streamDeadline) {
  const paths = await fs.readdir(${JSON.stringify(records)}, { recursive: true });
  for (const path of paths.filter(path => path.endsWith(".codex.jsonl"))) {
    streamed ||= (await fs.readFile(${JSON.stringify(records)} + "/" + path, "utf8")).includes("unfinished streamed answer");
  }
  if (!streamed) await new Promise(resolve => setTimeout(resolve, 10));
}
if (!streamed) throw new Error("the in-flight turn never streamed its partial answer");
` : ""}
process.kill(Number(await fs.readFile(${JSON.stringify(pidFile)}, "utf8")), "SIGKILL");
${ending === "unsettled" || ending === "signal" ? `
const lossDeadline = Date.now() + 5000;
while ((!held.lost || !sibling.lost) && Date.now() < lossDeadline) await new Promise(resolve => setTimeout(resolve, 10));
if (!held.lost || !sibling.lost) throw new Error("lost sessions were not observed");
// An idle lost session owns no event-loop reference. A script-owned
// signal timer can still settle the body; otherwise it is stranded.
${ending === "signal" ? 'setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);' : ""}
await new Promise(() => {});
` : `
const deadline = Date.now() + 5000;
while (!held.lost && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
const lostBeforeSend = held.lost;
const siblingLost = sibling.lost;
const second = ${ending === "mid-turn" ? "await pending" : 'await held.send("after death", { schema: { type: "object" } })'};
const third = await sibling.send("sibling after death");
await held.close();
await sibling.close();
return { first, lostBeforeSend, siblingLost, second, third };
`}`);
      // Startup competes with the whole estate on busy hosts. Keep the
      // run deadline below the process guard, and bound loss observation
      // separately above so a lost session still cannot hang the test.
      const result = await runNode([launcher, "--timeout", "30000", workflow], {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        ENSEMBLE_CODEX_SCHEMA_CLI: await executablePath("codex"),
        ...(ending === "mid-turn" ? {
          ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES: JSON.stringify([
            ...[1, 2].map(index => [
              { method: "item/completed", params: { item: { id: `answer-${index}`, type: "agentMessage", text: "worker-ok" }, completedAtMs: Date.now() } },
              { method: "turn/completed", params: { turn: { id: `turn-${index}`, items: [], status: "completed" } } }
            ]), [
            { method: "item/agentMessage/delta", params: { itemId: "partial-1", delta: "unfinished streamed answer" } }
          ]]),
          ENSEMBLE_FAKE_CODEX_STALL_AFTER_NOTIFICATION_SEQUENCE: "1"
        } : {}),
        ENSEMBLE_RUN_RECORD_DIR: records,
        ENSEMBLE_STATUS: "0",
        XDG_DATA_HOME: path.join(directory, "data")
      }, 45_000);
      const expectedStatus = ending === "unsettled" ? "failed" : ending === "signal" ? "interrupted" : "complete";
      assert.equal(result.code, ending === "unsettled" ? 1 : ending === "signal" ? 143 : 0, result.stderr);
      assert.match(result.stderr, ending === "mid-turn"
        ? /\[codex\] session 1 \(held-codex\) lost its worker during turn 2/
        : /\[codex\] session 1 \(held-codex\) lost its worker while idle after turn 1/);
      assert.match(result.stderr, /\[codex\] session 2 \(sibling\) lost its worker while idle after turn 1/);
      const manifestPath = await findOnlyFile(records, "manifest.json");
      const archiveDir = path.dirname(manifestPath);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.equal(manifest.status, expectedStatus);
      assert.equal(manifest.session_events.length, 2);
      assert.deepEqual(manifest.session_events.map((event: { native_session: string }) => event.native_session).sort(), ["thread-1", "thread-2"]);
      const sentinel = JSON.parse(await readFile(await findOnlyFile(records, "completion-sentinel.json"), "utf8"));
      assert.equal(sentinel.outcome, manifest.status);
      if (expectedStatus === "complete") {
        assert.deepEqual(JSON.parse(result.stdout), {
          first: "worker-ok", lostBeforeSend: true, siblingLost: true, second: null, third: null
        });
        for (const id of [3, 4]) {
          const record = JSON.parse(await readFile(path.join(archiveDir, "agents", String(id).padStart(6, "0"), "agent.json"), "utf8"));
          assert.equal(record.attempts.length, 1);
          assert.equal(record.attempts[0].failure.kind, "session-lost");
          assert.deepEqual(record.attempts[0].classification, { class: "unclassified", rule: "session.lost" });
          assert.deepEqual(record.attempts[0].worker_exit, { exit_code: null, signal: "SIGKILL" });
          if (ending === "mid-turn" && id === 3) {
            assert.equal(record.attempts[0].raw_output, "unfinished streamed answer");
            const transcript = record.transcripts.find((item: { partial: boolean }) => item.partial);
            assert.ok(transcript, "the interrupted turn lost its partial transcript");
            assert.match(await readFile(path.join(archiveDir, transcript.path), "utf8"), /unfinished streamed answer/);
          } else {
            assert.equal(record.attempts[0].raw_output, null);
          }
        }
      } else {
        assert.equal(JSON.parse(result.stdout).reason, expectedStatus);
        if (ending === "unsettled") {
          assert.equal(JSON.parse(result.stdout).error.kind, "WorkflowUnsettledError");
        }
      }
    } catch (error) {
      testFailed = true;
      throw error;
    } finally {
      await removeTestDirectory(directory, testFailed);
    }
  });
}
