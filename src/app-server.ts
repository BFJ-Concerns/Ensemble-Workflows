import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import {
  AppServerBackpressureError,
  AppServerExitedError,
  AppServerFirstOutputTimeoutError,
  AppServerOverloadedError,
  AppServerRequestError,
  AppServerRetryPromiseBrokenError,
  AppServerSystemError,
  AppServerStartupTimeoutError,
  attachAppServerDiagnostic,
  attachPartialWorkerText,
  attachWorkerExitStatus,
  CodexSchemaSubsetUnsupportedError,
  TurnTimeoutError
} from "./errors.js";
import type { WorkerExitStatus } from "./errors.js";

import type {
  JsonObject,
  RuntimeEvent,
  RuntimeTransport,
  ThreadStartOptions,
  TokenUsageEvent,
  TurnResult,
  TurnStartOptions
} from "./types.js";
import { tokenUsageEventFromParams } from "./budget.js";

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface RpcErrorPayload {
  code: number | string | undefined;
  message: string | undefined;
  data?: unknown;
}

interface RpcMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface TurnState {
  threadId: string;
  /** Learned from turn/start or the first turn-correlated inbound frame; ephemeral threads run one turn. */
  turnId: string | undefined;
  startedAt: number;
  firstDeltaAt: number | null;
  /** Whether the supervisor-facing first-output callback has fired for this turn. */
  firstOutputSeen: boolean;
  onFirstOutput: (() => void) | undefined;
  completedAt: number | null;
  deltaText: string;
  itemText?: string;
  items: Map<string, number>;
  tokenUsageEvents: TokenUsageEvent[];
  consecutiveRetryPromises: number;
  retryPromiseSilenceDeadline: NodeJS.Timeout | undefined;
  systemErrorDiagnosticGraceDeadline: NodeJS.Timeout | undefined;
  /** The honest terminal rendering if Codex never sends its separate error notification. */
  systemErrorDiagnosticFallback: Error | undefined;
  firstOutputDeadline: NodeJS.Timeout | undefined;
  promise: Promise<TurnResult>;
  resolve: (result: TurnResult) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout | undefined;
}

const MAX_CONSECUTIVE_APP_SERVER_RETRY_PROMISES = 5;
/**
 * Bounds total silence after an unfulfilled in-band retry promise. A genuine
 * server-side retry backs off in seconds, so minutes of nothing at all means
 * the promise is broken; 15 minutes prefers never killing a theoretically
 * alive turn over freeing its slot promptly.
 */
const DEFAULT_RETRY_PROMISE_SILENCE_TIMEOUT_MS = 15 * 60 * 1_000;
/**
 * A started turn that remains completely silent costs a worker slot without
 * producing evidence. Healthy long turns disarm this on their first output-bearing frame.
 */
const DEFAULT_FIRST_OUTPUT_TIMEOUT_MS = 15 * 60 * 1_000;
/**
 * How long a stdout EOF waits for the process's own exit event before
 * terminalising as "stdout closed". Long enough for a reaped death's status
 * to arrive (same-tick in practice), short enough that a live server that
 * closed its pipe still fails promptly.
 */
const STDOUT_CLOSE_EXIT_GRACE_MS = 50;
/**
 * Codex can announce terminal systemError immediately before its separate
 * diagnostic-bearing error notification. Retain the turn just long enough to
 * preserve that diagnostic, while still rejecting an abandoned status promptly.
 */
const SYSTEM_ERROR_DIAGNOSTIC_GRACE_MS = 50;
/**
 * Upper bound for one newline-delimited app-server frame before parsing. The
 * payload-depth cap protects the parsed shape; this bound protects the
 * upstream assembly that would otherwise retain an arbitrarily large line.
 */
const MAX_APP_SERVER_STDOUT_LINE_BYTES = 1024 * 1024;
const DECODE_FAILURE_BUFFER_PREFIX_BYTES = 512;
const DECODE_FAILURE_LINE_PREFIX_CHARACTERS = 512;
const SKILL_DISCOVERY_STABILITY_INTERVAL_MS = 1_000;
const MAX_SKILL_DISCOVERY_ATTEMPTS = 10;
/**
 * Aggregate wall-clock bound on one discovery: the sampling loop's own
 * attempt cap bounds the call count, and this bounds the elapsed time even
 * when individual calls run long — discovery is paid inside a held
 * admission slot, so an unbounded stabilisation wait would hold that slot
 * hostage.
 */
const SKILL_DISCOVERY_DEADLINE_MS = 30_000;

interface ThreadTranscript {
  events: JsonObject[];
  resolvedModel: string | null;
  resolvedEffort: string | null;
}

export interface CodexAppServerTransportOptions {
  cwd: string;
  codexBin: string;
  /** Machine-declared variables injected over the inherited environment. */
  workerEnv?: Record<string, string>;
  requestTimeoutMs: number;
  retryPromiseSilenceTimeoutMs?: number;
  firstOutputTimeoutMs?: number;
  startupHandshakeTimeoutMs?: number;
  clientName: string;
  clientVersion: string;
  onEvent?: (event: RuntimeEvent) => void;
  /** Test seam for discovery's deliberately time-spaced cold-start sampling. */
  skillDiscoveryStabilityIntervalMs?: number;
  /** Aggregate wall-clock bound on one discovery's whole sampling loop. */
  skillDiscoveryDeadlineMs?: number;
}

/**
 * Defers app-server startup to the first worker that names Codex, so a run
 * pays the startup cost — and the requirement that the `codex` CLI exists —
 * only for the engines its script actually uses. Startup is single-flight
 * and memoised, failures included: concurrent first users share one
 * handshake, and a failed spawn rejects every later use with the original
 * cause instead of respawning a binary that is not there.
 */
export class LazyCodexAppServerTransport implements RuntimeTransport {
  readonly cwd: string;

