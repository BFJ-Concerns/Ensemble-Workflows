import Ajv from "ajv";
import { Buffer } from "node:buffer";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import { createHash } from "node:crypto";

const VALIDATOR_ACTIVE = "ENSEMBLE_CODEX_SCHEMA_VALIDATOR_ACTIVE";
const commandTimeoutMs = Number(process.env.ENSEMBLE_CODEX_SCHEMA_COMMAND_TIMEOUT_MS ?? "120000");
const timeoutControlPath = process.env.ENSEMBLE_CODEX_SCHEMA_TIMEOUT_CONTROL;

if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs < 1) {
  throw new Error("ENSEMBLE_CODEX_SCHEMA_COMMAND_TIMEOUT_MS must be a positive integer");
}

const codexCli = process.env.ENSEMBLE_CODEX_SCHEMA_CLI;
if (codexCli === undefined || codexCli.length === 0) {
  throw new Error(
    "Codex fixture schema validation requires ENSEMBLE_CODEX_SCHEMA_CLI pointing to a codex CLI"
  );
}
const fixturePath = realpathSync(process.argv[1]);
const resolvedCodexCli = resolveCommand(codexCli);
if (process.env[VALIDATOR_ACTIVE] === "1" || resolvedCodexCli === fixturePath) {
  throw new Error(
    `Codex fixture schema validation refused to execute itself recursively: ${codexCli} resolves to ${resolvedCodexCli}`
  );
}

const { directory: schemaDirectory, removeOnExit } = await acquireSchemaDirectory();
if (removeOnExit) {
  process.once("exit", () => rmSync(schemaDirectory, { recursive: true, force: true }));
}

const ajv = new Ajv({ allErrors: true, strict: false, logger: false });
const validators = new Map();
const validationCapture = process.env.ENSEMBLE_FAKE_CODEX_VALIDATION_CAPTURE;

function resolveCommand(command) {
  if (command.includes(path.sep)) {
    return realpathSync(path.resolve(command));
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    try {
      return realpathSync(path.join(directory, command));
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        throw error;
      }
    }
  }
  return command;
}

function runCodexSchemaCommand(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexCli, args, {
      detached: true,
      env: { ...process.env, [VALIDATOR_ACTIVE]: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const terminate = () => {
      timedOut = true;
      killProcessGroup(child.pid);
    };
    const timeout = timeoutControlPath === undefined
      ? setTimeout(terminate, commandTimeoutMs)
      : controlledTimeout(terminate, timeoutControlPath);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(
          `Codex fixture schema command timed out after ${commandTimeoutMs}ms: ${args.join(" ")}`
        ));
      } else if (code !== 0) {
        reject(new Error(
          `Codex fixture schema command exited with code ${code ?? "null"} signal ${signal ?? "null"}: ${stderr.trim()}`
        ));
      } else {
        resolve(stdout);
      }
    });
  });
}

function controlledTimeout(callback, controlPath) {
  appendFileSync(controlPath, "armed\n");
  const interval = setInterval(() => {
    if (!readFileSync(controlPath, "utf8").includes("release\n")) {
      return;
    }
    clearInterval(interval);
    callback();
  }, 5);
  interval.unref();
  return interval;
}

function killProcessGroup(pid) {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}

async function acquireSchemaDirectory() {
  const cacheDirectory = process.env.ENSEMBLE_CODEX_SCHEMA_CACHE_DIRECTORY;
  if (cacheDirectory === undefined || cacheDirectory.length === 0) {
    return { directory: await generateSchemaDirectory(), removeOnExit: true };
  }

  const key = createHash("sha256").update(`${codexCli}\0${resolvedCodexCli}`).digest("hex");
  const sharedDirectory = path.join(cacheDirectory, key);
  const lockDirectory = `${sharedDirectory}.lock`;
  while (!hasSchemaFiles(sharedDirectory)) {
    try {
      mkdirSync(lockDirectory);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (lockOwnerIsGone(lockDirectory)) {
        rmSync(lockDirectory, { recursive: true, force: true });
      } else {
        await waitForSchemaLock();
      }
      continue;
    }
    try {
      writeFileSync(path.join(lockDirectory, "pid"), String(process.pid));
      if (!hasSchemaFiles(sharedDirectory)) {
        const generatedDirectory = await generateSchemaDirectory(cacheDirectory);
        renameSync(generatedDirectory, sharedDirectory);
      }
    } finally {
      rmSync(lockDirectory, { recursive: true, force: true });
    }
  }
  return { directory: sharedDirectory, removeOnExit: false };
}

