import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { removeTestDirectory } from "../failure-evidence.js";
import { ClaudeCliControlPlane } from "../../src/claude-control-plane.js";
import { ClaudeStripPreparer } from "../../src/claude-strip-preparation.js";
import { CLAUDE_TOOL_CLASSIFICATION, claudeToolSurfaceProbePrompt, readClaudeToolSurface } from "../../src/claude-tool-surface.js";
import { startCaptureProvider } from "../../src/provider-capture.js";
import { findOnlyFile, runNode } from "../integration/estate-process.js";

const exec = promisify(execFile);
const isLive = process.env.ENSEMBLE_LIVE === "1";
const skip = isLive ? false : "set ENSEMBLE_LIVE=1 to exercise the real Claude background tool surface";
const bundle = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

/** Private settings, placeholder credentials and a private daemon; no model is reached. */
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ensemble-claude-strip-"));
  const config = path.join(root, "claude");
  const xdg = path.join(root, "config");
  await mkdir(config);
  await mkdir(path.join(xdg, "ensemble"), { recursive: true });
  const key = "sk-ant-ensemble-tool-surface-placeholder";
  await writeFile(path.join(config, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true, customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] }
  }));
  await writeFile(path.join(config, "settings.json"), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
  const provider = await startCaptureProvider();
  const workerEnv = {
    CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: provider.origin, ANTHROPIC_API_KEY: key,
    ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "0", CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "0", CLAUDE_CODE_USE_FOUNDRY: "0"
  };
  await writeFile(path.join(xdg, "ensemble", "config.json"), JSON.stringify({
    schema_version: 1, worker_environment: { claude: workerEnv }
  }));
  const env = { ...workerEnv, XDG_CONFIG_HOME: xdg, TMPDIR: root,
    ENSEMBLE_STATUS: "0", ENSEMBLE_RUN_RECORD: "1", ENSEMBLE_RUN_RECORD_DIR: path.join(root, "records") };
  return { root, workerEnv, env, provider, async close(testFailed = false) {
    let cleanupFailed = false;
    try {
      // This config directory belongs solely to this test. No operator daemon is stopped.
      await exec("claude", ["daemon", "stop", "--any"], { env: { ...process.env, ...env }, timeout: 15_000 });
    } catch (error) {
      cleanupFailed = true;
      throw error;
    } finally {
      await provider.close();
      await removeTestDirectory(root, testFailed || cleanupFailed);
    }
  } };
}