  #options: CodexAppServerTransportOptions;
  #transportPromise: Promise<CodexAppServerTransport> | undefined;
  #closed = false;

  constructor(options: CodexAppServerTransportOptions) {
    this.cwd = options.cwd;
    this.#options = options;
  }

  async openThread(options: ThreadStartOptions): Promise<string> {
    const transport = await this.#transport();
    return transport.openThread(options);
  }

  async listSkills(cwd?: string): Promise<readonly string[]> {
    const transport = await this.#transport();
    return transport.listSkills(cwd);
  }

  async runTurn(threadId: string, prompt: string, options: TurnStartOptions): Promise<TurnResult> {
    const transport = await this.#transport();
    return transport.runTurn(threadId, prompt, options);
  }

  async close(): Promise<void> {
    // Latch: teardown is terminal. A straggler reaching the substrate after
    // close must fail, not spawn a fresh app-server nothing will ever stop.
    this.#closed = true;
    if (this.#transportPromise === undefined) {
      return;
    }

    let transport: CodexAppServerTransport;
    try {
      transport = await this.#transportPromise;
    } catch {
      // The startup failure already rejected the worker that triggered it;
      // closing a substrate that never came up has nothing left to do.
      return;
    }
    await transport.close();
  }

  #transport(): Promise<CodexAppServerTransport> {
    if (this.#closed) {
      return Promise.reject(new AppServerExitedError("codex app-server transport is closed"));
    }
    this.#transportPromise ??= CodexAppServerTransport.start(this.#options);
    return this.#transportPromise;
  }
}

export class CodexAppServerTransport implements RuntimeTransport {
  readonly cwd: string;

  #process: ChildProcessWithoutNullStreams;
  #requestTimeoutMs: number;
  #retryPromiseSilenceTimeoutMs: number;
  #firstOutputTimeoutMs: number;
  #startupHandshakeTimeoutMs: number;
  #skillDiscoveryStabilityIntervalMs: number;
  #skillDiscoveryDeadlineMs: number;
  #nextId = 0;
  #pending = new Map<number, PendingRequest>();
  #turns = new Map<string, TurnState>();
  #transcripts = new Map<string, ThreadTranscript>();
  #stderrTail: string[] = [];
  #exitStatus: WorkerExitStatus | null = null;
  #hasExited = false;
  #onEvent: ((event: RuntimeEvent) => void) | undefined;

