import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const nativeSetTimeout = globalThis.setTimeout;
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeSetImmediate = globalThis.setImmediate;
const controlPath = process.env.ENSEMBLE_TURN_TIMEOUT_CONTROL;
const controlledDelay = Number(process.env.ENSEMBLE_TURN_TIMEOUT_MS ?? "30001");
let captureTurnStartRequestTimeout = false;
let turnStartRequestTimeout;

globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay !== controlledDelay || controlPath === undefined) {
    if (captureTurnStartRequestTimeout && delay === 30_000) {
      captureTurnStartRequestTimeout = false;
      const timer = nativeSetTimeout(callback, delay, ...args);
      turnStartRequestTimeout = timer;
      return timer;
    }
    return nativeSetTimeout(callback, delay, ...args);
  }

  appendFileSync(controlPath, "armed\n");
  // createTurn() arms the per-turn timer immediately before #request("turn/start").
  // Its request timer being cleared proves the response reached the client; a
  // following event-loop turn lets the awaiting client store turnId first.
  captureTurnStartRequestTimeout = true;
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
    // Consume the one-shot release so unrelated later timers cannot inherit it.
    writeFileSync(controlPath, control.replace("release\n", ""));
    nativeClearInterval(timer);
    callback(...args);
  }, 5); // Hang-guard poll; only the client-written release marker fires the deadline.
  timer.unref();
  return timer;
};

globalThis.clearTimeout = (timer) => {
  nativeClearTimeout(timer);
  if (timer === turnStartRequestTimeout && controlPath !== undefined) {
    turnStartRequestTimeout = undefined;
    // The response handler clears this timer before resolving the request;
    // two check phases leave that resolution and the awaiting turn/start
    // continuation ahead of the fixture's release without using wall-clock
    // delay as the test mechanism.
    nativeSetImmediate(() => {
      nativeSetImmediate(() => appendFileSync(controlPath, "turn-start-processed\n")).unref();
    }).unref();
  }
};
