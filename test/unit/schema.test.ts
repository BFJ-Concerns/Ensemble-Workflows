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

test("candidate scanning performs linear character reads on unbalanced input", () => {
  const source = "{".repeat(200);
  const observed = observedText(source);

  const selection = selectLastValidJsonFromText(observed.text, { type: "object" });

  assert.deepEqual(selection, { kind: "invalid-json" });
  assert.ok(
    observed.characterReads() <= source.length * 6,
    `expected at most ${source.length * 6} character reads, saw ${observed.characterReads()}`
  );
});

function observedText(source: string): { text: string; characterReads: () => number } {
  let reads = 0;
  const target = {
    length: source.length,
    trim: () => proxy,
    slice: (start: number, end?: number) => source.slice(start, end),
    toString: () => source
  };
  const proxy = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) {
        reads += 1;
        return source[Number(property)];
      }
      return Reflect.get(object, property, receiver) as unknown;
    }
  });

  return {
    text: proxy as unknown as string,
    characterReads: () => reads
  };
}
