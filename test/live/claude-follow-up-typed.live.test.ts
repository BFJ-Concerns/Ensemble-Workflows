import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseTranscriptText } from "../../src/claude-transcript.js";
import { findOnlyFile, runNode } from "../integration/estate-process.js";
import {
  TYPED_FOLLOW_UP_OPENING_PROMPT,
  TYPED_FOLLOW_UP_SKILL,
  followUpArrival,
  installTypedFollowUpSkill,
  typedFollowUpArguments,
  typedFollowUpPrompt
} from "./claude-follow-up-typed-prompts.js";
import { installDeliveryClients, resumeDeliveryClient } from "./claude-follow-up-typed-processes.js";

const bundle = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

interface AgentRecord {
  status: string;
  session: { id: number; turn: number };
  transcripts: Array<{ path: string; source: string; session_id: string }>;
}

// The same public session journey covers an ordinary reader and one stopped
// between sends. The wrappers forward real bytes to real executables; only
// Claude's native transcript supplies the asserted delivery classification.
for (const pause of [false, true]) {
  test(`built Claude follow-ups arrive typed, exact and expanded with ${pause ? "a paused" : "an ordinary"} reader`, {
    skip: process.env.ENSEMBLE_LIVE !== "1", timeout: 900_000
  }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ensemble-typed-follow-up-"));
    try {
      await installTypedFollowUpSkill(directory);
      const bin = await installDeliveryClients(directory, pause);
      const store = path.join(directory, "records");
      await mkdir(store);
      const commandMarker = `COMMAND_${randomUUID()}`;
      const plainMarker = `PLAIN_${randomUUID()}`;
      const command = typedFollowUpPrompt(commandMarker);
      // Reuse the authored fixture text; these blank lines and JSON are data.
      const plain = typedFollowUpArguments(plainMarker) + "\n\n" + JSON.stringify({ value: "é😀", schema: { type: "object" } });
      const workflow = path.join(directory, "workflow.mjs");
      await writeFile(workflow, `
        export const meta = { name: "typed-follow-up" };
        const held = session(${JSON.stringify({ engine: "claude", cwd: directory, timeoutMs: 240_000, maxAttempts: 1 })});
        try {
          await held.send(${JSON.stringify(TYPED_FOLLOW_UP_OPENING_PROMPT)});
          await held.send(${JSON.stringify(command)});
          await held.send(${JSON.stringify(plain)});
        } finally { await held.close(); }
        return "complete";
      `);
      const result = await runNode([bundle, "--timeout", "800000", workflow], {
        PATH: bin + path.delimiter + process.env.PATH,
        ENSEMBLE_RUN_RECORD: "1", ENSEMBLE_RUN_RECORD_DIR: store, ENSEMBLE_STATUS: "0",
        XDG_CONFIG_HOME: path.join(directory, "config")
      }, 850_000);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout), "complete");
      assert.match(result.stderr, /\[sentinel\]/);

      const archive = path.dirname(await findOnlyFile(store, "manifest.json"));
      const files = (await readdir(archive, { recursive: true })).filter((file) => path.basename(file) === "agent.json");
      const records = await Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(archive, file), "utf8")) as AgentRecord));
      records.sort((left, right) => left.session.turn - right.session.turn);
      assert.equal(records.length, 3, "the held session must retain all three turns");
      assert.deepEqual(records.map((record) => record.status), ["complete", "complete", "complete"]);
      assert.equal(new Set(records.map((record) => record.session.id)).size, 1);
      assert.equal(new Set(records.flatMap((record) => record.transcripts.map((ref) => ref.session_id))).size, 1);

      for (const [index, marker, prompt, kind] of [
        [1, commandMarker, command, "command"],
        [2, plainMarker, plain, "plain"]
      ] as const) {
        const reference = records[index]?.transcripts[0];
        assert.ok(reference, "turn has no native transcript");
        assert.equal(reference.source, "claude-session-jsonl");
        const entries = parseTranscriptText(await readFile(path.join(archive, reference.path), "utf8"));
        // Locate this test's unique input row, never an assistant's echo or
        // an earlier turn's classification. No transcript rows are seeded.
        const start = entries.findIndex((entry) => entry.type === "user" && (JSON.stringify(entry.message?.content) ?? "").includes(marker));
        assert.ok(start >= 0, "the follow-up's input row is missing");
        const arrival = followUpArrival(entries, start, prompt);
        assert.equal(arrival.kind, kind, `unexpected native input shape: ${JSON.stringify(arrival).slice(0, 400)}`);
        if (arrival.kind === "command") {
          assert.equal(arrival.name, TYPED_FOLLOW_UP_SKILL.name);
          assert.equal(arrival.exact, true, "the command arguments changed in transit");
          assert.equal(arrival.expanded, true, "the native transcript has no skill expansion");
        } else if (arrival.kind === "plain") {
          assert.equal(arrival.exact, true, "the plain input changed in transit");
        }
        // Test output retains only the asserted native rows and their UUIDs.
        // The fixture owns their text; credentials and unrelated rows are
        // not captured. A verifier can retain these TAP diagnostics.
        const rows = entries.slice(start, start + (kind === "command" ? 2 : 1)).map((entry) => {
          const row = entry as typeof entry & { uuid?: string; timestamp?: string };
          return { type: row.type, uuid: row.uuid, timestamp: row.timestamp, content: row.message?.content };
        });
        console.log(JSON.stringify({ pause, kind, rows }));
      }
      if (pause) {
        const events = (await readFile(path.join(directory, "pause.jsonl"), "utf8")).trim().split("\n")
          .map((line) => JSON.parse(line) as { event: string; pid: number; state?: string; before?: string; after?: string; exit?: number; bytes?: number });
        const stopped = events.find((event) => event.event === "stopped-after-send");
        const sent = events.find((event) => event.event === "send-while-stopped");
        assert.ok(stopped && sent, "no send overlapped the attach-reader pause");
        assert.equal(stopped.state, "T");
        assert.equal(sent.pid, stopped.pid);
        assert.equal(sent.before, "T");
        assert.equal(sent.after, "T");
        assert.equal(sent.exit, 0);
        assert.ok((sent.bytes ?? 0) > 0);
        assert.ok(events.some((event) => event.event === "resumed" && event.pid === stopped.pid));
        console.log(JSON.stringify({ pause, events }));
      }
    } finally {
      try {
        await resumeDeliveryClient(directory);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
}