async function generateSchemaDirectory(parentDirectory = tmpdir()) {
  // The schemas are generated by whatever codex CLI is installed — no exact
  // version pinning. A cache owner performs the liveness check and generation
  // once; concurrent fixture consumers wait for its atomic publication.
  try {
    await runCodexSchemaCommand(["--version"]);
  } catch (error) {
    throw new Error(`Codex fixture schema validation could not run ${codexCli} --version`, { cause: error });
  }
  const directory = mkdtempSync(path.join(parentDirectory, ".ensemble-codex-schema-building-"));
  try {
    await runCodexSchemaCommand(["app-server", "generate-json-schema", "--out", directory]);
    if (!hasSchemaFiles(directory)) {
      throw new Error(`Codex fixture schema command produced no usable protocol schema: ${codexCli}`);
    }
    return directory;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`Codex fixture schema validation could not generate the pinned protocol schema with ${codexCli}`, {
      cause: error
    });
  }
}

function hasSchemaFiles(directory) {
  try {
    return readdirSync(directory).length > 0;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function lockOwnerIsGone(lockDirectory) {
  try {
    const pid = Number(readFileSync(path.join(lockDirectory, "pid"), "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function waitForSchemaLock() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

export function validateCodexFixturePayload(schemaPath, payload, options = {}) {
  if (options.allowMalformed !== undefined) {
    recordValidation({ schemaPath, outcome: "allowed-malformed", reason: options.allowMalformed, ...notificationIdentity(payload) });
    return payload;
  }

  let validate = validators.get(schemaPath);
  if (validate === undefined) {
    validate = ajv.compile(schemaFor(schemaPath));
    validators.set(schemaPath, validate);
  }

  if (!validate(payload)) {
    const detail = ajv.errorsText(validate.errors, { separator: "; " });
    throw new Error(`Codex fixture payload failed ${schemaPath} validation: ${detail}`);
  }
  recordValidation({ schemaPath, outcome: "valid", ...notificationIdentity(payload) });
  return payload;
}

export function codexFixtureSchemaIncludesProperty(schemaPath, property) {
  const schema = schemaFor(schemaPath);
  return schema.properties !== null && typeof schema.properties === "object" && Object.hasOwn(schema.properties, property);
}

function schemaFor(schemaPath) {
  const schema = JSON.parse(readFileSync(path.join(schemaDirectory, schemaPath), "utf8"));
  closeDeclaredObjects(schema);
  return schema;
}

function notificationIdentity(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const { method, params } = payload;
  if (typeof method !== "string" || params === null || typeof params !== "object" || Array.isArray(params)) {
    return {};
  }
  const { threadId, turnId, itemId, delta } = params;
  return {
    method,
    ...(typeof threadId !== "string" ? {} : { threadId }),
    ...(typeof turnId !== "string" ? {} : { turnId }),
    ...(typeof itemId !== "string" ? {} : { itemId }),
    ...(typeof delta !== "string" ? {} : { deltaByteLength: Buffer.byteLength(delta) })
  };
}

function closeDeclaredObjects(value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      closeDeclaredObjects(entry);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (value.type === "object" && value.properties !== undefined && value.additionalProperties === undefined) {
    value.additionalProperties = false;
  }
  for (const child of Object.values(value)) {
    closeDeclaredObjects(child);
  }
}

function recordValidation(entry) {
  if (validationCapture !== undefined) {
    appendFileSync(validationCapture, `${JSON.stringify(entry)}\n`);
  }
}
