import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";

const nativeSetTimeout = globalThis.setTimeout;
const nativeSetInterval = globalThis.setInterval;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeClearInterval = globalThis.clearInterval;
const acceleratedMs = Number(process.env.ENSEMBLE_POST_PROMISE_DEADLINE_MS ?? "60");
const controlPath = process.env.ENSEMBLE_POST_PROMISE_DEADLINE_CONTROL;
let deadlineCount = 0;
const controlledTimers = new Map();

globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay !== 15 * 60 * 1_000 || controlPath === undefined) {
    return nativeSetTimeout(callback, delay === 15 * 60 * 1_000 ? acceleratedMs : delay, ...args);
  }

  const id = ++deadlineCount;
  appendFileSync(controlPath, `armed:${id}\n`);
  const timer = nativeSetInterval(() => {
    let control = "";
    try {
      control = readFileSync(controlPath, "utf8");
    } catch {
      return;
    }
    if (!control.includes(`release:${id}\n`)) {
      return;
    }
    nativeClearInterval(timer);
    controlledTimers.delete(timer);
    callback(...args);
  }, 5);
  controlledTimers.set(timer, id);
  timer.unref();
  return timer;
};

globalThis.clearTimeout = (timer) => {
  const id = controlledTimers.get(timer);
  if (id !== undefined) {
    controlledTimers.delete(timer);
    nativeClearInterval(timer);
    appendFileSync(controlPath, `disarmed:${id}\n`);
    return;
  }
  nativeClearTimeout(timer);
};
