import { constants } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type WorkflowReference = string | { scriptPath: string };

export interface SavedWorkflowMeta {
  name: string;
  description: string;
}

export interface SavedWorkflowEntry extends SavedWorkflowMeta {
  scriptPath: string;
  scope: "project" | "user";
}

export interface WorkflowRegistryDirs {
  project: string;
  user: string;
}

export interface WorkflowRegistryNote {
  scriptPath: string;
  message: string;
}

export interface WorkflowRegistryListing {
  entries: SavedWorkflowEntry[];
  notes: WorkflowRegistryNote[];
}

export type WorkflowMetaReader = (source: string, filename: string) => unknown;

export class WorkflowResolutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class NestedWorkflowError extends WorkflowResolutionError {
  constructor() {
    super("workflow() cannot be called from inside a child workflow; nesting is limited to one level");
  }
}

export function defaultWorkflowRegistryDirs(cwd: string, env: NodeJS.ProcessEnv = process.env): WorkflowRegistryDirs {
  const dataHome =
    env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME.length > 0
      ? env.XDG_DATA_HOME
      : path.join(homedir(), ".local", "share");
  return {
    project: path.join(cwd, ".claude", "ensemble", "workflows"),
    user: path.join(dataHome, "ensemble", "workflows")
  };
}

export async function resolveWorkflowReference(
  nameOrRef: WorkflowReference,
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    readMeta: WorkflowMetaReader;
  }
): Promise<string> {
  if (typeof nameOrRef === "string") {
    return resolveWorkflowName(nameOrRef, options);
  }

  if (
    typeof nameOrRef !== "object" ||
    nameOrRef === null ||
    typeof (nameOrRef as { scriptPath?: unknown }).scriptPath !== "string" ||
    (nameOrRef as { scriptPath: string }).scriptPath.trim().length === 0
  ) {
    throw new WorkflowResolutionError("workflow() expects a workflow name string or { scriptPath: string }");
  }

  const scriptPath = path.resolve(options.cwd, nameOrRef.scriptPath);
  try {
    await access(scriptPath, constants.R_OK);
  } catch (error) {
    throw new WorkflowResolutionError(`workflow({ scriptPath }) could not read ${scriptPath}`, { cause: error });
  }
  return scriptPath;
}

export async function listSavedWorkflows(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  readMeta: WorkflowMetaReader;
}): Promise<WorkflowRegistryListing> {
  const dirs = defaultWorkflowRegistryDirs(options.cwd, options.env);
  const [project, user] = await Promise.all([
    listRegistryDir(dirs.project, "project", options.readMeta),
    listRegistryDir(dirs.user, "user", options.readMeta)
  ]);

  return {
    entries: [...project.entries, ...user.entries].sort(compareEntries),
    notes: [...project.notes, ...user.notes]
  };
}

async function resolveWorkflowName(
  name: string,
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    readMeta: WorkflowMetaReader;
  }
): Promise<string> {
  if (name.trim().length === 0) {
    throw new WorkflowResolutionError("workflow() name must not be empty");
  }

  const dirs = defaultWorkflowRegistryDirs(options.cwd, options.env);
  const skipped: WorkflowRegistryNote[] = [];
  for (const [scope, dir] of [
    ["project", dirs.project],
    ["user", dirs.user]
  ] as const) {
    const listing = await listRegistryDir(dir, scope, options.readMeta);
    skipped.push(...listing.notes);
    const matches = listing.entries.filter((entry) => entry.name === name);
    if (matches.length === 1) {
      const [match] = matches;
      if (match !== undefined) {
        return match.scriptPath;
      }
    }
    if (matches.length > 1) {
      throw new WorkflowResolutionError(`workflow(${JSON.stringify(name)}) is ambiguous in ${dir}`);
    }
  }

  // A "not found" that silently ignored an unparseable file would send the
  // author hunting in the wrong place — name what was skipped and why.
  const skippedSuffix =
    skipped.length === 0
      ? ""
      : `; skipped unreadable saved workflows: ${skipped.map((note) => `${note.scriptPath} (${note.message})`).join(", ")}`;
  throw new WorkflowResolutionError(
    `workflow(${JSON.stringify(name)}) was not found in ${dirs.project} or ${dirs.user}${skippedSuffix}`
  );
}

async function listRegistryDir(
  dir: string,
  scope: "project" | "user",
  readMeta: WorkflowMetaReader
): Promise<WorkflowRegistryListing> {
  let directoryEntries;
  try {
    directoryEntries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirectory(error)) {
      return { entries: [], notes: [] };
    }
    return {
      entries: [],
      notes: [{ scriptPath: dir, message: `could not read registry directory: ${formatError(error)}` }]
    };
  }

  const entries: SavedWorkflowEntry[] = [];
  const notes: WorkflowRegistryNote[] = [];
  for (const entry of directoryEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !isWorkflowScript(entry.name)) {
      continue;
    }

    const scriptPath = path.join(dir, entry.name);
    try {
      const source = await readFile(scriptPath, "utf8");
      const meta = savedWorkflowMeta(readMeta(source, scriptPath));
      if (meta === null) {
        notes.push({ scriptPath, message: "meta.name must be a string" });
        continue;
      }
      entries.push({ ...meta, scriptPath, scope });
    } catch (error) {
      notes.push({ scriptPath, message: formatError(error) });
    }
  }

  return { entries, notes };
}

function savedWorkflowMeta(meta: unknown): SavedWorkflowMeta | null {
  if (typeof meta !== "object" || meta === null) {
    return null;
  }
  const name = (meta as { name?: unknown }).name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return null;
  }
  const description = (meta as { description?: unknown }).description;
  return {
    name,
    description: typeof description === "string" ? description : ""
  };
}

function isWorkflowScript(name: string): boolean {
  return name.endsWith(".js") || name.endsWith(".mjs");
}

function compareEntries(left: SavedWorkflowEntry, right: SavedWorkflowEntry): number {
  const scopeRank = { project: 0, user: 1 };
  const scopeOrder = scopeRank[left.scope] - scopeRank[right.scope];
  if (scopeOrder !== 0) {
    return scopeOrder;
  }
  return left.name.localeCompare(right.name) || left.scriptPath.localeCompare(right.scriptPath);
}

function isMissingDirectory(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
