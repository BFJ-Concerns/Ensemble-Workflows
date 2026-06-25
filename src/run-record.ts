import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import type {
  EngineName,
  EngineTranscriptArtifact,
  JsonSchema,
  TokenUsageBreakdown,
  TokenUsageEvent
} from "./types.js";

const execFileAsync = promisify(execFile);
const SCHEMA_VERSION = 1;
const MANIFEST_PATH = "manifest.json";

type RunStatus = "in-progress" | "complete" | "failed" | "timed-out" | "interrupted";
type AgentStatus = "in-progress" | "complete" | "failed" | "timed-out" | "interrupted";
type AccountingSource = "provider-reported" | "estimated";

export interface CliFlagsRecord {
  budget?: Record<string, number | null>;
  concurrency?: Record<string, number>;
  timeoutMs?: number;
  jsonArgs: boolean;
}

export interface RunRecordStartOptions {
  storeDir: string;
  cwd: string;
  runUuid: string;
  workflowPath: string;
  workflowSource: string;
  args: unknown;
  cliFlags: CliFlagsRecord;
  startedAt?: string;
}

export interface RuntimeAgentAttemptRecord {
  attempt: number;
  status: "complete" | "failed";
  failure: { kind: string; message: string } | null;
  rawOutput: string | null;
  validatedOutput: unknown;
  startedAt: string;
  endedAt: string;
  durationMs: number | null;
  firstDeltaMs: number | null;
  tokenUsageEvents: TokenUsageEvent[];
  transcripts: EngineTranscriptArtifact[];
}

export interface RuntimeAgentRecord {
  id: number;
  engine: EngineName;
  model: string | null;
  effort: string | null;
  resolvedModel: string | null;
  label: string | null;
  phase: string | null;
  status: AgentStatus;
  creationOrder: number;
  concurrencyGroup: string;
  schema: JsonSchema | null;
  rawOutput: string | null;
  validatedOutput: unknown;
  attempts: RuntimeAgentAttemptRecord[];
}

export interface RunRecordFinishOptions {
  status: Exclude<RunStatus, "in-progress">;
  exitCode: number;
  result: unknown;
  endedAt?: string;
}

interface FileEntry {
  path: string;
  size: number;
  sha256: string;
}

interface NamespaceRecord {
  strategy: "git-root-realpath-sha256";
  id: string;
  material: string;
  hash: string;
}

interface GitState {
  root: string | null;
  head: string | null;
  dirty: boolean | null;
  diffPath: string | null;
}

interface Manifest {
  schema_version: 1;
  kind: "run_manifest";
  run_id: string;
  run_uuid: string;
  namespace: NamespaceRecord;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  workflow: {
    path: string;
    archive_path: string;
    sha256: string;
  };
  args: {
    archive_path: string;
    sha256: string;
  };
  meta: {
    task: unknown;
    raw: unknown;
  };
  cli_flags: CliFlagsRecord;
  git: {
    start: GitState;
    end: GitState | null;
  };
  environment: {
    os: {
      platform: string;
      release: string;
      arch: string;
    };
    node: string;
    tools: Record<string, string | null>;
  };
  harness: {
    package_name: string;
    package_version: string;
    commit: string | null;
  };
  result: {
    archive_path: string | null;
    exit_code: number | null;
  };
  cost_rollup: Record<string, Record<string, UsageRollup>>;
  files: FileEntry[];
}

interface UsageRollup {
  tokens: TokenUsageBreakdown;
  cost: {
    amount: number | null;
    currency: string | null;
    source: AccountingSource;
  };
}

export class RunRecordWriter {
  readonly archiveDir: string;
  readonly manifest: Manifest;

  #cwd: string;
  #files = new Map<string, FileEntry>();
  #agents = new Map<number, RuntimeAgentRecord>();

