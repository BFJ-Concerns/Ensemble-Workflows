import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { RunProgress } from "../../src/progress.js";
import {
  LEGACY_STATUS_FILENAME,
  StatusFileWriter,
  isStatusFileName,
  snapshotOwnerGone,
  statusFileName
} from "../../src/status-file.js";

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

function newProgress(runId = "run-x"): RunProgress {
  let clock = 1_000;
  const progress = new RunProgress({ runId, budget: new StubBudget(), now: () => (clock += 1) });
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

async function writeProcStat(procDir: string, pid: number, startTicks: string): Promise<void> {
  const dir = path.join(procDir, String(pid));
  await mkdir(dir, { recursive: true });
  // Fields 3–21 precede starttime (field 22); the comm field carries a
  // space so the parser's last-close-paren split is what the fixture tests.
  const before = ["S", "1", "1", "1", "0", "-1", "4194560", "0", "0", "0", "0", "0", "0", "0", "0", "0", "20", "0", "1"];
  await writeFile(path.join(dir, "stat"), `${pid} (fa ke) ${before.join(" ")} ${startTicks} 0 0\n`);
}

/** A fake proc root holding one live process (pid 4242, start ticks 99999) and this process. */
async function fakeProcRoot(): Promise<{ procDir: string; host: string }> {
  const procDir = await mkdtemp(path.join(tmpdir(), "ensemble-status-proc-"));
  await writeProcStat(procDir, 4242, "99999");
  await writeProcStat(procDir, process.pid, "77777");
  return { procDir, host: hostname() };
}

test("the status file is named by the run, under the local-file convention", () => {
  assert.equal(statusFileName("0b6d4c2e-1111-4222-8333-444455556666"), "ensemble.0b6d4c2e-1111-4222-8333-444455556666.local.json");
  assert.equal(isStatusFileName("ensemble.run-a.local.json"), true);
  // The legacy single slot is recognised so a sweep can retire it; a bare
  // prefix-and-suffix with no run between them is not a status file.
  assert.equal(isStatusFileName(LEGACY_STATUS_FILENAME), true);
  assert.equal(isStatusFileName("ensemble..local.json"), false);
  assert.equal(isStatusFileName("ensemble.run-a.local.json.4242.1.tmp"), false);
  assert.equal(isStatusFileName("settings.local.json"), false);
});

test("every published snapshot carries the writer's own liveness evidence and the schema version", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-status-owner-"));
  const writer = new StatusFileWriter({ progress: newProgress(), dir });
  try {
    const raw = await waitForFile(writer.path);
    const published = JSON.parse(raw) as { schema: number; owner?: { host: string; pid: number; start_ticks: string | null } };
    assert.equal(published.schema, 2);
    // The pid + start-ticks discipline the archive manifest's owner block
    // uses: a poller refutes a snapshot a killed run left behind instead of
    // trusting cleanup-by-cooperation.
    assert.equal(published.owner?.pid, process.pid);
    assert.equal(typeof published.owner?.host, "string");
    // This writer is alive with matching evidence, so it is not refutable.
    assert.equal(await snapshotOwnerGone(published.owner), false);
  } finally {
    await writer.close();
  }
});

test("snapshotOwnerGone refutes a dead or reused pid and never guesses without evidence", async () => {
  const { procDir, host } = await fakeProcRoot();
  // Dead pid: no stat entry, and this process can read its own.
  assert.equal(await snapshotOwnerGone({ host, pid: 555_555, start_ticks: "12345" }, procDir), true);
  // Reused pid: alive, but with different start ticks than recorded.
  assert.equal(await snapshotOwnerGone({ host, pid: 4242, start_ticks: "11111" }, procDir), true);
  // Matching evidence: not gone.
  assert.equal(await snapshotOwnerGone({ host, pid: 4242, start_ticks: "99999" }, procDir), false);
  // No recorded ticks, another host, or absent owner: never a guess.
  assert.equal(await snapshotOwnerGone({ host, pid: 4242, start_ticks: null }, procDir), false);
  assert.equal(await snapshotOwnerGone({ host: "elsewhere", pid: 4242, start_ticks: "11111" }, procDir), false);
  assert.equal(await snapshotOwnerGone(undefined, procDir), false);
});