  private constructor(options: CodexAppServerTransportOptions) {
    this.cwd = options.cwd;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#retryPromiseSilenceTimeoutMs =
      options.retryPromiseSilenceTimeoutMs ?? DEFAULT_RETRY_PROMISE_SILENCE_TIMEOUT_MS;
    this.#firstOutputTimeoutMs = options.firstOutputTimeoutMs ?? DEFAULT_FIRST_OUTPUT_TIMEOUT_MS;
    this.#startupHandshakeTimeoutMs = options.startupHandshakeTimeoutMs ?? 120_000;
    this.#skillDiscoveryStabilityIntervalMs =
      options.skillDiscoveryStabilityIntervalMs ?? SKILL_DISCOVERY_STABILITY_INTERVAL_MS;
    this.#skillDiscoveryDeadlineMs = options.skillDiscoveryDeadlineMs ?? SKILL_DISCOVERY_DEADLINE_MS;
    this.#onEvent = options.onEvent;
    this.#process = spawn(options.codexBin, ["app-server"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // Declared variables sit above inherited ones; everything undeclared
      // still inherits, so a configured parent keeps working unchanged.
      env: { ...process.env, ...options.workerEnv }
    });

    this.#wireReader();
    this.#wireStderr();
    this.#process.once("exit", (code, signal) => {
      // The observed exit is evidence: retained so every turn this death
      // terminalises carries how the process died, not only that it did.
      this.#exitStatus = { exitCode: code, signal };
      this.#failAll(new AppServerExitedError(`codex app-server exited with code ${code ?? "null"} signal ${signal ?? "null"}`));
    });
    // Without a listener, a spawn failure (codex missing, bad codexBin) surfaces
    // as an uncaught 'error' event and kills the whole process instead of
    // rejecting the startup handshake.
    this.#process.once("error", (error) => {
      this.#failAll(new AppServerExitedError(`codex app-server process error: ${error.message}`));
    });
  }

  static async start(options: CodexAppServerTransportOptions): Promise<CodexAppServerTransport> {
    const transport = new CodexAppServerTransport(options);
    try {
      await transport.#handshake(options.clientName, options.clientVersion);
    } catch (error) {
      await transport.close();
      throw error;
    }
    return transport;
  }

  async openThread(options: ThreadStartOptions): Promise<string> {
    const requestParams = {
      cwd: options.cwd ?? this.cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: true,
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.threadConfig !== undefined ? { config: options.threadConfig } : {})
    };
    const result = await this.#request("thread/start", requestParams);

    const resultObject = asJsonObject(result);
    const directThreadId = resultObject?.threadId;
    const nestedThread = asJsonObject(resultObject?.thread);
    const nestedThreadId = nestedThread?.id;

    const threadId = typeof directThreadId === "string" ? directThreadId : typeof nestedThreadId === "string" ? nestedThreadId : null;
    if (threadId !== null) {
      const resolvedModel = resultObject?.model;
      // The v2 ThreadStartResponse reports the effective model and nullable
      // reasoning effort. Retain them until this ephemeral thread's turn finishes
      // so an unpinned call can disclose what it actually used.
      const resolvedEffort = resultObject?.reasoningEffort;
      this.#transcripts.set(threadId, {
        resolvedModel: typeof resolvedModel === "string" && resolvedModel.length > 0 ? resolvedModel : null,
        resolvedEffort: typeof resolvedEffort === "string" && resolvedEffort.length > 0 ? resolvedEffort : null,
        events: [
          {
            direction: "client",
            method: "thread/start",
            params: requestParams,
            recordedAt: new Date().toISOString()
          },
          {
            direction: "server",
            method: "thread/start/result",
            result,
            recordedAt: new Date().toISOString()
          }
        ]
      });
      return threadId;
    }
    throw new AppServerRequestError("thread/start", {
      code: undefined,
      message: "response did not contain result.thread.id or result.threadId",
      data: result
    });
  }

  async listSkills(cwd = this.cwd): Promise<readonly string[]> {
    const startedAt = Date.now();
    let previousNames: readonly string[] | undefined;
    let observedExpansion = false;
    for (let attempt = 1; attempt <= MAX_SKILL_DISCOVERY_ATTEMPTS; attempt += 1) {
      const names = await this.#listSkillsOnce(cwd);
      if (observedExpansion && previousNames !== undefined && sameStrings(previousNames, names)) {
        return names;
      }
      if (previousNames !== undefined) {
        if (strictlyContainsAll(names, previousNames)) {
          observedExpansion = true;
        } else if (!sameStrings(previousNames, names)) {
          // A shrink or churn after growth would let the smaller set repeat
          // and qualify, leaving the vanished skill out of the deny overlay;
          // only a set still standing since its expansion may qualify.
          observedExpansion = false;
        }
      }
      previousNames = names;
      if (Date.now() - startedAt >= this.#skillDiscoveryDeadlineMs) {
        // The attempt cap bounds calls; this bounds elapsed time when the
        // calls themselves run long. Failing loud keeps the strip contract:
        // a deadline can never dispatch a partial deny overlay.
        throw new AppServerRequestError("skills/list", {
          code: "discovery_deadline",
          message: `skill discovery exceeded its ${this.#skillDiscoveryDeadlineMs}ms aggregate bound before stabilising`
        });
      }
      if (attempt < MAX_SKILL_DISCOVERY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, this.#skillDiscoveryStabilityIntervalMs));
      }
    }
    throw new AppServerRequestError("skills/list", {
      code: "unstable_discovery",
      message:
        `skill discovery did not observe a growing set followed by stability after ${MAX_SKILL_DISCOVERY_ATTEMPTS} calls`
    });
  }

  async #listSkillsOnce(cwd: string): Promise<readonly string[]> {
    const result = asJsonObject(await this.#request("skills/list", { cwds: [cwd], forceReload: true }));
    const entries = result?.data;
    if (!Array.isArray(entries)) {
      throw new AppServerRequestError("skills/list", {
        code: "invalid_response",
        message: "response omitted the discovered skill entries"
      });
    }

    const names = new Set<string>();
    for (const entry of entries) {
      const entryObject = asJsonObject(entry);
      const errors = entryObject?.errors;
      const skills = entryObject?.skills;
      if (!Array.isArray(errors) || errors.length > 0 || !Array.isArray(skills)) {
        throw new AppServerRequestError("skills/list", {
          code: "incomplete_discovery",
          message: "could not establish the complete discovered skill set"
        });
      }
      for (const skill of skills) {
        const name = asJsonObject(skill)?.name;
        if (typeof name !== "string" || name.length === 0) {
          throw new AppServerRequestError("skills/list", {
            code: "invalid_response",
            message: "response included a skill without a name"
          });
        }
        names.add(name);
      }
    }
    return [...names].sort();
  }

  async runTurn(threadId: string, prompt: string, options: TurnStartOptions): Promise<TurnResult> {
    const state = this.#createTurnState(threadId, options.timeoutMs, options.onFirstOutput);
    this.#turns.set(threadId, state);
    // The turn can terminalise while turn/start is still awaiting its
    // response (timeout, close, process death, an early error frame). This
    // pre-attached handler keeps that rejection from going unhandled while
    // nothing awaits the promise yet; later awaits still observe it.
    state.promise.catch(() => undefined);

    try {
      const params: JsonObject = {
        threadId,
        input: [{ type: "text", text: prompt }],
        sandboxPolicy: { type: "dangerFullAccess" }
      };
      if (options.schema !== undefined) {
        params.outputSchema = options.schema;
      }
      if (options.model !== undefined) {
        params.model = options.model;
      }
      if (options.effort !== undefined) {
        params.effort = options.effort;
        const transcript = this.#transcripts.get(threadId);
        if (transcript !== undefined) {
          transcript.resolvedEffort = options.effort;
        }
      }

      this.#appendTranscript(threadId, {
        direction: "client",
        method: "turn/start",
        params,
        recordedAt: new Date().toISOString()
      });
      const result = asJsonObject(await this.#request("turn/start", params));
      const startedTurn = asJsonObject(result?.turn);
      if (typeof startedTurn?.id === "string") {
        state.turnId = startedTurn.id;
      }
      return await state.promise;
    } catch (error) {
      // A turn/start request failure is a terminal path like any other.
      if (this.#turns.get(threadId) === state) {
        this.#rejectTurn(threadId, state, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      // The turn already terminalised through #rejectTurn (or completed)
      // while the request was in flight: the state settlement is the one
      // carrying the turn's real cause and partial text, so surface it in
      // preference to the bare request error.
      return await state.promise;
    }
  }

  /** Number of thread transcripts currently held in memory. Observability for tests. */
  openTranscripts(): number {
    return this.#transcripts.size;
  }

  async close(): Promise<void> {
    if (this.#hasExited) {
      return;
    }

    this.#hasExited = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new AppServerExitedError("codex app-server closed"));
    }
    this.#pending.clear();
    // One error instance per turn: the partial-text carrier is per-worker
    // state, so a shared instance would smear one turn's text across all.
    for (const [threadId, turn] of [...this.#turns]) {
      this.#rejectTurn(threadId, turn, new AppServerExitedError("codex app-server closed"));
    }
    this.#turns.clear();
    this.#transcripts.clear();

    this.#process.stdin.end();
    this.#process.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.#process.kill("SIGKILL");
        resolve();
      }, 5_000);
      this.#process.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  async #handshake(clientName: string, clientVersion: string): Promise<void> {
    try {
      await this.#request(
        "initialize",
        {
          clientInfo: {
            name: clientName,
            version: clientVersion
          }
        },
        this.#startupHandshakeTimeoutMs
      );
    } catch (error) {
      if (error instanceof TurnTimeoutError) {
        throw new AppServerStartupTimeoutError(this.#startupHandshakeTimeoutMs);
      }
      throw error;
    }
    this.#sendNotification("initialized", {});
  }

  #request(method: string, params: JsonObject, timeoutMs = this.#requestTimeoutMs): Promise<unknown> {
    const id = this.#nextId + 1;
    this.#nextId = id;

    const payload = JSON.stringify({ id, method, params });

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new TurnTimeoutError(`${method} request ${id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.#pending.set(id, { method, resolve, reject, timeout });
      this.#writeLine(payload).catch((error: unknown) => {
        this.#pending.delete(id);
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  #sendNotification(method: string, params: JsonObject): void {
    void this.#writeLine(JSON.stringify({ method, params }));
  }

  /** Sends a request through stdin without retaining or awaiting its response. */
  async #sendUnacknowledgedRequest(method: string, params: JsonObject): Promise<void> {
    const id = this.#nextId + 1;
    this.#nextId = id;
    await this.#writeLine(JSON.stringify({ id, method, params }));
  }

  async #writeLine(line: string): Promise<void> {
    if (this.#hasExited) {
      throw new AppServerExitedError("codex app-server is not running");
    }
    const framedLine = line.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    await new Promise<void>((resolve, reject) => {
      this.#process.stdin.write(`${framedLine}\n`, (error) => {
        if (error !== null && error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  #wireReader(): void {
    let chunks: Buffer[] = [];
    let byteLength = 0;
    let prefix = Buffer.alloc(0);
    let discardingOversizedLine = false;
    let oversizedLineByteLength = 0;

    const resetLine = (): void => {
      chunks = [];
      byteLength = 0;
      prefix = Buffer.alloc(0);
      discardingOversizedLine = false;
      oversizedLineByteLength = 0;
    };
    const retain = (chunk: Buffer): void => {
      if (chunk.length === 0) {
        return;
      }
      chunks.push(chunk);
      byteLength += chunk.length;
      if (prefix.length < DECODE_FAILURE_BUFFER_PREFIX_BYTES) {
        prefix = Buffer.concat([prefix, chunk.subarray(0, DECODE_FAILURE_BUFFER_PREFIX_BYTES - prefix.length)]);
      }
    };
    const reportOversizedLine = (): void => {
      this.#reportDecodeFailure(oversizedLineByteLength, prefix.toString("utf8"));
    };
    const handleRetainedLine = (): void => {
      // Match readline's CRLF treatment while applying the byte limit before
      // decoding or JSON parsing.
      const line = Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
      resetLine();
      this.#handleLine(line);
    };

    this.#process.stdout.on("data", (chunk: Buffer) => {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline === -1 ? chunk.length : newline;
        const segment = chunk.subarray(offset, end);

        if (discardingOversizedLine) {
          oversizedLineByteLength += segment.length;
          if (newline !== -1) {
            reportOversizedLine();
            resetLine();
          }
        } else if (byteLength + segment.length <= MAX_APP_SERVER_STDOUT_LINE_BYTES) {
          retain(segment);
          if (newline !== -1) {
            handleRetainedLine();
          }
        } else {
          const retainedBytes = Math.max(0, MAX_APP_SERVER_STDOUT_LINE_BYTES - byteLength);
          retain(segment.subarray(0, retainedBytes));
          // Discard through the newline so one hostile frame cannot retain
          // more memory or poison the following valid frame. Count the
          // discarded bytes as we go: decode diagnostics retain the
          // incumbent field's meaning even for a bounded frame.
          discardingOversizedLine = true;
          oversizedLineByteLength = byteLength + (segment.length - retainedBytes);
          if (newline !== -1) {
            reportOversizedLine();
            resetLine();
          }
        }
        offset = newline === -1 ? chunk.length : newline + 1;
      }
    });
    this.#process.stdout.once("end", () => {
      // readline flushes a final unterminated line on EOF. Keep that
      // diagnostic/decoding behaviour at this replacement boundary.
      if (discardingOversizedLine) {
        reportOversizedLine();
        resetLine();
      } else if (byteLength > 0) {
        handleRetainedLine();
      }
      if (this.#hasExited) {
        return;
      }
      // stdout EOF usually means the process died, and the death's `exit`
      // event carries the evidence (#exitStatus) the terminal errors must
      // ride. EOF can be observed before the exit status is reaped, so give
      // the exit event a short grace to win that race; a server that closed
      // its pipe while still alive fails through the timer as before.
      const grace = setTimeout(() => {
        this.#failAll(new AppServerExitedError("codex app-server stdout closed"));
      }, STDOUT_CLOSE_EXIT_GRACE_MS);
      grace.unref();
      this.#process.once("exit", () => {
        clearTimeout(grace);
      });
    });
  }

  #wireStderr(): void {
    const reader = createInterface({ input: this.#process.stderr });
    reader.on("line", (line) => {
      this.#stderrTail.push(line);
      if (this.#stderrTail.length > 50) {
        this.#stderrTail.shift();
      }
    });
  }

  #handleLine(line: string): void {
    if (line.trim().length === 0) {
      return;
    }

    const parsed = parseRpcMessage(line);
    if (parsed === null) {
      // Failures carry their evidence: an inbound frame the harness cannot
      // decode must be visible as a decode failure, not resurface later as
      // an unattributable turn timeout. The line is retained bounded — the
      // point is attribution, not archiving an arbitrarily large payload.
      this.#reportDecodeFailure(Buffer.byteLength(line, "utf8"), line.slice(0, DECODE_FAILURE_LINE_PREFIX_CHARACTERS));
      return;
    }

    const id = typeof parsed.id === "number" ? parsed.id : null;
    const method = typeof parsed.method === "string" ? parsed.method : null;

    if (id !== null && method !== null) {
      this.#onEvent?.({
        method: "server/request/denied",
        params: { requestId: id, requestMethod: method },
        receivedAt: Date.now()
      });
      // A turn-scoped server request is the server speaking as surely as a
      // notification: it must disarm the silence clock
      // even though it is answered here and never reaches
      // #handleNotification, where disarming otherwise lives.
      const requestParams = asJsonObject(parsed.params);
      if (requestParams !== null) {
        const turn = this.#turnCorrelatedBy(requestParams);
        if (turn !== undefined) {
          this.#disarmRetryPromiseSilenceDeadline(turn);
          this.#disarmFirstOutputDeadline(turn);
          this.#noteTurnFirstOutput(turn);
        }
      }
      this.#sendApprovalDenial(id);
      return;
    }

    if (id !== null && ("result" in parsed || "error" in parsed)) {
      this.#handleResponse(id, parsed);
      return;
    }

    if (method !== null) {
      this.#handleNotification(method, asJsonObject(parsed.params) ?? {});
    }
  }

  #reportDecodeFailure(byteLength: number, linePrefix: string): void {
    this.#onEvent?.({
      method: "transport/decodeFailed",
      params: { byteLength, linePrefix },
      receivedAt: Date.now()
    });
  }

  #handleResponse(id: number, message: RpcMessage): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      return;
    }

    this.#pending.delete(id);
    clearTimeout(pending.timeout);

    if (message.error !== undefined) {
      pending.reject(appServerErrorFromPayload(pending.method, asRpcError(message.error)));
      return;
    }

    pending.resolve(message.result);
  }

  #handleNotification(method: string, params: JsonObject): void {
    this.#onEvent?.({ method, params, receivedAt: Date.now() });

    const threadId = params.threadId;
    if (typeof threadId !== "string") {
      return;
    }

    this.#appendTranscript(threadId, {
      direction: "server",
      method,
      params,
      recordedAt: new Date().toISOString()
    });

    const turn = this.#turns.get(threadId);
    if (turn === undefined) {
      return;
    }

    // Correlation is deliberately narrow: it decides only whether this frame
    // speaks for the live turn's silence clock. Every other behaviour below
    // handles the frame as before — a gate ahead of all handlers would
    // silently drop text, usage, and completion on any identity mismatch.
    const speaksForTurn = this.#correlatesWithTurn(turn, params);
    if (speaksForTurn) {
      this.#disarmRetryPromiseSilenceDeadline(turn);
      // `turn/started` only acknowledges acceptance. Every later correlated
      // server notification is output from the live turn — streamed text,
      // tool work, usage, routing, status, or a terminal item — and proves
      // it is no longer silently stuck before producing anything.
      if (isOutputBearingTurnFrame(method)) {
        this.#disarmFirstOutputDeadline(turn);
        this.#noteTurnFirstOutput(turn);
      }
    }

    const now = Date.now();
    if (isTurnProgressNotification(method)) {
      turn.consecutiveRetryPromises = 0;
    }

    if (method === "turn/started") {
      return;
    }

    if (method === "model/rerouted") {
      const toModel = params.toModel;
      const transcript = this.#transcripts.get(threadId);
      if (transcript !== undefined && typeof toModel === "string" && toModel.length > 0) {
        transcript.resolvedModel = toModel;
      }
      return;
    }

    if (method === "item/started") {
      const item = asJsonObject(params.item);
      const itemType = itemTypeFromItem(item);
      turn.items.set(itemType, (turn.items.get(itemType) ?? 0) + 1);
      return;
    }

    if (method === "item/agentMessage/delta") {
      if (turn.firstDeltaAt === null) {
        turn.firstDeltaAt = now;
      }
      if (typeof params.delta === "string") {
        turn.deltaText += params.delta;
      }
      return;
    }

    if (method === "item/completed") {
      const item = asJsonObject(params.item);
      const itemType = itemTypeFromItem(item);
      if (itemType === "agentMessage" && typeof item?.text === "string") {
        turn.itemText = item.text;
      }
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      const event = tokenUsageEventFromParams(params);
      if (event !== null) {
        turn.tokenUsageEvents.push(event);
      }
      return;
    }

    if (method === "thread/status/changed") {
      const status = asJsonObject(params.status);
      if (status?.type === "systemError") {
        this.#armSystemErrorDiagnosticGrace(threadId, turn, method, params);
      }
      return;
    }

    if (method === "turn/completed") {
      turn.completedAt = now;
      // A systemError has already made this turn terminal. Codex normally
      // follows it with an error notification carrying the useful diagnostic,
      // but a completion frame cannot turn that failed turn into success.
      if (turn.systemErrorDiagnosticGraceDeadline !== undefined) {
        this.#rejectTurn(threadId, turn, turn.systemErrorDiagnosticFallback!);
        return;
      }
      this.#completeTurn(threadId, turn);
      return;
    }

    if (method === "error") {
      // systemError is terminal, but Codex 0.151.0 puts its useful diagnostic
      // in this following notification. It is not a retry promise in this
      // state: the terminal status has already settled the turn's direction.
      if (turn.systemErrorDiagnosticGraceDeadline !== undefined) {
        void this.#rejectTurn(threadId, turn, appServerErrorFromNotification(params));
        return;
      }
      if (params.willRetry === true) {
        turn.consecutiveRetryPromises += 1;
        if (turn.consecutiveRetryPromises > MAX_CONSECUTIVE_APP_SERVER_RETRY_PROMISES) {
          const diagnostic = errorPayloadFromNotification(params);
          void this.#rejectTurn(
            threadId,
            turn,
            attachAppServerDiagnostic(
              new AppServerRetryPromiseBrokenError("turn notification", diagnostic),
              appServerDiagnosticFromPayload(diagnostic)
            )
          );
          return;
        }
        // The promise is now the most recent frame on the turn — the only
        // state in which the silence clock runs. The disarm above cleared any
        // earlier deadline, so this cannot stack timers. Correlation gates
        // arming exactly as it gates disarming: the clock is the one
        // behaviour turn identity decides.
        if (speaksForTurn) {
          this.#armRetryPromiseSilenceDeadline(threadId, turn, params);
        }
        return;
      }
      void this.#rejectTurn(threadId, turn, appServerErrorFromNotification(params));
    }
  }

  /**
   * Whether an inbound frame speaks for this turn's silence clock. Thread
   * identity has already matched; a frame naming a different turn (a
   * straggler from an abandoned turn on a recycled thread) must not disarm
   * the live turn's deadline. Frames carrying no turn identity are
   * thread-scoped and count: ephemeral threads run one turn, so the thread
   * speaking is the turn's server speaking.
   */
  #correlatesWithTurn(turn: TurnState, params: JsonObject): boolean {
    const turnId = turnIdFromParams(params);
    if (turnId === undefined) {
      return true;
    }
    if (turn.turnId === undefined) {
      turn.turnId = turnId;
      return true;
    }
    return turn.turnId === turnId;
  }

  /** Resolves an inbound frame's params to the live turn they speak for, if any. */
  #turnCorrelatedBy(params: JsonObject): TurnState | undefined {
    const threadId = params.threadId;
    if (typeof threadId !== "string") {
      return undefined;
    }
    const turn = this.#turns.get(threadId);
    if (turn === undefined || !this.#correlatesWithTurn(turn, params)) {
      return undefined;
    }
    return turn;
  }

  #disarmRetryPromiseSilenceDeadline(turn: TurnState): void {
    if (turn.retryPromiseSilenceDeadline !== undefined) {
      clearTimeout(turn.retryPromiseSilenceDeadline);
      turn.retryPromiseSilenceDeadline = undefined;
    }
  }

  #disarmSystemErrorDiagnosticGrace(turn: TurnState): void {
    if (turn.systemErrorDiagnosticGraceDeadline !== undefined) {
      clearTimeout(turn.systemErrorDiagnosticGraceDeadline);
      turn.systemErrorDiagnosticGraceDeadline = undefined;
    }
  }

  #armSystemErrorDiagnosticGrace(threadId: string, turn: TurnState, method: string, statusParams: JsonObject): void {
    if (turn.systemErrorDiagnosticGraceDeadline !== undefined) {
      return;
    }
    // The status envelope has no diagnostic fields in the installed protocol.
    // Keep its fallback ready for either grace expiry or a misleading
    // completion notification during the grace.
    const diagnostic = {
      code: undefined,
      message: "Codex app-server reported terminal systemError without a diagnostic",
      data: statusParams
    };
    turn.systemErrorDiagnosticFallback = attachAppServerDiagnostic(
      new AppServerSystemError(method, diagnostic),
      appServerDiagnosticFromPayload(diagnostic)
    );
    turn.systemErrorDiagnosticGraceDeadline = setTimeout(() => {
      void this.#rejectTurn(threadId, turn, turn.systemErrorDiagnosticFallback!);
    }, SYSTEM_ERROR_DIAGNOSTIC_GRACE_MS);
  }

  #armRetryPromiseSilenceDeadline(threadId: string, turn: TurnState, promiseParams: JsonObject): void {
    // Capture the promise diagnostic now: expiry must report the retry the
    // server announced and then abandoned, not a generic timeout.
    const diagnostic = errorPayloadFromNotification(promiseParams);
    turn.retryPromiseSilenceDeadline = setTimeout(() => {
      void this.#rejectTurn(
        threadId,
        turn,
        attachAppServerDiagnostic(
          new AppServerRetryPromiseBrokenError(
            `turn notification (silent for ${this.#retryPromiseSilenceTimeoutMs}ms after a promised retry)`,
            diagnostic
          ),
          appServerDiagnosticFromPayload(diagnostic)
        )
      );
    }, this.#retryPromiseSilenceTimeoutMs);
  }

  #disarmFirstOutputDeadline(turn: TurnState): void {
    if (turn.firstOutputDeadline !== undefined) {
      clearTimeout(turn.firstOutputDeadline);
      turn.firstOutputDeadline = undefined;
    }
  }

  /**
   * Fire the supervisor-facing first-output callback, once per turn. Called
   * only from the frame-driven sites (an output-bearing notification, a
   * turn-scoped server request) — never from the completion/rejection
   * teardown, which also disarms the deadline but proves nothing about
   * output. The callback is observability: a throw inside it must never
   * affect the turn.
   */
  #noteTurnFirstOutput(turn: TurnState): void {
    if (turn.firstOutputSeen) {
      return;
    }
    turn.firstOutputSeen = true;
    try {
      turn.onFirstOutput?.();
    } catch {
      // Liveness reporting must never take the turn down with it.
    }
  }

  #armFirstOutputDeadline(threadId: string, turn: TurnState): void {
    turn.firstOutputDeadline = setTimeout(() => {
      void this.#rejectTurn(threadId, turn, new AppServerFirstOutputTimeoutError(this.#firstOutputTimeoutMs));
    }, this.#firstOutputTimeoutMs);
  }

  /**
   * The single terminal path for a failing turn. Every way a turn can end
   * short of completion — error notification, retry-promise bound,
   * systemError, per-turn timeout, transport close, process death — comes
   * through here, so the terminalisation invariant is enforced once: the
   * worker's accumulated text rides the rejection instead of being deleted
   * with the turn state.
   */
  #rejectTurn(threadId: string, turn: TurnState, error: Error): void {
    // itemText first, mirroring #completeTurn: a worker whose text arrived
    // as a completed item rather than deltas has still said it.
    this.#turns.delete(threadId);
    this.#transcripts.delete(threadId);
    clearTimeout(turn.timeout);
    this.#disarmRetryPromiseSilenceDeadline(turn);
    this.#disarmSystemErrorDiagnosticGrace(turn);
    this.#disarmFirstOutputDeadline(turn);
    if (turn.turnId !== undefined) {
      // #writeLine enters stdin.write synchronously, preserving wire order;
      // neither write completion nor the app-server response may delay the
      // original rejection and its replacement attempt.
      void this.#sendUnacknowledgedRequest("turn/interrupt", {
        threadId,
        turnId: turn.turnId
      }).catch(() => {
        // Interruption is best-effort. The original turn failure remains the
        // terminal cause and replacement attempts must still be able to run.
      });
    }
    turn.reject(attachPartialWorkerText(error, turn.itemText ?? turn.deltaText));
  }

  #completeTurn(threadId: string, turn: TurnState): void {
    this.#turns.delete(threadId);
    clearTimeout(turn.timeout);
    this.#disarmRetryPromiseSilenceDeadline(turn);
    this.#disarmSystemErrorDiagnosticGrace(turn);
    this.#disarmFirstOutputDeadline(turn);
    const text = turn.itemText ?? turn.deltaText;
    const transcript = this.#transcripts.get(threadId);
    const result: TurnResult = {
      text,
      ...(transcript?.resolvedModel !== null && transcript?.resolvedModel !== undefined
        ? { resolvedModel: transcript.resolvedModel }
        : {}),
      ...(transcript?.resolvedEffort !== null && transcript?.resolvedEffort !== undefined
        ? { resolvedEffort: transcript.resolvedEffort }
        : {}),
      deltaText: turn.deltaText,
      durationMs: turn.completedAt === null ? null : turn.completedAt - turn.startedAt,
      firstDeltaMs: turn.firstDeltaAt === null ? null : turn.firstDeltaAt - turn.startedAt,
      items: Object.fromEntries(turn.items),
      tokenUsageEvents: turn.tokenUsageEvents,
      transcripts: [
        {
          filename: "transcript.codex.jsonl",
          format: "jsonl",
          source: "codex-app-server-events",
          threadId,
          content: this.#transcriptText(threadId)
        }
      ]
    };
    if (turn.itemText !== undefined) {
      result.itemText = turn.itemText;
    }
    // The transcript is snapshotted into the result above; keeping the map entry
    // would retain every attempt's full event log for the life of the run.
    this.#transcripts.delete(threadId);
    turn.resolve(result);
  }

  #appendTranscript(threadId: string, event: JsonObject): void {
    const transcript = this.#transcripts.get(threadId);
    if (transcript === undefined) {
      return;
    }
    transcript.events.push(event);
  }

  #transcriptText(threadId: string): string {
    const transcript = this.#transcripts.get(threadId);
    if (transcript === undefined) {
      return "";
    }
    return `${transcript.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  }

  #createTurnState(
    threadId: string,
    timeoutMs: number | undefined,
    onFirstOutput: (() => void) | undefined
  ): TurnState {
    let resolveTurn: (result: TurnResult) => void = () => undefined;
    let rejectTurn: (reason: Error) => void = () => undefined;
    const promise = new Promise<TurnResult>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });

    const state: TurnState = {
      threadId,
      turnId: undefined,
      startedAt: Date.now(),
      firstDeltaAt: null,
      firstOutputSeen: false,
      onFirstOutput,
      completedAt: null,
      deltaText: "",
      items: new Map<string, number>(),
      tokenUsageEvents: [],
      consecutiveRetryPromises: 0,
      retryPromiseSilenceDeadline: undefined,
      systemErrorDiagnosticGraceDeadline: undefined,
      systemErrorDiagnosticFallback: undefined,
      firstOutputDeadline: undefined,
      promise,
      resolve: resolveTurn,
      reject: rejectTurn,
      // No timeoutMs → no per-turn deadline; the turn runs until it completes or
      // the run is stopped. A backstop is the orchestrator's responsibility.
      timeout:
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              void this.#rejectTurn(
                threadId,
                state,
                new TurnTimeoutError(`turn on ${threadId} timed out after ${timeoutMs}ms`)
              );
            }, timeoutMs)
    };
    this.#armFirstOutputDeadline(threadId, state);
    return state;
  }

  #sendApprovalDenial(id: number): void {
    void this.#writeLine(
      JSON.stringify({
        id,
        result: {
          decision: "denied",
          reason: "Ensemble workers run with approvalPolicy never"
        }
      })
    );
  }

  #failAll(error: Error): void {
    if (this.#hasExited) {
      return;
    }
    this.#hasExited = true;

    const stderr = this.#stderrTail.length > 0 ? `\nRecent stderr:\n${this.#stderrTail.join("\n")}` : "";
    const wrapped = new AppServerExitedError(`${error.message}${stderr}`);

    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(wrapped);
    }
    this.#pending.clear();

    // One error instance per turn: the partial-text carrier is per-worker
    // state, so the shared `wrapped` would smear one turn's text across all.
    for (const [threadId, turn] of [...this.#turns]) {
      const perTurn = new AppServerExitedError(wrapped.message);
      if (this.#exitStatus !== null) {
        attachWorkerExitStatus(perTurn, this.#exitStatus);
      }
      void this.#rejectTurn(threadId, turn, perTurn);
    }
    this.#turns.clear();
    this.#transcripts.clear();
  }
}

