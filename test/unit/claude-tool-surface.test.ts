import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeStripPreparer } from "../../src/claude-strip-preparation.js";
import { confirmClaudeStrip, deriveClaudeStrip, readClaudeToolSurface } from "../../src/claude-tool-surface.js";
import { CapabilityStripUnsupportedError, EngineShutdownError } from "../../src/errors.js";

import type { ClaudeToolSurfaceProbeRequest } from "../../src/claude-control-plane.js";
import type { ClaudeToolSurface } from "../../src/claude-tool-surface.js";
import type { CapturedProviderRequest } from "../../src/provider-capture.js";

const NONCE = "nonce-7731";

/** A Messages request shaped as Claude Code 2.1.322 sent one to a capture provider. */
function messagesRequest(options: { loaded: string[]; deferred?: string[]; nonce?: string; version?: string }): CapturedProviderRequest {
  const listing = options.deferred === undefined
    ? ""
    : "<system-reminder>\nThe following deferred tools are now available via ToolSearch. Use ToolSearch with query " +
      `"select:<name>" to load tool schemas before calling them:\n${options.deferred.join("\n")}\n\n# MCP Server Instructions\n</system-reminder>`;
  return {
    method: "POST",
    path: "/v1/messages?beta=true",
    headers: { "user-agent": `claude-cli/${options.version ?? "2.1.322"} (external, cli)` },
    body: {
      model: "claude-test",
      tools: options.loaded.map((name) => ({ name, description: `${name} tool`, input_schema: { type: "object" } })),
      messages: [{ role: "user", content: [{ type: "text", text: listing }, { type: "text", text: `probe ${options.nonce ?? NONCE}` }] }]
    }
  };
}

function surface(names: string[], cliVersion = "2.1.322"): ClaudeToolSurface {
  return { cliVersion, source: "test", tools: names.map((name) => ({ name, exposure: "loaded" })) };
}

test("the surface is the union of loaded and deferred tools over every request carrying the nonce", () => {
  const read = readClaudeToolSurface([
    messagesRequest({ loaded: ["Bash", "DeferredToolPlaceholder", "ToolSearch"], deferred: ["SendMessage", "mcp__x__y"] }),
    messagesRequest({ loaded: ["Bash", "SendMessage", "mcp__x__y"] }),
    // Another session's request, and a side request with no tools, are not the probe's surface.
    messagesRequest({ loaded: ["Workflow"], nonce: "someone-else" }),
    { ...messagesRequest({ loaded: [] }), body: { messages: [{ role: "user", content: `title for probe ${NONCE}` }] } }
  ], NONCE);
  assert.equal(read.cliVersion, "2.1.322");
  assert.deepEqual(read.tools, [
    { name: "Bash", exposure: "loaded" },
    { name: "DeferredToolPlaceholder", exposure: "loaded" },
    { name: "mcp__x__y", exposure: "loaded" },
    { name: "SendMessage", exposure: "loaded" },
    { name: "ToolSearch", exposure: "loaded" }
  ]);
});

test("an unreadable capture throws rather than read as an empty surface", () => {
  assert.throws(() => readClaudeToolSurface([], NONCE), /no captured Messages request/);
  assert.throws(
    () => readClaudeToolSurface([messagesRequest({ loaded: ["Bash"] }), messagesRequest({ loaded: ["Bash"], version: "2.1.323" })], NONCE),
    /more than one claude-cli version/
  );
  assert.throws(
    () => readClaudeToolSurface([{ ...messagesRequest({ loaded: ["Bash"] }), headers: {} }], NONCE),
    /no claude-cli version/
  );
});

test("a strip denies its classified members and every unclassified built-in, never unrelated or operator tools", () => {
  const inventory = surface(["Bash", "ListAgents", "Read", "Skill", "SpawnTeammate", "mcp__x__y"]);
  const agents = deriveClaudeStrip(inventory, ["agents"]);
  assert.deepEqual(agents.permissionDenyRules, ["Agent", "ListAgents", "SendMessage", "SpawnTeammate", "Task", "Workflow"]);
  assert.deepEqual(agents.classes.operator, ["mcp__x__y"]);
  const skills = deriveClaudeStrip(inventory, ["skills"]);
  assert.deepEqual(skills.permissionDenyRules, ["Skill", "SpawnTeammate"]);
});

