import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
import { setInterval } from "node:timers";

import { accelerateDeadline } from "./accelerate-deadline.mjs";

const controlPath = process.env.ENSEMBLE_WORKFLOW_TIMEOUT_CONTROL;
if (controlPath === undefined) throw new Error("workflow timeout control path is required");

// Exercise the real CLI deadline callbacks only after the server has entered
// the state under test. All transport and teardown clocks remain real.
accelerateDeadline({ controlPath, errorName: "WorkflowTimeoutError", kind: "workflow" });
const released = new Set();
setInterval(() => {
  const control = readFileSync(controlPath, "utf8");
  if (!control.includes("ready\n")) return;
  for (const match of control.matchAll(/^armed:workflow:(\d+):\d+$/gm)) {
    const id = match[1];
    if (released.has(id)) continue;
    released.add(id);
    appendFileSync(controlPath, `release:workflow:${id}\n`);
  }
}, 5).unref();