  private constructor(archiveDir: string, cwd: string, manifest: Manifest) {
    this.archiveDir = archiveDir;
    this.#cwd = cwd;
    this.manifest = manifest;
  }

  static async start(options: RunRecordStartOptions): Promise<RunRecordWriter> {
    const namespace = await deriveNamespace(options.cwd);
    const runId = `${namespace.id}:${options.runUuid}`;
    const archiveDir = path.join(options.storeDir, "runs", "cwd", namespace.hash, options.runUuid);
    await mkdir(archiveDir, { recursive: true });

    const harnessRoot = (await findHarnessRoot()) ?? options.cwd;
    const packageInfo = await readPackageInfo(harnessRoot);
    const gitStart = await readGitState(options.cwd, "git/start.diff", archiveDir);
    const writer = new RunRecordWriter(archiveDir, options.cwd, {
      schema_version: SCHEMA_VERSION,
      kind: "run_manifest",
      run_id: runId,
      run_uuid: options.runUuid,
      namespace,
      status: "in-progress",
      started_at: options.startedAt ?? new Date().toISOString(),
      ended_at: null,
      workflow: {
        path: options.workflowPath,
        archive_path: "workflow.js",
        sha256: sha256(options.workflowSource)
      },
      args: {
        archive_path: "args.json",
        sha256: sha256(canonicalJson(options.args))
      },
      meta: {
        task: null,
        raw: null
      },
      cli_flags: options.cliFlags,
      git: {
        start: gitStart,
        end: null
      },
      environment: {
        os: {
          platform: os.platform(),
          release: os.release(),
          arch: os.arch()
        },
        node: process.version,
        tools: await toolVersions()
      },
      harness: {
        package_name: packageInfo.name,
        package_version: packageInfo.version,
        commit: await git(["rev-parse", "HEAD"], harnessRoot)
      },
      result: {
        archive_path: null,
        exit_code: null
      },
      cost_rollup: {},
      files: []
    });

    await writer.#writeText("workflow.js", options.workflowSource);
    await writer.#writeJson("args.json", {
      schema_version: SCHEMA_VERSION,
      kind: "run_args",
      value: options.args
    });
    if (gitStart.diffPath !== null) {
      await writer.#trackFile(gitStart.diffPath);
    }
    await writer.#writeManifest();
    return writer;
  }

  async noteMeta(meta: unknown): Promise<void> {
    this.manifest.meta = {
      task: extractTask(meta),
      raw: meta
    };
    await this.#writeManifest();
  }

  async recordAgent(record: RuntimeAgentRecord): Promise<void> {
    this.#agents.set(record.id, record);
    const agentDir = `agents/${padId(record.id)}`;
    const transcriptRefs = [];

    for (const attempt of record.attempts) {
      let index = 0;
      for (const transcript of attempt.transcripts) {
        index += 1;
        const suffix = transcript.format === "jsonl" ? "jsonl" : "txt";
        const relativePath = `${agentDir}/attempt-${padAttempt(attempt.attempt)}-${index}-${safeName(transcript.filename, suffix)}`;
        await this.#writeText(relativePath, transcript.content);
        transcriptRefs.push({
          attempt: attempt.attempt,
          path: relativePath,
          format: transcript.format,
          source: transcript.source,
          thread_id: transcript.threadId ?? null,
          session_id: transcript.sessionId ?? null
        });
      }
    }

    const agentJsonPath = `${agentDir}/agent.json`;
    await this.#writeJson(agentJsonPath, {
      schema_version: SCHEMA_VERSION,
      kind: "agent_record",
      id: record.id,
      engine: record.engine,
      model: record.model,
      effort: record.effort,
      resolved_model: record.resolvedModel,
      label: record.label,
      phase: record.phase,
      status: record.status,
      creation_order: record.creationOrder,
      concurrency_group: record.concurrencyGroup,
      schema: record.schema,
      raw_output: record.rawOutput,
      validated_output: record.validatedOutput,
      attempts: record.attempts.map((attempt) => ({
        attempt: attempt.attempt,
        status: attempt.status,
        failure: attempt.failure,
        raw_output: attempt.rawOutput,
        validated_output: attempt.validatedOutput,
        started_at: attempt.startedAt,
        ended_at: attempt.endedAt,
        duration_ms: attempt.durationMs,
        first_delta_ms: attempt.firstDeltaMs,
        token_usage_events: attempt.tokenUsageEvents
      })),
      transcripts: transcriptRefs
    });
    this.manifest.cost_rollup = buildCostRollup([...this.#agents.values()]);
    await this.#writeManifest();
  }

  async finish(options: RunRecordFinishOptions): Promise<void> {
    this.manifest.status = options.status;
    this.manifest.ended_at = options.endedAt ?? new Date().toISOString();
    this.manifest.git.end = await readGitState(this.#cwd, "git/end.diff", this.archiveDir);
    if (this.manifest.git.end.diffPath !== null) {
      await this.#trackFile(this.manifest.git.end.diffPath);
    }
    this.manifest.result = {
      archive_path: "result.json",
      exit_code: options.exitCode
    };
    await this.#writeJson("result.json", {
      schema_version: SCHEMA_VERSION,
      kind: "run_result",
      status: options.status,
      exit_code: options.exitCode,
      value: options.result
    });
    await this.#writeManifest();
  }

  async #writeJson(relativePath: string, value: unknown): Promise<void> {
    await this.#writeText(relativePath, `${canonicalJson(value)}\n`);
  }

  async #writeText(relativePath: string, content: string): Promise<void> {
    const destination = path.join(this.archiveDir, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(temporary, content, "utf8");
    await rename(temporary, destination);
    await this.#trackFile(relativePath);
  }

  async #writeManifest(): Promise<void> {
    this.manifest.files = [...this.#files.values()].sort((a, b) => a.path.localeCompare(b.path));
    const destination = path.join(this.archiveDir, MANIFEST_PATH);
    const temporary = path.join(this.archiveDir, `.manifest.${process.pid}.${Date.now()}.tmp`);
    await writeFile(temporary, `${canonicalJson(this.manifest)}\n`, "utf8");
    await rename(temporary, destination);
  }

  async #trackFile(relativePath: string): Promise<void> {
    const absolute = path.join(this.archiveDir, relativePath);
    const [metadata, contentHash] = await Promise.all([stat(absolute), hashFile(absolute)]);
    this.#files.set(relativePath, {
      path: relativePath,
      size: metadata.size,
      sha256: contentHash
    });
  }
}

