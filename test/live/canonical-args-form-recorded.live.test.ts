import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const isLive = process.env.ENSEMBLE_LIVE === "1";
const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const archiveVerifierPath = path.resolve("test/consumers/verify-args.mjs");
const execFileAsync = promisify(execFile);

test("live built bundle archives independently verifiable root and child canonical args", { skip: !isLive }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-canonical-args-live-"));
  const recordStore = path.join(directory, "records");
  const root = path.join(directory, "root.js");
  const child = path.join(directory, "child.js");

  try {
    await writeFile(
      child,
      `export const meta = { name: "canonical-child" }; return { childArgs: args };\n`
    );
    await writeFile(
      root,
      `
        export const meta = { name: "canonical-root" };
        return await workflow({ scriptPath: "./child.js" }, { child: { value: 7 }, labels: ["alpha", "beta"] });
      `
    );

    const run = await execFileAsync(
      process.execPath,
      [bundledCliPath, "--json-args", JSON.stringify({ root: { value: 3 }, labels: ["gamma"] }), root],
      {
        cwd: directory,
        env: {
          ...process.env,
          ENSEMBLE_RUN_RECORD: "1",
          ENSEMBLE_RUN_RECORD_DIR: recordStore,
          ENSEMBLE_STATUS: "0"
        }
      }
    );
    assert.deepEqual(JSON.parse(run.stdout), { childArgs: { child: { value: 7 }, labels: ["alpha", "beta"] } });

    const archiveDir = await archiveDirectory(recordStore);
    const verified = await execFileAsync(process.execPath, [archiveVerifierPath, archiveDir]);
    assert.match(verified.stdout, /verified 3 args digests/);

    await writeFile(path.join(archiveDir, "workflows/000001/args.canonical.json"), `{"tampered":true}`);
    await assert.rejects(
      () => execFileAsync(process.execPath, [archiveVerifierPath, archiveDir]),
      (error: NodeJS.ErrnoException & { stderr?: string }) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr ?? "", /workflow invocation 1 args sha256 mismatch/);
        return true;
      }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function archiveDirectory(store: string): Promise<string> {
  const entries = await readdir(store, { recursive: true, withFileTypes: true });
  const manifest = entries.find((entry) => entry.isFile() && entry.name === "manifest.json");
  assert.ok(manifest, "the built bundle did not create a durable manifest");
  return manifest.parentPath;
}
