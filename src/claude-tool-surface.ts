import { CapabilityStripUnsupportedError } from "./errors.js";

import type { DischargedEnforcement, PreparedStrip, StrippableCapability } from "./capability-stripping.js";
import type { CapturedProviderRequest } from "./provider-capture.js";

/**
 * Claude's agents and skills strips are derived from the tool surface the
 * served Claude Code actually shows its model, read live for each run, and
 * never from a fixed list of tool names alone.
 *
 * The surface is read off the wire. A probe session is launched by the
 * same route as a worker — the same `claude` executable and per-user
 * daemon, the same working directory, model pin and per-dispatch settings
 * file — except that the settings file's `env` block points
 * `ANTHROPIC_BASE_URL` at a loopback capture provider
 * (`startCaptureProvider`). That provider answers every request with a
 * terminal 400, so no model is reached and nothing is billed. Its captured
 * Messages requests carry each tool the session would offer, and the
 * `claude-cli/<version>` user agent names the version that serves the
 * session. That version may differ from what `claude --version` reports,
 * because the daemon can predate an update.
 *
 * Preparing a strip takes two probes. An unrestricted probe takes the
 * inventory. The deny rules are derived from it (`deriveClaudeStrip`),
 * with the settings `env` variables that remove a tool the rules do not
 * reach (`CLAUDE_TOOL_REMOVAL_ENV`). A second probe then runs under exactly
 * those settings and confirms what remains (`confirmClaudeStrip`). The agent record's enforcement detail
 * states the version, the source, and what was checked and denied.
 * `ClaudeStripPreparer` runs the sequence once for each working directory,
 * model and strip in a run.
 *
 * Measured on Claude Code 2.1.322 (2026-11-10), with `claude -p` against a
 * capture provider; the `--bg` route is the one Ensemble dispatches, and
 * is unmeasured:
 * - A Messages request lists the loaded tools in `tools` and announces the
 *   rest by name in a deferred-tools listing inside a message text block
 *   ("The following deferred tools are now available via ToolSearch…:"
 *   followed by one name per line). A tool missing from both is not
 *   available to the model.
 * - After the 400, the CLI retried the same turn several times, first with
 *   deferral (loaded tools plus `ToolSearch` and `DeferredToolPlaceholder`)
 *   and then without it (every tool loaded). The name union matched apart
 *   from those two deferral entries, so the surface is the union over every
 *   request that carries the probe's nonce.
 * - A bare tool name in the operator's `permissions.deny` (`Agent`, in that
 *   estate) was absent from both the tools array and the deferred listing.
 */

/** How a tool reached the model on the probe's requests. */
export type ClaudeToolExposure = "loaded" | "deferred";

export interface ClaudeTool {
  readonly name: string;
  /** `loaded` when any captured request carried its definition; `deferred` when it was only announced by name. */
  readonly exposure: ClaudeToolExposure;
}

/** The tools one served Claude Code version offered a session, as its own provider requests showed them. */
export interface ClaudeToolSurface {
  /** From the `claude-cli/<version>` user agent of the captured requests. */
  readonly cliVersion: string;
  /** How the surface was read, for the record. */
  readonly source: string;
  /** Sorted by name; every name appears once. */
  readonly tools: readonly ClaudeTool[];
}

/** The opening text of a probe session. No model ever reads it: the nonce only marks the session's own requests. */
export function claudeToolSurfaceProbePrompt(nonce: string): string {
  return `Ensemble tool-surface probe ${nonce}. No answer is needed.`;
}

const PROBE_SOURCE = "provider-visible requests of a claude --bg probe session";
const DEFERRED_LISTING_MARKER = "deferred tools are now available via ToolSearch";
const USER_AGENT = /^claude-cli\/(\S+)/;
const TOOL_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Read the surface from a capture provider's requests. Only Messages
 * requests whose messages carry `nonce` and that have a `tools` array count,
 * so a side request that offers no tools (a title, say) is ignored.
 * Anything this cannot read — no qualifying request, a missing or
 * inconsistent version, a tool with no name — throws, so a wire change can
 * never read as a stripped surface.
 */
