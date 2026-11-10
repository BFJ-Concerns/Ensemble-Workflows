import { confirmClaudeStrip, deriveClaudeStrip, CLAUDE_TOOL_CLASSIFICATION } from "./claude-tool-surface.js";
import { CapabilityStripUnsupportedError, EngineShutdownError } from "./errors.js";

import type { StrippableCapability } from "./capability-stripping.js";
import type { ClaudeToolSurfaceProbe } from "./claude-control-plane.js";
import type { ClaudeToolClassification, PreparedClaudeStrip } from "./claude-tool-surface.js";

/** What one stripped Claude dispatch needs prepared: the inputs that can change the tool surface its worker sees. */
export interface ClaudeStripRequest {
  strip: readonly StrippableCapability[];
  /** The worker's resolved placement. Project settings and MCP configuration there shape the surface. */
  cwd: string;
  /** The worker's model pin, which the probes also carry. */
  model?: string;
}

export interface ClaudeStripPreparerOptions {
  /** The control plane's probe; omitted, every preparation refuses, as no surface can be read. */
  probe: ClaudeToolSurfaceProbe | undefined;
  /** Bound on one whole preparation, both probes included. */
  timeoutMs?: number;
  /** Injectable so a witness can stand a known tool in for one nobody has classified. */
  classification?: ClaudeToolClassification;
}

/**
 * Decided: 90 seconds for both probes. Each probe is one session launch, a
 * few seconds normally, and the dispatch's own registration window is 30
 * seconds.
 */
const DEFAULT_TIMEOUT_MS = 90_000;

interface Entry {
  promise: Promise<PreparedClaudeStrip>;
  /** Set once the preparation settles successfully. */
  cliVersion: string | null;
}

/**
 * The one route from Claude's live tool surface to both the deny rules a
 * stripped worker is dispatched under and its record's enforcement
 * detail. The Claude adapter owns one for the run.
 *
 * - Timing: only a stripped dispatch prepares, after admission and once
 *   its placement is open, so an unstripped worker never pays for a probe.
 *   Retries reuse their call's preparation. A held session prepares at its
 *   creating turn. A chain step onto Claude prepares for its own target.
 * - Sharing: one preparation for each working directory, model and strip
 *   set, memoised as a promise, so concurrent dispatches share one in
 *   flight. No shared table is mutated.
 * - Failure: whatever stops the surface being established refuses the
 *   worker before it spawns (`CapabilityStripUnsupportedError`): no probe,
 *   a probe failure, an unreadable capture, a failed confirmation, or the
 *   time bound. A failed preparation is forgotten at once, so the next
 *   dispatch probes again rather than inheriting the refusal.
 * - Version: a prepared entry holds for the run while the served version
 *   stays the same. When a worker reports serving another version (its
 *   transcript's `version`), `retainVersion` drops every entry prepared
 *   for a different one, so later dispatches prepare against the version
 *   that is serving.
 * - Cancellation: `close()` aborts probes in flight, and their
 *   preparations reject as the engine's shutdown.
 */
export class ClaudeStripPreparer {
  #probe: ClaudeToolSurfaceProbe | undefined;
  #timeoutMs: number;
  #classification: ClaudeToolClassification;
  #entries = new Map<string, Entry>();
  #abort = new AbortController();

  constructor(options: ClaudeStripPreparerOptions) {
    this.#probe = options.probe;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#classification = options.classification ?? CLAUDE_TOOL_CLASSIFICATION;
  }

  prepare(request: ClaudeStripRequest): Promise<PreparedClaudeStrip> {
    if (this.#abort.signal.aborted) {
      return Promise.reject(new EngineShutdownError("claude"));
    }
    const strip = [...new Set(request.strip)].sort();
    const key = JSON.stringify([request.cwd, request.model ?? null, strip]);
    const existing = this.#entries.get(key);
    if (existing !== undefined) return existing.promise;
    const entry: Entry = { promise: this.#prepare({ ...request, strip }), cliVersion: null };
    this.#entries.set(key, entry);
    entry.promise.then(
      (prepared) => { entry.cliVersion = prepared.cliVersion; },
      () => { if (this.#entries.get(key) === entry) this.#entries.delete(key); }
    );
    return entry.promise;
  }

  /** Forget every settled preparation made for a served version other than `cliVersion`. */
  retainVersion(cliVersion: string): void {
    for (const [key, entry] of this.#entries) {
      if (entry.cliVersion !== null && entry.cliVersion !== cliVersion) this.#entries.delete(key);
    }
  }

  close(): void {
    this.#abort.abort();
    this.#entries.clear();
  }

  async #prepare(request: ClaudeStripRequest): Promise<PreparedClaudeStrip> {
    const probe = this.#probe;
    const capability = request.strip.join(", ");
    if (probe === undefined) {
      throw new CapabilityStripUnsupportedError("claude", capability, "this Claude control plane cannot probe the live tool surface");
    }
    // The timer and the run's shutdown abort the same probe, so a probe
    // still in flight is torn down whichever ends first.
    const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(this.#timeoutMs)]);
    const base = { cwd: request.cwd, ...(request.model !== undefined ? { model: request.model } : {}), signal };
    try {
      const inventory = await probe({ ...base, permissionDenyRules: [] });
      const derived = deriveClaudeStrip(inventory, request.strip, this.#classification);
      const confirmation = await probe({ ...base, permissionDenyRules: derived.permissionDenyRules });
      return confirmClaudeStrip(derived, confirmation);
    } catch (error) {
      if (this.#abort.signal.aborted) throw new EngineShutdownError("claude");
      if (error instanceof CapabilityStripUnsupportedError) throw error;
      const reason = signal.aborted
        ? `the live tool surface was not established within ${this.#timeoutMs}ms`
        : `the live tool surface could not be established: ${error instanceof Error ? error.message : String(error)}`;
      throw new CapabilityStripUnsupportedError("claude", capability, reason);
    }
  }
}
