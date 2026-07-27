import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveAmbientSettings } from "../../src/ambient-settings.js";

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

test("an absent machine config is silent and resolves built-in defaults", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-ambient-"));
  const configHome = path.join(cwd, "missing-config-home");
  const settings = resolveAmbientSettings({
    env: { XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: path.join(cwd, "data") },
    cwd
  });

  assert.deepEqual(settings.agentCeiling, { value: null, layer: "default" });
  assert.equal(settings.concurrencyCaps.claude.value, 8);
  assert.equal(settings.concurrencyCaps.claude.layer, "default");
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
