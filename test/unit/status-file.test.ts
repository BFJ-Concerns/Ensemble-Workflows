import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { RunProgress } from "../../src/progress.js";
import { STATUS_FILENAME, StatusFileWriter } from "../../src/status-file.js";

import type { BudgetView, ProgressSnapshot } from "../../src/progress.js";
import type { EngineName } from "../../src/types.js";

class StubBudget implements BudgetView {
  ceilings: Partial<Record<EngineName, number | null>> = { codex: null, claude: null, opencode: null };
  spent(): number {
    return 0;
  }
  remaining(): number {
    return Number.POSITIVE_INFINITY;
  }
}

function newProgress(): RunProgress {
  let clock = 1_000;
  const progress = new RunProgress({ runId: "run-x", budget: new StubBudget(), now: () => (clock += 1) });
  progress.registerEngine("codex", 4);
  progress.registerEngine("claude", 8);
  progress.registerEngine("opencode", 2);
  return progress;
}

async function waitForFile(file: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await readFile(file, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`status file never appeared: ${file}`);
}

async function waitForSnapshot(file: string, predicate: (snapshot: ProgressSnapshot) => boolean): Promise<ProgressSnapshot> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const snapshot = JSON.parse(await readFile(file, "utf8")) as ProgressSnapshot;
      if (predicate(snapshot)) {
        return snapshot;
      }
    } catch {
      // The atomic rename may not have happened yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`status file never matched expectation: ${file}`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

test("StatusFileWriter publishes a live snapshot and removes it on close", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-status-file-"));
  const file = path.join(dir, STATUS_FILENAME);
  const progress = newProgress();
  const writer = new StatusFileWriter({ progress, dir });

  // The initial publish happens without close, so a watcher sees the run start.
  const initial = JSON.parse(await waitForFile(file)) as ProgressSnapshot;
  assert.equal(initial.runId, "run-x");
  assert.equal(initial.state, "running");
  assert.equal(initial.engines.codex?.cap, 4);

  const id = progress.queueAgent({ engine: "codex", label: "x", phase: null });
  progress.startAgent(id);
  progress.settleAgent(id, "done");
  const latest = await waitForSnapshot(file, (snapshot) => snapshot.totals.done === 1);
  assert.equal(latest.engines.codex?.done, 1);
  assert.equal(latest.totals.done, 1);

  await writer.close();

  assert.equal(await exists(file), false);
});

test("StatusFileWriter coalesces a burst of changes into the latest published state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-status-file-"));
  const file = path.join(dir, STATUS_FILENAME);
  const progress = newProgress();
  const writer = new StatusFileWriter({ progress, dir });

  // Fire many synchronous transitions; the writer must converge on the latest.
  for (let index = 0; index < 200; index += 1) {
    const id = progress.queueAgent({ engine: "claude", label: null, phase: null });
    progress.startAgent(id);
    progress.settleAgent(id, "done");
  }

  const snapshot = await waitForSnapshot(file, (candidate) => candidate.totals.done === 200);
  assert.equal(snapshot.engines.claude?.done, 200);
  assert.equal(snapshot.totals.done, 200);

  await writer.close();
  assert.equal(await exists(file), false);
});

test("StatusFileWriter routes write failures to onError and still closes", async () => {
  const blocker = path.join(await mkdtemp(path.join(tmpdir(), "ensemble-status-file-")), "blocker");
  await writeFile(blocker, "not a directory");
  // A file stands where a directory parent is needed: mkdir -p fails (ENOTDIR).
  const dir = path.join(blocker, "status");

  const errors: unknown[] = [];
  const writer = new StatusFileWriter({ progress: newProgress(), dir, onError: (error) => errors.push(error) });
  await writer.close();

  assert.ok(errors.length >= 1, "expected at least one write error");
});