test("two runs in one directory are each visible for their own lifetime", async () => {
  // Each run's view is its own: a later run never overwrites an earlier run's,
  // and the first run to end never removes the other's file.
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-status-two-runs-"));
  const first = new StatusFileWriter({ progress: newProgress("run-first"), dir });
  const second = new StatusFileWriter({ progress: newProgress("run-second"), dir });

  const firstSnapshot = JSON.parse(await waitForFile(first.path)) as ProgressSnapshot;
  const secondSnapshot = JSON.parse(await waitForFile(second.path)) as ProgressSnapshot;
  assert.equal(firstSnapshot.runId, "run-first");
  assert.equal(secondSnapshot.runId, "run-second");
  assert.notEqual(first.path, second.path);

  await first.close();

  // The second run is untouched by the first's ending, and still live.
  assert.equal(await exists(first.path), false);
  assert.equal((JSON.parse(await readFile(second.path, "utf8")) as ProgressSnapshot).runId, "run-second");
  assert.deepEqual(await readdir(dir), [path.basename(second.path)]);

  await second.close();
  assert.deepEqual(await readdir(dir), []);
});

test("a new writer's startup sweep removes the files of runs whose owner is provably gone, and nothing else", async () => {
  const { procDir, host } = await fakeProcRoot();
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-status-sweep-"));
  const dead = path.join(dir, statusFileName("run-dead"));
  const live = path.join(dir, statusFileName("run-live"));
  const legacy = path.join(dir, LEGACY_STATUS_FILENAME);
  const noEvidence = path.join(dir, statusFileName("run-no-evidence"));
  const unparseable = path.join(dir, statusFileName("run-garbled"));
  const foreign = path.join(dir, "settings.local.json");
  // Temp files are judged by their writer pid against the same proc root:
  // 555555 has no stat entry, 4242 has one.
  const deadTemp = `${dead}.555555.3.tmp`;
  const liveTemp = `${live}.4242.1.tmp`;
  await Promise.all([
    // A SIGKILLed run's leftover: state "running", owner provably dead.
    writeFile(dead, `${JSON.stringify({ runId: "run-dead", state: "running", owner: { host, pid: 555_555, start_ticks: "1" } })}\n`),
    // A run still going: owner evidence matches the fake proc root.
    writeFile(live, `${JSON.stringify({ runId: "run-live", state: "running", owner: { host, pid: 4242, start_ticks: "99999" } })}\n`),
    // The pre-per-run single slot, left by a killed older runtime.
    writeFile(legacy, `${JSON.stringify({ runId: "run-old", state: "running", owner: { host, pid: 555_555, start_ticks: "1" } })}\n`),
    // No evidence and unparseable content are never this writer's to destroy.
    writeFile(noEvidence, `${JSON.stringify({ runId: "run-no-evidence", state: "running" })}\n`),
    writeFile(unparseable, "{not json\n"),
    writeFile(foreign, "{}\n"),
    // Temp files: attributable to a dead writer, or to a live one.
    writeFile(deadTemp, "half-written\n"),
    writeFile(liveTemp, "half-written\n")
  ]);

  const writer = new StatusFileWriter({ progress: newProgress("run-new"), dir, procDir });
  try {
    await waitForFile(writer.path);
  } finally {
    await writer.close();
  }

  const survivors = (await readdir(dir)).sort();
  assert.deepEqual(survivors, [
    path.basename(liveTemp),
    path.basename(live),
    path.basename(unparseable),
    path.basename(noEvidence),
    path.basename(foreign)
  ].sort());
});

test("StatusFileWriter publishes a live snapshot and removes it on close", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-status-file-"));
  const progress = newProgress();
  const writer = new StatusFileWriter({ progress, dir });
  const file = writer.path;

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
  const progress = newProgress();
  const writer = new StatusFileWriter({ progress, dir });
  const file = writer.path;

  // Fire many synchronous transitions; the writer must converge on the latest.
  const ids: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    ids.push(progress.queueAgent({ engine: "codex", label: `a${index}`, phase: null }));
  }
  for (const id of ids) {
    progress.startAgent(id);
    progress.settleAgent(id, "done");
  }

  const latest = await waitForSnapshot(file, (snapshot) => snapshot.totals.done === 20);
  assert.equal(latest.totals.done, 20);
  assert.equal(latest.totals.active, 0);

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
  const progress = newProgress();
  const writer = new StatusFileWriter({ progress, dir, heartbeatMs: 5 });
  const file = writer.path;

  const first = JSON.parse(await waitForFile(file)) as ProgressSnapshot;
  // No progress activity at all — only the heartbeat may advance the stamp.
  const later = await waitForSnapshot(file, (candidate) => candidate.updatedAt > first.updatedAt);
  assert.ok(later.updatedAt > first.updatedAt);

  await writer.close();
});

test("a throwing error reporter cannot take the writer down", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-status-file-"));
  let reports = 0;
  const writer = new StatusFileWriter({
    progress: newProgress(),
    dir,
    fileOperations: {
      writeFile: async () => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
    },
    onError: () => {
      reports += 1;
      throw new Error("reporter failed");
    }
  });
  await writer.close();
  assert.ok(reports >= 1);
});
