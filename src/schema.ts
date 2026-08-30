import { Ajv } from "ajv/dist/ajv.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";

import { InvalidAgentSchemaError } from "./errors.js";

import type { JsonSchema } from "./types.js";

const ajv = new Ajv({
  allErrors: true,
  strict: false
});

const ajv2020 = new Ajv2020({
  allErrors: true,
  strict: false
});

type SchemaCompiler = Pick<Ajv, "compile">;

const DRAFT_2020_12_URI = "https://json-schema.org/draft/2020-12/schema";
const DRAFT_07_URI = "http://json-schema.org/draft-07/schema";

/**
 * Dialect routing (a dialect is honoured or loudly rejected): the standard
 * `"$schema"` declaration selects the compiler that actually implements
 * that dialect — an undeclared schema keeps the default (draft-07
 * semantics), the draft 2020-12 URI compiles under its own dialect, and a
 * dialect nothing here implements is rejected pre-spawn *naming the
 * supported dialects and the remedy*, never with a bare unresolved-URI
 * message the author cannot act on.
 */
function compilerFor(schema: JsonSchema): SchemaCompiler {
  const declared = schema.$schema;
  if (typeof declared !== "string") {
    return ajv;
  }
  const dialect = declared.replace(/#$/, "");
  if (dialect === DRAFT_2020_12_URI) {
    return ajv2020;
  }
  if (dialect === DRAFT_07_URI) {
    return ajv;
  }
  throw new InvalidAgentSchemaError(
    `unsupported JSON Schema dialect '${declared}' — supported dialects are ` +
      `draft 2020-12 ("${DRAFT_2020_12_URI}") and draft-07 ("${DRAFT_07_URI}#", ` +
      "also the default when $schema is omitted); declare one of those or omit $schema"
  );
}

export interface ParsedJson {
  value: unknown;
  source: "direct" | "object-fallback" | "array-fallback";
}

export interface ValidationResult {
  ok: boolean;
  value: unknown;
  errors: ErrorObject[] | null | undefined;
}

export type JsonSelectionResult =
  | { kind: "valid"; parsed: ParsedJson }
  | { kind: "invalid-json" }
  | { kind: "schema-validation"; validation: ValidationResult };

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

export function selectLastValidJsonFromText(text: string, schema: JsonSchema): JsonSelectionResult {
  const candidates = parseJsonCandidates(text);
  if (candidates.length === 0) {
    return { kind: "invalid-json" };
  }

  let selected: ParsedJson | null = null;
  let lastValidation: ValidationResult | null = null;
  for (const candidate of candidates) {
    const validation = validateJsonSchema(candidate.value, schema);
    if (validation.ok) {
      selected = candidate;
    }
    lastValidation = validation;
  }

  if (selected !== null) {
    return { kind: "valid", parsed: selected };
  }
  if (lastValidation !== null) {
    return { kind: "schema-validation", validation: lastValidation };
  }
  return { kind: "invalid-json" };
}

export function validateJsonSchema(value: unknown, schema: JsonSchema): ValidationResult {
  const validate = compileSchema(schema);
  const ok = validate(value);
  return { ok, value, errors: validate.errors };
}

/** Compile-check a schema up front so a malformed one fails before a worker spawns, not after a paid turn. */
export function assertCompilableSchema(schema: JsonSchema): void {
  try {
    compileSchema(schema);
  } catch (error) {
    if (error instanceof InvalidAgentSchemaError) {
      // Already the author-facing rejection (an unsupported dialect);
      // re-wrapping would bury the remedy under a second layer of message.
      throw error;
    }
    throw new InvalidAgentSchemaError(error instanceof Error ? error.message : String(error), {
      cause: error,
      offending: schema
    });
  }
}

export function normaliseForCodexOutputSchema(schema: JsonSchema): JsonSchema {
  return normaliseSchemaNode(schema) as JsonSchema;
}

function compileSchema(schema: JsonSchema): ValidateFunction {
  return compilerFor(schema).compile(schema);
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

function parseJsonCandidates(source: string): ParsedJson[] {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const direct = tryParse(trimmed);
  if (direct.ok) {
    return [{ value: direct.value, source: "direct" }];
  }

  const candidates: ParsedJson[] = [];
  const regions = indexBalancedJsonRegions(trimmed);
  for (let index = 0; index < trimmed.length; index += 1) {
    const open = trimmed[index];
    if (open !== "{" && open !== "[") {
      continue;
    }
    const region = regions.byStart.get(index);
    if (region === undefined) {
      continue;
    }
    const alreadyClassified = region.parsed !== undefined;
    const parsed = parseRegion(trimmed, region);
    if (parsed.ok) {
      candidates.push({
        value: parsed.value,
        source: open === "{" ? "object-fallback" : "array-fallback"
      });
      // A valid outer value already contains every nested value. Preserve the
      // settled non-overlapping candidate rule by skipping its interior.
      index = region.end;
    } else if (!alreadyClassified) {
      // Any invalid structural descendant makes every containing region invalid.
      // Classify once inside-out so the outer scan can reuse that fact instead of
      // repeatedly slicing and parsing the same hostile nested text.
      classifyDescendants(trimmed, region);
    }
  }
  return candidates;
}

type ParseResult = { ok: true; value: unknown } | { ok: false };

interface IndexedJsonRegion {
  start: number;
  end: number;
  quoteParity: 0 | 1;
  children: IndexedJsonRegion[];
  parsed?: ParseResult;
}

function indexBalancedJsonRegions(source: string): {
  byStart: Map<number, IndexedJsonRegion>;
  ordered: IndexedJsonRegion[];
} {
  const starts = {
    "{": [[], []] as [number[], number[]],
    "[": [[], []] as [number[], number[]]
  };
  const regions: IndexedJsonRegion[] = [];
  let quoteParity: 0 | 1 = 0;
  let consecutiveBackslashes = 0;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (char === "\\") {
      consecutiveBackslashes += 1;
      continue;
    }

    if (char === "\"" && consecutiveBackslashes % 2 === 0) {
      quoteParity = quoteParity === 0 ? 1 : 0;
      consecutiveBackslashes = 0;
      continue;
    }
    consecutiveBackslashes = 0;

    if (char === "{" || char === "[") {
      starts[char][quoteParity].push(index);
      continue;
    }

    const open = char === "}" ? "{" : char === "]" ? "[" : null;
    if (open !== null) {
      const start = starts[open][quoteParity].pop();
      if (start !== undefined) {
        regions.push({ start, end: index, quoteParity, children: [] });
      }
    }
  }

  const ordered = regions.sort((left, right) => left.start - right.start || right.end - left.end);
  attachContainedRegions(ordered, 0);
  attachContainedRegions(ordered, 1);
  return { byStart: new Map(ordered.map((region) => [region.start, region])), ordered };
}

function attachContainedRegions(regions: IndexedJsonRegion[], quoteParity: 0 | 1): void {
  const containers: IndexedJsonRegion[] = [];
  for (const region of regions) {
    if (region.quoteParity !== quoteParity) {
      continue;
    }
    while (containers.length > 0) {
      const candidate = containers.at(-1) as IndexedJsonRegion;
      if (candidate.end >= region.end) {
        break;
      }
      containers.pop();
    }
    const parent = containers.at(-1);
    if (parent !== undefined && parent.start < region.start && region.end <= parent.end) {
      parent.children.push(region);
    }
    containers.push(region);
  }
}

function parseRegion(source: string, region: IndexedJsonRegion): ParseResult {
  region.parsed ??= tryParse(source.slice(region.start, region.end + 1));
  return region.parsed;
}

function classifyDescendants(source: string, region: IndexedJsonRegion): void {
  const descendants: IndexedJsonRegion[] = [];
  const pending = [...region.children];
  while (pending.length > 0) {
    const descendant = pending.pop() as IndexedJsonRegion;
    descendants.push(descendant);
    pending.push(...descendant.children);
  }

  for (let index = descendants.length - 1; index >= 0; index -= 1) {
    const descendant = descendants[index] as IndexedJsonRegion;
    if (descendant.parsed !== undefined) {
      continue;
    }
    if (descendant.children.some((child) => child.parsed?.ok === false)) {
      descendant.parsed = { ok: false };
    } else {
      parseRegion(source, descendant);
    }
  }
}

function extractBalancedJson(source: string, open: "{" | "[", close: "}" | "]"): string | null {
  const start = source.indexOf(open);
  if (start === -1) {
    return null;
  }

  return extractBalancedJsonAt(source, start, open, close)?.text ?? null;
}

function extractBalancedJsonAt(
  source: string,
  start: number,
  open: "{" | "[",
  close: "}" | "]"
): { text: string; end: number } | null {
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
        return { text: source.slice(start, index + 1), end: index };
      }
    }
  }

  return null;
}
