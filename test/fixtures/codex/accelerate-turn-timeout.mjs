import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";

const nativeSetTimeout = globalThis.setTimeout;
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
const controlPath = process.env.ENSEMBLE_TURN_TIMEOUT_CONTROL;
const controlledDelay = Number(process.env.ENSEMBLE_TURN_TIMEOUT_MS ?? "30000");

globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay !== controlledDelay || controlPath === undefined) {
    return nativeSetTimeout(callback, delay, ...args);
  }

  appendFileSync(controlPath, "armed\n");
  const timer = nativeSetInterval(() => {
    let control = "";
    try {
      control = readFileSync(controlPath, "utf8");
    } catch {
      return;
    }
    if (!control.includes("release\n")) {
      return;
    }
    nativeClearInterval(timer);
    callback(...args);
  }, 5);
  timer.unref();
  return timer;
};
