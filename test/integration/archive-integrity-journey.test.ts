import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readArchiveIntegrity } from "../archive-integrity-reader.js";
import { findOnlyFile, hermeticEstateEnvironment, runNode } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/scripts/ensemble.mjs");
const consumerPath = path.resolve("test/consumers/read-archive-integrity.mjs");
const archivedAgentsConsumerPath = path.resolve("test/consumers/read-archived-agents.mjs");
test("a sealed archive attests itself and its sentinel attests it back", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-archive-attested-"));
  const store = path.join(directory, "records");
  const workflowPath = path.join(directory, "workflow.js");

  try {
    await writeFile(workflowPath, `export const meta = { name: "attested" };\nreturn "ok";\n`);
    const run = await runNode([bundledCliPath, workflowPath], { ENSEMBLE_RUN_RECORD_DIR: store });
    assert.equal(run.code, 0, run.stderr);

    const archiveDir = path.dirname(await findOnlyFile(store, "manifest.json"));
    const reading = await readArchiveIntegrity(archiveDir);
    assert.equal(reading.status, "complete");
    assert.equal(reading.manifestVerified, true);
    assert.deepEqual(reading.filesLost, []);
    assert.equal(reading.sentinelPresent, true);
    assert.equal(reading.sentinelVerified, true);
    // The one thing the manifest cannot do for itself: a second file, written
    // after the seal, naming the digest it saw.
    assert.equal(reading.sentinelAttestsManifest, true);
    assert.equal(reading.liveness.verdict, "settled");

    // The attestation has teeth: an edited field breaks it, which is the
    // whole reason to carry the digest at all.
    const manifestPath = path.join(archiveDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { status: string };
    manifest.status = "failed";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const tampered = await readArchiveIntegrity(archiveDir);
    assert.equal(tampered.manifestVerified, false);
    // Rewriting the digest to match the edit repairs the self-check and is
    // exactly what the sentinel's outside copy is for.
    assert.equal(tampered.sentinelAttestsManifest, true);
    const repaired = JSON.parse(await readFile(manifestPath, "utf8")) as {
      integrity: { manifest_sha256: string };
    };
    repaired.integrity.manifest_sha256 = tamperedDigest(repaired);
    await writeFile(manifestPath, JSON.stringify(repaired, null, 2), "utf8");
    const resealed = await readArchiveIntegrity(archiveDir);
    assert.equal(resealed.manifestVerified, true);
    assert.equal(resealed.sentinelAttestsManifest, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an archive that lost files mid-run seals as incomplete and names the loss", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-archive-lost-"));
  const store = path.join(directory, "records");
  const workflowPath = path.join(directory, "workflow.js");

  try {
    // The workflow deletes a file out of its own archive while the run is
    // still going: the ordinary shape of an archive on a filesystem someone
    // else is also touching (a cleaner, a full disk, a stray rm).
    await writeFile(
      workflowPath,
      `
        export const meta = { name: "lost-mid-run" };
        const { readdir, rm } = await import("node:fs/promises");
        const path = (await import("node:path")).default;
        const store = process.env.ENSEMBLE_RUN_RECORD_DIR;
        const entries = await readdir(store, { recursive: true });
        const manifest = entries.find((entry) => path.basename(entry) === "manifest.json");
        await rm(path.join(store, path.dirname(manifest), "workflow.js"));
        return "ok";
      `
    );
    const run = await runNode([bundledCliPath, workflowPath], { ENSEMBLE_RUN_RECORD_DIR: store });
    assert.equal(run.code, 0, run.stderr);

    const archiveDir = path.dirname(await findOnlyFile(store, "manifest.json"));
    const reading = await readArchiveIntegrity(archiveDir);
    // The run itself ended cleanly, and result.json still says so — but the
    // archive is not whole, so the manifest refuses to call itself complete.
    assert.equal(reading.status, "incomplete");
    assert.deepEqual(reading.filesLost, [{ path: "workflow.js", reason: "missing" }]);
    assert.equal(reading.manifestVerified, true);
    assert.equal(reading.sentinelAttestsManifest, true);
    const result = JSON.parse(await readFile(path.join(archiveDir, "result.json"), "utf8")) as {
      status: string;
      exit_code: number;
    };
    assert.equal(result.status, "complete");
    assert.equal(result.exit_code, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a killed run reads as dead where a running one reads as live, without waiting for a reaper", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-archive-killed-"));
  const store = path.join(directory, "records");
  const workflowPath = path.join(directory, "workflow.js");
  const readyPath = path.join(directory, "ready");

  try {
    await writeFile(
      workflowPath,
      `
        export const meta = { name: "killed" };
        const { writeFile } = await import("node:fs/promises");
        await writeFile(${JSON.stringify(readyPath)}, "up");
        await new Promise((resolve) => setTimeout(resolve, 600_000));
        return "unreachable";
      `
    );
    const child = spawn(process.execPath, [bundledCliPath, workflowPath], {
      cwd: process.cwd(),
      env: hermeticEstateEnvironment({ ENSEMBLE_RUN_RECORD_DIR: store }),
      stdio: ["ignore", "ignore", "ignore"]
    });
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    await waitFor(async () => {
      await access(readyPath);
      await stat(await findOnlyFile(store, "manifest.json"));
    });

    const archiveDir = path.dirname(await findOnlyFile(store, "manifest.json"));
    // Same archive, twice, with only the owner process's fate differing:
    // that difference alone must move the reading.
    const running = await readArchiveIntegrity(archiveDir);
    assert.equal(running.status, "in-progress");
    assert.equal(running.liveness.verdict, "live");
    assert.equal(running.sentinelPresent, false);

    child.kill("SIGKILL");
    await exited;

    const killed = await readArchiveIntegrity(archiveDir);
    assert.equal(killed.status, "in-progress");
    assert.equal(killed.liveness.verdict, "dead");
    assert.equal(killed.liveness.reason, "owner-process-gone");
    // The reaper's contract is untouched: nothing was rewritten, so the
    // manifest still attests itself and still says "in-progress".
    assert.equal(killed.manifestVerified, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archive canonical order is locale-independent between writer and consumer", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-archive-locale-"));
  const store = path.join(directory, "records");
  const workflowPath = path.join(directory, "workflow.js");

  try {
    await writeFile(workflowPath, `export const meta = { name: "locale" };\nreturn "ok";\n`);
    // Written under a Turkish locale, read under the C locale: the canonical
    // form sorts by UTF-16 code unit, so the digest recipe holds across any
    // writer/consumer locale pairing — a locale-sensitive sort would let the
    // environment's ICU tailoring decide the byte order of the digested
    // document, and the two processes would disagree.
    const run = await runNode([bundledCliPath, workflowPath], {
      ENSEMBLE_RUN_RECORD_DIR: store,
      LC_ALL: "tr_TR.UTF-8"
    });
    assert.equal(run.code, 0, run.stderr);

    const archiveDir = path.dirname(await findOnlyFile(store, "manifest.json"));
    const reading = await runNode([consumerPath, archiveDir], { LC_ALL: "C" });
    assert.equal(reading.code, 0, reading.stderr);
    const parsed = JSON.parse(reading.stdout) as Awaited<ReturnType<typeof readArchiveIntegrity>>;
    assert.equal(parsed.manifestVerified, true);
    assert.equal(parsed.sentinelVerified, true);
    // The rule a cold consumer needs rides the archive itself.
    const manifest = JSON.parse(await readFile(path.join(archiveDir, "manifest.json"), "utf8")) as {
      integrity: { recipe?: string };
    };
    assert.match(manifest.integrity.recipe ?? "", /UTF-16 code unit/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the reference consumer refuses path escapes and symlinked entries", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-archive-hostile-"));
  const store = path.join(directory, "records");
  const workflowPath = path.join(directory, "workflow.js");

  try {
    await writeFile(workflowPath, `export const meta = { name: "hostile" };\nreturn "ok";\n`);
    const run = await runNode([bundledCliPath, workflowPath], { ENSEMBLE_RUN_RECORD_DIR: store });
    assert.equal(run.code, 0, run.stderr);

    const archiveDir = path.dirname(await findOnlyFile(store, "manifest.json"));
    const manifestPath = path.join(archiveDir, "manifest.json");
    const pristine = await readFile(manifestPath, "utf8");

    // Path escape: an entry pointing above the archive, with real matching
    // bytes waiting there — containment must refuse before any hash
    // comparison can vouch for foreign bytes.
    const escaped = JSON.parse(pristine) as {
      files: Array<{ path: string }>;
      integrity: { manifest_sha256: string | null };
    };
    const victim = escaped.files.find((file) => file.path === "workflow.js");
    assert.ok(victim, "the archived workflow source must be declared");
    await writeFile(path.join(archiveDir, "..", "outside.js"), await readFile(path.join(archiveDir, "workflow.js")));
    victim.path = "../outside.js";
    escaped.integrity.manifest_sha256 = tamperedDigest(escaped);
    await writeFile(manifestPath, JSON.stringify(escaped, null, 2), "utf8");
    const escapeReading = await runNode([consumerPath, archiveDir]);
    assert.notEqual(escapeReading.code, 0);
    assert.match(escapeReading.stderr, /escapes the archive/);

    // Symlinked entry: identical bytes, but reached through a link — the
    // archive attests only its own bytes, never a link's current target.
    await writeFile(manifestPath, pristine, "utf8");
    await rm(path.join(archiveDir, "workflow.js"));
    await symlink(path.join(archiveDir, "..", "outside.js"), path.join(archiveDir, "workflow.js"));
    const symlinkReading = await runNode([consumerPath, archiveDir]);
    assert.notEqual(symlinkReading.code, 0);
    assert.match(symlinkReading.stderr, /is a symlink/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an archive whose agent records are gone fails verification, named", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-archive-agents-"));
  const store = path.join(directory, "records");
  const workflowPath = path.join(directory, "workflow.js");
  // A directory outside any repository, so `isolation: "worktree"` is refused
  // at placement — after the dispatch-time record is written and before any
  // engine is contacted. The archive that leaves behind is the product's own
  // agent record, written by the real writer, not a fixture standing in for
  // one.
  const unplaceable = path.join(directory, "not-a-repository");

  try {
    await mkdir(unplaceable);
    // Two records, because the sibling consumer below discovers records by
    // walking the store: with only one, removing it leaves nothing to walk
    // and the failure would come from that consumer's pre-existing "expected
    // at least one agent.json" assertion rather than from the manifest
    // comparison under test.
    await writeFile(
      workflowPath,
      `export const meta = { name: "agent-records" };\n` +
        `for (const attempt of ["first", "second"]) {\n` +
        `  try {\n` +
        `    await agent(attempt, ${JSON.stringify({ engine: "codex", isolation: "worktree", cwd: unplaceable, maxAttempts: 1 })});\n` +
        `  } catch (error) {\n` +
        `    if (attempt === "second") throw error;\n` +
        `  }\n` +
        `}\n` +
        `return "unreached";\n`
    );
    const run = await runNode([bundledCliPath, workflowPath], { ENSEMBLE_RUN_RECORD_DIR: store });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /requires cwd to be inside a git repository/);

    const archiveDir = path.dirname(await findOnlyFile(store, "manifest.json"));
    const recordPath = "agents/000001/agent.json";
    await access(path.join(archiveDir, recordPath));

    const sound = await readArchiveIntegrity(archiveDir);
    assert.equal(sound.manifestVerified, true);
    assert.equal(sound.agentRecordsVerified, 2);
    const soundAgents = await runNode([archivedAgentsConsumerPath, store]);
    assert.equal(soundAgents.code, 0, soundAgents.stderr);

    // Removed outright: the manifest still names the record, so verification
    // must fail on the record's absence rather than on whichever read faults
    // first — the reading a consumer can act on.
    const manifestPath = path.join(archiveDir, "manifest.json");
    const pristine = await readFile(manifestPath, "utf8");
    await rm(path.join(archiveDir, "agents", "000001"), { recursive: true });
    const removed = await runNode([consumerPath, archiveDir]);
    assert.notEqual(removed.code, 0);
    assert.match(removed.stderr, new RegExp(`agent record ${recordPath} is named by the manifest but missing`));
    const walkedRemoved = await runNode([archivedAgentsConsumerPath, store]);
    assert.notEqual(walkedRemoved.code, 0);
    assert.match(walkedRemoved.stderr, new RegExp(`agent record ${recordPath} is named by .* but is not a file`));
    // Something else standing where the record should be. The manifest names
    // a record; a directory at that path satisfies a bare presence test and
    // then faults in the byte walk as a platform read error, which is the
    // same unnamed ending the check exists to replace.
    await mkdir(path.join(archiveDir, "agents", "000001", "agent.json"), { recursive: true });
    const substituted = await runNode([consumerPath, archiveDir]);
    assert.notEqual(substituted.code, 0);
    assert.match(substituted.stderr, new RegExp(`agent record ${recordPath} is named by the manifest but is not a file`));
    const walkedSubstituted = await runNode([archivedAgentsConsumerPath, store]);
    assert.notEqual(walkedSubstituted.code, 0);
    assert.match(walkedSubstituted.stderr, new RegExp(`agent record ${recordPath} is named by .* but is not a file`));
    await rm(path.join(archiveDir, "agents", "000001"), { recursive: true });

    // Declared lost, with the self-digest recomputed over the declaration:
    // every other integrity signal reads sound, and a `files_lost` entry
    // excuses an ordinary file from the byte walk. It cannot excuse an agent
    // record — that is the hole this check closes, and the one route by which
    // an archive missing its load-bearing content used to verify clean.
    const laundered = JSON.parse(pristine) as {
      files: Array<{ path: string }>;
      integrity: { manifest_sha256: string | null; files_lost: Array<{ path: string; reason: string }> };
    };
    laundered.integrity.files_lost = [{ path: recordPath, reason: "missing" }];
    laundered.integrity.manifest_sha256 = tamperedDigest(laundered);
    await writeFile(manifestPath, JSON.stringify(sortJson(laundered), null, 2), "utf8");
    const excused = await runNode([consumerPath, archiveDir]);
    assert.notEqual(excused.code, 0);
    assert.match(excused.stderr, new RegExp(`agent record ${recordPath} is named by the manifest but recorded lost`));

    // The same laundered archive read by the other consumer model, which
    // reaches the archive by walking the store rather than by being handed
    // one. Its own copy of the comparison has to catch this independently:
    // the surviving record satisfies every shape assertion it makes, so
    // without the manifest comparison it reports a clean read of a run whose
    // records are half gone.
    const walkedAgents = await runNode([archivedAgentsConsumerPath, store]);
    assert.notEqual(walkedAgents.code, 0);
    assert.match(walkedAgents.stderr, new RegExp(`agent record ${recordPath} is named by .* but recorded lost`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function tamperedDigest(manifest: { integrity: { manifest_sha256: string | null } }): string {
  const copy = JSON.parse(JSON.stringify(manifest)) as { integrity: { manifest_sha256: string | null } };
  copy.integrity.manifest_sha256 = null;
  return createHash("sha256").update(JSON.stringify(sortJson(copy), null, 2)).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entryValue]) => [key, sortJson(entryValue)]));
  }
  return value;
}

async function waitFor(check: () => Promise<unknown>): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
