import { Ajv } from "ajv/dist/ajv.js";
import type { ErrorObject, ValidateFunction } from "ajv";

import type { JsonSchema } from "./types.js";

const ajv = new Ajv({
  allErrors: true,
  strict: false
});

export interface ParsedJson {
  value: unknown;
  source: "direct" | "object-fallback" | "array-fallback";
}

export interface ValidationResult {
  ok: boolean;
  value: unknown;
  errors: ErrorObject[] | null | undefined;
}

export function parseJsonFromText(text: string): ParsedJson | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const direct = tryParse(trimmed);
  if (direct.ok) {
    return { value: direct.value, source: "direct" };
  }

  const objectCandidate = extractBalancedJson(trimmed, "{", "}");
  if (objectCandidate !== null) {
    const parsed = tryParse(objectCandidate);
    if (parsed.ok) {
      return { value: parsed.value, source: "object-fallback" };
    }
  }

  const arrayCandidate = extractBalancedJson(trimmed, "[", "]");
  if (arrayCandidate !== null) {
    const parsed = tryParse(arrayCandidate);
    if (parsed.ok) {
      return { value: parsed.value, source: "array-fallback" };
    }
  }

  return null;
}

export function validateJsonSchema(value: unknown, schema: JsonSchema): ValidationResult {
  const validate = compileSchema(schema);
  const ok = validate(value);
  return { ok, value, errors: validate.errors };
}

export function normaliseForCodexOutputSchema(schema: JsonSchema): JsonSchema {
  return normaliseSchemaNode(schema) as JsonSchema;
}

function compileSchema(schema: JsonSchema): ValidateFunction {
  return ajv.compile(schema);
}

function normaliseSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normaliseSchemaNode(item));
  }

  const object = asJsonObject(value);
  if (object === null) {
    return value;
  }

  const normalised: JsonSchema = {};
  for (const [key, child] of Object.entries(object)) {
    normalised[key] = cloneJsonNode(child);
  }

  const authoredProperties = asJsonObject(object.properties);
  if (authoredProperties !== null) {
    const properties: JsonSchema = {};
    for (const [key, propertySchema] of Object.entries(authoredProperties)) {
      properties[key] = normaliseSchemaNode(propertySchema);
    }
    normalised.properties = properties;
  }

  normaliseSchemaMapKeyword(object, normalised, "$defs");
  normaliseSchemaMapKeyword(object, normalised, "definitions");

  if (Object.hasOwn(object, "items")) {
    normalised.items = Array.isArray(object.items)
      ? object.items.map((item) => normaliseSchemaNode(item))
      : normaliseSchemaNode(object.items);
  }

  normaliseSchemaArrayKeyword(object, normalised, "anyOf");
  normaliseSchemaArrayKeyword(object, normalised, "oneOf");
  normaliseSchemaArrayKeyword(object, normalised, "allOf");

  const properties = asJsonObject(normalised.properties);
  if (properties === null) {
    return normalised;
  }

  promotePropertiesToRequired(normalised, properties);
  return normalised;
}

function normaliseSchemaMapKeyword(source: JsonSchema, target: JsonSchema, key: "$defs" | "definitions"): void {
  const definitions = asJsonObject(source[key]);
  if (definitions === null) {
    return;
  }

  const normalisedDefinitions: JsonSchema = {};
  for (const [name, schema] of Object.entries(definitions)) {
    normalisedDefinitions[name] = normaliseSchemaNode(schema);
  }
  target[key] = normalisedDefinitions;
}

function normaliseSchemaArrayKeyword(source: JsonSchema, target: JsonSchema, key: "anyOf" | "oneOf" | "allOf"): void {
  if (Array.isArray(source[key])) {
    target[key] = source[key].map((schema) => normaliseSchemaNode(schema));
  }
}

function promotePropertiesToRequired(normalised: JsonSchema, properties: JsonSchema): void {
  // Codex's strict structured-output gate accepts no optional properties:
  // every property key must also appear in required. This copy is Codex-bound
  // only; client validation still uses the authored schema.
  if (!Object.hasOwn(normalised, "required")) {
    normalised.required = Object.keys(properties);
    return;
  }

  if (Array.isArray(normalised.required)) {
    const required = [...normalised.required];
    const seen = new Set(required);
    for (const property of Object.keys(properties)) {
      if (!seen.has(property)) {
        required.push(property);
        seen.add(property);
      }
    }
    normalised.required = required;
  }
}

function asJsonObject(value: unknown): JsonSchema | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonSchema) : null;
}

function cloneJsonNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonNode(item));
  }
  const object = asJsonObject(value);
  if (object === null) {
    return value;
  }
  const clone: JsonSchema = {};
  for (const [key, child] of Object.entries(object)) {
    clone[key] = cloneJsonNode(child);
  }
  return clone;
}

function tryParse(source: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(source) as unknown };
  } catch {
    return { ok: false };
  }
}

function extractBalancedJson(source: string, open: "{" | "[", close: "}" | "]"): string | null {
  const start = source.indexOf(open);
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let isInString = false;
  let isEscaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];

    if (isInString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === "\\") {
        isEscaped = true;
      } else if (char === "\"") {
        isInString = false;
      }
      continue;
    }

    if (char === "\"") {
      isInString = true;
    } else if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return null;
}