export function readClaudeToolSurface(requests: readonly CapturedProviderRequest[], nonce: string): ClaudeToolSurface {
  const exposure = new Map<string, ClaudeToolExposure>();
  const versions = new Set<string>();
  let read = 0;
  for (const request of requests) {
    if (request.method !== "POST" || !/^\/v1\/messages(?:\?|$)/.test(request.path)) continue;
    const body = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) continue;
    const { messages, tools } = body as { messages?: unknown; tools?: unknown };
    const texts = stringsWithin(messages);
    if (!Array.isArray(tools) || !texts.some((text) => text.includes(nonce))) continue;
    const version = USER_AGENT.exec(request.headers["user-agent"] ?? "")?.[1];
    if (version === undefined) {
      throw new Error(`a probe request carried no claude-cli version in its user agent (${JSON.stringify(request.headers["user-agent"] ?? null)})`);
    }
    versions.add(version);
    for (const tool of tools) {
      const name = (tool as { name?: unknown } | null)?.name;
      if (typeof name !== "string" || !TOOL_NAME.test(name)) {
        throw new Error(`a probe request listed a tool with no readable name: ${JSON.stringify(tool).slice(0, 200)}`);
      }
      exposure.set(name, "loaded");
    }
    for (const name of texts.flatMap(deferredListing)) {
      if (!exposure.has(name)) exposure.set(name, "deferred");
    }
    read += 1;
  }
  if (read === 0) {
    throw new Error(`no captured Messages request carried the probe nonce and a tools array (${requests.length} requests captured)`);
  }
  if (versions.size !== 1) {
    throw new Error(`the probe's requests named more than one claude-cli version: ${[...versions].join(", ")}`);
  }
  return {
    cliVersion: [...versions][0]!,
    source: PROBE_SOURCE,
    tools: [...exposure].map(([name, how]) => ({ name, exposure: how })).sort((a, b) => a.name.localeCompare(b.name))
  };
}

function stringsWithin(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsWithin);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringsWithin);
  return [];
}

/** The names in a deferred-tools listing: the run of name-only lines after the marker sentence's colon. */
function deferredListing(text: string): string[] {
  const marker = text.indexOf(DEFERRED_LISTING_MARKER);
  if (marker === -1) return [];
  const listStart = text.indexOf(":\n", marker);
  if (listStart === -1) return [];
  const names: string[] = [];
  for (const line of text.slice(listStart + 2).split("\n")) {
    if (!TOOL_NAME.test(line)) break;
    names.push(line);
  }
  return names;
}

/**
 * What a tool on Claude's surface is, for stripping:
 * - a strippable capability, denied whenever that capability is stripped;
 * - `unrelated`, judged to be in neither capability and never denied;
 * - `operator`, an MCP tool the operator's configuration adds (`mcp__…`),
 *   outside the engine-provided surface the strip promise covers, and never
 *   denied;
 * - `unclassified`, a built-in tool nobody has judged yet.
 */
export type ClaudeToolClass = StrippableCapability | "unrelated" | "operator" | "unclassified";

export type ClaudeToolClassification = Readonly<Record<string, StrippableCapability | "unrelated">>;

/**
 * The judged built-in tools. Decided: an unclassified tool is denied under
 * every strip, because Claude Code publishes no capability metadata for its
 * tools, and failing closed is what covers a new agent-spawning tool the day
 * it appears. Adding a tool here refines a judgement and is never needed
 * for coverage: an entry that moves a new tool to `unrelated` gives it back
 * to stripped workers.
 *
 * `Task` is the agent tool's earlier name. `Workflow` runs scripts that
 * spawn agents. `ListAgents` and `SendMessage` discover and message agents.
 * `TaskStop` stops the worker's own background tasks; it neither starts nor
 * reaches another agent, and the harness relies on it to settle background
 * work. `Task*` are the task-list tools. The other `unrelated` entries were
 * observed on 2.1.322 and reach no other agent.
 *
 * `advisor` is a provider-side tool: the Messages API itself runs it, by
 * handing the worker's conversation to another model (2.1.322 offered
 * `{"type":"advisor_20260301","name":"advisor","model":"claude-opus-5-5"}`)
 * and returning that model's reply. Decided: it belongs to `agents`, because
 * it puts a second model to work on the worker's task, on a model the script
 * did not choose, which is the delegation an agents strip exists to remove.
 * `permissions.deny` does not remove it; `CLAUDE_TOOL_REMOVAL_ENV` does.
 */
