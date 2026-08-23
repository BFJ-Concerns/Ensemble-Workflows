// Per-engine default concurrency caps. A worker's cost is remote inference,
// not local computation, so these are bounds on how many turns a provider is
// asked to serve at once — not a function of the host machine. A cap
// derived from the CPU count would limit local builds rather than remote
// turns; the machine's own load is governed elsewhere and by better means.
//
// Codex and Claude share one default.

export function defaultCodexConcurrency(): number {
  return 12;
}

export function defaultClaudeConcurrency(): number {
  return 12;
}

export function defaultOpenCodeConcurrency(): number {
  return 2;
}
