import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

export function accelerateDeadline({ controlPath, errorName, kind, observe }) {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeSetInterval = globalThis.setInterval;
  const nativeClearTimeout = globalThis.clearTimeout;
  const nativeClearInterval = globalThis.clearInterval;
  let deadlineCount = 0;
  const controlledTimers = new Map();

  globalThis.setTimeout = (callback, delay, ...args) => {
    const callbackText = Function.prototype.toString.call(callback);
    if (controlPath !== undefined && observe !== undefined && callbackText.includes(observe.errorName)) {
      appendFileSync(controlPath, `observed:${observe.kind}:${delay}\n`);
      return nativeSetTimeout(callback, delay, ...args);
    }
    if (controlPath === undefined || !callbackText.includes(errorName)) {
      return nativeSetTimeout(callback, delay, ...args);
    }

    const id = ++deadlineCount;
    appendFileSync(controlPath, `armed:${kind}:${id}:${delay}\n`);
    const timer = nativeSetInterval(() => {
      let control = "";
      try {
        control = readFileSync(controlPath, "utf8");
      } catch {
        return;
      }
      const releaseMarker = `release:${kind}:${id}\n`;
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
    controlledTimers.set(timer, { id });
    timer.unref();
    return timer;
  };

  globalThis.clearTimeout = (timer) => {
    const controlled = controlledTimers.get(timer);
    if (controlled !== undefined) {
      controlledTimers.delete(timer);
      nativeClearInterval(timer);
      appendFileSync(controlPath, `disarmed:${kind}:${controlled.id}\n`);
      return;
    }
    nativeClearTimeout(timer);
  };
}
