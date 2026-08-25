import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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

test("StatusFileWriter heartbeat re-stamps a quiet run's snapshot", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-status-file-"));
  const file = path.join(dir, STATUS_FILENAME);
  const progress = newProgress();
  const writer = new StatusFileWriter({ progress, dir, heartbeatMs: 5 });

  const first = JSON.parse(await waitForFile(file)) as ProgressSnapshot;
  // No progress activity at all — only the heartbeat may advance the stamp.
  const later = await waitForSnapshot(file, (candidate) => candidate.updatedAt > first.updatedAt);
  assert.ok(later.updatedAt > first.updatedAt);

  await writer.close();
});

test("StatusFileWriter close leaves another run's snapshot in place", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-status-file-"));
  const file = path.join(dir, STATUS_FILENAME);
  const progress = newProgress();
  const writer = new StatusFileWriter({ progress, dir });
  await waitForFile(file);

  // A second run in the same cwd has since published its own snapshot.
  const other = { schema: 1, runId: "another-run", state: "running" };
  await writeFile(file, `${JSON.stringify(other)}\n`);

  await writer.close();

  const survivor = JSON.parse(await readFile(file, "utf8")) as { runId: string };
  assert.equal(survivor.runId, "another-run");
});

test("StatusFileWriter close cannot unlink a snapshot replaced after its ownership check", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-status-file-"));
  const file = path.join(dir, STATUS_FILENAME);
  const progress = newProgress();
  const other = { schema: 1, runId: "another-run", state: "running" };
  let replaced = false;
  const writer = new StatusFileWriter({
    progress,
    dir,
    fileOperations: {
      readFile: async (candidate, encoding) => {
        const contents = await readFile(candidate, encoding);
        if (!replaced) {
          replaced = true;
          await writeFile(file, `${JSON.stringify(other)}\n`);
        }
        return contents;
      }
    }
  });
  await waitForFile(file);

  await writer.close();

  const survivor = JSON.parse(await readFile(file, "utf8")) as { runId: string };
  assert.equal(survivor.runId, "another-run");
});

test("StatusFileWriter close restores another run's snapshot by rename when the no-clobber link fails", async () => {
  // A failed link() must not fall through to the claim unlink — that
  // destroyed the foreign snapshot outright (its public name empty, its
  // content parked under a name nothing reads). The rename fallback puts it
  // back and consumes the claim in the same motion.
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-status-file-"));
  const file = path.join(dir, STATUS_FILENAME);
  const progress = newProgress();
  const writer = new StatusFileWriter({
    progress,
    dir,
    onError: () => {
      throw new Error("reporter failed");
    },
    fileOperations: {
      link: async () => {
        throw Object.assign(new Error("forced restore failure"), { code: "EIO" });
      }
    }
  });
  await waitForFile(file);
  await writeFile(file, `${JSON.stringify({ schema: 1, runId: "another-run", state: "running" })}\n`);

  await assert.doesNotReject(writer.close());

  const survivor = JSON.parse(await readFile(file, "utf8")) as { runId: string };
  assert.equal(survivor.runId, "another-run");
  const claims = (await readdir(dir)).filter((entry) => entry.endsWith(".remove"));
  assert.deepEqual(claims, []);
});

test("StatusFileWriter close keeps its claim when no restore route succeeds", async () => {
  // Both restore routes forced down: the claim is deliberately left in
  // place — the foreign snapshot's only remaining copy — for a later run's
  // stale-artefact sweep, rather than unlinked into nothing.
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-status-file-"));
  const file = path.join(dir, STATUS_FILENAME);
  const progress = newProgress();
  const { rename } = await import("node:fs/promises");
  const errors: unknown[] = [];
  const writer = new StatusFileWriter({
    progress,
    dir,
    onError: (error) => errors.push(error),
    fileOperations: {
      link: async () => {
        throw Object.assign(new Error("forced link failure"), { code: "EIO" });
      },
      rename: async (source, destination) => {
        if (source.endsWith(".remove")) {
          throw Object.assign(new Error("forced rename failure"), { code: "EIO" });
        }
        await rename(source, destination);
      }
    }
  });
  await waitForFile(file);
  await writeFile(file, `${JSON.stringify({ schema: 1, runId: "another-run", state: "running" })}\n`);

  await assert.doesNotReject(writer.close());

  const claims = (await readdir(dir)).filter((entry) => entry.endsWith(".remove"));
  assert.equal(claims.length, 1);
  const preserved = JSON.parse(await readFile(path.join(dir, claims[0]!), "utf8")) as { runId: string };
  assert.equal(preserved.runId, "another-run");
  assert.equal(errors.length, 2);
});

test("StatusFileWriter sweeps dead-process artefacts without touching live-process artefacts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-status-file-"));
  const target = path.join(dir, STATUS_FILENAME);
  const deadPid = 2_147_483_647;
  const stale = [
    `${target}.${deadPid}.1.tmp`,
    `${target}.${deadPid}.00000000-0000-4000-8000-000000000001.remove`
  ];
  const live = [
    `${target}.${process.pid}.999.tmp`,
    `${target}.${process.pid}.00000000-0000-4000-8000-000000000002.remove`
  ];
  await Promise.all([...stale, ...live].map(async (file) => writeFile(file, "status artefact")));

  const writer = new StatusFileWriter({ progress: newProgress(), dir });
  await waitForFile(target);
  await writer.close();

  for (const file of stale) {
    assert.equal(await exists(file), false, `expected stale artefact to be swept: ${file}`);
  }
  for (const file of live) {
    assert.equal(await exists(file), true, `expected live artefact to survive: ${file}`);
  }
});
