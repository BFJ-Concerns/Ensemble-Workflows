import assert from "node:assert/strict";
import test from "node:test";

import { assertCompilableSchema, parseJsonFromText, selectLastValidJsonFromText, validateJsonSchema } from "../../src/schema.js";
import { InvalidAgentSchemaError } from "../../src/errors.js";

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

test("the standard draft 2020-12 declaration is accepted and enforced under its own dialect", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["ok"],
    additionalProperties: false,
    properties: { ok: { type: "boolean" } },
    // 2020-12 vocabulary a draft-07 compiler does not implement: the array
    // form of items was replaced by prefixItems in this dialect.
    prefixItems: [{ type: "string" }]
  };
  assert.doesNotThrow(() => assertCompilableSchema(schema));
  assert.equal(validateJsonSchema({ ok: true }, schema).ok, true);
  assert.equal(validateJsonSchema({ ok: "not-a-boolean" }, schema).ok, false);
});

test("an explicit draft-07 declaration keeps the default dialect", () => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    required: ["ok"],
    properties: { ok: { type: "boolean" } }
  };
  assert.doesNotThrow(() => assertCompilableSchema(schema));
  assert.equal(validateJsonSchema({ ok: true }, schema).ok, true);
});

test("an unimplemented dialect is rejected pre-spawn, naming the supported dialects and the remedy", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2019-09/schema",
    type: "object"
  };
  assert.throws(
    () => assertCompilableSchema(schema),
    (error: unknown) => {
      assert.ok(error instanceof InvalidAgentSchemaError);
      // The pre-fix rejection was Ajv's bare "no schema with key or ref
      // <uri>" — a message naming only the URI the author already wrote.
      assert.match(error.message, /unsupported JSON Schema dialect/);
      assert.match(error.message, /2020-12/);
      assert.match(error.message, /draft-07/);
      assert.match(error.message, /omit \$schema/);
      return true;
    }
  );
});

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

test("candidate discovery gives each opener fresh quote state", () => {
  const cases = [
    'A stray { and a quote " then {"answer":"v"}',
    'The template said "use {placeholder" here. Answer: {"answer":"v"}',
    'Log line: Error at "line { 42" — result: {"answer":"v"}'
  ];

  for (const source of cases) {
    assert.deepEqual(selectLastValidJsonFromText(source, answerSchema), {
      kind: "valid",
      parsed: { value: { answer: "v" }, source: "object-fallback" }
    });
  }
});

test("candidate parsing performs linear materialisation work on balanced invalid nesting", () => {
  const depth = 200;
  const source = `${"{".repeat(depth)}not-json${"}".repeat(depth)}`;
  const observed = observedText(source);

  const selection = selectLastValidJsonFromText(observed.text, { type: "object" });

  assert.deepEqual(selection, { kind: "invalid-json" });
  const work = observed.slicedCharacters() + observed.parsedCharacters();
  assert.ok(work <= source.length * 6, `expected at most ${source.length * 6} materialised characters, saw ${work}`);
});

const answerSchema = {
  type: "object",
  required: ["answer"],
  additionalProperties: false,
  properties: { answer: { type: "string", enum: ["v"] } }
};

function observedText(source: string): {
  text: string;
  characterReads: () => number;
  slicedCharacters: () => number;
  parsedCharacters: () => number;
} {
  let reads = 0;
  let sliced = 0;
  let parsed = 0;

  function view(value: string, includeTrim: boolean): object {
    const target = {
      length: value.length,
      ...(includeTrim ? { trim: () => proxy } : {}),
      slice: (start: number, end?: number) => {
        const result = value.slice(start, end);
        sliced += result.length;
        return view(result, false);
      },
      toString: () => {
        parsed += value.length;
        return value;
      }
    };
    return new Proxy(target, {
      get(object, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          reads += 1;
          return value[Number(property)];
        }
        return Reflect.get(object, property, receiver) as unknown;
      }
    });
  }

  const proxy = view(source, true);

  return {
    text: proxy as unknown as string,
    characterReads: () => reads,
    slicedCharacters: () => sliced,
    parsedCharacters: () => parsed
  };
}
