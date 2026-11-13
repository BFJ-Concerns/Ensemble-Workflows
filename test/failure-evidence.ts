import { readdir, rm, writeFile } from "node:fs/promises";
import process from "node:process";
import path from "node:path";

export const failureEvidenceMarker = ".ensemble-retained-failure-evidence";

/** Clean a test's private files, retaining its archives in place after an opted-in failure. */
export async function removeTestDirectory(directory: string, failed: boolean, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!failed || env.ENSEMBLE_LIVE_FAILURE_EVIDENCE !== "1") {
    await rm(directory, { recursive: true, force: true });
    return;
  }
  if (await retainArchives(directory)) {
    await writeFile(path.join(directory, failureEvidenceMarker), "Run-record archives retained after a test failure. Remove this directory after inspection.\n");
    process.stderr.write(`[test-failure-evidence] retained archives under ${directory}\n`);
  }
}

async function retainArchives(directory: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  // Even an incomplete or malformed manifest is failure evidence. Keep the
  // entire archive, including transcripts and the files table, at its
  // announced path; discard private configuration and other fixture files.
  if (entries.some(entry => entry.name === "manifest.json" && entry.isFile())) return true;
  let retained = false;
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory() && await retainArchives(child)) {
      retained = true;
    } else {
      await rm(child, { recursive: true, force: true });
    }
  }
  if (!retained) await rm(directory, { recursive: true, force: true });
  return retained;
}
