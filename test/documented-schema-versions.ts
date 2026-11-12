import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PAGE = "docs/run-records.md";
const HEADING = "## Schema versions";
const FAMILY_COLUMN = "Artefact family";
const VERSION_COLUMN = "Current version";

/**
 * The current version docs/run-records.md declares for one artefact family.
 *
 * The page states each family's current version once, in the table under its
 * "Schema versions" heading; every other section refers to that table. A test
 * compares this number with what the runtime writes for the family.
 *
 * `family` is the text of the row's "Artefact family" cell as a reader sees
 * it, without link markup: "Live status". The row's "Current version" cell
 * holds the whole number in backticks. The page is read relative to the
 * working directory, which the test suite sets to the repository root.
 */
export function documentedSchemaVersion(family: string): number {
  const [header, ...rows] = schemaVersionsTable();
  assert.ok(header !== undefined, `${PAGE} must have a table under "${HEADING}"`);
  const familyColumn = header.indexOf(FAMILY_COLUMN);
  const versionColumn = header.indexOf(VERSION_COLUMN);
  assert.notEqual(familyColumn, -1, `the "${HEADING}" table in ${PAGE} must have an "${FAMILY_COLUMN}" column`);
  assert.notEqual(versionColumn, -1, `the "${HEADING}" table in ${PAGE} must have a "${VERSION_COLUMN}" column`);

  const matching = rows.filter((row) => linkText(row[familyColumn] ?? "") === family);
  assert.equal(matching.length, 1, `the "${HEADING}" table in ${PAGE} must have exactly one "${family}" row`);
  const version = /^`(\d+)`$/.exec(matching[0]?.[versionColumn] ?? "");
  assert.ok(version !== null, `the "${family}" row of the "${HEADING}" table in ${PAGE} must give its current version as a whole number in backticks`);
  return Number(version[1]);
}

/** The table's rows as trimmed cells, header first, without the delimiter row. */
function schemaVersionsTable(): string[][] {
  const page = readFileSync(PAGE, "utf8");
  const start = page.indexOf(`\n${HEADING}\n`);
  assert.notEqual(start, -1, `${PAGE} must have a "${HEADING}" section`);
  const afterHeading = page.slice(start + HEADING.length + 2);
  const nextHeading = afterHeading.search(/^#{1,2} /m);
  const section = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
  return section
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));
}

/** A cell's text with each Markdown link reduced to its label. */
function linkText(cell: string): string {
  return cell.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}
