import { access } from "node:fs/promises";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

while (true) {
  try {
    await access(process.env.ENSEMBLE_SUITE_PIPE_HOLDER_RELEASE_PATH);
    break;
  } catch {
    await delay(10);
  }
}

process.stdout.write("SUITE_RUNNER_TRAILING_MARKER\n");
