import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, compareCodeUnits, sha256 } from "../../src/canonical-document.js";

test("canonical key order is by UTF-16 code unit, not locale collation", () => {
  // "B" (0x42) sorts before "a" (0x61) by code unit; essentially every ICU
  // locale puts "a" first, so this pair discriminates a collator-ordered
  // sort from the recipe's — the digest's whole premise is that writer and
  // consumer order identically on any machine.
  assert.equal(compareCodeUnits("B", "a"), -1);
  assert.equal(canonicalJson({ a: 1, B: 2 }), '{\n  "B": 2,\n  "a": 1\n}');
  // "_" (0x5F) sorts below lower-case ASCII by code unit, so `files_lost`
  // precedes `filesa` — an ICU collation that treats "_" as ignorable
  // punctuation compares "fileslost" to "filesa" and orders them the other
  // way round.
  assert.equal(canonicalJson({ files_lost: 1, filesa: 2 }), '{\n  "files_lost": 1,\n  "filesa": 2\n}');
  // Integer-index keys are the recipe's stated exception: ECMA-262 property
  // enumeration places them first in numeric order regardless of the sort,
  // so "2" precedes "10" and the recipe says so rather than claiming a
  // code-unit order the platform cannot deliver.
  assert.equal(canonicalJson({ "10": 1, "2": 2 }), '{\n  "2": 2,\n  "10": 1\n}');
});

test("the recipe's textual substitution reproduces a self-digest", () => {
  // The rule a cold consumer follows: null the digest field, re-serialise
  // canonically, hash. Demonstrated over a miniature document; the recipe
  // *wording* staying truthful to this computation is held by review, not
  // by this test.
  const document: { integrity: { algorithm: string; doc_sha256: string | null }; b: number; a: number } = {
    integrity: { algorithm: "sha256", doc_sha256: null },
    b: 2,
    a: 1
  };
  document.integrity.doc_sha256 = sha256(canonicalJson(document));
  const copy = JSON.parse(JSON.stringify(document)) as typeof document;
  copy.integrity.doc_sha256 = null;
  assert.equal(sha256(canonicalJson(copy)), document.integrity.doc_sha256);
});
