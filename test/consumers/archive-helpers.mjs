import assert from "node:assert/strict";
import { appendFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export function createAcknowledgementWriter(file) {
  const acknowledged = new Set();
  return {
    hasAcknowledged: (marker) => acknowledged.has(marker),
    async acknowledge(marker) {
      if (acknowledged.has(marker)) return;
      if (file !== undefined) await appendFile(file, `${marker}\n`);
      acknowledged.add(marker);
    }
  };
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function findOnlyFile(root, basename) {
  const entries = await readdir(root, { recursive: true });
  const matches = entries.filter((entry) => path.basename(entry) === basename);
  assert.equal(matches.length, 1, `expected one ${basename}, found ${matches.length}`);
  return path.join(root, matches[0]);
}
