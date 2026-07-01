import { homedir } from "node:os";
import path from "node:path";

export const RUN_RECORD_ENV = "ENSEMBLE_RUN_RECORD";
export const RUN_RECORD_DIR_ENV = "ENSEMBLE_RUN_RECORD_DIR";

export function resolveRunRecordDir(env: NodeJS.ProcessEnv): string | null {
  if (isOff(env[RUN_RECORD_ENV])) {
    return null;
  }
  const explicit = env[RUN_RECORD_DIR_ENV];
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const dataHome = env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME.length > 0 ? env.XDG_DATA_HOME : path.join(homedir(), ".local", "share");
  return path.join(dataHome, "ensemble");
}

function isOff(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  // Trimmed to parse like ENSEMBLE_STATUS: a stray shell space must not silently re-enable recording.
  return ["off", "0", "false", "no"].includes(value.trim().toLowerCase());
}
