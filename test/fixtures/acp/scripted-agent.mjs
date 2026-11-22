// A scripted Agent Client Protocol agent: JSON-RPC 2.0 over stdio, one value
// per line. Its replies have the shapes Antigravity's `agy acp` 1.5.14 gave on
// 2026-11-22: string ids on its own requests, a `model` select whose choice
// decides whether a `thought_level` select is offered at all, -32602 for a
// value it does not offer and -32000 for a missing sign-in.
//
// SCRIPTED_ACP_AGENT holds the script as JSON:
//   { signedOut?: true, signInAfterFirstRefusal?: path,
//     protocolVersion?: number, turns?: Step[][], counter?: path }
// With signInAfterFirstRefusal, the first session/new across processes
// records its refusal in that file and subsequent opens succeed.
// The nth `session/prompt` plays the nth turn; a turn past the script's end
// has no steps. With `counter`, the count is kept in that file, so an agent
// started after another one exited plays on from where it stopped. A turn
// ends `end_turn` with usage unless a step ends it.
//   { update: {...} }           send one session/update
//   { permission: toolCallId }  ask approval, then report the answer received
//   { echo: true }              send the prompt's text back as a message chunk
//   { raw: "..." }              write a line as it stands
//   { stderr: "..." }           write to stderr
//   { untilCancelled: true }    wait for session/cancel, end the turn `cancelled`
//   { stop: "refusal" }         end the turn with this stop reason
//   { error: { code, message } } end the turn with a JSON-RPC error
//   { result: {...} }           send a custom prompt result
//   { exit: code }              exit at once, the turn unanswered
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";

const script = JSON.parse(process.env.SCRIPTED_ACP_AGENT ?? "{}");
const turns = script.turns ?? [];
const LEVELS = {
  "tiered-model": ["low", "medium", "high"],
  "single-level-model": [],
  "gpt-oss-120b-medium": []
};
const USAGE = { inputTokens: 100, outputTokens: 7, cachedReadTokens: 40, cachedWriteTokens: 0, thoughtTokens: 3, totalTokens: 110 };

const sessions = new Map();
const awaitingClient = new Map();
let nextRequestId = 0;
let turnsPlayed = 0;

function nextTurn() {
  if (script.counter === undefined) return turns[turnsPlayed++] ?? [];
  const played = existsSync(script.counter) ? Number(readFileSync(script.counter, "utf8")) : 0;
  writeFileSync(script.counter, String(played + 1));
  return turns[played] ?? [];
}

const frame = (value) => `${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`;
const send = (value) => process.stdout.write(frame(value));
const update = (sessionId, body) => frame({ method: "session/update", params: { sessionId, update: body } });

function configOptions(session) {
  const select = (id, currentValue, values) => ({
    id, name: id, category: id, type: "select", currentValue, options: values.map((value) => ({ value, name: value }))
  });
  const levels = LEVELS[session.model];
  return [
    select("model", session.model, Object.keys(LEVELS)),
    ...(levels.length > 0 ? [select("thought_level", session.level, levels)] : []),
    select("mode", "default", ["default", "plan"])
  ];
}

function setConfigOption(id, session, { configId, value }) {
  if (configId === "model" && value in LEVELS) {
    session.model = value;
    session.level = LEVELS[value].includes(session.level) ? session.level : LEVELS[value].at(-1);
  } else if (configId === "model") {
    return send({ id, error: { code: -32602, message: `Unknown model ID: ${value}` } });
  } else if (configId === "thought_level" && LEVELS[session.model].includes(value)) {
    session.level = value;
  } else {
    return send({ id, error: { code: -32602, message: `Thinking level "${value}" is not offered for model "${session.model}"` } });
  }
  send({ id, result: { configOptions: configOptions(session) } });
}

async function playTurn(id, sessionId, prompt, steps) {
  const session = sessions.get(sessionId);
  let stopReason = "end_turn";
  for (const step of steps) {
    if (step.update !== undefined) process.stdout.write(update(sessionId, step.update));
    if (step.echo === true) {
      const text = (prompt ?? []).map((block) => block.text ?? "").join("");
      process.stdout.write(update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }));
    }
    if (step.raw !== undefined) process.stdout.write(`${step.raw}\n`);
    if (step.stderr !== undefined) process.stderr.write(`${step.stderr}\n`);
    if (step.exit !== undefined) process.exit(step.exit);
    if (step.stop !== undefined) stopReason = step.stop;
    if (step.error !== undefined) return send({ id, error: step.error });
    if (step.result !== undefined) return send({ id, result: step.result });
    if (step.permission !== undefined) {
      const requestId = String(++nextRequestId);
      const answered = new Promise((resolve) => awaitingClient.set(requestId, resolve));
      send({
        id: requestId,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: step.permission, kind: "execute", status: "pending" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }]
        }
      });
      const answer = await answered;
      const allowed = answer.result?.outcome?.optionId === "allow";
      process.stdout.write(update(sessionId, {
        sessionUpdate: "tool_call_update", toolCallId: step.permission, status: allowed ? "completed" : "failed", rawOutput: { answer }
      }));
    }
    if (step.untilCancelled === true) {
      await new Promise((resolve) => (session.cancelled = resolve));
      stopReason = "cancelled";
    }
  }
  send({ id, result: { stopReason, usage: USAGE } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params, ...answer } = JSON.parse(line);
  if (method === undefined) return awaitingClient.get(id)?.(answer);
  if (method === "initialize") {
    return send({ id, result: { protocolVersion: script.protocolVersion ?? 1, agentCapabilities: {}, agentInfo: { name: "Scripted ACP agent", version: "0" }, authMethods: [] } });
  }
  if (method === "session/new") {
    if (script.signedOut === true || (script.signInAfterFirstRefusal !== undefined && !existsSync(script.signInAfterFirstRefusal))) {
      if (script.signInAfterFirstRefusal !== undefined) writeFileSync(script.signInAfterFirstRefusal, "");
      return send({ id, error: { code: -32000, message: "Authentication required" } });
    }
    const sessionId = `session-${sessions.size + 1}`;
    const session = { model: "tiered-model", level: "high", cancelled: undefined };
    sessions.set(sessionId, session);
    // One write, so the update can reach the client in the same read as the reply.
    return process.stdout.write(
      frame({ id, result: { sessionId, configOptions: configOptions(session), _meta: { scripted: { cwd: params.cwd } } } }) +
      update(sessionId, { sessionUpdate: "usage_update", used: 0, size: 1000 })
    );
  }
  const session = sessions.get(params?.sessionId);
  if (method === "session/set_config_option") return setConfigOption(id, session, params);
  if (method === "session/prompt") return void playTurn(id, params.sessionId, params.prompt, nextTurn());
  if (method === "session/cancel") return session?.cancelled?.();
  send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
});
