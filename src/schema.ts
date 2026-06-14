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

function compileSchema(schema: JsonSchema): ValidateFunction {
  return ajv.compile(schema);
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