export const CLAUDE_TOOL_CLASSIFICATION: ClaudeToolClassification = {
  Agent: "agents",
  ListAgents: "agents",
  SendMessage: "agents",
  Task: "agents",
  Workflow: "agents",
  advisor: "agents",
  Skill: "skills",
  AskUserQuestion: "unrelated",
  Bash: "unrelated",
  CronCreate: "unrelated",
  CronDelete: "unrelated",
  CronList: "unrelated",
  DeferredToolPlaceholder: "unrelated",
  Edit: "unrelated",
  EndConversation: "unrelated",
  EnterPlanMode: "unrelated",
  EnterWorktree: "unrelated",
  ExitPlanMode: "unrelated",
  ExitWorktree: "unrelated",
  LSP: "unrelated",
  Monitor: "unrelated",
  NotebookEdit: "unrelated",
  PushNotification: "unrelated",
  Read: "unrelated",
  ReportFindings: "unrelated",
  ScheduleWakeup: "unrelated",
  TaskCreate: "unrelated",
  TaskGet: "unrelated",
  TaskList: "unrelated",
  TaskStop: "unrelated",
  TaskUpdate: "unrelated",
  ToolSearch: "unrelated",
  WebFetch: "unrelated",
  WebSearch: "unrelated",
  Write: "unrelated"
};

/**
 * Tools that stay on the surface under their own `permissions.deny` rule,
 * each with the settings `env` variables that remove it. A provider-side
 * tool is the known case: the deny rules govern the tools Claude Code runs
 * itself, and this one the provider runs.
 *
 * A stripped dispatch carries the variables of every name its strip denies,
 * in the per-dispatch settings file's `env` block, alongside the deny rule
 * that name still takes. The confirming probe carries the same variables,
 * so the check that nothing denied remains judges this route as well. No
 * variable is set for an unstripped worker or for the inventory probe.
 *
 * `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` was read from the 2.1.322 executable,
 * whose advisor availability check returns false while it is set; Claude
 * Code does not document it. It is trusted only as far as each preparation's
 * confirming probe shows the tool gone: a release that ignores or renames
 * it makes the strip refuse before the worker spawns, and never dispatches
 * a worker that still has the tool.
 *
 * An entry is how a newly found tool of this kind is removed: add its
 * variables here, and its classification above.
 */
export const CLAUDE_TOOL_REMOVAL_ENV: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  advisor: { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" }
};

export function classifyClaudeTool(name: string, classification: ClaudeToolClassification = CLAUDE_TOOL_CLASSIFICATION): ClaudeToolClass {
  if (name.startsWith("mcp__")) return "operator";
  return Object.hasOwn(classification, name) ? classification[name]! : "unclassified";
}

/** The deny rules one strip takes against one inventory, with the judgement behind them. */
export interface DerivedClaudeStrip {
  readonly inventory: ClaudeToolSurface;
  readonly strip: readonly StrippableCapability[];
  /**
   * Sorted and unique: every classified member of a stripped capability,
   * whether or not this inventory showed it, plus every unclassified tool
   * the inventory showed. A member the inventory lacks costs nothing to
   * deny and still covers a tool that a later session gains.
   */
  readonly permissionDenyRules: readonly string[];
  /** The `CLAUDE_TOOL_REMOVAL_ENV` variables of every denied name; empty when no denied name has any. */
  readonly settingsEnv: Readonly<Record<string, string>>;
  /** The inventory's tools by class. */
  readonly classes: Readonly<Record<ClaudeToolClass, readonly string[]>>;
  /** The table the inventory was judged by, so the confirmation judges by the same one. */
  readonly classification: ClaudeToolClassification;
}

export function deriveClaudeStrip(
  inventory: ClaudeToolSurface,
  strip: readonly StrippableCapability[],
  classification: ClaudeToolClassification = CLAUDE_TOOL_CLASSIFICATION
): DerivedClaudeStrip {
  const classes: Record<ClaudeToolClass, string[]> = { agents: [], skills: [], unrelated: [], operator: [], unclassified: [] };
  for (const tool of inventory.tools) {
    classes[classifyClaudeTool(tool.name, classification)].push(tool.name);
  }
  const members = Object.entries(classification)
    .filter(([, judged]) => judged !== "unrelated" && strip.includes(judged))
    .map(([name]) => name);
  const permissionDenyRules = [...new Set([...members, ...(strip.length > 0 ? classes.unclassified : [])])].sort();
  const settingsEnv = Object.assign({}, ...permissionDenyRules.map((name) => CLAUDE_TOOL_REMOVAL_ENV[name] ?? {})) as Record<string, string>;
  return { inventory, strip: [...strip], permissionDenyRules, settingsEnv, classes, classification };
}

