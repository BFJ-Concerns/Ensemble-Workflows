import assert from "node:assert/strict";
import test from "node:test";

import { EnsembleRuntime } from "../../src/runtime.js";

import type { RunRecordWriter, RuntimeAgentRecord } from "../../src/run-record.js";
import type {
  RuntimeTransport,
  ThreadStartOptions,
  TurnResult,
} from "../../src/types.js";
import type {
  IsolatedWorktree,
  IsolatedWorktreeRecord,
  WorktreeIsolationManager,
} from "../../src/worktree-isolation.js";

test("a finalisation failure keeps a committed worktree discoverable in memory and the durable agent record", async () => {
  const worktree = {
    path: "/estate/repo.worktrees/committed",
    branch: "ensemble-workflows/estate-committed",
    baseCommit: "estate-base",
  };
  const manager = new ThrowingFinishManager(worktree);
  const records: RuntimeAgentRecord[] = [];
  const runtime = new EnsembleRuntime({
    transport: new CommittedWorkerTransport(),
    cwd: "/estate/repo",
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1,
    worktreeManager: manager,
  });
  runtime.setRunRecorder({
    recordAgent: async (record: RuntimeAgentRecord) => {
      records.push(structuredClone(record));
    },
  } as unknown as RunRecordWriter);

  await assert.rejects(
    runtime.agent("commit before finalisation fails", {
      engine: "codex",
      isolation: "worktree",
      maxAttempts: 1,
    }),
    /ESTATE_FINISH_FAILURE/,
  );

  assert.deepEqual(manager.finished, [worktree]);
  assert.deepEqual(
    {
      runtime: runtime.worktrees.some((record) => record.branch === worktree.branch),
      durable: records.some((record) => record.worktree?.branch === worktree.branch),
    },
    {
      runtime: true,
      durable: true,
    },
    "the created branch must remain discoverable even when finish() cannot produce its complete outcome",
  );
});

class ThrowingFinishManager implements WorktreeIsolationManager {
  readonly finished: IsolatedWorktree[] = [];

  constructor(private readonly worktree: IsolatedWorktree) {}

  async create(): Promise<IsolatedWorktree> {
    return this.worktree;
  }

  async finish(worktree: IsolatedWorktree): Promise<IsolatedWorktreeRecord> {
    this.finished.push(worktree);
    throw new Error("ESTATE_FINISH_FAILURE");
  }
}

class CommittedWorkerTransport implements RuntimeTransport {
  readonly cwd = "/estate/repo";

  async openThread(options: ThreadStartOptions): Promise<string> {
    assert.equal(options.cwd, "/estate/repo.worktrees/committed");
    return "estate-thread";
  }

  async runTurn(): Promise<TurnResult> {
    return {
      text: "commit complete",
      deltaText: "commit complete",
      durationMs: 0,
      firstDeltaMs: 0,
      items: {},
      tokenUsageEvents: [],
    };
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}
