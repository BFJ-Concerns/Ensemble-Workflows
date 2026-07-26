import assert from "node:assert/strict";
import test from "node:test";

import { parseJsonFromText, selectLastValidJsonFromText, validateJsonSchema } from "../../src/schema.js";

const nestedSchema = {
  type: "object",
  required: ["status", "details"],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["ok"] },
    details: {
      type: "object",
      required: ["count"],
      additionalProperties: false,
      properties: {
        count: { type: "integer" }
      }
    }
  }
};

test("parseJsonFromText extracts direct and wrapped JSON", () => {
  assert.deepEqual(parseJsonFromText("{\"x\":1}"), { value: { x: 1 }, source: "direct" });
  assert.deepEqual(parseJsonFromText("Here: {\"x\":1}"), {
    value: { x: 1 },
    source: "object-fallback"
  });
});

test("schema-aware selection reports the route of the last validating candidate", () => {
  const selection = selectLastValidJsonFromText(
    'Draft: {"status":"ok","details":{"count":1}}\nFinal: ["accepted"]',
    {
      anyOf: [nestedSchema, { type: "array", items: { type: "string" } }]
    }
  );

  assert.deepEqual(selection, {
    kind: "valid",
    parsed: {
      value: ["accepted"],
      source: "array-fallback"
    }
  });
});

test("validateJsonSchema enforces nested required properties and enums", () => {
  assert.equal(validateJsonSchema({ status: "ok", details: { count: 2 } }, nestedSchema).ok, true);
  assert.equal(validateJsonSchema({ status: "bad", details: { count: 2 } }, nestedSchema).ok, false);
  assert.equal(validateJsonSchema({ status: "ok", details: {} }, nestedSchema).ok, false);
});