/**
 * A strip ready for dispatch on Claude: the deny rules and `env` variables
 * the worker's settings file carries, and the enforcement each capability's
 * record entry states. All come from the one preparation, so the archive
 * names the settings that were dispatched.
 */
export interface PreparedClaudeStrip extends PreparedStrip {
  readonly engine: "claude";
  readonly cliVersion: string;
  readonly permissionDenyRules: readonly string[];
  readonly settingsEnv: Readonly<Record<string, string>>;
}

export function isPreparedClaudeStrip(prepared: PreparedStrip | undefined): prepared is PreparedClaudeStrip {
  const candidate = prepared as Partial<PreparedClaudeStrip> | undefined;
  return candidate?.engine === "claude" && Array.isArray(candidate.permissionDenyRules) &&
    typeof candidate.settingsEnv === "object" && candidate.settingsEnv !== null;
}

/**
 * Judge the second probe, which ran under `derived.permissionDenyRules` and
 * `derived.settingsEnv`, and settle the strip. Its own version must match
 * the inventory's. No denied name may remain on it, whether loaded or
 * deferred. No unclassified built-in may appear on it either: one the
 * inventory did not show was never denied, so it would reach the worker
 * unjudged. Every `unrelated` tool the inventory showed must remain, since a
 * strip removes nothing it was not asked to. Operator tools are not
 * compared: an MCP server's connection timing varies between sessions. A
 * failed check refuses the worker before it spawns.
 */
export function confirmClaudeStrip(derived: DerivedClaudeStrip, confirmation: ClaudeToolSurface): PreparedClaudeStrip {
  const refuse = (detail: string): never => {
    throw new CapabilityStripUnsupportedError("claude", derived.strip.join(", "), detail);
  };
  if (confirmation.cliVersion !== derived.inventory.cliVersion) {
    refuse(`the served Claude Code changed between probes (${derived.inventory.cliVersion}, then ${confirmation.cliVersion})`);
  }
  const remaining = new Set(confirmation.tools.map((tool) => tool.name));
  const leaked = derived.permissionDenyRules.filter((name) => remaining.has(name));
  if (leaked.length > 0) {
    refuse(`Claude Code ${confirmation.cliVersion} still offered ${JSON.stringify(leaked)} under ${settingsDescription(derived)}`);
  }
  const unjudged = confirmation.tools
    .map((tool) => tool.name)
    .filter((name) => classifyClaudeTool(name, derived.classification) === "unclassified");
  if (unjudged.length > 0) {
    refuse(`the confirming probe offered unclassified tools the inventory did not show: ${JSON.stringify(unjudged)}`);
  }
  const lost = derived.classes.unrelated.filter((name) => !remaining.has(name));
  if (lost.length > 0) {
    refuse(`the deny rules also removed ${JSON.stringify(lost)}, which no requested strip covers`);
  }
  const enforcement: Partial<Record<StrippableCapability, DischargedEnforcement>> = {};
  for (const capability of derived.strip) {
    enforcement[capability] = { route: "config", detail: enforcementDetail(derived, capability, confirmation) };
  }
  return {
    engine: "claude",
    requested: [...derived.strip],
    cliVersion: confirmation.cliVersion,
    permissionDenyRules: [...derived.permissionDenyRules],
    settingsEnv: { ...derived.settingsEnv },
    enforcement
  };
}

/** The settings a strip's rules travel in, as the record and a refusal name them. */
function settingsDescription(derived: DerivedClaudeStrip): string {
  const deny = `permissions.deny ${JSON.stringify(derived.permissionDenyRules)}`;
  return Object.keys(derived.settingsEnv).length === 0 ? deny : `${deny} and env ${JSON.stringify(derived.settingsEnv)}`;
}

function enforcementDetail(derived: DerivedClaudeStrip, capability: StrippableCapability, confirmation: ClaudeToolSurface): string {
  const { classes, inventory } = derived;
  return [
    `${settingsDescription(derived)} in the per-dispatch settings file`,
    `derived from the ${inventory.tools.length} tools Claude Code ${inventory.cliVersion} offered (${inventory.source})`,
    `${capability} members offered: ${JSON.stringify(classes[capability])}`,
    `unclassified and denied: ${JSON.stringify(classes.unclassified)}`,
    `operator MCP tools left in place: ${JSON.stringify(classes.operator)}`,
    `a second probe under these settings offered none of them and kept every unrelated tool (${confirmation.tools.length} tools)`
  ].join("; ");
}
