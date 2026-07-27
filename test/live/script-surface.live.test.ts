import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const isLive = process.env.ENSEMBLE_LIVE === "1";
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
          schema: {
            type: "object",
            required: ["point"],
            additionalProperties: false,
            properties: { point: { type: "string" } }
          }
        }),
        () => agent("Reply with exactly one short JSON object: {\\"point\\":\\"beta\\"}", {
          engine: "codex",
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

      return { drafts: drafts.filter(Boolean), compiled };
    `
  );

  const cliPath = path.resolve("dist/src/cli/ensemble.js");
  const result = await runNode([cliPath, script]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /\[phase\] draft/);
  assert.match(result.stderr, /\[phase\] compile/);
  const parsed = JSON.parse(result.stdout) as {
    drafts: unknown[];
    compiled: { count: number; summary: string };
  };
  assert.equal(parsed.drafts.length, 2);
  assert.equal(parsed.compiled.count, 2);
  assert.match(parsed.compiled.summary, /LIVE_WORKFLOW_OK/);
});

test("live CLI runs Codex findings through Claude verification", { skip: !isLive, timeout: 420_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-live-cross-engine-"));
  const script = path.join(directory, "workflow.js");

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
          required: ["token", "accepted", "checkedBy"],
          additionalProperties: false,
          properties: {
            token: { type: "string", enum: ["LIVE_CROSS_VERIFY"] },
            accepted: { type: "boolean", enum: [true] },
            checkedBy: { type: "string", enum: ["claude"] }
          }
        };

        phase("find");
        const finding = await agent(
          "Return exactly one JSON object matching the schema: token LIVE_CROSS_FIND and risk cross-engine-contract.",
          { engine: "codex", schema: findingSchema, maxAttempts: 1 }
        );

        phase("verify");
        const verification = await agent(
          "Verify this Codex finding is structurally valid and relevant to cross-engine verification. " +
            "Return JSON with token LIVE_CROSS_VERIFY, accepted true, and checkedBy claude. Finding: " +
            JSON.stringify(finding),
          { engine: "claude", schema: verificationSchema, maxAttempts: 2 }
        );

        return { finding, verification };
      `
    );

    const cliPath = path.resolve("dist/src/cli/ensemble.js");
    const result = await runNode([cliPath, script]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /\[phase\] find/);
    assert.match(result.stderr, /\[phase\] verify/);
    const parsed = JSON.parse(result.stdout) as {
      finding: { token: string; risk: string };
      verification: { token: string; accepted: boolean; checkedBy: string };
    };
    assert.deepEqual(parsed.finding, { token: "LIVE_CROSS_FIND", risk: "cross-engine-contract" });
    assert.deepEqual(parsed.verification, {
      token: "LIVE_CROSS_VERIFY",
      accepted: true,
      checkedBy: "claude"
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live CLI accepts prose-wrapped schema output from a real Claude worker", { skip: !isLive, timeout: 420_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-live-tolerant-parse-"));
  const script = path.join(directory, "workflow.js");
  const recordStore = path.join(directory, "records");
  const expected = {
    token: "LIVE_TOLERANT_CLAUDE",
    product: 57,
    checkedBy: "claude"
  };

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
          required: ["token", "product", "checkedBy"],
          additionalProperties: false,
          properties: {
            token: { type: "string", enum: ["LIVE_TOLERANT_CLAUDE"] },
            product: { type: "integer", enum: [57] },
            checkedBy: { type: "string", enum: ["claude"] }
          }
        };

        phase("prose-wrapped-claude");
        return await agent(
          "Calculate 19 multiplied by 3. In your final response, first write at least one complete sentence " +
            "explaining how you computed the product. After that prose, include a JSON object with token " +
            "LIVE_TOLERANT_CLAUDE, product 57, and checkedBy claude. The prose before the object is required.",
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

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /\[phase\] prose-wrapped-claude/);
    assert.deepEqual(JSON.parse(result.stdout), expected);

    const { agent } = await recordedAgent(recordStore, "prose-wrapped-claude");
    assert.equal(agent.attempts.length, 1);
    assert.equal(agent.attempts[0]?.status, "complete");
    assert.deepEqual(agent.validated_output, expected);
    assert.equal(typeof agent.raw_output, "string");
    const rawOutput = agent.raw_output ?? "";
    const objectStart = rawOutput.indexOf("{");
    assert.ok(objectStart > 0, `Claude did not put prose before its JSON object: ${rawOutput}`);
    assert.match(rawOutput.slice(0, objectStart), /[A-Za-z][\s\S]*[.!?]/);
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
  const registryReceipt = "typescript@5.9.3";
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

        const resultSchema = {
          type: "object",
          required: ["attempted", "exitCode", "registryReceipt"],
          additionalProperties: false,
          properties: {
            attempted: { type: "boolean", enum: [true] },
            exitCode: { type: "integer" },
            registryReceipt: { type: "string" }
          }
        };

        phase("unrestricted-posture");
        const result = await agent(
          ${JSON.stringify(
            `Use the shell tool to run this command exactly once: ${command}. ` +
              "Do not infer or invent its result. Return attempted true, the tool exit code as exitCode, " +
              "and the command stdout as registryReceipt."
          )},
          {
          engine: "codex",
          label: "unrestricted-posture",
          schema: resultSchema,
          maxAttempts: 1
          }
        );

        return result;
      `
    );

    const result = await runNode([bundledCliPath, script], {
      env: { ...process.env, ENSEMBLE_RUN_RECORD_DIR: recordStore }
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /\[phase\] unrestricted-posture/);
    const parsed = JSON.parse(result.stdout) as UnrestrictedProbeResult;
    assert.deepEqual(parsed, {
      attempted: true,
      exitCode: 0,
      registryReceipt
    });
    assert.equal(await readFile(outsidePath, "utf8"), outsideReceipt);

    const recorded = await recordedCommand(recordStore, "unrestricted-posture", registryUrl);
    assert.equal(recorded.exitCode, 0);
    assert.match(recorded.aggregatedOutput ?? "", /typescript@5\.9\.3/);
  } finally {
    await rm(outsidePath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

interface UnrestrictedProbeResult {
  attempted: true;
  exitCode: number;
  registryReceipt: string;
}

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

        const resultSchema = {
          type: "object",
          required: ["attempted", "exitCode", "httpStatus", "body"],
          additionalProperties: false,
          properties: {
            attempted: { type: "boolean", enum: [true] },
            exitCode: { type: "integer", enum: [0] },
            httpStatus: { type: "integer", enum: [200] },
            body: { type: "string", enum: ["{}"] }
          }
        };

        phase("unrestricted-posture-estate");
        return await agent(
          ${JSON.stringify(
            `Use the shell tool to run this command exactly once: printf %s ${fileReceipt} > ${outsideFile} && curl --silent --show-error --max-time 10 --write-out '\\n%{http_code}' ${registryUrl}. Do not infer or invent its result. Return attempted true, the tool exit code as exitCode, the final curl status line as integer httpStatus, and the preceding curl stdout as body.`
          )},
          {
          engine: "codex",
          label: "unrestricted-posture-estate",
          schema: resultSchema,
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
    assert.deepEqual(JSON.parse(result.stdout), {
      attempted: true,
      exitCode: 0,
      httpStatus: 200,
      body: "{}"
    });

    assert.equal(await readFile(outsideFile, "utf8"), fileReceipt);
    const command = await recordedCommand(recordStore, "unrestricted-posture-estate", registryUrl);
    assert.equal(command.exitCode, 0);
    assert.match(command.command, new RegExp(escapeRegExp(outsideFile)));
    assert.match(command.aggregatedOutput ?? "", /\{\}\s+200/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outsideDirectory, { recursive: true, force: true });
  }
});

test("live bundled CLI starts a Codex worker in its per-call cwd", { skip: !isLive, timeout: 240_000 }, async () => {
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
          name: "codex-per-call-cwd",
          description: "Worker observation of its per-call starting directory"
        };
        return await agent(
          "Use the shell to run pwd and then cat placement-receipt.txt. Return the observed directory and file contents.",
          {
            engine: "codex",
            cwd: ${JSON.stringify(targetCwd)},
            label: "per-call-cwd",
            maxAttempts: 1,
            schema: {
              type: "object",
              required: ["cwd", "receipt"],
              additionalProperties: false,
              properties: {
                cwd: { type: "string" },
                receipt: { type: "string" }
              }
            }
          }
        );
      `
    );

    const result = await runNode([bundledCliPath, script], {
      env: { ...process.env, ENSEMBLE_RUN_RECORD_DIR: recordStore }
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      cwd: targetCwd,
      receipt
    });
    const command = await recordedCommand(recordStore, "per-call-cwd", "placement-receipt.txt");
    assert.equal(command.exitCode, 0);
    assert.match(command.aggregatedOutput ?? "", new RegExp(escapeRegExp(targetCwd)));
    assert.match(command.aggregatedOutput ?? "", new RegExp(receipt));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live bundled CLI preserves a Codex worker-created commit", { skip: !isLive, timeout: 240_000 }, async () => {
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
          name: "codex-worktree-commit",
          description: "Final-consumer proof that an isolated worker can commit"
        };
        const agentResult = await agent(
          ${JSON.stringify(
            `Use the shell to create worker-commit.txt containing exactly ${receipt}, git add it, and commit it with message "worker commit". Then return the current branch and HEAD commit.`
          )},
          {
            engine: "codex",
            isolation: "worktree",
            label: "worktree-commit",
            maxAttempts: 1,
            schema: {
              type: "object",
              required: ["branch", "commit"],
              additionalProperties: false,
              properties: {
                branch: { type: "string" },
                commit: { type: "string" }
              }
            }
          }
        );
        return { agentResult, worktrees };
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
      agentResult: { branch: string; commit: string };
      worktrees: Array<{ path: string; branch: string; baseCommit: string; changed: boolean; removed: boolean }>;
    };
    assert.equal(parsed.worktrees.length, 1);
    const worktree = parsed.worktrees[0];
    assert.ok(worktree);
    assert.equal(worktree.changed, true);
    assert.equal(worktree.removed, false);
    assert.equal(await readFile(path.join(worktree.path, "worker-commit.txt"), "utf8"), receipt);
    assert.equal((await git(worktree.path, ["status", "--porcelain=v1", "--untracked-files=all"])).trim(), "");

    const tip = (await git(repo, ["rev-parse", worktree.branch])).trim();
    assert.notEqual(tip, worktree.baseCommit);
    assert.equal(parsed.agentResult.branch, worktree.branch);
    assert.equal(parsed.agentResult.commit, tip);

    const { agent } = await recordedAgent(recordStore, "worktree-commit");
    assert.deepEqual(agent.worktree, {
      branch: worktree.branch,
      base_commit: worktree.baseCommit
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

interface RecordedCommand {
  command: string;
  exitCode: number | null;
  aggregatedOutput: string | null;
}

interface RecordedAgent {
  label: string | null;
  worktree: { branch: string; base_commit: string } | null;
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
