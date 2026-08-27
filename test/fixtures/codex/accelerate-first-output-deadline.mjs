import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const nativeSetTimeout = globalThis.setTimeout;
const nativeSetInterval = globalThis.setInterval;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeClearInterval = globalThis.clearInterval;
const controlPath = process.env.ENSEMBLE_FIRST_OUTPUT_DEADLINE_CONTROL;
let deadlineCount = 0;
const controlledTimers = new Map();

globalThis.setTimeout = (callback, delay, ...args) => {
  const callbackText = Function.prototype.toString.call(callback);
  const isFirstOutputDeadline = callbackText.includes("AppServerFirstOutputTimeoutError");
  const isRetryPromiseDeadline = callbackText.includes("AppServerRetryPromiseBrokenError");
  if (controlPath === undefined || (!isFirstOutputDeadline && !isRetryPromiseDeadline)) {
    return nativeSetTimeout(callback, delay, ...args);
  }

  if (isRetryPromiseDeadline) {
    appendFileSync(controlPath, `observed:retry-promise:${delay}\n`);
    return nativeSetTimeout(callback, delay, ...args);
  }
  if (delay !== 15 * 60 * 1_000) {
    return nativeSetTimeout(callback, delay, ...args);
  }

  const id = ++deadlineCount;
  appendFileSync(controlPath, `armed:first-output:${id}\n`);
  const timer = nativeSetInterval(() => {
    let control = "";
    try {
      control = readFileSync(controlPath, "utf8");
    } catch {
      return;
    }
    const releaseMarker = `release:first-output:${id}\n`;
    if (!control.includes(releaseMarker)) {
      return;
    }
    writeFileSync(controlPath, control.replace(releaseMarker, ""));
    nativeClearInterval(timer);
    controlledTimers.delete(timer);
    callback(...args);
  }, 5);
  controlledTimers.set(timer, { id });
  timer.unref();
  return timer;
};

globalThis.clearTimeout = (timer) => {
  const controlled = controlledTimers.get(timer);
  if (controlled !== undefined) {
    controlledTimers.delete(timer);
    nativeClearInterval(timer);
    appendFileSync(controlPath, `disarmed:first-output:${controlled.id}\n`);
    return;
  }
  nativeClearTimeout(timer);
};
