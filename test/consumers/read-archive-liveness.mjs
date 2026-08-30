/* global process */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { judgeArchivedRunLiveness } from "./archive-liveness.mjs";

const [manifestPath, procDir, host] = process.argv.slice(2);
assert.ok(manifestPath && procDir && host, "usage: read-archive-liveness.mjs <manifest.json> <proc-dir> <host>");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
process.stdout.write(`${JSON.stringify(await judgeArchivedRunLiveness(manifest, { procDir, host }))}\n`);