function buildCostRollup(records: RuntimeAgentRecord[]): Record<string, Record<string, UsageRollup>> {
  const rollup: Record<string, Record<string, UsageRollup>> = {};
  for (const record of records) {
    const engine = record.engine;
    const model = record.model ?? "default";
    rollup[engine] ??= {};
    rollup[engine][model] ??= {
      tokens: zeroUsage(),
      cost: { amount: null, currency: null, source: "estimated" }
    };
    const bucket = rollup[engine][model];
    for (const attempt of record.attempts) {
      for (const event of attempt.tokenUsageEvents) {
        addUsage(bucket.tokens, event.last);
        addProviderCost(bucket.cost, event);
      }
    }
  }
  return rollup;
}

function addProviderCost(target: UsageRollup["cost"], event: TokenUsageEvent): void {
  const cost = event.raw.cost;
  if (typeof cost !== "number" || !Number.isFinite(cost)) {
    return;
  }
  target.amount = (target.amount ?? 0) + cost;
  target.source = "provider-reported";
  const currency = event.raw.currency;
  if (typeof currency === "string" && (target.currency === null || target.currency === currency)) {
    target.currency = currency;
  }
}

function addUsage(target: TokenUsageBreakdown, delta: TokenUsageBreakdown): void {
  target.cachedInputTokens += delta.cachedInputTokens;
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.reasoningOutputTokens += delta.reasoningOutputTokens;
  target.totalTokens += delta.totalTokens;
}

