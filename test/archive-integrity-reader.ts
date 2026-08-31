import assert from "node:assert/strict";
import path from "node:path";

import { runNode } from "./integration/estate-process.js";

const consumerPath = path.resolve("test/consumers/read-archive-integrity.mjs");

export interface ArchiveIntegrityReading {
  status: string;
  manifestVerified: boolean;
  filesLost: Array<{ path: string; reason: string }>;
  sentinelPresent: boolean;
  sentinelVerified: boolean | null;
  sentinelAttestsManifest: boolean | null;
  liveness: { verdict: string; reason: string | null };
}

/** Runs the independent cold archive consumer and returns its parsed reading. */
export async function readArchiveIntegrity(archiveDir: string): Promise<ArchiveIntegrityReading> {
  const reading = await runNode([consumerPath, archiveDir]);
  assert.equal(reading.code, 0, reading.stderr);
  return JSON.parse(reading.stdout) as ArchiveIntegrityReading;
}
