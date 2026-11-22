import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

import { CapabilityStripUnsupportedError, LeanStartUnsupportedError } from "../../src/errors.js";
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
