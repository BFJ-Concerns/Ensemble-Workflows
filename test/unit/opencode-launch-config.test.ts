import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { CapabilityStripUnsupportedError, LeanStartUnsupportedError } from "../../src/errors.js";
import { OpenCodeCliRunner } from "../../src/opencode-engine.js";
import { readProcessStartTicks } from "../../src/process-owner-evidence.js";
import { prepareOpenCodeLaunch } from "../../src/opencode-launch-config.js";

const providerModel = "gateway/proof";
const output = (config: unknown) => ({ exitCode: 0, stdout: JSON.stringify(config) });

test("an ordinary opencode worker reads no configuration through Ensemble", async () => {
  const env = { OPENCODE_CONFIG_CONTENT: "{custom}" };
  const launch = await prepareOpenCodeLaunch({
    env, strip: [], lean: false, providerModel,
    run: async () => assert.fail("ordinary worker must not probe")
  });
  assert.equal(launch.env, env);
});

test("opencode strip retains JSONC settings and verifies native agent deny precedence", async () => {
  const env = { OPENCODE_CONFIG_CONTENT: `{
    // Preserve an injected setting containing a URL.
    "instructions": ["https://example.invalid/rules",],
    "agent": { "build": { "prompt": "fixture instructions" } },
  }` };
  const permission = { "*": "allow" };
  const agent = { build: { permission: { skill: "allow", bash: "ask" } } };
  let calls = 0;
  const launch = await prepareOpenCodeLaunch({
    env, strip: ["skills"], lean: false, providerModel,
    run: async (args, probeEnv) => {
      assert.deepEqual(args, ["debug", "config"]);
      if (calls++ === 0) return output({ permission, agent });
      const overlay = JSON.parse(probeEnv.OPENCODE_CONFIG_CONTENT!);
      assert.deepEqual(overlay.instructions, ["https://example.invalid/rules"]);
      assert.equal(overlay.agent.build.prompt, "fixture instructions");
      assert.deepEqual(overlay.agent.build.permission, { bash: "ask", skill: "deny" });
      assert.deepEqual(JSON.parse(probeEnv.OPENCODE_PERMISSION!), { "*": "allow", skill: "deny" });
      return output(overlay);
    }
  });
  assert.equal(calls, 2);
  assert.notEqual(launch.env, env);

  let probe = 0;
  await assert.rejects(prepareOpenCodeLaunch({
    env, strip: ["skills"], lean: false, providerModel,
    run: async () => output(probe++ === 0 ? { agent } : {
      permission: { skill: "deny" },
      agent: { build: { permission: { skill: "deny", "sk*": "allow" } } }
    })
  }), CapabilityStripUnsupportedError);
});

test("opencode lean retains reach configuration and removes its private file on refusal", async () => {
  const provider = { gateway: { options: { baseURL: "https://example.invalid" } } };
  const env = { XDG_CONFIG_HOME: "/operator/config", XDG_DATA_HOME: "/operator/auth" };
  const original = {
    provider,
    instructions: ["/operator/AGENTS.md"],
    mcp: { search: { enabled: true } },
    skills: { paths: ["/operator/skills"] },
    permission: { bash: "deny" },
    agent: { build: { prompt: "operator instructions", permission: { edit: "deny" } } }
  };
  let profileFile: string | undefined;
  await assert.rejects(prepareOpenCodeLaunch({
    env, strip: [], lean: true, providerModel,
    run: async (args, probeEnv) => {
      if (probeEnv === env) return output(original);
      if (args[0] === "models") return { exitCode: 0, stdout: "gateway/other\n" };
      profileFile = probeEnv.OPENCODE_CONFIG!;
      const profile = JSON.parse(await readFile(profileFile, "utf8"));
      assert.deepEqual(profile.provider, provider);
      assert.deepEqual(profile.agent, { build: { permission: { edit: "deny" } } });
      assert.deepEqual(profile.permission, original.permission);
      assert.equal(profile.instructions, undefined);
      assert.equal(profile.mcp, undefined);
      assert.equal(profile.skills, undefined);
      assert.equal(probeEnv.XDG_DATA_HOME, env.XDG_DATA_HOME);
      assert.notEqual(probeEnv.XDG_CONFIG_HOME, env.XDG_CONFIG_HOME);
      assert.equal((await stat(profileFile)).mode & 0o777, 0o600);
      return output(profile);
    }
  }), LeanStartUnsupportedError);
  assert.ok(profileFile);
  await assert.rejects(access(profileFile), { code: "ENOENT" });
});

