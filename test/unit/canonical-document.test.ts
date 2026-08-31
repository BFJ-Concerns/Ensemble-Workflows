import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, compareCodeUnits, sha256 } from "../../src/canonical-document.js";

test("canonical key order is by UTF-16 code unit, not locale collation", () => {
  // "B" (0x42) sorts before "a" (0x61) by code unit; essentially every ICU
  // locale puts "a" first. Pinning the pair keeps the canonical form
  // byte-stable across writer and consumer environments — the digest
  // recipe's whole premise.
  assert.equal(compareCodeUnits("B", "a"), -1);
  assert.equal(canonicalJson({ a: 1, B: 2 }), '{\n  "B": 2,\n  "a": 1\n}');
  // "_" (0x5F) sorts below lower-case ASCII by code unit; ICU tailorings
  // treat punctuation variably, which is why the recipe never asks a
  // collator.
  assert.equal(canonicalJson({ files_lost: 1, files: 2 }), '{\n  "files": 2,\n  "files_lost": 1\n}');
});

test("the recipe's textual substitution reproduces a self-digest", () => {
  // The rule a cold consumer follows: null the digest field, re-serialise
  // canonically, hash. Demonstrated here over a miniature document so the
  // recipe's wording and the writer's computation cannot drift apart
  // silently.
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
