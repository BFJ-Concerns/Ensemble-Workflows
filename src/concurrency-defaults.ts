import { cpus } from "node:os";

export function defaultCodexConcurrency(): number {
  return Math.max(1, Math.min(16, cpus().length - 2));
}

export function defaultClaudeConcurrency(): number {
  return 8;
}

export function defaultOpenCodeConcurrency(): number {
  return 2;
}