function zeroUsage(): TokenUsageBreakdown {
  return {
    cachedInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

async function deriveNamespace(cwd: string): Promise<NamespaceRecord> {
  const gitRoot = await git(["rev-parse", "--show-toplevel"], cwd);
  const material = await realpath(gitRoot ?? cwd);
  const hash = sha256(material);
  return {
    strategy: "git-root-realpath-sha256",
    id: `cwd:${hash.slice(0, 24)}`,
    material,
    hash
  };
}

async function readGitState(cwd: string, diffPath: string, archiveDir: string): Promise<GitState> {
  const root = await git(["rev-parse", "--show-toplevel"], cwd);
  const head = await git(["rev-parse", "HEAD"], cwd);
  const porcelain = await git(["status", "--porcelain"], cwd);
  const dirty = porcelain === null ? null : porcelain.length > 0;
  let archivedDiffPath: string | null = null;
  if (dirty === true) {
    const diff = await git(["diff", "--binary"], cwd);
    if (diff !== null && diff.length > 0) {
      await writeStandaloneText(path.join(archiveDir, diffPath), diff);
      archivedDiffPath = diffPath;
    }
  }
  return { root, head, dirty, diffPath: archivedDiffPath };
}

async function readPackageInfo(cwd: string): Promise<{ name: string; version: string }> {
  try {
    const text = await readFile(path.join(cwd, "package.json"), "utf8");
    const parsed = JSON.parse(text) as { name?: unknown; version?: unknown };
    return {
      name: typeof parsed.name === "string" ? parsed.name : "ensemble-workflows",
      version: typeof parsed.version === "string" ? parsed.version : "0.0.0"
    };
  } catch {
    return { name: "ensemble-workflows", version: "0.0.0" };
  }
}

async function findHarnessRoot(): Promise<string | null> {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const text = await readFile(path.join(current, "package.json"), "utf8");
      const parsed = JSON.parse(text) as { name?: unknown };
      if (parsed.name === "ensemble-workflows") {
        return current;
      }
    } catch {
      // Keep walking; bundled skill installs may not carry package metadata.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function toolVersions(): Promise<Record<string, string | null>> {
  const [gitVersion, codexVersion, claudeVersion, openCodeVersion] = await Promise.all([
    commandVersion("git", ["--version"]),
    commandVersion("codex", ["--version"]),
    commandVersion("claude", ["--version"]),
    commandVersion("opencode", ["--version"])
  ]);
  return { git: gitVersion, codex: codexVersion, claude: claudeVersion, opencode: openCodeVersion };
}

async function commandVersion(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 5_000 });
    return (stdout || stderr).trim() || null;
  } catch {
    return null;
  }
}

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 10_000, maxBuffer: 20 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

function extractTask(meta: unknown): unknown {
  if (typeof meta !== "object" || meta === null || !("task" in meta)) {
    return null;
  }
  return (meta as { task?: unknown }).task ?? null;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([key, entryValue]) => [key, sortJson(entryValue)]));
  }
  return value;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function hashFile(filePath: string): Promise<string> {
  const text = await readFile(filePath);
  return createHash("sha256").update(text).digest("hex");
}

async function writeStandaloneText(destination: string, content: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(tmpdir(), `ensemble-run-record-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, content, "utf8");
  try {
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function padId(id: number): string {
  return String(id).padStart(6, "0");
}

function padAttempt(attempt: number): string {
  return String(attempt).padStart(3, "0");
}

function safeName(filename: string, suffix: string): string {
  const cleaned = filename.replace(/[^a-zA-Z0-9._-]/g, "-");
  return cleaned.endsWith(`.${suffix}`) ? cleaned : `${cleaned}.${suffix}`;
}
