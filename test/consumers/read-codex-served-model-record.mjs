#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const [store] = process.argv.slice(2);
if (store === undefined) {
  throw new Error("usage: read-codex-served-model-record.mjs <record-store>");
}

const entries = await readdir(store, { recursive: true });
const manifestPath = entries.find((entry) => entry.endsWith("manifest.json"));
if (manifestPath === undefined) {
  throw new Error("record store did not contain a run directory");
}
const archive = path.dirname(path.join(store, manifestPath));
const [agentDirectory] = await readdir(path.join(archive, "agents"), { withFileTypes: true });
if (agentDirectory === undefined || !agentDirectory.isDirectory()) {
  throw new Error("archive did not contain an agent record");
}

const manifest = JSON.parse(await readFile(path.join(archive, "manifest.json"), "utf8"));
const agent = JSON.parse(await readFile(path.join(archive, "agents", agentDirectory.name, "agent.json"), "utf8"));
const attempt = agent.attempts?.[0];
process.stdout.write(`${JSON.stringify({
  manifestSchemaVersion: manifest.schema_version,
  requestedModel: agent.model,
  servedModel: agent.resolved_model,
  attemptServedModel: attempt?.resolved_model ?? null
})}\n`);
