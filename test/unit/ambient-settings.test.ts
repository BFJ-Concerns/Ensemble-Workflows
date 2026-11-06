import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CALLER_IDENTITY_ENV, resolveAmbientSettings } from "../../src/ambient-settings.js";

test("caller identity has a named environment route without widening ambient settings", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-caller-identity-env-"));
  try {
    const settings = resolveAmbientSettings({
      env: { XDG_CONFIG_HOME: path.join(cwd, "missing"), [CALLER_IDENTITY_ENV]: "session:ambient-test" },
      cwd
    });
    assert.equal(CALLER_IDENTITY_ENV, "ENSEMBLE_CALLER_IDENTITY");
    assert.equal("callerIdentity" in settings, false);
    assert.deepEqual(Object.keys(settings).sort(), [
      "agentCeiling",
      "concurrencyCaps",
      "configFile",
      "openCodeModels",
      "runRecordDir",
      "runRecordEnabled",
      "runRecordStoreDir",
      "statusDir",
      "statusEnabled",
      "workerEnvironment"
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ambient settings resolve every setting independently through all layers", async () => {
  const fixture = await configFixture({
    schema_version: 1,
    agent_ceiling: 2,
    concurrency: { codex: 3, claude: 4, opencode: 5 },
    run_record: { enabled: true, dir: "/file/records" },
    status: { enabled: false }
  });
  try {
    const settings = resolveAmbientSettings({
      env: {
        XDG_CONFIG_HOME: fixture.configHome,
        ENSEMBLE_AGENT_CEILING: "6",
        ENSEMBLE_CONCURRENCY_CLAUDE: "7",
        ENSEMBLE_RUN_RECORD_DIR: "/env/records"
      },
      cwd: fixture.cwd,
      flags: {
        concurrencyCaps: { codex: 8 }
      }
    });

    assert.deepEqual(settings.agentCeiling, { value: 6, layer: "env" });
    assert.deepEqual(settings.concurrencyCaps.codex, { value: 8, layer: "flag" });
    assert.deepEqual(settings.concurrencyCaps.claude, { value: 7, layer: "env" });
    assert.deepEqual(settings.concurrencyCaps.opencode, { value: 5, layer: "config-file" });
    assert.deepEqual(settings.runRecordDir, { value: "/env/records", layer: "env" });
    assert.deepEqual(settings.statusDir, { value: null, layer: "config-file" });
  } finally {
    await fixture.cleanup();
  }
});

test("a higher layer can explicitly restore an unbounded agent ceiling", async () => {
  const fixture = await configFixture({ schema_version: 1, agent_ceiling: 2 });
  try {
    const fromEnvironment = resolveAmbientSettings({
      env: {
        XDG_CONFIG_HOME: fixture.configHome,
        ENSEMBLE_AGENT_CEILING: "null"
      },
      cwd: fixture.cwd
    });
    assert.deepEqual(fromEnvironment.agentCeiling, { value: null, layer: "env" });

    const fromFlag = resolveAmbientSettings({
      env: {
        XDG_CONFIG_HOME: fixture.configHome,
        ENSEMBLE_AGENT_CEILING: "6"
      },
      cwd: fixture.cwd,
      flags: { agentCeiling: null }
    });
    assert.deepEqual(fromFlag.agentCeiling, { value: null, layer: "flag" });
  } finally {
    await fixture.cleanup();
  }
});

test("an absent machine config is silent and resolves built-in defaults", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-ambient-"));
  const configHome = path.join(cwd, "missing-config-home");
  const settings = resolveAmbientSettings({
    env: { XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: path.join(cwd, "data") },
    cwd
  });

  assert.deepEqual(settings.agentCeiling, { value: null, layer: "default" });
  assert.equal(settings.concurrencyCaps.claude.value, 12);
  assert.equal(settings.concurrencyCaps.claude.layer, "default");
  assert.equal(settings.concurrencyCaps.codex.value, 12);
  assert.equal(settings.concurrencyCaps.codex.layer, "default");
  assert.deepEqual(settings.runRecordDir, {
    value: path.join(cwd, "data", "ensemble"),
    layer: "default"
  });
  assert.deepEqual(settings.statusDir, { value: null, layer: "default" });
  await rm(cwd, { recursive: true, force: true });
});

test("machine config rejects parse errors, unknown keys, invalid values, zero, and schema skew", async () => {
  const cases: Array<{ source: string; pattern: RegExp }> = [
    { source: '{"schema_version":1,', pattern: /parse.*config\.json/i },
    { source: '{"schema_version":1,"maxAgent":2}', pattern: /maxAgent.*config\.json/ },
    { source: '{"schema_version":1,"agent_ceiling":"2"}', pattern: /agent_ceiling.*config\.json/ },
    { source: '{"schema_version":1,"concurrency":{"codex":0}}', pattern: /concurrency\.codex.*config\.json/ },
    { source: '{"schema_version":2}', pattern: /schema_version 2.*config\.json.*understood versions: 1/ }
  ];

  for (const entry of cases) {
    const fixture = await rawConfigFixture(entry.source);
    try {
      assert.throws(
        () => resolveAmbientSettings({ env: { XDG_CONFIG_HOME: fixture.configHome }, cwd: fixture.cwd }),
        entry.pattern
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("malformed environment values fail naming the variable", () => {
  assert.throws(
    () =>
      resolveAmbientSettings({
        env: { XDG_CONFIG_HOME: "/definitely/absent", ENSEMBLE_AGENT_CEILING: "two" },
        cwd: "/tmp"
      }),
    /ENSEMBLE_AGENT_CEILING/
  );
  assert.throws(
    () =>
      resolveAmbientSettings({
        env: { XDG_CONFIG_HOME: "/definitely/absent", ENSEMBLE_CONCURRENCY_CODEX: "0" },
        cwd: "/tmp"
      }),
    /ENSEMBLE_CONCURRENCY_CODEX/
  );
  assert.throws(
    () =>
      resolveAmbientSettings({
        env: { XDG_CONFIG_HOME: "/definitely/absent", ENSEMBLE_STATUS: "perhaps" },
        cwd: "/tmp"
      }),
    /ENSEMBLE_STATUS/
  );
});

test("every environment-variable refusal quotes the offending value", () => {
  const cases: Array<[string, string]> = [
    ["ENSEMBLE_AGENT_CEILING", "two"],
    ["ENSEMBLE_CONCURRENCY_CODEX", "0"],
    ["ENSEMBLE_CONCURRENCY_CLAUDE", "-3"],
    ["ENSEMBLE_STATUS", "perhaps"],
    ["ENSEMBLE_RUN_RECORD", "maybe"],
    ["ENSEMBLE_STATUS_DIR", "  "],
    ["ENSEMBLE_RUN_RECORD_DIR", ""],
    ["ENSEMBLE_AGENT_CEILING", "9".repeat(400)],
    ["ENSEMBLE_CONCURRENCY_OPENCODE", "9007199254740993"]
  ];
  for (const [key, value] of cases) {
    assert.throws(
      () => resolveAmbientSettings({ env: { XDG_CONFIG_HOME: "/definitely/absent", [key]: value }, cwd: "/tmp" }),
      (error: Error) => error.message.startsWith(`Invalid value for ${key}:`) && error.message.endsWith(`; got ${JSON.stringify(value)}`),
      `${key}=${JSON.stringify(value)}`
    );
  }
});

test("worker_environment resolves per engine from the config file alone", async () => {
  const fixture = await configFixture({
    schema_version: 1,
    worker_environment: {
      claude: { ANTHROPIC_BASE_URL: "https://gateway.local", ANTHROPIC_AUTH_TOKEN: "tok" },
      codex: { OPENAI_BASE_URL: "https://codex-gateway.local" }
    }
  });
  try {
    const settings = resolveAmbientSettings({
      env: { XDG_CONFIG_HOME: fixture.configHome },
      cwd: fixture.cwd
    });

    assert.deepEqual(settings.workerEnvironment, {
      claude: { ANTHROPIC_BASE_URL: "https://gateway.local", ANTHROPIC_AUTH_TOKEN: "tok" },
      codex: { OPENAI_BASE_URL: "https://codex-gateway.local" }
    });
    // Config-file only: there is deliberately no
    // ENSEMBLE_WORKER_ENVIRONMENT variable and no CLI flag, so nothing else
    // to assert layers against — an absent section is simply empty.
  } finally {
    await fixture.cleanup();
  }
});

test("an absent worker_environment section resolves empty, changing nothing", async () => {
  const fixture = await configFixture({ schema_version: 1 });
  try {
    const settings = resolveAmbientSettings({
      env: { XDG_CONFIG_HOME: fixture.configHome },
      cwd: fixture.cwd
    });
    assert.deepEqual(settings.workerEnvironment, {});
  } finally {
    await fixture.cleanup();
  }
});

test("worker_environment fails loud on unknown engines and non-string values", async () => {
  const cases: Array<{ source: string; pattern: RegExp }> = [
    {
      source: '{"schema_version":1,"worker_environment":{"gemini":{"K":"v"}}}',
      pattern: /worker_environment\.gemini.*config\.json/
    },
    {
      source: '{"schema_version":1,"worker_environment":{"claude":{"K":1}}}',
      pattern: /worker_environment\.claude\.K.*must be a string/
    },
    {
      source: '{"schema_version":1,"worker_environment":{"claude":["K"]}}',
      pattern: /worker_environment\.claude.*JSON object/
    },
    {
      source: '{"schema_version":1,"worker_environment":{"claude":{" ":"v"}}}',
      pattern: /worker_environment\.claude.*non-empty/
    },
    {
      source: '{"schema_version":1,"worker_environment":[]}',
      pattern: /worker_environment.*JSON object/
    }
  ];

  for (const entry of cases) {
    const fixture = await rawConfigFixture(entry.source);
    try {
      assert.throws(
        () => resolveAmbientSettings({ env: { XDG_CONFIG_HOME: fixture.configHome }, cwd: fixture.cwd }),
        entry.pattern
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("opencode_models declares the opencode catalogue from the config file alone", async () => {
  const fixture = await configFixture({
    schema_version: 1,
    opencode_models: {
      "hosted-model": {
        provider_model: "router/vendor/hosted-model",
        display_name: "Hosted Model",
        family: "vendor",
        vision: true,
        billing: "pay-as-you-go",
        variants: ["fast", "thorough"]
      },
      "bare-model": { provider_model: "local/Bare-Model" }
    }
  });
  try {
    const settings = resolveAmbientSettings({
      env: { XDG_CONFIG_HOME: fixture.configHome },
      cwd: fixture.cwd
    });

    assert.deepEqual(settings.openCodeModels, [
      {
        key: "hosted-model",
        providerModel: "router/vendor/hosted-model",
        displayName: "Hosted Model",
        provider: "router",
        family: "vendor",
        capabilities: { vision: true },
        billing: { mode: "pay-as-you-go" },
        variants: ["fast", "thorough"]
      },
      // Only the route is required: the display name falls back to the key,
      // and undeclared metadata stays absent rather than guessed.
      {
        key: "bare-model",
        providerModel: "local/Bare-Model",
        displayName: "bare-model",
        provider: "local",
        capabilities: { vision: false },
        variants: []
      }
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("an absent opencode_models section declares no opencode models", async () => {
  const fixture = await configFixture({ schema_version: 1 });
  try {
    const settings = resolveAmbientSettings({
      env: { XDG_CONFIG_HOME: fixture.configHome },
      cwd: fixture.cwd
    });
    assert.deepEqual(settings.openCodeModels, []);
  } finally {
    await fixture.cleanup();
  }
});

test("opencode_models fails loud on malformed declarations", async () => {
  const cases: Array<{ models: unknown; pattern: RegExp }> = [
    { models: [], pattern: /opencode_models.*JSON object of model keys/ },
    { models: { " ": { provider_model: "a/b" } }, pattern: /opencode_models.*model keys must be non-empty/ },
    { models: { m: "a/b" }, pattern: /opencode_models\.m .*must be a JSON object/ },
    { models: { m: {} }, pattern: /opencode_models\.m\.provider_model.*provider\/model route/ },
    { models: { m: { provider_model: "no-provider" } }, pattern: /opencode_models\.m\.provider_model/ },
    { models: { m: { provider_model: "/model" } }, pattern: /opencode_models\.m\.provider_model/ },
    { models: { m: { provider_model: "a/b", tier: "x" } }, pattern: /Unknown machine configuration key opencode_models\.m\.tier/ },
    { models: { m: { provider_model: "a/b", family: "" } }, pattern: /opencode_models\.m\.family.*non-empty string/ },
    { models: { m: { provider_model: "a/b", vision: "yes" } }, pattern: /opencode_models\.m\.vision.*boolean/ },
    { models: { m: { provider_model: "a/b", billing: "free" } }, pattern: /opencode_models\.m\.billing.*pay-as-you-go \| self-hosted/ },
    { models: { m: { provider_model: "a/b", variants: ["x", "x"] } }, pattern: /opencode_models\.m\.variants.*distinct/ },
    {
      models: { first: { provider_model: "a/shared" }, second: { provider_model: "a/shared" } },
      pattern: /opencode_models.*"a\/shared" names both "first" and "second"/
    }
  ];

  for (const entry of cases) {
    const fixture = await configFixture({ schema_version: 1, opencode_models: entry.models });
    try {
      assert.throws(
        () => resolveAmbientSettings({ env: { XDG_CONFIG_HOME: fixture.configHome }, cwd: fixture.cwd }),
        entry.pattern
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("the record store directory resolves even when recording is disabled", async () => {
  // The completion sentinel lands under the store whether or not the archive
  // is written, so the store path must survive `run_record.enabled: false`.
  const fixture = await configFixture({
    schema_version: 1,
    run_record: { enabled: false, dir: "/file/records" }
  });
  try {
    const settings = resolveAmbientSettings({
      env: { XDG_CONFIG_HOME: fixture.configHome },
      cwd: fixture.cwd
    });
    assert.deepEqual(settings.runRecordDir, { value: null, layer: "config-file" });
    assert.deepEqual(settings.runRecordStoreDir, { value: "/file/records", layer: "config-file" });
  } finally {
    await fixture.cleanup();
  }
});

async function configFixture(value: unknown): Promise<{
  cwd: string;
  configHome: string;
  cleanup(): Promise<void>;
}> {
  return rawConfigFixture(JSON.stringify(value));
}

async function rawConfigFixture(source: string): Promise<{
  cwd: string;
  configHome: string;
  cleanup(): Promise<void>;
}> {
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-ambient-"));
  const configHome = path.join(cwd, "config");
  const configFile = path.join(configHome, "ensemble", "config.json");
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, source);
  return {
    cwd,
    configHome,
    cleanup: async () => rm(cwd, { recursive: true, force: true })
  };
}

test("a configured status directory that does not exist is refused quoting the path", () => {
  const missing = "/definitely/absent/status dir";
  assert.throws(
    () => resolveAmbientSettings({ env: { XDG_CONFIG_HOME: "/definitely/absent", ENSEMBLE_STATUS_DIR: missing }, cwd: "/tmp" }),
    (error: Error) => error.message.includes(`not a directory: ${JSON.stringify(missing)} (from the ENSEMBLE_STATUS_DIR`)
  );
});
