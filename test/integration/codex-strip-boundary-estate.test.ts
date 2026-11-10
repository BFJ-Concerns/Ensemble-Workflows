import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { codexModelSurface, seedCodexHome, type CodexModelSurface, type SeededCodexHome } from "../fixtures/codex/provider-wire.js";
import { startCaptureProvider, type CaptureProvider } from "../fixtures/provider-capture.js";
import { executablePath, runNode, runProcess } from "./estate-process.js";

/**
 * The Codex capability strip witnessed at the worker boundary: what the
 * installed `codex` CLI showed its model, captured on the provider wire,
 * for real workers dispatched through the built launcher.
 *
 * One run dispatches three workers in sequence on one app-server — an
 * unstripped control, a worker stripped of agents and skills, and a second
 * unstripped control — each prompted to invoke the seeded skill. The
 * controls prove the witness can see every capability the strip removes,
 * on this Codex version and fixture; the control after the strip proves the
 * strip did not reach beyond its own thread. Each captured request is
 * attributed to its worker by the thread and turn the run record holds,
 * never by order or by a worker's reply.
 *
 * Nothing calls a model and no account is needed: the capture provider
 * stops every turn at its first request. The workers live in a fresh home
 * and an empty directory, so no operator context reaches them.
 */

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

type Arm = "control-before" | "stripped" | "control-after";
const ARMS: readonly { arm: Arm; strip: readonly string[] }[] = [
  { arm: "control-before", strip: [] },
  { arm: "stripped", strip: ["agents", "skills"] },
  { arm: "control-after", strip: [] }
];

/**
 * The probe's retained evidence: per arm, the surface its one captured
 * request showed the model. It holds no request body, header or path
 * outside the fixture, so it carries no credential or operator context.
 */
interface ProbeEvidence {
  codexVersion: string;
  arms: Record<Arm, { strip: readonly string[]; surface: CodexModelSurface }>;
}

let directory: string;
let provider: CaptureProvider;
let seeded: SeededCodexHome;
let evidence: ProbeEvidence;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ensemble-codex-strip-boundary-"));
  provider = await startCaptureProvider();
  seeded = await seedCodexHome(directory, provider.baseUrl);
  const workDirectory = path.join(directory, "work");
  const recordStore = path.join(directory, "records");
  const workflow = path.join(directory, "workflow.js");
  await mkdir(workDirectory);

  const version = await runProcess(await executablePath("codex"), ["--version"]);
  assert.equal(version.code, 0, version.stderr);

  const dispatches = ARMS.map(
    ({ arm, strip }) =>
      `await agent(${JSON.stringify(`Provider-wire probe, arm ${arm}: use $${seeded.skill.name} now.`)}, ${JSON.stringify({
        engine: "codex",
        label: arm,
        cwd: workDirectory,
        maxAttempts: 1,
        ...(strip.length > 0 ? { strip } : {})
      })});`
  );
  await writeFile(workflow, [`export const meta = { name: "codex-strip-boundary" };`, ...dispatches, `return "probed";`, ``].join("\n"));

  const run = await runNode(
    [bundledCliPath, workflow],
    {
      HOME: seeded.home,
      CODEX_HOME: seeded.codexHome,
      XDG_CONFIG_HOME: path.join(seeded.home, ".config"),
      XDG_DATA_HOME: path.join(seeded.home, ".local", "share"),
      ENSEMBLE_RUN_RECORD: "1",
      ENSEMBLE_RUN_RECORD_DIR: recordStore,
      ENSEMBLE_STATUS: "0"
    },
    120_000
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, '"probed"\n', run.stderr);

  const surfaces = provider.requests().map(codexModelSurface);
  const recorded = await recordedTurns(recordStore);
  const arms = {} as ProbeEvidence["arms"];
  for (const { arm, strip } of ARMS) {
    const turn = recorded.get(arm);
    assert.ok(turn !== undefined, `the run record holds no ${arm} worker`);
    assert.deepEqual(turn.strip, strip, `the ${arm} worker recorded a different strip than it was dispatched with`);
    const own = surfaces.filter((surface) => surface.threadId === turn.threadId);
    assert.equal(own.length, 1, `expected one provider request on the ${arm} thread ${turn.threadId}, captured ${own.length}`);
    assert.equal(own[0]!.turnId, turn.turnId, `the ${arm} request belongs to a different turn than the worker's`);
    arms[arm] = { strip, surface: own[0]! };
  }
  assert.equal(surfaces.length, ARMS.length, "the provider saw requests no worker accounts for");
  evidence = { codexVersion: version.stdout.trim(), arms };
});

