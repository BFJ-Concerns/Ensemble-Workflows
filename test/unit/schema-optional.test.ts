import assert from "node:assert/strict";
import test from "node:test";

import { appServerErrorFromPayload } from "../../src/app-server.js";
import { EnsembleRuntime } from "../../src/runtime.js";

import type { RunRecordWriter, RuntimeAgentRecord } from "../../src/run-record.js";
import { normaliseForCodexOutputSchema, validateJsonSchema } from "../../src/schema.js";

import type {
  JsonSchema,
  RuntimeTransport,
  ThreadStartOptions,
  TurnResult,
  TurnStartOptions
} from "../../src/types.js";

class CapturingTransport implements RuntimeTransport {
  readonly cwd = "/fake/repo";
  readonly openedThreads: ThreadStartOptions[] = [];
  readonly turns: Array<{ threadId: string; prompt: string; options: TurnStartOptions }> = [];

  #responses: TurnResult[];

  constructor(responses: TurnResult[]) {
    this.#responses = responses;
  }

  async openThread(options: ThreadStartOptions): Promise<string> {
    this.openedThreads.push(options);
    return `thread-${this.openedThreads.length}`;
  }

  async runTurn(threadId: string, prompt: string, options: TurnStartOptions): Promise<TurnResult> {
    this.turns.push({ threadId, prompt, options });
    const response = this.#responses.shift();
    assert.ok(response, "fake transport response was not configured");
    return response;
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

class RejectingTransport implements RuntimeTransport {
  readonly cwd = "/fake/repo";
  readonly openedThreads: ThreadStartOptions[] = [];
  readonly turns: Array<{ threadId: string; prompt: string; options: TurnStartOptions }> = [];

  #error: Error;

  constructor(error: Error) {
    this.#error = error;
  }

  async openThread(options: ThreadStartOptions): Promise<string> {
    this.openedThreads.push(options);
    return `thread-${this.openedThreads.length}`;
  }

  async runTurn(threadId: string, prompt: string, options: TurnStartOptions): Promise<TurnResult> {
    this.turns.push({ threadId, prompt, options });
    throw this.#error;
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

test("normaliseForCodexOutputSchema recursively promotes optional object properties", () => {
  const authored: JsonSchema = {
    type: "object",
    required: ["id"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      details: {
        type: "object",
        required: ["count"],
        additionalProperties: false,
        properties: {
          count: { type: "integer" },
          note: { type: "string" }
        }
      },
      entries: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            code: { type: "string" },
            flagged: { type: "boolean" }
          }
        }
      }
    }
  };

  const normalised = normaliseForCodexOutputSchema(authored);

  assert.deepEqual(normalised.required, ["id", "details", "entries"]);
  assert.deepEqual(propertySchema(normalised, "details").required, ["count", "note"]);
  assert.deepEqual(itemSchema(propertySchema(normalised, "entries")).required, ["code", "flagged"]);
  assert.deepEqual(authored.required, ["id"]);
  assert.notEqual(normalised, authored);
});

test("normaliseForCodexOutputSchema walks definitions and combinator branches", () => {
  const authored: JsonSchema = {
    $defs: {
      finding: {
        type: "object",
        required: ["title"],
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          confidence: { type: "number" }
        }
      }
    },
    definitions: {
      legacy: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" }
        }
      }
    },
    anyOf: [
      {
        type: "object",
        required: ["ok"],
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          reason: { type: "string" }
        }
      }
    ],
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          choice: { type: "string" }
        }
      }
    ],
    allOf: [
      {
        type: "object",
        required: ["base"],
        additionalProperties: false,
        properties: {
          base: { type: "string" },
          extra: { type: "string" }
        }
      }
    ]
  };

  const normalised = normaliseForCodexOutputSchema(authored);

  assert.deepEqual(defSchema(normalised, "$defs", "finding").required, ["title", "confidence"]);
  assert.deepEqual(defSchema(normalised, "definitions", "legacy").required, ["label"]);
  assert.deepEqual(branchSchema(normalised, "anyOf", 0).required, ["ok", "reason"]);
  assert.deepEqual(branchSchema(normalised, "oneOf", 0).required, ["choice"]);
  assert.deepEqual(branchSchema(normalised, "allOf", 0).required, ["base", "extra"]);
});

