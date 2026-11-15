/* global process */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// A reader of version 6 expects a branch name for every isolated checkout.
// Its version check must reject detached records before it reads that name.
const record = JSON.parse(await readFile(process.argv[2], "utf8"));
assert.equal(record.schema_version, 6, "unsupported run record schema");
process.stdout.write(`${record.worktree.branch.trim()}\n`);
