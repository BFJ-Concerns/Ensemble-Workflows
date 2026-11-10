import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ENGINE_RESOURCE_RESOLVERS, claudeConfigDirectory, engineResourceRequirements } from "../../src/engine-resources.js";
import { createDefaultEngineRegistry, EngineRegistry, type EngineAdapter } from "../../src/engines.js";
import { launchEnvironment } from "../../src/engine-environment.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { classifyAttemptFailure } from "../../src/failure-classification.js";
import {
  EngineResourceGate,
  ResourcePreflightRefusedError,
  diagnoseCallerSandbox,
  judgeResources,
  probeResource,
  type ResourceRequirement
} from "../../src/resource-preflight.js";

import { NoWorkerScopes } from "../../src/worker-scopes.js";

import type { EngineName } from "../../src/types.js";

async function withDirectory(run: (dir: string) => Promise<void>, root = tmpdir()): Promise<void> {
  const dir = await mkdtemp(path.join(root, "ensemble-preflight-"));
  try {
    await run(dir);
  } finally {
    await chmod(dir, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}

function requirement(overrides: Partial<ResourceRequirement> & { path: string }): ResourceRequirement {
  return { owner: "launcher", role: "test store", access: "create-entries", resolvedFrom: "the test", ...overrides };
}

test("a usable directory passes both probes and is left as it was", async () => {
  // Under /tmp rather than the suite's TMPDIR, which is too deep to hold a
  // Unix socket path.
  await withDirectory(async (dir) => {
    assert.equal(await probeResource(requirement({ path: dir })), null);
    assert.equal(await probeResource(requirement({ path: dir, access: "bind-socket" })), null);
    assert.deepEqual(await readdir(dir), []);
  }, "/tmp");
});

test("a directory too deep to hold a socket path is denied as too long, and left as it was", async () => {
  await withDirectory(async (dir) => {
    const deep = path.join(dir, "d".repeat(100));
    await mkdir(deep);
    const denial = await probeResource(requirement({ path: deep, access: "bind-socket" }));
    assert.equal(denial?.code, "ENAMETOOLONG");
    assert.deepEqual(await readdir(deep), []);
  });
});

test("a missing directory is judged at its nearest existing ancestor, which is left as it was", async () => {
  await withDirectory(async (dir) => {
    assert.equal(await probeResource(requirement({ path: path.join(dir, "not", "yet") })), null);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("a read-only ancestor denies a missing directory, naming where it was probed", { skip: process.getuid?.() === 0 }, async () => {
  await withDirectory(async (dir) => {
    const locked = path.join(dir, "locked");
    await mkdir(locked);
    await chmod(locked, 0o500);
    const denial = await probeResource(requirement({ path: path.join(locked, "store") }));
    assert.equal(denial?.code, "EACCES");
    assert.equal(denial?.probedPath, locked);
  });
});

test("a path through a file is denied as not a directory", async () => {
  await withDirectory(async (dir) => {
    await writeFile(path.join(dir, "file"), "");
    const denial = await probeResource(requirement({ path: path.join(dir, "file", "store") }));
    assert.equal(denial?.code, "ENOTDIR");
  });
});

test("a refusal names the resource, its owner, its source and the error, and claims no sandbox without evidence", async () => {
  await withDirectory(async (dir) => {
    await writeFile(path.join(dir, "file"), "");
    const store = path.join(dir, "file", "store");
    const refusal = await judgeResources([requirement({ path: store, resolvedFrom: "ENSEMBLE_RUN_RECORD_DIR" })], {}).then(
      () => assert.fail("expected a refusal"),
      (error: unknown) => error
    );
    assert.ok(refusal instanceof ResourcePreflightRefusedError);
    assert.equal(refusal.sandbox, null);
    assert.match(refusal.message, new RegExp(`cannot create entries in ${store}`));
    assert.match(refusal.message, /the launcher's test store \(from ENSEMBLE_RUN_RECORD_DIR\): ENOTDIR/);
    assert.match(refusal.message, /no sandbox around the launching process was identified/);
  });
});

test("a caller sandbox is named only by a rule whose evidence matches", () => {
  const denials = [
    { requirement: requirement({ path: "/home/someone/.codex" }), probedPath: "/home/someone/.codex", code: "EROFS", message: "read-only" }
  ];
  const rules = [
    {
      name: "Example",
      lift: "run the launcher outside it",
      detect: (env: NodeJS.ProcessEnv) => (env.EXAMPLE_SANDBOX === "1" ? "EXAMPLE_SANDBOX=1" : null)
    }
  ];
  assert.equal(diagnoseCallerSandbox({}, denials, rules), null);
  assert.deepEqual(diagnoseCallerSandbox({ EXAMPLE_SANDBOX: "1" }, denials, rules), {
    name: "Example",
    evidence: "EXAMPLE_SANDBOX=1",
    lift: "run the launcher outside it"
  });
});

test("the engine gate reuses a resource verdict and refuses each attempt afresh", async () => {
  await withDirectory(async (dir) => {
    await writeFile(path.join(dir, "file"), "");
    const resolved: EngineName[] = [];
    const gate = new EngineResourceGate((engine) => {
      resolved.push(engine);
      return engine === "codex" ? [requirement({ owner: "codex", path: path.join(dir, "file", "home") })] : [];
    }, {});
    await gate.require("claude");
    const first = await gate.require("codex").catch((error: unknown) => error);
    await rm(path.join(dir, "file"));
    const second = await gate.require("codex").catch((error: unknown) => error);
    assert.ok(first instanceof ResourcePreflightRefusedError);
    assert.ok(second instanceof ResourcePreflightRefusedError);
    assert.notEqual(first, second);
    assert.deepEqual(resolved, ["claude", "codex", "codex"]);
  });
});

test("a preflight refusal is an availability failure on every engine", () => {
  for (const engine of ["codex", "claude", "opencode"] as const) {
    assert.deepEqual(
      classifyAttemptFailure({
        engine,
        failure: { kind: "ResourcePreflightRefusedError", message: "denied" },
        appServerDiagnostic: null,
        diagnostics: undefined
      }),
      { class: "availability", rule: "preflight.resource-denied" }
    );
  }
});

test("the Codex home resolves from the environment Codex is launched with", () => {
  const launcher = { HOME: "/home/launcher", CODEX_HOME: "/inherited/codex" };
  assert.deepEqual(
    engineResourceRequirements("codex", undefined, "/work", launcher).map((r) => [r.path, r.resolvedFrom]),
    [["/inherited/codex", "CODEX_HOME"]]
  );
  assert.deepEqual(
    engineResourceRequirements("codex", { CODEX_HOME: "declared" }, "/work", launcher).map((r) => [r.path, r.resolvedFrom]),
    [["/work/declared", "CODEX_HOME"]]
  );
  assert.deepEqual(
    engineResourceRequirements("codex", { HOME: "/home/declared" }, "/work", { HOME: "/home/launcher" }).map((r) => [r.path, r.resolvedFrom]),
    [["/home/declared/.codex", "default: $HOME/.codex"]]
  );
});

test("every engine declares the filesystem resources it needs", () => {
  const env = { worker: { HOME: "/home/someone" }, launcher: { HOME: "/home/someone" }, cwd: "/work" };
  for (const [engine, resolve] of Object.entries(ENGINE_RESOURCE_RESOLVERS)) {
    const requirements = resolve(env);
    assert.ok(requirements.length > 0, `${engine} declares no resources`);
    for (const declared of requirements) {
      assert.equal(declared.owner, engine);
      assert.ok(path.isAbsolute(declared.path), `${engine}: ${declared.path} is not absolute`);
    }
  }
});


test("Claude checks its own homes and sockets separately from launcher scratch and valve paths", () => {
  const requirements = engineResourceRequirements("claude", {
    HOME: "/worker", CLAUDE_CONFIG_DIR: "/mnt/ai-data/scratch/ensemble-home-preflight/claude",
    TMPDIR: "/worker/tmp", TMUX_TMPDIR: "/worker/valve"
  }, "/work", { HOME: "/launcher", TMPDIR: "/launcher/tmp", TMUX_TMPDIR: "/launcher/valve" });
  assert.deepEqual(requirements.map((r) => [r.role, r.path, r.access]), [
    ["Claude home", "/mnt/ai-data/scratch/ensemble-home-preflight/claude", "create-entries"],
    ["Claude global configuration", "/mnt/ai-data/scratch/ensemble-home-preflight/claude", "create-entries"],
    ["daemon sockets", `/tmp/cc-daemon-${process.getuid?.() ?? 0}/31fe4a63`, "bind-socket"],
    ["dispatch settings scratch files", "/launcher/tmp", "create-entries"],
    ["reply valve sockets", "/launcher/valve", "bind-socket"],
    ["Claude scratch files", `/worker/tmp/claude-${process.getuid?.() ?? 0}`, "create-entries"]
  ]);
  const defaults = engineResourceRequirements("claude", { HOME: "/declared" }, "/work", {});
  assert.equal(defaults[0]?.path, "/declared/.claude");
  assert.equal(defaults[1]?.path, "/declared");
  assert.equal(defaults[3]?.path, "/tmp");
  assert.equal(defaults[4]?.path, "/tmp");
});

test("opencode checks every XDG home and its worker temporary directory", () => {
  const requirements = engineResourceRequirements("opencode", {
    HOME: "/worker", XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "/config",
    XDG_STATE_HOME: "/state", XDG_CACHE_HOME: "/cache", TMPDIR: "/worker/tmp"
  }, "/work", { HOME: "/launcher", TMPDIR: "/launcher/tmp" });
  assert.deepEqual(requirements.map((r) => r.path), [
    "/work/data/opencode", "/config/opencode", "/state/opencode", "/cache/opencode", "/worker/tmp/opencode"
  ]);
  assert.deepEqual(engineResourceRequirements("opencode", undefined, "/work", { HOME: "/worker" }).map((r) => r.path), [
    "/worker/.local/share/opencode", "/worker/.config/opencode", "/worker/.local/state/opencode", "/worker/.cache/opencode", "/tmp/opencode"
  ]);
});

test("a Codex marker identifies a denied caller without mistaking a malformed path for sandbox denial", () => {
  const denial = { requirement: requirement({ path: "/store" }), probedPath: "/store", code: "EROFS", message: "read-only" };
  assert.equal(diagnoseCallerSandbox({}, [denial]), null);
  assert.equal(diagnoseCallerSandbox({ CODEX_THREAD_ID: "an-unsandboxed-caller" }, [denial]), null);
  const identified = diagnoseCallerSandbox({ CODEX_SANDBOX_NETWORK_DISABLED: "1" }, [denial]);
  assert.equal(identified?.name, "Codex");
  assert.match(identified?.lift ?? "", /danger-full-access/);
  assert.equal(diagnoseCallerSandbox({ CODEX_SANDBOX_NETWORK_DISABLED: "1" }, [{ ...denial, code: "ENOTDIR" }]), null);
});

test("a denied engine scratch directory refuses before the engine starts", async () => {
  await withDirectory(async (dir) => {
    const blocker = path.join(dir, "scratch");
    await writeFile(blocker, "not a directory");
    const gate = new EngineResourceGate((engine) => engineResourceRequirements(engine, { HOME: dir }, dir, { HOME: dir, TMPDIR: blocker }));
    await assert.rejects(gate.require("claude"), (error: unknown) => {
      assert.ok(error instanceof ResourcePreflightRefusedError);
      assert.match(error.message, /dispatch settings scratch files.*launcher TMPDIR.*ENOTDIR/);
      return true;
    });
  });
});


test("a denied Claude scratch home falls back before its worker runs and does not inspect unused engines", async () => {
  await withDirectory(async (dir) => {
    const blocker = path.join(dir, "scratch");
    await writeFile(blocker, "not a directory");
    const ran: EngineName[] = [];
    const resolved: EngineName[] = [];
    const adapter = (name: EngineName): EngineAdapter => ({
      name, concurrency: 1,
      schedule: async (run) => run(),
      createInvocation: () => ({ runAttempt: async () => {
        ran.push(name);
        return { text: "fallback answer", deltaText: "fallback answer", durationMs: 1, firstDeltaMs: 1, items: {}, tokenUsageEvents: [] };
      } }),
      close: async () => undefined
    });
    const runtime = new EnsembleRuntime({
      cwd: dir, defaultMaxAttempts: 1,
      engines: new EngineRegistry([adapter("claude"), adapter("codex"), adapter("opencode")], [], (engine) => {
        resolved.push(engine);
        return engineResourceRequirements(engine, { HOME: dir }, dir, { HOME: dir, TMPDIR: blocker });
      })
    });
    try {
      assert.equal(await runtime.agent("work", { engine: "claude", fallback: [{ engine: "codex", model: "gpt-6-sol" }] }), "fallback answer");
      assert.deepEqual(ran, ["codex"]);
      assert.deepEqual(resolved, ["claude", "codex"]);
    } finally {
      await runtime.close();
    }
  });
});


test("relative Claude configuration stays on one home when dispatch and roster commands have different working directories", () => {
  const requirements = engineResourceRequirements("claude", { CLAUDE_CONFIG_DIR: "relative-home" }, "/worker/cwd", {});
  assert.equal(requirements[0]?.path, path.resolve("relative-home"));
});

test("relative engine homes follow each worker placement without reusing another placement's verdict", async () => {
  await withDirectory(async (dir) => {
    const good = path.join(dir, "good");
    const bad = path.join(dir, "bad");
    await mkdir(good);
    await mkdir(bad);
    await writeFile(path.join(dir, "resources"), "base directory must not be judged");
    await writeFile(path.join(bad, "resources"), "worker resource is not a directory");
    for (const name of ["claude", "opencode"] as const) {
      const ran: string[] = [];
      const adapter: EngineAdapter = {
        name, concurrency: 1,
        schedule: async (run) => run(),
        createInvocation: (_prompt, options) => ({ runAttempt: async () => {
          ran.push(options.cwd!);
          return { text: '"answer"', deltaText: '"answer"', durationMs: 1, firstDeltaMs: 1, items: {}, tokenUsageEvents: [] };
        } }),
        close: async () => undefined
      };
      const runtime = new EnsembleRuntime({
        cwd: dir, defaultMaxAttempts: 1,
        engines: new EngineRegistry([adapter], [], (engine, cwd) =>
          engineResourceRequirements(engine, name === "claude" ? { CLAUDE_CODE_TMPDIR: "resources" } : { XDG_DATA_HOME: "resources" }, cwd)
            .filter((r) => r.role === (name === "claude" ? "Claude scratch files" : "opencode data")))
      });
      try {
        // Usable placement must not inherit a denial from the run's base.
        assert.equal(await runtime.agent("work", { engine: name, cwd: good }), '"answer"');
        // A second placement must not inherit the first placement's pass.
        await assert.rejects(runtime.agent("work", { engine: name, cwd: bad, schema: { type: "string" } }), ResourcePreflightRefusedError);
        assert.deepEqual(ran, [good]);
      } finally {
        await runtime.close();
      }
    }
  });
});


test("the default registry uses worker placement for Claude and opencode, but the app-server base for Codex", async () => {
  const registry = await createDefaultEngineRegistry({
    cwd: "/run/base", codexBin: "codex", requestTimeoutMs: 1000,
    startupHandshakeTimeoutMs: 1000, clientName: "test", clientVersion: "test",
    workerScopes: new NoWorkerScopes(),
    workerEnvironment: {
      codex: { CODEX_HOME: "codex-home" },
      claude: { CLAUDE_CODE_TMPDIR: "claude-scratch" },
      opencode: { XDG_DATA_HOME: "data" }
    },
    onEvent: () => undefined, onClaudeEvent: () => undefined, onOpenCodeEvent: () => undefined
  });
  try {
    assert.equal(registry.resourceRequirements("codex", "/placed/worker")[0]?.path, "/run/base/codex-home");
    assert.equal(registry.resourceRequirements("claude", "/placed/worker").find((r) => r.role === "Claude scratch files")?.path,
      `/placed/worker/claude-scratch/claude-${process.getuid?.() ?? 0}`);
    assert.equal(registry.resourceRequirements("opencode", "/placed/worker")[0]?.path, "/placed/worker/data/opencode");
  } finally {
    await registry.close();
  }
});


test("a socket directory without search permission preserves the resource refusal", { skip: process.getuid?.() === 0 }, async () => {
  await withDirectory(async (dir) => {
    await chmod(dir, 0o600);
    await assert.rejects(judgeResources([requirement({ owner: "claude", path: dir, access: "bind-socket" })], {}), (error: unknown) => {
      assert.ok(error instanceof ResourcePreflightRefusedError);
      assert.equal(error.denials[0]?.code, "EACCES");
      assert.equal(error.denials[0]?.requirement.path, dir);
      assert.match(error.message, /the claude engine's test store/);
      return true;
    });
  }, "/mnt/ai-data/scratch");
});

test("an empty Claude config override keeps the default home and daemon identity", () => {
  const env = launchEnvironment("claude", { CLAUDE_CONFIG_DIR: "" }, { HOME: "/worker" });
  assert.equal(env.CLAUDE_CONFIG_DIR, "");
  assert.equal(claudeConfigDirectory(env, "/placed/worker"), "/worker/.claude");
  const empty = engineResourceRequirements("claude", { CLAUDE_CONFIG_DIR: "" }, "/placed/worker", { HOME: "/worker" });
  const absent = engineResourceRequirements("claude", undefined, "/placed/worker", { HOME: "/worker" });
  assert.deepEqual(empty, absent);
});

test("a relative Codex HOME is resolved against the app-server launch directory", () => {
  const resources = engineResourceRequirements("codex", { HOME: "relative-home", CODEX_HOME: "" }, "/run/base", {});
  assert.equal(resources[0]?.path, "/run/base/relative-home/.codex");
});
