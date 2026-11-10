/* global process */

// Scripted terminal for the blocked-worker fixture. Execute the real editor
// helper and submit its copied file; refuse availability probes so blocked
// recovery remains disabled after initial delivery.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "-V") process.exit(1);
const root = path.dirname(args[1]);
const state = path.join(root, "fixture-editor.json");
const target = path.join(root, "fixture-input.txt");
if (args.includes("new-session")) writeFileSync(state, JSON.stringify({ editor: process.env.VISUAL }));
if (args.at(-1) === "C-g") {
  const { editor } = JSON.parse(readFileSync(state, "utf8"));
  const [file, ...editorArgs] = editor.split(" ");
  execFileSync(file, [...editorArgs, target]);
}
if (args.at(-1) === "Enter") execFileSync("claude", ["receive", target]);
