import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ClaudeCliControlPlane, type ClaudeSessionHandle } from "../../src/claude-control-plane.js";
import { parseTranscriptText } from "../../src/claude-transcript.js";
import { ClaudeEngineAdapter, EngineRegistry } from "../../src/engines.js";
import type { RunRecordWriter, RuntimeAgentRecord } from "../../src/run-record.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { TYPED_FOLLOW_UP_OPENING_PROMPT } from "./claude-follow-up-typed-prompts.js";

// The real CLI and terminal own the dialog, editor and transcript. Only the
// provider reply and one dropped editor key are scripted, making the blocked
// state and retry reproducible without asking a model to disobey its prompt.
for (const refuse of [false, true]) {
  test(`native Claude input dialogs release the editor and preserve their session, refusal ${refuse}`, {
    skip: process.env.ENSEMBLE_LIVE !== "1" ? "ENSEMBLE_LIVE must be 1" : false,
    timeout: 180_000
  }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ensemble-blocked-nudge-live-"));
    const configDir = path.join(dir, "claude");
    const dropped = path.join(dir, "drop-editor-key");
    const records: RuntimeAgentRecord[] = [];
    const submissions: Array<{ session: string; message: string; submitted: boolean }> = [];
    let transcriptPath: string | null = null;
    let requests = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      if (request.url?.includes("count_tokens")) {
        response.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      if (!request.url?.includes("/messages")) {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream: boolean; tools?: Array<{ name: string }> };
      // Title requests carry no tools; they must not consume the scripted turn.
      const workerRequest = body.tools !== undefined;
      if (workerRequest) requests += 1;
      const asking = workerRequest && requests === 1;
      if (asking && refuse) await writeFile(dropped, "");
      const block = asking ? {
        type: "tool_use", id: "tool_question", name: "AskUserQuestion",
        input: { questions: [{ question: "Which fixture value?", header: "Fixture", multiSelect: false, options: [
          { label: "One", description: "First fixture value." }, { label: "Two", description: "Second fixture value." }
        ] }] }
      } : { type: "text", text: "OK" };
      const message = {
        id: `msg_${requests}_${asking}`, type: "message", role: "assistant", model: "claude-haiku-5-5",
        content: [block], stop_reason: asking ? "tool_use" : "end_turn", stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 }
      };
      if (!body.stream) {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(message));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const event = (type: string, fields: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      event("message_start", { message: { ...message, content: [], stop_reason: null } });
      event("content_block_start", { index: 0, content_block: asking ? { ...block, input: {} } : { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: asking
        ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
        : { type: "text_delta", text: "OK" } });
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } });
      event("message_stop", {});
      response.end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    let runtime: EnsembleRuntime | undefined;
    try {
      await mkdir(configDir);
      await writeFile(path.join(configDir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
      await writeFile(path.join(configDir, "settings.json"), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
      const tmux = execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim();
      const wrapper = path.join(dir, "tmux.mjs");
      await writeFile(wrapper, `#!/usr/bin/env node
        import { existsSync, unlinkSync } from "node:fs";
        import { spawnSync } from "node:child_process";
        const args = process.argv.slice(2);
        if (args.at(-1) === "C-g" && existsSync(${JSON.stringify(dropped)})) {
          unlinkSync(${JSON.stringify(dropped)});
          process.exit(0);
        }
        const result = spawnSync(${JSON.stringify(tmux)}, args, { stdio: "inherit" });
        process.exit(result.status ?? 1);
      `, { mode: 0o755 });
      class ObservedPlane extends ClaudeCliControlPlane {
        override async steer(handle: ClaudeSessionHandle, message: string) {
          const outcome = await super.steer(handle, message);
          submissions.push({ session: handle.sessionId, message, submitted: outcome.submitted });
          transcriptPath = await this.transcriptPath(handle);
          return outcome;
        }
      }
      const plane = new ObservedPlane({
        tmuxBin: wrapper,
        workerEnv: {
          CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
          ANTHROPIC_AUTH_TOKEN: "fixture-only", CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "0", CLAUDE_CODE_USE_FOUNDRY: "0"
        }
      });
      runtime = new EnsembleRuntime({
        engines: new EngineRegistry([new ClaudeEngineAdapter({ controlPlane: plane, config: { pollIntervalMs: 100 } })]),
        defaultMaxAttempts: 2
      });
      runtime.setRunRecorder({ recordAgent: async (record: RuntimeAgentRecord) => records.push(structuredClone(record)) } as unknown as RunRecordWriter);
      const result = await runtime.agent(TYPED_FOLLOW_UP_OPENING_PROMPT, {
        engine: "claude", model: "claude-haiku-5-5", effort: "low", cwd: dir, maxAttempts: 2, timeoutMs: 60_000
      });
      const record = records.at(-1);
      const entries = transcriptPath === null ? [] : parseTranscriptText(await readFile(transcriptPath, "utf8"));
      if (result !== "OK") console.log(JSON.stringify({ nativeUserRows: entries.filter(entry => entry.type === "user") }));
      assert.equal(result, "OK", JSON.stringify({
        requests, submissions: submissions.map(({ submitted }) => submitted),
        failures: record?.attempts.map(attempt => attempt.failure)
      }));
      assert.ok(transcriptPath);
      assert.equal(record?.attempts.length, refuse ? 2 : 1);
      if (refuse) {
        assert.equal(record?.attempts[0]?.failure?.kind, "claude-valve-error");
        assert.match(record?.attempts[0]?.failure?.message ?? "", /prompt editor did not finish copying within 30000ms/);
        assert.equal(submissions[1]?.message, submissions[2]?.message);
      }
      assert.equal(record?.attempts.at(-1)?.failure, null);
      assert.equal(submissions.length, refuse ? 3 : 2, "one opening, a nudge, and only its refused copy if injected");
      assert.deepEqual(submissions.map(submission => submission.submitted), refuse ? [true, false, true] : [true, true]);
      assert.equal(new Set(submissions.map(submission => submission.session)).size, 1);
      assert.match(submissions.at(-1)?.message ?? "", /waiting for input/);
      const inputs = entries.filter(entry => entry.type === "user" && typeof entry.message?.content === "string");
      assert.equal(inputs.length, 2, "the refused copy must not create a native user turn");
      assert.equal(inputs[1]?.message?.content, submissions.at(-1)?.message, "the nudge must arrive exactly once and unchanged");
      console.log(JSON.stringify({
        cli: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(), provider: "scripted fixture",
        session: submissions[0]?.session, attempts: record?.attempts.length, failure: record?.attempts[0]?.failure,
        nativeUserTurns: inputs.length, exactNudge: true, result
      }));
    } finally {
      await runtime?.close();
      // This configuration directory owns its daemon; the operator's is separate.
      try { execFileSync("claude", ["daemon", "stop", "--any"], { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, stdio: "ignore", timeout: 10_000 }); }
      catch { /* The daemon can already have stopped after its last session. */ }
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
}
