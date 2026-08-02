import process from "node:process";

const nativeSetTimeout = globalThis.setTimeout;
const acceleratedMs = Number(process.env.ENSEMBLE_POST_PROMISE_DEADLINE_MS ?? "60");

globalThis.setTimeout = (callback, delay, ...args) =>
  nativeSetTimeout(callback, delay === 15 * 60 * 1_000 ? acceleratedMs : delay, ...args);
