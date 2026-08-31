/* global process, Buffer */

/**
 * A stand-in `claude` CLI for the one condition a live worker cannot be
 * asked for on cue: an operational failure *after* the worker has already
 * generated — and been charged for — real output. Live, that needs a worker
 * killed mid-turn, and `claude --bg` workers live inside the shared per-user
 * daemon, so the only kill that lands would take the operator's own sessions
 * with it.
 *
 * The fixture supplies the condition and nothing else: it speaks the real
 * control plane's three surfaces (`--bg` dispatch on stdin, `agents --json`
 * roster, `stop`/`rm` teardown) and writes a genuine session transcript at
 * the real path, so the built CLI runs its own dispatch, poll, evidence and
 * archive paths unmodified. The dispatched worker writes a usage-bearing
 * assistant entry that is still mid-turn (`stop_reason: tool_use`), then
 * reports `blocked` for ever; with no reply valve on PATH the engine's
 * blocked-recovery bound is spent immediately and the turn fails carrying
 * the spend the transcript proves.
 *
 * Environment:
 * - `ENSEMBLE_FAKE_CLAUDE_STATE` — the roster's JSON state file (required).
 * - `ENSEMBLE_FAKE_CLAUDE_USAGE` — the assistant entry's usage block, as
 *   JSON; defaults to 120 input / 30 output / 9 cache-read.
 * - `ENSEMBLE_FAKE_CLAUDE_GENERATING` — leave the worker generating after
 *   its transcript is written, so the caller can interrupt the real CLI.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

const statePath = process.env.ENSEMBLE_FAKE_CLAUDE_STATE;
if (statePath === undefined || statePath.length === 0) {
  process.stderr.write("fake claude: ENSEMBLE_FAKE_CLAUDE_STATE is required\n");
  process.exit(2);
}

const argv = process.argv.slice(2);

async function readState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return { sessions: [] };
  }
}

async function writeState(state) {
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function flagValue(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function usageBlock() {
  const declared = process.env.ENSEMBLE_FAKE_CLAUDE_USAGE;
  if (declared === undefined || declared.length === 0) {
    return { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 9 };
  }
  return JSON.parse(declared);
}

function isGenerating() {
  return process.env.ENSEMBLE_FAKE_CLAUDE_GENERATING === "1";
}

async function dispatch() {
  const name = flagValue("--name") ?? "unnamed";
  const prompt = await readStdin();
  const sessionId = randomUUID();
  const projectDir = path.join(homedir(), ".claude", "projects", "fake-worker-project");
  await mkdir(projectDir, { recursive: true });
  const transcript = [
    { type: "user", message: { role: "user", content: prompt } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        model: flagValue("--model") ?? "claude-fake-worker",
        content: [{ type: "text", text: "started work, calling a tool" }],
        stop_reason: "tool_use",
        usage: usageBlock()
      }
    }
  ];
  await writeFile(
    path.join(projectDir, `${sessionId}.jsonl`),
    `${transcript.map((entry) => JSON.stringify(entry)).join("\n")}\n`
  );

  const state = await readState();
  const id = `bg-${state.sessions.length + 1}`;
  state.sessions.push({
    id,
    sessionId,
    name,
    kind: "background",
    cwd: process.cwd(),
    status: "busy",
    state: isGenerating() ? "working" : "blocked",
    ...(isGenerating() ? {} : { waitingFor: "a permission prompt the fixture never answers" })
  });
  await writeState(state);
  process.stdout.write(`${id}\n`);
}

async function roster() {
  const state = await readState();
  state.polls = (state.polls ?? 0) + 1;
  await writeState(state);
  process.stdout.write(`${JSON.stringify(state.sessions)}\n`);
}

async function forget(id) {
  const state = await readState();
  state.sessions = state.sessions.filter((session) => session.id !== id && session.sessionId !== id);
  await writeState(state);
}

if (argv.includes("--bg")) {
  await dispatch();
} else if (argv[0] === "agents") {
  await roster();
} else if (argv[0] === "stop" || argv[0] === "rm") {
  await forget(argv[1]);
} else {
  process.stderr.write(`fake claude: unsupported invocation ${JSON.stringify(argv)}\n`);
  process.exit(2);
}
