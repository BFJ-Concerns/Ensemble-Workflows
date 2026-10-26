import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import { liveCodexModel, liveCodexScriptOptions, liveOpenCodeModel } from "./live-models.js";

const isLive = process.env.ENSEMBLE_LIVE === "1";
const codexModelSkip = liveCodexModel === undefined ? "ENSEMBLE_LIVE_CODEX_MODEL is unset" : false;
const liveOptions = { skip: !isLive };
const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const execFileAsync = promisify(execFile);

test("live CLI runs a fan-out then compiler workflow and splits stdout from stderr", liveOptions, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-live-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = {
        name: "fan-out-compiler",
        description: "Live proof that the CLI drives the script surface"
      };

      phase("draft");
      const drafts = await parallel([
        () => agent("Reply with exactly one short JSON object: {\\"point\\":\\"alpha\\"}", {
          engine: "codex",
          ${liveCodexScriptOptions()}
          schema: {
            type: "object",
            required: ["point"],
            additionalProperties: false,
            properties: { point: { type: "string" } }
          }
        }),
        () => agent("Reply with exactly one short JSON object: {\\"point\\":\\"beta\\"}", {
          engine: "codex",
          ${liveCodexScriptOptions()}
          schema: {
            type: "object",
            required: ["point"],
            additionalProperties: false,
            properties: { point: { type: "string" } }
          }
        })
      ]);

      phase("compile");
      const compiled = await agent(
        "Return JSON with count 2 and summary containing LIVE_WORKFLOW_OK. Inputs: " + JSON.stringify(drafts),
        {
          engine: "codex",
          ${liveCodexScriptOptions()}
          schema: {
            type: "object",
            required: ["count", "summary"],
            additionalProperties: false,
            properties: {
              count: { type: "integer" },
              summary: { type: "string" }
            }
          }
        }
      );

      return { drafts, compiled };
    `
  );

  const cliPath = path.resolve("dist/src/cli/ensemble.js");
  const result = await runNode([cliPath, script]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /\[phase\] draft/);
  assert.match(result.stderr, /\[phase\] compile/);
  // What the workers wrote into the schema's fields is their own choice; the
  // product determines that both fan-out results and the compiled result reach
  // stdout as schema-validated objects.
  const parsed = JSON.parse(result.stdout) as {
    drafts: Array<{ point: unknown } | null>;
    compiled: { count: unknown; summary: unknown };
  };
  assert.equal(parsed.drafts.length, 2);
  for (const draft of parsed.drafts) {
    assert.equal(typeof draft?.point, "string", `a fan-out result was not its validated object: ${JSON.stringify(draft)}`);
  }
  assert.ok(Number.isInteger(parsed.compiled.count), `the compiled result was not its validated object: ${result.stdout}`);
  assert.equal(typeof parsed.compiled.summary, "string");
});

test("live built CLI runs a current Codex model with unusual open-domain metadata", { skip: !isLive || codexModelSkip, timeout: 240_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-live-open-domain-options-"));
  const script = path.join(directory, "workflow.js");
  const token = `LIVE_OPEN_DOMAIN_${randomUUID()}`;

  try {
    await writeFile(
      script,
      `
        export const meta = {
          name: "open-domain-option-pass-through",
          description: "A current engine-owned model and unusual metadata still reach a real worker"
        };

        const model = ${JSON.stringify(liveCodexModel)};
        const metadata = {
          effort: "high",
          label: "release candidate: Δ / unusual",
          phase: "verify → final consumer"
        };
        return await agent(
          "Return exactly one JSON object with token ${token}.",
          {
            engine: "codex",
            model,
            effort: metadata.effort,
            label: metadata.label,
            phase: metadata.phase,
            timeoutMs: 180_000,
            maxAttempts: 1,
            schema: {
              type: "object",
              required: ["token"],
              additionalProperties: false,
              properties: {
                token: { type: "string", enum: ["${token}"] }
              }
            }
          }
        );
      `
    );

    const result = await runNode([bundledCliPath, script], {
      env: { ...process.env, ENSEMBLE_RUN_RECORD: "0", ENSEMBLE_STATUS: "0" }
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { token });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live built CLI honours the maximum faithful per-turn timeout as a long deadline", { skip: !isLive, timeout: 240_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-live-large-turn-timeout-"));
  const script = path.join(directory, "workflow.js");
  const token = `LIVE_LARGE_TIMEOUT_${randomUUID()}`;

  try {
    await writeFile(
      script,
      `
        export const meta = {
          name: "maximum-faithful-turn-timeout",
          description: "The largest faithfully representable deadline permits an ordinary worker"
        };

        return await agent(
          "Return exactly one JSON object with token ${token}.",
          {
            engine: "codex",
            ${liveCodexScriptOptions()}
            timeoutMs: 2147483647,
            maxAttempts: 1,
            schema: {
              type: "object",
              required: ["token"],
              additionalProperties: false,
              properties: {
                token: { type: "string", enum: ["${token}"] }
              }
            }
          }
        );
      `
    );

    const result = await runNode([bundledCliPath, script], {
      env: { ...process.env, ENSEMBLE_RUN_RECORD: "0", ENSEMBLE_STATUS: "0" }
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { token });
    assert.doesNotMatch(result.stderr, /TimeoutOverflowWarning|TurnTimeoutError/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live CLI runs Codex findings through Claude verification", { skip: !isLive, timeout: 420_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-live-cross-engine-"));
  const script = path.join(directory, "workflow.js");
  const recordStore = path.join(directory, "records");

  try {
    await writeFile(
      script,
      `
        export const meta = {
          name: "codex-finds-claude-verifies",
          description: "Live proof that Ensemble can verify one engine with another"
        };

        const findingSchema = {
          type: "object",
          required: ["token", "risk"],
          additionalProperties: false,
          properties: {
            token: { type: "string", enum: ["LIVE_CROSS_FIND"] },
            risk: { type: "string" }
          }
        };

        const verificationSchema = {
          type: "object",
          required: ["token", "accepted"],
          additionalProperties: false,
          properties: {
            token: { type: "string", enum: ["LIVE_CROSS_VERIFY"] },
            accepted: { type: "boolean" }
          }
        };

        phase("find");
        const finding = await agent(
          "Return exactly one JSON object matching the schema: token LIVE_CROSS_FIND and a short risk description.",
          { engine: "codex", ${liveCodexScriptOptions()} label: "cross-find", schema: findingSchema, maxAttempts: 2 }
        );

        phase("verify");
        const verification = await agent(
          "Judge whether this Codex finding is relevant to cross-engine verification. " +
            "Return JSON with token LIVE_CROSS_VERIFY and your judgement as accepted. Finding: " +
            JSON.stringify(finding),
          { engine: "claude", label: "cross-verify", schema: verificationSchema, maxAttempts: 2 }
        );

        return { finding, verification };
      `
    );

    const cliPath = path.resolve("dist/src/cli/ensemble.js");
    const result = await runNode([cliPath, script], {
      env: { ...process.env, ENSEMBLE_RUN_RECORD_DIR: recordStore }
    });

    // Both families must actually have answered: the archive names the engine
    // each agent ran on and holds the validated object stdout returned, and
    // the verifier's prompt carries the finding the first engine produced.
    // What the finding says and how Claude judges it are the workers' choices.
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /\[phase\] find/);
    assert.match(result.stderr, /\[phase\] verify/);
    const parsed = JSON.parse(result.stdout) as { finding: unknown; verification: unknown };
    const { agent: finder } = await recordedAgent(recordStore, "cross-find");
    const { agent: verifier } = await recordedAgent(recordStore, "cross-verify");
    assert.equal(finder.engine, "codex");
    assert.equal(verifier.engine, "claude");
    assert.equal(finder.status, "complete");
    assert.equal(verifier.status, "complete");
    assert.deepEqual(finder.validated_output, parsed.finding);
    assert.deepEqual(verifier.validated_output, parsed.verification);
    assert.ok(
      verifier.prompt.includes(JSON.stringify(parsed.finding)),
      `the Claude verifier's recorded prompt did not carry the Codex finding: ${verifier.prompt}`
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live CLI accepts prose-wrapped schema output from a real Claude worker", { skip: !isLive, timeout: 420_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-live-tolerant-parse-"));
  const script = path.join(directory, "workflow.js");
  const recordStore = path.join(directory, "records");

  try {
    await writeFile(
      script,
      `
        export const meta = {
          name: "claude-tolerant-parse",
          description: "Live proof that a prose-wrapped Claude result reaches the schema consumer"
        };

        const schema = {
          type: "object",
          required: ["token", "product"],
          additionalProperties: false,
          properties: {
            token: { type: "string", enum: ["LIVE_TOLERANT_CLAUDE"] },
            product: { type: "integer" }
          }
        };

        phase("prose-wrapped-claude");
        return await agent(
          "Calculate 19 multiplied by 3. In your final response, first write at least one complete sentence " +
            "explaining how you computed the product. After that prose, include a JSON object with token " +
            "LIVE_TOLERANT_CLAUDE and the product. The prose before the object is required.",
          {
            engine: "claude",
            label: "prose-wrapped-claude",
            schema,
            maxAttempts: 1
          }
        );
      `
    );

    const cliPath = path.resolve("dist/src/cli/ensemble.js");
    const result = await runNode([cliPath, script], {
      env: { ...process.env, ENSEMBLE_RUN_RECORD_DIR: recordStore }
    });

    // The product determines that the object inside Claude's raw reply is the
    // validated value stdout returns. Whether Claude wrapped it in prose this
    // time is the model's choice, so a bare reply is reported, not failed.
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /\[phase\] prose-wrapped-claude/);
    const returned: unknown = JSON.parse(result.stdout);

    const { agent } = await recordedAgent(recordStore, "prose-wrapped-claude");
    assert.equal(agent.attempts.length, 1);
    assert.equal(agent.attempts[0]?.status, "complete");
    assert.deepEqual(agent.validated_output, returned);
    assert.equal(typeof agent.raw_output, "string", "the archive did not keep Claude's raw reply");
    const rawOutput = agent.raw_output ?? "";
    const objectStart = rawOutput.indexOf("{");
    const objectEnd = rawOutput.lastIndexOf("}") + 1;
    assert.ok(objectStart >= 0 && objectEnd > objectStart, `the archived raw reply holds no JSON object: ${rawOutput}`);
    assert.deepEqual(JSON.parse(rawOutput.slice(objectStart, objectEnd)), returned);
    if (rawOutput.slice(0, objectStart).trim().length === 0) {
      t.diagnostic("Claude replied with bare JSON this run, so the prose-tolerant parse was not exercised");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live built CLI gives Codex workers unrestricted filesystem and network access", { skip: !isLive, timeout: 240_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-live-unrestricted-"));
  const script = path.join(directory, "workflow.js");
  const recordStore = path.join(directory, "records");
  const outsidePath = path.join(tmpdir(), `ensemble-outside-${randomUUID()}.txt`);
  const outsideReceipt = `OUTSIDE_WORKSPACE_${randomUUID()}`;
  const registryUrl = "https://registry.npmjs.org/typescript/5.9.3";
  const command =
    `printf '%s' '${outsideReceipt}' > '${outsidePath}' && ` +
    `curl --silent --show-error --fail --max-time 20 '${registryUrl}' | ` +
    `node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const p=JSON.parse(s);process.stdout.write(p.name+'@'+p.version)})"`;

  try {
    await writeFile(
      script,
      `
        export const meta = {
          name: "codex-unrestricted-posture",
          description: "Live proof of Codex worker filesystem and network reach"
        };

        phase("unrestricted-posture");
        return await agent(
          ${JSON.stringify(`Use the shell tool to run this command exactly once: ${command}. Then reply with the single word done.`)},
          {
          engine: "codex",
          ${liveCodexScriptOptions()}
          label: "unrestricted-posture",
          maxAttempts: 1
          }
        );
      `
    );

    const result = await runNode([bundledCliPath, script], {
      env: { ...process.env, ENSEMBLE_RUN_RECORD_DIR: recordStore }
    });

    // Reach is witnessed by the file the worker's shell left outside the
    // workspace and by the engine's own record of the command, never by the
    // worker's account of what it ran.
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /\[phase\] unrestricted-posture/);
    assert.equal(await readFile(outsidePath, "utf8"), outsideReceipt);

    const recorded = await recordedCommand(recordStore, "unrestricted-posture", registryUrl);
    assert.equal(recorded.exitCode, 0);
    assert.match(recorded.aggregatedOutput ?? "", /typescript@5\.9\.3/);
  } finally {
    await rm(outsidePath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("live CLI gives a real Codex worker unrestricted filesystem and network access", { skip: !isLive, timeout: 240_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-live-unrestricted-estate-"));
  const cacheDirectory = path.join(homedir(), ".cache");
  await mkdir(cacheDirectory, { recursive: true });
  const outsideDirectory = await mkdtemp(path.join(cacheDirectory, "ensemble-worker-posture-"));
  const outsideFile = path.join(outsideDirectory, "worker-receipt.txt");
  const script = path.join(directory, "workflow.js");
  const recordStore = path.join(directory, "records");
  const fileReceipt = `UNRESTRICTED_FILE_${randomUUID()}`;
  const registryUrl = "https://registry.npmjs.org/-/ping";

  try {
    await writeFile(
      script,
      `
        export const meta = {
          name: "codex-unrestricted-posture-estate",
          description: "Worker-shell proof of unrestricted filesystem and network access"
        };

        phase("unrestricted-posture-estate");
        return await agent(
          ${JSON.stringify(
            `Use the shell tool to run this command exactly once: printf %s ${fileReceipt} > ${outsideFile} && curl --silent --show-error --max-time 10 --write-out '\\n%{http_code}' ${registryUrl}. Then reply with the single word done.`
          )},
          {
          engine: "codex",
          ${liveCodexScriptOptions()}
          label: "unrestricted-posture-estate",
          maxAttempts: 1
          }
        );
      `
    );

    const result = await runNode([bundledCliPath, script], {
      env: { ...process.env, ENSEMBLE_RUN_RECORD_DIR: recordStore }
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /\[phase\] unrestricted-posture-estate/);

    assert.equal(await readFile(outsideFile, "utf8"), fileReceipt);
    const command = await recordedCommand(recordStore, "unrestricted-posture-estate", registryUrl);
    assert.equal(command.exitCode, 0);
    assert.match(command.command, new RegExp(escapeRegExp(outsideFile)));
    // Reachability, not one endpoint's method policy: any HTTP status in the
    // engine's record of the command proves the request left the worker and
    // came back; a restricted worker gets a curl connection error instead.
    // Codex may route worker traffic through its own network proxy (observed
    // 2026-08-07: the proxy answers GET /-/ping with 405 where the origin
    // answers 200), so no one status is pinned.
    assert.match(command.aggregatedOutput ?? "", /\s[1-5]\d{2}\s*$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outsideDirectory, { recursive: true, force: true });
  }
});

const placementScenarios = [
  { engine: "codex", scriptOptions: liveCodexScriptOptions() },
  { engine: "claude", scriptOptions: "" },
  ...(liveOpenCodeModel !== undefined
    ? [{ engine: "opencode", scriptOptions: `model: ${JSON.stringify(liveOpenCodeModel)},` }]
    : [])
] as const;

for (const scenario of placementScenarios) {
  test(`live bundled CLI starts a real ${scenario.engine} worker in its per-call cwd`, { skip: !isLive, timeout: 420_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-live-cwd-"));
  const targetCwd = path.join(directory, "target");
  const script = path.join(directory, "workflow.js");
  const recordStore = path.join(directory, "records");
  const receipt = `CWD_RECEIPT_${randomUUID()}`;

  try {
    await mkdir(targetCwd);
    await writeFile(path.join(targetCwd, "placement-receipt.txt"), receipt);
    await writeFile(
      script,
      `
        export const meta = {
          name: ${JSON.stringify(`${scenario.engine}-per-call-cwd`)},
          description: "Worker observation of its per-call starting directory"
        };
        return await agent(
          "Copy the file placement-receipt.txt in your current working directory to a new file named placed.txt in the same directory, using relative paths only. Then reply with the single word done.",
          {
            engine: ${JSON.stringify(scenario.engine)},
            ${scenario.scriptOptions}
            cwd: ${JSON.stringify(targetCwd)},
            label: ${JSON.stringify(`per-call-cwd-${scenario.engine}`)},
            maxAttempts: 1
          }
        );
      `
    );

    const result = await runNode([bundledCliPath, script], {
      env: { ...process.env, ENSEMBLE_RUN_RECORD_DIR: recordStore }
    });

    // Placement is asserted from what the product determines — the archived
    // resolved_cwd — and from a side effect only a worker started in the
    // target directory could leave there: a relative-path copy of a receipt it
    // could learn nowhere else. The worker's reply is not asserted; how it
    // words "done" is its own choice, and a live test asserts what the
    // product determines, never the model's compliance.
    assert.equal(result.code, 0, result.stderr);
    const { agent } = await recordedAgent(recordStore, `per-call-cwd-${scenario.engine}`);
    assert.equal(agent.resolved_cwd, targetCwd);
    assert.equal(agent.isolation, null);
    assert.equal((await readFile(path.join(targetCwd, "placed.txt"), "utf8")).trimEnd(), receipt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  });
}

for (const scenario of placementScenarios) {
  test(`live bundled CLI preserves a real ${scenario.engine} worker-created commit`, { skip: !isLive, timeout: 420_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-live-worktree-commit-"));
  const repo = path.join(directory, "repo");
  const script = path.join(repo, "workflow.js");
  const recordStore = path.join(directory, "records");
  const receipt = `WORKTREE_COMMIT_${randomUUID()}`;

  try {
    await mkdir(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "ensemble-workflows@example.invalid"]);
    await git(repo, ["config", "user.name", "Ensemble Workflows Test"]);
    await writeFile(path.join(repo, "README.md"), "temporary worktree commit fixture\n");
    await writeFile(
      script,
      `
        export const meta = {
          name: ${JSON.stringify(`${scenario.engine}-worktree-commit`)},
          description: "Final-consumer proof that an isolated worker can commit"
        };
        await agent(
          ${JSON.stringify(
            `Use the shell to create worker-commit.txt containing exactly ${receipt}, git add it, and commit it with message "worker commit". Then reply with the single word done.`
          )},
          {
            engine: ${JSON.stringify(scenario.engine)},
            ${scenario.scriptOptions}
            isolation: "worktree",
            label: ${JSON.stringify(`worktree-commit-${scenario.engine}`)},
            maxAttempts: 1
          }
        );
        return { worktrees };
      `
    );
    await git(repo, ["add", "README.md", "workflow.js"]);
    await git(repo, ["commit", "-m", "initial"]);

    const result = await runNode([bundledCliPath, script], {
      cwd: repo,
      env: { ...process.env, ENSEMBLE_RUN_RECORD_DIR: recordStore }
    });

    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as {
      worktrees: Array<{ path: string; branch: string; baseCommit: string; changed: boolean; removed: boolean }>;
    };
    assert.equal(parsed.worktrees.length, 1);
    const worktree = parsed.worktrees[0];
    assert.ok(worktree);
    assert.equal(worktree.changed, true);
    assert.equal(worktree.removed, false);
    assert.equal((await readFile(path.join(worktree.path, "worker-commit.txt"), "utf8")).trimEnd(), receipt);
    assert.equal((await git(worktree.path, ["status", "--porcelain=v1", "--untracked-files=all"])).trim(), "");

    const tip = (await git(repo, ["rev-parse", worktree.branch])).trim();
    // The commit is read from the repository and the archive, not from the
    // worker's account of its branch and HEAD.
    assert.notEqual(tip, worktree.baseCommit);

    const { agent } = await recordedAgent(recordStore, `worktree-commit-${scenario.engine}`);
    assert.equal(agent.resolved_cwd, worktree.path);
    assert.equal(agent.isolation, "worktree");
    // `tip_commit` is part of the record's worktree shape since 619ff32
    // (recoverability details in agent records). Asserted against the branch
    // tip this test already resolved, so the record is checked to name the
    // commit the worker actually made rather than merely to carry the field.
    assert.deepEqual(agent.worktree, {
      branch: worktree.branch,
      base_commit: worktree.baseCommit,
      tip_commit: tip,
      changed: true,
      removed: false
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  });
}

interface RecordedCommand {
  command: string;
  exitCode: number | null;
  aggregatedOutput: string | null;
}

interface RecordedAgent {
  label: string | null;
  engine: string;
  status: string;
  prompt: string;
  resolved_cwd: string;
  isolation: "worktree" | null;
  worktree: {
    branch: string;
    base_commit: string;
    tip_commit: string | null;
    changed: boolean;
    removed: boolean;
  } | null;
  raw_output: string | null;
  validated_output: unknown;
  attempts: Array<{ status: string; diagnostics: Record<string, unknown> }>;
  transcripts: Array<{ path: string }>;
}

interface RecordedAgentArchive {
  agent: RecordedAgent;
  archiveDirectory: string;
}

async function recordedAgent(recordStore: string, label: string): Promise<RecordedAgentArchive> {
  const entries = await readdir(recordStore, { recursive: true });
  for (const entry of entries.filter((candidate) => candidate.endsWith("agent.json"))) {
    const agentPath = path.join(recordStore, entry);
    const agent = JSON.parse(await readFile(agentPath, "utf8")) as RecordedAgent;
    if (agent.label === label) {
      return {
        agent,
        archiveDirectory: path.resolve(path.dirname(agentPath), "../..")
      };
    }
  }
  throw new Error(`No recorded agent with label ${label}`);
}

async function recordedCommand(recordStore: string, label: string, url: string): Promise<RecordedCommand> {
  const { agent, archiveDirectory } = await recordedAgent(recordStore, label);
  for (const transcript of agent.transcripts) {
    const events = (await readFile(path.join(archiveDirectory, transcript.path), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string; params?: { item?: RecordedCommand & { type?: string } } });
    const completed = events.find(
      (event) =>
        event.method === "item/completed" &&
        event.params?.item?.type === "commandExecution" &&
        event.params.item.command.includes(url)
    )?.params?.item;
    if (completed !== undefined) {
      return completed;
    }
  }
  throw new Error(`No completed command execution for ${label} and ${url}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runNode(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}
