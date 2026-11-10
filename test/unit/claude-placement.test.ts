import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ClaudeCliControlPlane } from "../../src/claude-control-plane.js";
import { enteredWorktrees, parseTranscriptText } from "../../src/claude-transcript.js";
import { ClaudeEngineAdapter, EngineRegistry } from "../../src/engines.js";
import { RunRecordWriter } from "../../src/run-record.js";
import { EnsembleRuntime } from "../../src/runtime.js";

import type { ClaudeControlPlane } from "../../src/claude-control-plane.js";

// Placement and settings use the same delivery stub as the control-plane
// fixtures; native editor delivery has separate transport coverage.
class DeliveryStubControlPlane extends ClaudeCliControlPlane {
  override async steer() { return { submitted: true as const }; }
}

test("Claude dispatch selects in-place editing per session without rewriting project settings", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-placement-settings-"));
  let plane: ClaudeCliControlPlane | undefined;
  let handle: Awaited<ReturnType<ClaudeCliControlPlane["dispatch"]>> | undefined;
  try {
    await mkdir(path.join(dir, ".claude"));
    const projectSettings = '{"worktree":{"bgIsolation":"worktree","baseRef":"head"}}\n';
    await writeFile(path.join(dir, ".claude/settings.json"), projectSettings);
    const observed = path.join(dir, "selected.json");
    const bin = path.join(dir, "claude.mjs");
    await writeFile(bin, `#!${process.execPath}
      import { readFile, writeFile } from 'node:fs/promises';
      const args = process.argv.slice(2);
      const observed = ${JSON.stringify(observed)};
      if (args[0] === '--bg') {
        for await (const chunk of process.stdin) void chunk;
        const settings = JSON.parse(await readFile(args[args.indexOf('--settings') + 1], 'utf8'));
        // Keep only the fields this fixture owns, never a settings-file copy.
        await writeFile(observed, JSON.stringify({
          cwd: process.cwd(), worktree: settings.worktree,
          deny: settings.permissions?.deny, declared: settings.env.PLACEMENT_TEST
        }));
      } else if (args[0] === 'agents') {
        try { JSON.parse(await readFile(observed, 'utf8')); }
        catch { process.stdout.write('[]'); process.exit(0); }
        process.stdout.write(JSON.stringify([{
          id: 'placed', sessionId: 'placed-session', name: 'placed-worker',
          kind: 'background', pid: process.pid, cwd: ${JSON.stringify(dir)}, status: 'idle', state: 'done'
        }]));
      }
    `, { mode: 0o755 });
    plane = new DeliveryStubControlPlane({ claudeBin: bin, workerEnv: { PLACEMENT_TEST: "declared" }, holdScope: null });
    handle = await plane.dispatch({ prompt: "fixture", name: "placed-worker", cwd: dir, permissionDenyRules: ["Skill"] });
    assert.equal(handle.launchFailure, undefined);
    assert.deepEqual(JSON.parse(await readFile(observed, "utf8")), {
      cwd: dir, worktree: { bgIsolation: "none" }, deny: ["Skill"], declared: "declared"
    });
    assert.equal(await readFile(path.join(dir, ".claude/settings.json"), "utf8"), projectSettings);
  } finally {
    if (plane && handle) await plane.stop(handle);
    await rm(dir, { recursive: true, force: true });
  }
});