test("normaliseForCodexOutputSchema leaves already required schemas semantically unchanged", () => {
  const authored: JsonSchema = {
    type: "object",
    required: ["topic", "summary"],
    additionalProperties: false,
    properties: {
      topic: { type: "string" },
      summary: { type: "string" }
    }
  };

  assert.deepEqual(normaliseForCodexOutputSchema(authored), authored);
});

test("normaliseForCodexOutputSchema treats property maps as containers, not schemas", () => {
  const authored: JsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      properties: { type: "string" }
    }
  };

  const normalised = normaliseForCodexOutputSchema(authored);

  assert.deepEqual(normalised.required, ["properties"]);
  assert.deepEqual(normalised.properties, {
    properties: { type: "string" }
  });
});

test("Codex receives the normalised copy while client validation keeps authored optionality", async () => {
  const authored: JsonSchema = {
    type: "object",
    required: ["pass", "reason"],
    additionalProperties: false,
    properties: {
      pass: { type: "boolean" },
      reason: { type: "string" },
      issues: {
        type: "array",
        items: { type: "string" }
      }
    }
  };
  const transport = new CapturingTransport([turn("{\"pass\":true,\"reason\":\"optional omitted\"}")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 1
  });

  const result = await runtime.agent("return verdict", { engine: "codex", schema: authored });

  assert.deepEqual(result, { pass: true, reason: "optional omitted" });
  assert.deepEqual(authored.required, ["pass", "reason"]);
  assert.equal(validateJsonSchema(result, authored).ok, true);
  assert.equal(validateJsonSchema(result, transport.turns[0]?.options.schema ?? {}).ok, false);
  assert.notEqual(transport.turns[0]?.options.schema, authored);
  assert.deepEqual(transport.turns[0]?.options.schema?.required, ["pass", "reason", "issues"]);
});

test("unsupported Codex schema shapes still fail with the distinct subset error", async () => {
  const unsupported: JsonSchema = { not: {} };
  const transport = new RejectingTransport(
    appServerErrorFromPayload("turn notification", {
      code: undefined,
      message: "received scoped error notification",
      data: {
        error: {
          message:
            "{\"type\":\"error\",\"error\":{\"code\":\"invalid_json_schema\",\"message\":\"not is unsupported\"},\"status\":400}"
        }
      }
    })
  );
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 1
  });

  // Codex's pre-generation rejection arrives after the turn was dispatched,
  // so it is the worker's failure and resolves as a value; the record
  // names the rejection class.
  const records: RuntimeAgentRecord[] = [];
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);
  assert.equal(await runtime.agent("return verdict", { engine: "codex", schema: unsupported }), null);
  assert.equal(records.at(-1)?.attempts.at(-1)?.failure?.kind, "CodexSchemaSubsetUnsupportedError");
  assert.deepEqual(transport.turns[0]?.options.schema, unsupported);
});

function propertySchema(schema: JsonSchema, key: string): JsonSchema {
  const properties = schema.properties as JsonSchema;
  return properties[key] as JsonSchema;
}

function itemSchema(schema: JsonSchema): JsonSchema {
  return schema.items as JsonSchema;
}

function defSchema(schema: JsonSchema, key: "$defs" | "definitions", name: string): JsonSchema {
  const definitions = schema[key] as JsonSchema;
  return definitions[name] as JsonSchema;
}

function branchSchema(schema: JsonSchema, key: "anyOf" | "oneOf" | "allOf", index: number): JsonSchema {
  const branches = schema[key] as JsonSchema[];
  return branches[index] as JsonSchema;
}

function turn(text: string): TurnResult {
  return {
    text,
    deltaText: text,
    durationMs: 10,
    firstDeltaMs: 5,
    items: {},
    tokenUsageEvents: []
  };
}