test("a later opencode dispatch reclaims a killed launcher's lean profile and keeps live profiles", async (t) => {
  if (await readProcessStartTicks("/proc", process.pid) === null) {
    t.skip("requires process ownership evidence from /proc");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-reclaim-"));
  const savedTemp = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try {
    const savedProfilePath = path.join(root, "profile-path");
    const moduleUrl = new URL("../../src/opencode-launch-config.js", import.meta.url).href;
    await assert.rejects(promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
      import { writeFile } from "node:fs/promises";
      const { prepareOpenCodeLaunch } = await import(process.argv[1]);
      const launch = await prepareOpenCodeLaunch({
        env: {}, lean: true, strip: [], providerModel: "gateway/proof",
        run: async (args) => ({
          exitCode: 0,
          stdout: args[0] === "models" ? "gateway/proof" : '{"provider":{"gateway":{"options":{"apiKey":"fixture-key"}}}}'
        })
      });
      await writeFile(process.argv[2], launch.env.OPENCODE_CONFIG);
      process.kill(process.pid, "SIGKILL");
    `, moduleUrl, savedProfilePath], { timeout: 10_000 }), { signal: "SIGKILL" });

    const abandonedConfig = await readFile(savedProfilePath, "utf8");
    assert.match(await readFile(abandonedConfig, "utf8"), /fixture-key/);
    const live = await prepareOpenCodeLaunch({
      env: {}, lean: true, strip: [], providerModel,
      run: async (args) => args[0] === "models" ? { exitCode: 0, stdout: providerModel } : output({})
    });
    // This may be another launcher between directory creation and its owner write.
    const unknownOwner = await mkdtemp(path.join(root, "ensemble-opencode-lean-"));
    const bin = path.join(root, "opencode");
    await writeFile(bin, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    try {
      const result = await new OpenCodeCliRunner(bin).run({ cwd: root, providerModel, prompt: "fixture" });
      assert.equal(result.exitCode, 0);
      await assert.rejects(access(path.dirname(abandonedConfig)), { code: "ENOENT" });
      await access(live.env.OPENCODE_CONFIG!);
      await access(unknownOwner);
    } finally {
      await live.close?.();
    }
  } finally {
    if (savedTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTemp;
    await rm(root, { recursive: true, force: true });
  }
});

test("the opencode sweep requires the sticky bit in a writable root and skips unsafe entries", async (t) => {
  const ticks = await readProcessStartTicks("/proc", process.pid);
  if (ticks === null) {
    t.skip("requires process ownership evidence from /proc");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-sweep-"));
  try {
    const owner = JSON.stringify({ pid: process.pid, start_ticks: `${ticks}0`, host: hostname() });
    const elsewhere = path.join(root, "other-owner.json");
    await writeFile(elsewhere, owner);
    const linked = await mkdtemp(path.join(root, "ensemble-opencode-lean-"));
    await symlink(elsewhere, path.join(linked, "owner.json"));
    const pipe = await mkdtemp(path.join(root, "ensemble-opencode-lean-"));
    await promisify(execFile)("mkfifo", [path.join(pipe, "owner.json")]);
    const writable = await mkdtemp(path.join(root, "ensemble-opencode-lean-"));
    await writeFile(path.join(writable, "owner.json"), owner);
    await chmod(writable, 0o777);
    const ordinary = await mkdtemp(path.join(root, "ensemble-opencode-lean-"));
    await writeFile(path.join(ordinary, "owner.json"), owner);

    const moduleUrl = new URL("../../src/opencode-launch-config.js", import.meta.url).href;
    const sweep = () => promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
      const { sweepAbandonedOpenCodeProfiles } = await import(process.argv[1]);
      await sweepAbandonedOpenCodeProfiles();
    `, moduleUrl], { timeout: 5_000, env: { ...process.env, TMPDIR: root } });

    await chmod(root, 0o0777);
    await sweep();
    await access(ordinary);

    await chmod(root, 0o1777);
    await sweep();
    await assert.rejects(access(ordinary), { code: "ENOENT" });
    for (const directory of [linked, pipe, writable]) await access(directory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
