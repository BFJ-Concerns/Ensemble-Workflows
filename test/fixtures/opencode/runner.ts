import type { ChildProcess } from "node:child_process";

/** Wait for the runner to observe process events before driving a fake child. */
export function waitForRunListeners(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const observe = (event: string | symbol): void => {
      if (event !== "close") return;
      child.off("newListener", observe);
      resolve();
    };
    child.on("newListener", observe);
  });
}