export function appServerErrorFromPayload(method: string, errorPayload: RpcErrorPayload): Error {
  // Exact code matches outrank the substring scan: a payload that merely
  // *mentions* invalid_json_schema (say, inside a backpressure diagnostic)
  // must not be reclassified as a terminal schema rejection.
  const diagnostic = appServerDiagnosticFromPayload(errorPayload);
  const error =
    errorPayload.code === -32001
      ? new AppServerBackpressureError(method, errorPayload)
      : payloadContainsInvalidJsonSchema(errorPayload)
        ? new CodexSchemaSubsetUnsupportedError(errorPayload, diagnostic)
        : new AppServerRequestError(method, errorPayload);
  return attachAppServerDiagnostic(error, diagnostic);
}

function appServerErrorFromNotification(params: JsonObject): Error {
  const errorPayload = errorPayloadFromNotification(params);
  if (errorPayload.code === "serverOverloaded") {
    return attachAppServerDiagnostic(
      new AppServerOverloadedError("turn notification", errorPayload),
      appServerDiagnosticFromPayload(errorPayload)
    );
  }
  return appServerErrorFromPayload("turn notification", errorPayload);
}

function appServerDiagnosticFromPayload(payload: RpcErrorPayload): {
  code: number | string | null;
  message: string;
  payload: string;
} {
  return {
    code: payload.code ?? null,
    message: payload.message ?? "unknown app-server error",
    payload: renderPayloadSafely(payload.data)
  };
}

