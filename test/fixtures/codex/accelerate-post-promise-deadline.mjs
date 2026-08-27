import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const nativeSetTimeout = globalThis.setTimeout;
const nativeSetInterval = globalThis.setInterval;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeClearInterval = globalThis.clearInterval;
const controlPath = process.env.ENSEMBLE_POST_PROMISE_DEADLINE_CONTROL;
let deadlineCount = 0;
const controlledTimers = new Map();

globalThis.setTimeout = (callback, delay, ...args) => {
  const callbackText = Function.prototype.toString.call(callback);
  const terminalKind = callbackText.includes("AppServerRetryPromiseBrokenError") ? "retry-promise" : undefined;
  if (delay !== 15 * 60 * 1_000 || controlPath === undefined || terminalKind === undefined) {
    return nativeSetTimeout(callback, delay, ...args);
  }

  const id = ++deadlineCount;
  appendFileSync(controlPath, `armed:${terminalKind}:${id}\n`);
  const timer = nativeSetInterval(() => {
    let control = "";
    try {
      control = readFileSync(controlPath, "utf8");
    } catch {
      return;
    }
    const releaseMarker = `release:${terminalKind}:${id}\n`;
    if (!control.includes(releaseMarker)) {
      return;
    }
    // Consume this one-shot client-ready release: a later deadline must not
    // inherit a release intended for an earlier timer.
    writeFileSync(controlPath, control.replace(releaseMarker, ""));
    nativeClearInterval(timer);
    controlledTimers.delete(timer);
    callback(...args);
  }, 5); // Hang-guard poll; only the client-written release marker fires the deadline.
  controlledTimers.set(timer, { id, terminalKind });
  timer.unref();
  return timer;
};

globalThis.clearTimeout = (timer) => {
  const controlled = controlledTimers.get(timer);
  if (controlled !== undefined) {
    controlledTimers.delete(timer);
    nativeClearInterval(timer);
    appendFileSync(controlPath, `disarmed:${controlled.terminalKind}:${controlled.id}\n`);
    return;
  }
  nativeClearTimeout(timer);
};