test("native worktree evidence retains entered trees after exit and ignores failed requests", () => {
  const rows = [
    { type: "assistant", message: { content: [{ type: "tool_use", name: "EnterWorktree", input: { name: "failed" } }] } },
    { type: "worktree-state", worktreeSession: { worktreePath: "/repo/.claude/worktrees/one", worktreeBranch: "worktree-one" } },
    { type: "worktree-state", worktreeSession: { worktreePath: "/repo/.claude/worktrees/one", worktreeBranch: "worktree-one" } },
    { type: "worktree-state", worktreeSession: null },
    { type: "worktree-state", worktreeSession: { worktreePath: "/hook/tree", hookBased: true } },
    { type: "worktree-state", worktreeSession: {} },
    { type: "worktree-state", worktreeSession: [] },
    { type: "worktree-state", worktreeSession: "invalid" },
    { type: "worktree-state", worktreeSession: { worktreePath: "" } }
  ];
  assert.deepEqual(enteredWorktrees(parseTranscriptText(rows.map((row) => JSON.stringify(row)).join("\n"))), [
    { path: "/repo/.claude/worktrees/one", branch: "worktree-one" },
    { path: "/hook/tree", branch: null }
  ]);
  assert.deepEqual(enteredWorktrees([]), []);
});

for (const outcome of ["complete", "refused"] as const) {
  test(`Claude ${outcome} attempt archives native worktrees separately from Ensemble isolation`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "claude-placement-archive-"));
    const transcript = path.join(dir, "session.jsonl");
    const tree = { path: path.join(dir, "native-tree"), branch: "native-branch" };
    const launchDiagnostics = { claudeLaunch: { failure: "attachment outcome uncertain", cleanupConfirmed: false } };
    const handle = { id: "owned", sessionId: "owned-session", name: "owned", cwd: dir,
      launchFailure: { message: "attachment outcome uncertain", diagnostics: launchDiagnostics } };
    const plane: ClaudeControlPlane = {
      dispatch: async (options) => {
        // Record the actual submission, including the engine preamble, as
        // the native transcript does before its worktree and assistant rows.
        const rows = (await readFile(transcript, "utf8")).split("\n");
        rows[0] = JSON.stringify({ type: "user", message: { content: options.prompt } });
        await writeFile(transcript, rows.join("\n"));
        return handle;
      },
      poll: async () => ({ status: "idle", state: "done", present: true }),
      transcriptPath: async () => transcript,
      steer: async () => ({ submitted: false, reason: "unused" }),
      stop: async () => {},
      tmuxAvailable: async () => false
    };
    const runtime = new EnsembleRuntime({
      engines: new EngineRegistry([new ClaudeEngineAdapter({ cwd: dir, controlPlane: plane })]),
      defaultMaxAttempts: 1
    });
    try {
      await writeFile(transcript, [
        { type: "user", message: { content: "fixture" } },
        { type: "worktree-state", worktreeSession: { worktreePath: tree.path, worktreeBranch: tree.branch } },
        { type: "worktree-state", worktreeSession: null },
        { type: "assistant", ...(outcome === "refused" ? { isApiErrorMessage: true, apiErrorStatus: 429, error: "rate_limit" } : {}),
          message: { model: outcome === "complete" ? "claude-test" : "<synthetic>", stop_reason: "end_turn",
            content: [{ type: "text", text: outcome === "complete" ? "done" : "rate limited" }] } }
      ].map((row) => JSON.stringify(row)).join("\n"));
      const writer = await RunRecordWriter.start({
        storeDir: path.join(dir, "records"), cwd: dir, runUuid: `native-tree-${outcome}`,
        workflowPath: path.join(dir, "workflow.js"), workflowSource: "return true;", args: [], cliFlags: { jsonArgs: false }
      });
      runtime.setRunRecorder(writer);
      assert.equal(await runtime.agent("fixture", { engine: "claude", cwd: dir }), outcome === "complete" ? "done" : null);
      await runtime.close();
      await writer.finish({ status: "complete", exitCode: 0, result: true });
      const record = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8"));
      assert.equal(record.resolved_cwd, dir);
      assert.equal(record.worktree, null);
      assert.deepEqual(record.attempts[0].diagnostics.worktrees, [tree]);
      assert.deepEqual(record.attempts[0].diagnostics.claudeLaunch, launchDiagnostics.claudeLaunch);
      if (outcome === "refused") {
        assert.deepEqual(record.attempts[0].diagnostics.apiError, { status: 429, code: "rate_limit" });
      }
    } finally {
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
