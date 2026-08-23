import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const nativeSetTimeout = globalThis.setTimeout;
const nativeSetInterval = globalThis.setInterval;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeClearInterval = globalThis.clearInterval;
const acceleratedMs = Number(process.env.ENSEMBLE_POST_PROMISE_DEADLINE_MS ?? "60");
const controlPath = process.env.ENSEMBLE_POST_PROMISE_DEADLINE_CONTROL;
const deadlineKind = process.env.ENSEMBLE_POST_PROMISE_DEADLINE_KIND ?? "retry-promise";
let deadlineCount = 0;
const controlledTimers = new Map();

globalThis.setTimeout = (callback, delay, ...args) => {
  const callbackText = Function.prototype.toString.call(callback);
  const expectedError = deadlineKind === "first-delta"
    ? "AppServerFirstOutputTimeoutError"
    : "AppServerRetryPromiseBrokenError";
  if (delay !== 15 * 60 * 1_000 || controlPath === undefined || !callbackText.includes(expectedError)) {
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
    const releaseMarker = `release:${id}\n`;
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
