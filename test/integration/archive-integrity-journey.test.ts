import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { findOnlyFile, hermeticEstateEnvironment, runNode } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const consumerPath = path.resolve("test/consumers/read-archive-integrity.mjs");
const distIndexPath = path.resolve("dist/src/index.js");

interface IntegrityReading {
  status: string;
  manifestVerified: boolean;
  filesLost: Array<{ path: string; reason: string }>;
  sentinelPresent: boolean;
  sentinelVerified: boolean | null;
  sentinelAttestsManifest: boolean | null;
  liveness: { verdict: string; reason: string | null };
}

async function readArchive(archiveDir: string): Promise<IntegrityReading> {
  const reading = await runNode([consumerPath, archiveDir, distIndexPath]);
  assert.equal(reading.code, 0, reading.stderr);
  return JSON.parse(reading.stdout) as IntegrityReading;
}

test("a sealed archive attests itself and its sentinel attests it back", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-archive-attested-"));
  const store = path.join(directory, "records");
  const workflowPath = path.join(directory, "workflow.js");

  try {
    await writeFile(workflowPath, `export const meta = { name: "attested" };\nreturn "ok";\n`);
    const run = await runNode([bundledCliPath, workflowPath], { ENSEMBLE_RUN_RECORD_DIR: store });
    assert.equal(run.code, 0, run.stderr);

    const archiveDir = path.dirname(await findOnlyFile(store, "manifest.json"));
    const reading = await readArchive(archiveDir);
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
    const tampered = await readArchive(archiveDir);
    assert.equal(tampered.manifestVerified, false);
    // Rewriting the digest to match the edit repairs the self-check and is
    // exactly what the sentinel's outside copy is for.
    assert.equal(tampered.sentinelAttestsManifest, true);
    const repaired = JSON.parse(await readFile(manifestPath, "utf8")) as {
      integrity: { manifest_sha256: string };
    };
    repaired.integrity.manifest_sha256 = tamperedDigest(repaired);
    await writeFile(manifestPath, JSON.stringify(repaired, null, 2), "utf8");
    const resealed = await readArchive(archiveDir);
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
    const reading = await readArchive(archiveDir);
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
    const running = await readArchive(archiveDir);
    assert.equal(running.status, "in-progress");
    assert.equal(running.liveness.verdict, "live");
    assert.equal(running.sentinelPresent, false);

    child.kill("SIGKILL");
    await exited;

    const killed = await readArchive(archiveDir);
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
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
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
