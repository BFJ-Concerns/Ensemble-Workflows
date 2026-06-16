import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { formatStatusLine, readStatusLine } from "../../src/status-line.js";
import { STATUS_FILENAME } from "../../src/status-file.js";

import type { EngineProgressSnapshot, ProgressSnapshot } from "../../src/progress.js";

function engine(overrides: Partial<EngineProgressSnapshot> = {}): EngineProgressSnapshot {
  return { cap: null, active: 0, queued: 0, done: 0, failed: 0, spent: 0, ceiling: null, remaining: null, ...overrides };
}

function snapshot(overrides: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
  return {
    schema: 1,
    runId: "run-1",
    pid: 1,
    workflow: null,
    state: "running",
    startedAt: 0,
    updatedAt: 0,
    finishedAt: null,
    currentPhase: null,
    totals: { active: 0, queued: 0, done: 0, failed: 0 },
    engines: { codex: engine(), claude: engine() },
    agents: [],
    ...overrides
  };
}

test("formatStatusLine compresses phase, per-engine load, tally, and elapsed into one line", () => {
  const line = formatStatusLine(
    snapshot({
      currentPhase: "Verify",
      totals: { active: 4, queued: 2, done: 12, failed: 1 },
      engines: {
        codex: engine({ active: 3, queued: 2, spent: 48_000, ceiling: 100_000 }),
        claude: engine({ active: 1 })
      }
    }),
    134_000
  );

  assert.equal(line, "ensemble · ▸ Verify · codex ⚡3⏳2 48k/100k · claude ⚡1 · ✓12 ✗1 · 2m14s");
});

test("formatStatusLine falls back to the workflow name when no phase is set", () => {
  const line = formatStatusLine(snapshot({ workflow: "audit" }), 0);
  assert.equal(line, "ensemble · ▸ audit · 0s");
});

test("formatStatusLine shows spend for an idle engine and omits failed when zero", () => {
  const line = formatStatusLine(
    snapshot({
      totals: { active: 0, queued: 0, done: 3, failed: 0 },
      engines: { codex: engine({ spent: 6_500 }), claude: engine() }
    }),
    5_000
  );
  assert.equal(line, "ensemble · codex 6.5k · ✓3 · 5s");
});

test("formatStatusLine renders an hours-scale duration and uses finishedAt when set", () => {
  const line = formatStatusLine(snapshot({ state: "finished", finishedAt: 3_725_000 }), 9_999_999);
  assert.equal(line, "ensemble · 1h02m");
});

test("readStatusLine returns null when the side-channel is off or the file is absent", async () => {
  assert.equal(await readStatusLine(null, () => 0), null);
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-status-line-"));
  assert.equal(await readStatusLine(dir, () => 0), null);
});

test("readStatusLine ignores corrupt, finished, and stale snapshots", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-status-line-"));
  const file = path.join(dir, STATUS_FILENAME);

  await writeFile(file, "{ not json");
  assert.equal(await readStatusLine(dir, () => 1_000), null);

  await writeFile(file, `${JSON.stringify(snapshot({ state: "finished", updatedAt: 1_000 }))}\n`);
  assert.equal(await readStatusLine(dir, () => 1_000), null);

  await writeFile(file, `${JSON.stringify(snapshot({ state: "running", updatedAt: 1_000 }))}\n`);
  assert.equal(await readStatusLine(dir, () => 1_000 + 30_001), null);
});

test("readStatusLine renders a fresh running snapshot", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-status-line-"));
  const file = path.join(dir, STATUS_FILENAME);
  const fresh = snapshot({
    currentPhase: "collect",
    startedAt: 0,
    updatedAt: 10_000,
    engines: { codex: engine({ active: 2 }), claude: engine() }
  });
  await writeFile(file, `${JSON.stringify(fresh)}\n`);

  const line = await readStatusLine(dir, () => 12_000);
  assert.equal(line, "ensemble · ▸ collect · codex ⚡2 · 12s");
});