after(async () => {
  await provider?.close();
  if (directory !== undefined) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Codex worker stripped of agents is shown no agent tools, while unstripped siblings before and after it are", (context) => {
  context.diagnostic(JSON.stringify(evidenceSummary()));
  const spawnsAgents = (arm: Arm) => evidence.arms[arm].surface.tools.some((tool) => tool.endsWith("spawn_agent"));
  const detail = JSON.stringify(evidence, (key, value: unknown) => (key === "inputText" ? undefined : value), 2);

  assert.ok(spawnsAgents("control-before"), `positive control: the unstripped worker was shown no spawn_agent tool, so the witness cannot see agents\n${detail}`);
  assert.ok(spawnsAgents("control-after"), `the strip reached the later unstripped sibling\n${detail}`);
  assert.ok(!spawnsAgents("stripped"), `the stripped worker was shown an agent tool\n${detail}`);

  const agentNamespaces = new Set(
    evidence.arms["control-before"].surface.tools.filter((tool) => tool.endsWith(".spawn_agent")).map((tool) => tool.split(".")[0])
  );
  assert.deepEqual(
    evidence.arms.stripped.surface.tools,
    evidence.arms["control-before"].surface.tools.filter((tool) => !agentNamespaces.has(tool.split(".")[0])),
    `the strip removed or added tools beyond the agent namespace\n${detail}`
  );
});

test("a Codex worker stripped of skills is shown neither the seeded skill's listing nor its invoked body, while unstripped siblings are", () => {
  const detail = JSON.stringify(evidenceSummary(), null, 2);
  for (const arm of ["control-before", "control-after"] as const) {
    const surface = evidence.arms[arm].surface;
    assert.ok(surface.listedSkills.includes(seeded.skill.name), `${arm}: the seeded skill was not listed\n${detail}`);
    assert.ok(surface.injectedSkills.includes(seeded.skill.name), `${arm}: the named skill was not invoked\n${detail}`);
    assert.ok(surface.inputText.includes(seeded.skill.bodyToken), `${arm}: the invoked skill body was not supplied\n${detail}`);
  }
  const stripped = evidence.arms.stripped.surface;
  assert.deepEqual(stripped.listedSkills, [], `the stripped worker was shown a skill listing\n${detail}`);
  assert.deepEqual(stripped.injectedSkills, [], `the stripped worker received an invoked skill\n${detail}`);
  assert.ok(!stripped.inputText.includes(seeded.skill.bodyToken), `the stripped worker received the seeded body token\n${detail}`);
});

/** Persistable witness without input text, credentials or temporary fixture paths. */
function evidenceSummary() {
  return {
    codexVersion: evidence.codexVersion,
    arms: Object.fromEntries(ARMS.map(({ arm }) => {
      const { inputText, ...surface } = evidence.arms[arm].surface;
      return [arm, {
        strip: evidence.arms[arm].strip,
        ...surface,
        seededBodyPresent: inputText.includes(seeded.skill.bodyToken)
      }];
    }))
  };
}

interface RecordedTurn {
  strip: readonly string[];
  threadId: string;
  turnId: string;
}

/**
 * Each labelled worker's strip, thread and turn, read from the run's
 * archived record: the thread from the agent record, the turn from the
 * `turn/started` notification archived in that worker's transcript.
 */
async function recordedTurns(recordStore: string): Promise<Map<string, RecordedTurn>> {
  const entries = await readdir(recordStore, { recursive: true });
  const manifests = entries.filter((entry) => path.basename(entry) === "manifest.json");
  assert.equal(manifests.length, 1, `expected one archived run, found ${manifests.length}`);
  const archive = path.dirname(path.join(recordStore, manifests[0]!));
  const turns = new Map<string, RecordedTurn>();
  for (const agentDirectory of await readdir(path.join(archive, "agents"))) {
    const agent = JSON.parse(await readFile(path.join(archive, "agents", agentDirectory, "agent.json"), "utf8")) as {
      label: string;
      strip: { requested: string[] } | null;
      transcripts: { path: string; thread_id: string }[];
    };
    assert.equal(agent.transcripts.length, 1, `the ${agent.label} worker archived ${agent.transcripts.length} transcripts`);
    const transcript = agent.transcripts[0]!;
    const rows = (await readFile(path.join(archive, transcript.path), "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { direction: string; method?: string; params?: { turn?: { id?: string } } });
    const turnIds = rows.flatMap((row) =>
      row.direction === "server" && row.method === "turn/started" && typeof row.params?.turn?.id === "string" ? [row.params.turn.id] : []
    );
    assert.equal(turnIds.length, 1, `the ${agent.label} transcript records ${turnIds.length} started turns`);
    turns.set(agent.label, { strip: agent.strip?.requested ?? [], threadId: transcript.thread_id, turnId: turnIds[0]! });
  }
  return turns;
}