test("a stripped Claude worker is offered no agent or skill tool, while unstripped controls on either side are",
  { skip, timeout: 600_000 }, async (t) => {
    const f = await fixture();
    const nonces = [randomUUID(), randomUUID(), randomUUID()];
    let testFailed = false;
    try {
      const workflow = path.join(f.root, "surface.mjs");
      await writeFile(workflow, `export const meta = { name: "claude-strip-boundary" };
        for (const [index, prompt] of ${JSON.stringify(nonces.map(claudeToolSurfaceProbePrompt))}.entries()) {
          await agent(prompt, { engine: "claude", model: "haiku", cwd: ${JSON.stringify(f.root)},
            label: "surface-" + index, maxAttempts: 1, timeoutMs: 60000,
            ...(index === 1 ? { strip: ["agents", "skills"] } : {}) });
        }`);
      const result = await runNode([bundle, "--timeout", "400000", workflow], f.env, 450_000);
      t.diagnostic(JSON.stringify({ code: result.code, stderr: result.stderr }));
      // The capture provider rejects each turn intentionally. Its request is the evidence.
      const surfaces = nonces.map((nonce) => readClaudeToolSurface(f.provider.requests(), nonce));
      t.diagnostic(JSON.stringify({ code: result.code, surfaces }));
      const archive = path.dirname(await findOnlyFile(path.join(f.root, "records"), "manifest.json"));
      const records = await Promise.all((await readdir(path.join(archive, "agents"))).map(async (id) =>
        JSON.parse(await readFile(path.join(archive, "agents", id, "agent.json"), "utf8")) as {
          label: string; strip: null | { enforcement: Record<string, { route: string; detail: string }> }
        }));
      const [before, stripped, after] = surfaces;
      assert.ok(before && stripped && after);
      for (const name of ["ListAgents", "SendMessage", "Skill"]) {
        assert.ok(before.tools.some(tool => tool.name === name), `first control did not expose ${name}`);
        assert.ok(after.tools.some(tool => tool.name === name), `second control did not expose ${name}`);
      }
      const restrictedRecord = records.find(record => record.label === "surface-1");
      assert.ok(restrictedRecord?.strip, result.stderr);
      const details = restrictedRecord.strip.enforcement;
      const denyMatch = /^permissions.deny (\[[^\]]*\])/.exec(details.agents!.detail);
      assert.ok(denyMatch);
      assert.match(details.agents!.detail, /CLAUDE_CODE_DISABLE_ADVISOR_TOOL.*1/);
      assert.ok(!stripped.tools.some(tool => tool.name === "advisor"));
      assert.ok(before.tools.some(tool => tool.name === "advisor"));
      assert.ok(after.tools.some(tool => tool.name === "advisor"));
      const denies = JSON.parse(denyMatch[1]!) as string[];
      const offered = new Set(stripped.tools.map(tool => tool.name));
      assert.ok(denies.every(name => !offered.has(name)));
      assert.deepEqual([...offered].sort(), before.tools.map(tool => tool.name).filter(name => !denies.includes(name)).sort());
      assert.deepEqual(after.tools.map(tool => tool.name), before.tools.map(tool => tool.name));
      for (const capability of ["agents", "skills"]) {
        assert.equal(details[capability]?.route, "config");
        assert.ok(details[capability]?.detail.includes(`Claude Code ${stripped.cliVersion}`));
      }
      assert.equal(records.filter(record => record.strip === null).length, 2);
      // Probes use their own capture servers; only the three requested workers reach this one.
      for (const request of f.provider.requests()) {
        if (request.path.startsWith("/v1/messages") && JSON.stringify(request.body).includes("Ensemble tool-surface probe")) {
          assert.ok(nonces.some(nonce => JSON.stringify(request.body).includes(nonce)), "an unstripped worker triggered a preparation probe");
        }
      }
    } catch (error) {
      testFailed = true;
      throw error;
    } finally { await f.close(testFailed); }
  });

test("a built-in agent tool nobody has classified is denied while unrelated tools stay available",
  { skip, timeout: 300_000 }, async (t) => {
    const f = await fixture();
    const plane = new ClaudeCliControlPlane({ workerEnv: f.workerEnv });
    const classification = { ...CLAUDE_TOOL_CLASSIFICATION };
    delete classification.ListAgents;
    const surfaces: Awaited<ReturnType<typeof plane.probeToolSurface>>[] = [];
    const preparer = new ClaudeStripPreparer({ classification, probe: async (request) => {
      const surface = await plane.probeToolSurface(request);
      surfaces.push(surface);
      return surface;
    } });
    let testFailed = false;
    try {
      const prepared = await preparer.prepare({ strip: ["agents"], cwd: f.root, model: "haiku" });
      t.diagnostic(JSON.stringify({ prepared, surfaces }));
      assert.ok(surfaces[0]?.tools.some(tool => tool.name === "ListAgents"), "the control did not expose the stand-in agent tool");
      assert.ok(prepared.permissionDenyRules.includes("ListAgents"));
      assert.equal(prepared.settingsEnv.CLAUDE_CODE_DISABLE_ADVISOR_TOOL, "1");
      assert.ok(surfaces[0]?.tools.some(tool => tool.name === "advisor"));
      assert.ok(!surfaces[1]?.tools.some(tool => tool.name === "advisor"));
      assert.ok(!surfaces[1]?.tools.some(tool => tool.name === "ListAgents"));
      for (const name of ["Read", "Bash"]) assert.ok(surfaces[1]?.tools.some(tool => tool.name === name));
      assert.match(prepared.enforcement.agents?.detail ?? "", /unclassified and denied: \[[^\]]*"ListAgents"/);
      const skills = await preparer.prepare({ strip: ["skills"], cwd: f.root, model: "haiku" });
      assert.deepEqual(skills.settingsEnv, {});
      assert.ok(surfaces[3]?.tools.some(tool => tool.name === "advisor"), "skills-only strip removed advisor");
      assert.ok(!surfaces[3]?.tools.some(tool => tool.name === "Skill"));
    } catch (error) {
      testFailed = true;
      throw error;
    } finally { t.diagnostic(JSON.stringify({ surfaces })); preparer.close(); await plane.close(); await f.close(testFailed); }
  });