function errorPayloadFromNotification(params: JsonObject): RpcErrorPayload {
  const turnError = asJsonObject(params.error);
  const codexErrorInfo = turnError?.codexErrorInfo;
  const code = typeof codexErrorInfo === "string" ? codexErrorInfo : undefined;
  const errorInfo =
    code ?? (asJsonObject(codexErrorInfo) === null ? undefined : renderPayloadSafely(codexErrorInfo));
  const message = typeof turnError?.message === "string" ? turnError.message : undefined;
  const additionalDetails =
    typeof turnError?.additionalDetails === "string" ? turnError.additionalDetails : undefined;
  const renderedDiagnostic = [errorInfo, message, additionalDetails]
    .filter((value): value is string => value !== undefined)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(": ");

  return {
    code,
    message: renderedDiagnostic.length > 0 ? renderedDiagnostic : renderPayloadSafely(params),
    data: params
  };
}

/**
 * Renders a payload for a diagnostic message without letting the payload's
 * own shape break the diagnostic: JSON.stringify throws on cycles and
 * overflows the stack on pathological nesting — inside error handling,
 * where a second failure would replace the first with a crash.
 */
function renderPayloadSafely(payload: unknown): string {
  try {
    return JSON.stringify(payload) ?? "undefined";
  } catch (error) {
    return `[unrenderable payload: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function isTurnProgressNotification(method: string): boolean {
  return (
    method === "turn/started" ||
    method === "turn/diff/updated" ||
    method === "turn/plan/updated" ||
    // MCP progress is a tool saying it is alive, not the response stream
    // resuming — the reset set's rationale. Counting it would let a
    // promise/heartbeat alternation defeat the consecutive-promise bound.
    (method.startsWith("item/") && method !== "item/mcpToolCall/progress")
  );
}

/**
 * `turn/started` establishes a turn but does not show it doing useful work;
 * retaining the first-output deadline through that acknowledgement catches a
 * turn that accepts and then stalls. Any subsequent correlated server frame
 * is observable output and therefore disarms that deadline.
 */
function isOutputBearingTurnFrame(method: string): boolean {
  return method !== "turn/started";
}

/**
 * Turn identity from an inbound frame's params. Most turn-scoped frames carry
 * a flat `turnId`; `turn/started` and `turn/completed` instead nest the id as
 * `turn.id` (v2 schema, 0.146.0).
 */
function turnIdFromParams(params: JsonObject): string | undefined {
  if (typeof params.turnId === "string") {
    return params.turnId;
  }
  const turn = asJsonObject(params.turn);
  return typeof turn?.id === "string" ? turn.id : undefined;
}

/**
 * Depth cap for walks over inbound payload structure. Real protocol frames
 * nest a handful of levels; the cap exists so a hostile or broken provider
 * payload becomes an ordinary miss instead of a stack overflow that kills
 * the process with no salvage envelope.
 */
const MAX_INBOUND_PAYLOAD_DEPTH = 64;

function payloadContainsInvalidJsonSchema(value: unknown, depth = 0): boolean {
  if (depth >= MAX_INBOUND_PAYLOAD_DEPTH) {
    return false;
  }
  if (typeof value === "string") {
    return value.includes("invalid_json_schema");
  }
  if (Array.isArray(value)) {
    return value.some((item) => payloadContainsInvalidJsonSchema(item, depth + 1));
  }
  const object = asJsonObject(value);
  if (object === null) {
    return false;
  }
  return Object.values(object).some((item) => payloadContainsInvalidJsonSchema(item, depth + 1));
}

function parseRpcMessage(line: string): RpcMessage | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return asJsonObject(parsed);
  } catch {
    return null;
  }
}

function asJsonObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** A repeated cold set is not evidence that asynchronous skill loading finished. */
function strictlyContainsAll(candidate: readonly string[], baseline: readonly string[]): boolean {
  return candidate.length > baseline.length && baseline.every((name) => candidate.includes(name));
}

function asRpcError(value: unknown): RpcErrorPayload {
  const object = asJsonObject(value);
  if (object === null) {
    return { code: undefined, message: String(value) };
  }
  return {
    code: typeof object.code === "number" ? object.code : undefined,
    message: typeof object.message === "string" ? object.message : undefined,
    data: object.data
  };
}

function itemTypeFromItem(item: JsonObject | null): string {
  if (item === null) {
    return "?";
  }
  const itemType = item.itemType ?? item.type;
  return typeof itemType === "string" ? itemType : "?";
}