test("confirmation refuses a leaked tool, a lost unrelated tool, or a changed version", () => {
  const derived = deriveClaudeStrip(surface(["Bash", "ListAgents", "Read", "SpawnTeammate"]), ["agents"]);
  assert.throws(() => confirmClaudeStrip(derived, surface(["Bash", "Read", "SpawnTeammate"])), (error: unknown) =>
    error instanceof CapabilityStripUnsupportedError && /still offered \["SpawnTeammate"\]/.test(error.message));
  assert.throws(() => confirmClaudeStrip(derived, surface(["Bash"])), /also removed \["Read"\]/);
  assert.throws(() => confirmClaudeStrip(derived, surface(["Bash", "Read"], "2.1.323")), /changed between probes/);
  const prepared = confirmClaudeStrip(derived, surface(["Bash", "Read"]));
  assert.deepEqual(prepared.permissionDenyRules, derived.permissionDenyRules);
  assert.equal(prepared.enforcement.agents?.route, "config");
  assert.match(prepared.enforcement.agents?.detail ?? "", /Claude Code 2\.1\.322/);
});

/** A probe that offers `names` minus the request's denies, counting its calls. */
function countingProbe(names: string[], cliVersion = "2.1.322"): { calls: ClaudeToolSurfaceProbeRequest[]; probe: (request: ClaudeToolSurfaceProbeRequest) => Promise<ClaudeToolSurface> } {
  const calls: ClaudeToolSurfaceProbeRequest[] = [];
  return {
    calls,
    probe: async (request) => {
      calls.push(request);
      return surface(names.filter((name) => !request.permissionDenyRules.includes(name)), cliVersion);
    }
  };
}

test("concurrent dispatches with the same inputs share one preparation; other inputs prepare their own", async () => {
  const { calls, probe } = countingProbe(["Bash", "ListAgents"]);
  const preparer = new ClaudeStripPreparer({ probe });
  const [first, second] = await Promise.all([
    preparer.prepare({ strip: ["agents"], cwd: "/a" }),
    preparer.prepare({ strip: ["agents", "agents"], cwd: "/a" })
  ]);
  assert.equal(first, second);
  assert.equal(calls.length, 2);
  await preparer.prepare({ strip: ["agents"], cwd: "/b" });
  assert.equal(calls.length, 4);
});

test("a failed preparation refuses before spawn and is not remembered", async () => {
  let fail = true;
  const preparer = new ClaudeStripPreparer({
    probe: async () => {
      if (fail) throw new Error("probe session never registered");
      return surface(["Bash"]);
    }
  });
  await assert.rejects(preparer.prepare({ strip: ["agents"], cwd: "/a" }), (error: unknown) =>
    error instanceof CapabilityStripUnsupportedError && /never registered/.test(error.message));
  fail = false;
  await preparer.prepare({ strip: ["agents"], cwd: "/a" });
});

test("no probe, an expired bound, and the engine closing each end a preparation", async () => {
  await assert.rejects(new ClaudeStripPreparer({ probe: undefined }).prepare({ strip: ["skills"], cwd: "/a" }), /cannot probe/);

  const hanging = (request: ClaudeToolSurfaceProbeRequest): Promise<ClaudeToolSurface> =>
    new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason as Error)));
  await assert.rejects(new ClaudeStripPreparer({ probe: hanging, timeoutMs: 20 }).prepare({ strip: ["skills"], cwd: "/a" }), /within 20ms/);

  const closing = new ClaudeStripPreparer({ probe: hanging });
  const pending = closing.prepare({ strip: ["skills"], cwd: "/a" });
  closing.close();
  await assert.rejects(pending, EngineShutdownError);
});

test("a worker serving another version drops preparations made for the old one", async () => {
  const { calls, probe } = countingProbe(["Bash"]);
  const preparer = new ClaudeStripPreparer({ probe });
  await preparer.prepare({ strip: ["skills"], cwd: "/a" });
  preparer.retainVersion("2.1.322");
  await preparer.prepare({ strip: ["skills"], cwd: "/a" });
  assert.equal(calls.length, 2);
  preparer.retainVersion("2.1.330");
  await preparer.prepare({ strip: ["skills"], cwd: "/a" });
  assert.equal(calls.length, 4);
});
