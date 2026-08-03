import Ajv from "ajv";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

const PINNED_CODEX_CLI_VERSION = "codex-cli 0.146.0";
const codexCli = process.env.ENSEMBLE_CODEX_SCHEMA_CLI;
if (codexCli === undefined || codexCli.length === 0) {
  throw new Error(
    "Codex fixture schema validation requires ENSEMBLE_CODEX_SCHEMA_CLI pointing to codex-cli 0.146.0"
  );
}

let actualVersion;
try {
  actualVersion = execFileSync(codexCli, ["--version"], { encoding: "utf8" }).trim();
} catch (error) {
  throw new Error(`Codex fixture schema validation could not run ${codexCli} --version`, {
    cause: error
  });
}
if (actualVersion !== PINNED_CODEX_CLI_VERSION) {
  throw new Error(
    `Codex fixture schema validation requires ${PINNED_CODEX_CLI_VERSION}, received ${actualVersion}`
  );
}

const schemaDirectory = mkdtempSync(path.join(tmpdir(), "ensemble-codex-schema-"));
try {
  execFileSync(codexCli, ["app-server", "generate-json-schema", "--out", schemaDirectory], {
    stdio: ["ignore", "ignore", "pipe"]
  });
} catch (error) {
  rmSync(schemaDirectory, { recursive: true, force: true });
  throw new Error("Codex fixture schema validation could not generate the pinned protocol schema", {
    cause: error
  });
}
process.once("exit", () => rmSync(schemaDirectory, { recursive: true, force: true }));

const ajv = new Ajv({ allErrors: true, strict: false, logger: false });
const validators = new Map();
const validationCapture = process.env.ENSEMBLE_FAKE_CODEX_VALIDATION_CAPTURE;

export function validateCodexFixturePayload(schemaPath, payload, options = {}) {
  if (options.allowMalformed !== undefined) {
    recordValidation({ schemaPath, outcome: "allowed-malformed", reason: options.allowMalformed });
    return payload;
  }

  let validate = validators.get(schemaPath);
  if (validate === undefined) {
    const schema = JSON.parse(readFileSync(path.join(schemaDirectory, schemaPath), "utf8"));
    closeDeclaredObjects(schema);
    validate = ajv.compile(schema);
    validators.set(schemaPath, validate);
  }

  if (!validate(payload)) {
    const detail = ajv.errorsText(validate.errors, { separator: "; " });
    throw new Error(`Codex fixture payload failed ${schemaPath} validation: ${detail}`);
  }
  recordValidation({ schemaPath, outcome: "valid" });
  return payload;
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
