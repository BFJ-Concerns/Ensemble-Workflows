import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { CodexAppServerTransport } from "../../src/app-server.js";
import { AppServerExitedError } from "../../src/errors.js";
import { runProcess } from "./estate-process.js";

test("real Codex startup in a per-call cwd retains a SQLite lock refusal and recovers after release", { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-codex-startup-state-"));
  const home = path.join(directory, "home");
  const codexHome = path.join(home, ".codex");
  const cwd = path.join(directory, "requested-cwd");
  let database: DatabaseSync | undefined;
  const options = {
    cwd,
    codexBin: "codex",
    workerEnv: {
      HOME: home,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share")
    },
    clientName: "ensemble-startup-state",
    clientVersion: "1",
    requestTimeoutMs: 15_000,
    startupHandshakeTimeoutMs: 20_000
  };
  try {
    await mkdir(codexHome, { recursive: true });
    await mkdir(cwd);
    const version = await runProcess("codex", ["--version"], options.workerEnv, 15_000);
    assert.equal(version.code, 0, version.stderr);
    t.diagnostic(version.stdout.trim());

    // Initialise the real engine's database before taking its lock. The
    // requested cwd and home stay identical across all three starts.
    await (await CodexAppServerTransport.start(options)).close();
    const states = (await readdir(codexHome)).filter((name) => /^state_\d+\.sqlite$/.test(name));
    assert.equal(states.length, 1, `expected one Codex state database, found ${states.join(", ")}`);
    database = new DatabaseSync(path.join(codexHome, states[0]!));
    // A rollback-journal exclusive transaction blocks readers as well as
    // writers, so startup encounters contention without a timing race.
    database.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;");
    await assert.rejects(CodexAppServerTransport.start(options), (error: unknown) => {
      assert.ok(error instanceof AppServerExitedError, String(error));
      assert.match(error.message, /exited with code 1 signal null/);
      assert.match(error.message, /failed to initialize sqlite state runtime/);
      assert.ok(error.message.includes(codexHome), error.message);
      return true;
    });
    database.exec("ROLLBACK;");
    database.close();
    database = undefined;

    await (await CodexAppServerTransport.start(options)).close();
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
