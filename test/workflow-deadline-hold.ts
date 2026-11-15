/**
 * Holds an in-process run's whole-workflow deadline until the test has seen
 * the state the deadline is meant to interrupt.
 *
 * A test of `--timeout` that needs work to happen before the deadline (a
 * worker to finish, a hanging call to start) otherwise races a short real
 * timer against the host: on a loaded machine the deadline can fire while
 * the script is still loading. Under the hold, the timer whose callback
 * raises `WorkflowTimeoutError` keeps its own delay but fires no earlier
 * than `release()`, so the deadline still ends the run through the
 * product's own callback and every other timer runs untouched. The test
 * calls `release()` from the event it means — typically a fake engine's
 * hook when the hanging call starts — and `restore()` in a `finally`.
 *
 * The built CLI in a child process is held the same way by the preload
 * `test/fixtures/codex/release-workflow-timeout.mjs`.
 */
export interface WorkflowDeadlineHold {
  release(): void;
  restore(): void;
}

export function holdWorkflowDeadline(): WorkflowDeadlineHold {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const held = new Map<unknown, { fire: (() => void) | null; cancelled: boolean }>();
  let released = false;

  const patchedSetTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (typeof callback !== "function" || !Function.prototype.toString.call(callback).includes("WorkflowTimeoutError")) {
      return nativeSetTimeout(callback, delay, ...args);
    }
    const entry = { fire: null as (() => void) | null, cancelled: false };
    const timer = nativeSetTimeout(() => {
      if (entry.cancelled) return;
      if (released) callback(...args);
      else entry.fire = () => callback(...args);
    }, delay);
    held.set(timer, entry);
    return timer;
  }) as typeof globalThis.setTimeout;

  const patchedClearTimeout = ((timer?: Parameters<typeof clearTimeout>[0]) => {
    const entry = held.get(timer);
    if (entry !== undefined) {
      entry.cancelled = true;
      entry.fire = null;
    }
    nativeClearTimeout(timer);
  }) as typeof globalThis.clearTimeout;

  globalThis.setTimeout = patchedSetTimeout;
  globalThis.clearTimeout = patchedClearTimeout;

  return {
    release() {
      released = true;
      // A deadline already due fires on a later turn of the event loop, never
      // inside the caller: the hook that releases it finishes its own work
      // (such as arming a hanging call's cancellation) first.
      setImmediate(() => {
        for (const entry of held.values()) {
          const fire = entry.fire;
          entry.fire = null;
          if (fire !== null && !entry.cancelled) fire();
        }
      });
    },
    restore() {
      if (globalThis.setTimeout === patchedSetTimeout) globalThis.setTimeout = nativeSetTimeout;
      if (globalThis.clearTimeout === patchedClearTimeout) globalThis.clearTimeout = nativeClearTimeout;
    }
  };
}
