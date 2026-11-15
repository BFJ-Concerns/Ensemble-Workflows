import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { findClaudeTranscript } from "../live/claude-transcript-path.js";

test("live transcript discovery tolerates each missing level in a fresh Claude home", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "ensemble-transcript-path-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const projects = path.join(home, ".claude", "projects");
  assert.equal(await findClaudeTranscript(projects, "worker"), null);
  await mkdir(projects, { recursive: true });
  assert.equal(await findClaudeTranscript(projects, "worker"), null);
  await writeFile(path.join(projects, "not-a-project"), "");
  const project = path.join(projects, "project");
  await mkdir(project);
  await writeFile(path.join(project, "other-worker.jsonl"), "{}");
  assert.equal(await findClaudeTranscript(projects, "worker"), null);
  const transcript = path.join(project, "worker.jsonl");
  await writeFile(transcript, "{}");
  assert.equal(await findClaudeTranscript(projects, "worker"), transcript);
});

test("live transcript discovery surfaces filesystem errors other than missing paths", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "ensemble-transcript-error-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const projects = path.join(home, "projects");
  await writeFile(projects, "not a directory");
  await assert.rejects(findClaudeTranscript(projects, "worker"), { code: "ENOTDIR" });
  await rm(projects);
  await mkdir(path.join(projects, "project", "worker.jsonl"), { recursive: true });
  await assert.rejects(findClaudeTranscript(projects, "worker"), { code: "EISDIR" });
});
