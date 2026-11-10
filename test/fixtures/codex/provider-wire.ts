import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CapturedProviderRequest } from "../provider-capture.js";

/**
 * Provider-wire probing of a real Codex worker: an isolated Codex home whose
 * default model provider is a loopback capture provider, and the oracle that
 * reads a captured `/v1/responses` request back into the surface Codex
 * showed its model.
 *
 * How current Codex presents the strippable capabilities to its model, read
 * off the wire on codex-cli 0.160.0 and 0.167.0:
 *
 * - Agent spawning is a `namespace` tool (`multi_agent_v1`) in the request's
 *   `tools`, whose members include `spawn_agent`.
 * - There is no skill tool. Skills reach the model as context: a listing in
 *   a developer message's `<skills_instructions>` block, and — when the
 *   prompt mentions a skill as `$<name>` — the skill's whole `SKILL.md`
 *   injected as a `<skill>` user message. The mention is Codex's skill
 *   invocation route; reading a `SKILL.md` through the shell is not an
 *   engine-provided capability and is outside what a strip promises.
 *
 * The oracle throws on a request it cannot read, so a Codex wire change
 * fails a probe loudly instead of reading as an empty, stripped-looking
 * surface.
 */

/** A user skill planted in the isolated home: the positive control for skill discovery and invocation. */
export interface SeededCodexSkill {
  name: string;
  /** A token that appears only in the skill's body, so its presence on the wire proves the body was injected. */
  bodyToken: string;
}

export interface SeededCodexHome {
  /** For the worker's `HOME`, so no user-level context outside the fixture is discovered. */
  home: string;
  /** For the worker's `CODEX_HOME`. */
  codexHome: string;
  skill: SeededCodexSkill;
}

export const SEEDED_CODEX_SKILL: SeededCodexSkill = {
  name: "ensemble-probe-skill",
  bodyToken: "ensemble-probe-skill-body-token"
};

/**
 * Writes an isolated Codex home under `root`: a `config.toml` that routes
 * every thread to the capture provider at `providerBaseUrl` with no account
 * and no retries, and one seeded user skill. Nothing from the operator's own
 * Codex home is copied, so the worker's surface is Codex's defaults plus the
 * seed. The caller owns `root` and removes it.
 */
export async function seedCodexHome(root: string, providerBaseUrl: string): Promise<SeededCodexHome> {
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const skill = SEEDED_CODEX_SKILL;
  const skillDirectory = path.join(codexHome, "skills", skill.name);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    path.join(codexHome, "config.toml"),
    [
      `model = "provider-wire-probe"`,
      `model_provider = "capture"`,
      ``,
      `[model_providers.capture]`,
      `name = "capture"`,
      `base_url = ${JSON.stringify(providerBaseUrl)}`,
      `wire_api = "responses"`,
      `requires_openai_auth = false`,
      `request_max_retries = 0`,
      `stream_max_retries = 0`,
      ``
    ].join("\n")
  );
  await writeFile(
    path.join(skillDirectory, "SKILL.md"),
    [
      `---`,
      `name: ${skill.name}`,
      `description: Seeded by Ensemble's provider-wire probe; listed only while skill discovery reaches the model.`,
      `---`,
      ``,
      `Reply with ${skill.bodyToken}.`,
      ``
    ].join("\n")
  );
  return { home, codexHome, skill };
}

/** What one captured Codex request showed the model, attributed to its thread and turn. */
export interface CodexModelSurface {
  threadId: string;
  turnId: string;
  /** Function tools by name, namespace members as `<namespace>.<member>`, other tool kinds by type. */
  tools: string[];
  /** Skill names in the `<skills_instructions>` listing. */
  listedSkills: string[];
  /** Skill names whose `SKILL.md` was injected as a `<skill>` message. */
  injectedSkills: string[];
  /** Every input text, joined; for prompt-marker and body-token checks. */
  inputText: string;
}

export function codexModelSurface(request: CapturedProviderRequest): CodexModelSurface {
  const where = `${request.method} ${request.path}`;
  const metadata = parseTurnMetadata(request.headers["x-codex-turn-metadata"], where);
  const body = request.body;
  if (!isRecord(body) || !Array.isArray(body.tools) || !Array.isArray(body.input)) {
    throw new Error(`${where}: not a Responses request with tools and input; Codex's wire shape has changed`);
  }
  const tools = body.tools.flatMap((tool: unknown): string[] => {
    if (!isRecord(tool) || typeof tool.type !== "string") {
      throw new Error(`${where}: unreadable tool entry ${JSON.stringify(tool)}`);
    }
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      return tool.tools.map((member: unknown) => `${String(tool.name)}.${isRecord(member) ? String(member.name) : "?"}`);
    }
    return [typeof tool.name === "string" ? tool.name : tool.type];
  });
  const texts = body.input.flatMap((item: unknown): string[] =>
    isRecord(item) && Array.isArray(item.content)
      ? item.content.flatMap((part: unknown) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
      : []
  );
  const listing = texts.find((text) => text.includes("<skills_instructions>")) ?? "";
  return {
    threadId: metadata.threadId,
    turnId: metadata.turnId,
    tools,
    listedSkills: [...listing.matchAll(/^- ([^\s:]+): .*\(file: [^)]+\)$/gm)].map((match) => match[1]!),
    injectedSkills: texts.flatMap((text) => [...text.matchAll(/<skill>\s*<name>([^<]+)<\/name>/g)].map((match) => match[1]!)),
    inputText: texts.join("\n")
  };
}

function parseTurnMetadata(header: string | undefined, where: string): { threadId: string; turnId: string } {
  let metadata: unknown;
  try {
    metadata = JSON.parse(header ?? "");
  } catch {
    throw new Error(`${where}: no readable x-codex-turn-metadata header to attribute the request to a thread and turn`);
  }
  if (!isRecord(metadata) || typeof metadata.thread_id !== "string" || typeof metadata.turn_id !== "string") {
    throw new Error(`${where}: x-codex-turn-metadata names no thread_id and turn_id`);
  }
  return { threadId: metadata.thread_id, turnId: metadata.turn_id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
