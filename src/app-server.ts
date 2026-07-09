import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import {
  AppServerBackpressureError,
  AppServerExitedError,
  AppServerRequestError,
  AppServerStartupTimeoutError,
  CodexSchemaSubsetUnsupportedError,
  TurnTimeoutError
} from "./errors.js";

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
  code: number | undefined;
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
  startedAt: number;
  firstDeltaAt: number | null;
  completedAt: number | null;
  deltaText: string;
  itemText?: string;
  items: Map<string, number>;
  tokenUsageEvents: TokenUsageEvent[];
  promise: Promise<TurnResult>;
  resolve: (result: TurnResult) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout | undefined;
}

interface ThreadTranscript {
  events: JsonObject[];
}

interface ResolvedThreadDefaults {
  model?: string;
  effort?: string;
}

export interface CodexAppServerTransportOptions {
  cwd: string;
  codexBin: string;
  requestTimeoutMs: number;
  startupHandshakeTimeoutMs?: number;
  clientName: string;
  clientVersion: string;
  onEvent?: (event: RuntimeEvent) => void;
}

export class CodexAppServerTransport implements RuntimeTransport {
  readonly cwd: string;

  #process: ChildProcessWithoutNullStreams;
  #requestTimeoutMs: number;
  #startupHandshakeTimeoutMs: number;
  #nextId = 0;
  #pending = new Map<number, PendingRequest>();
  #turns = new Map<string, TurnState>();
  #transcripts = new Map<string, ThreadTranscript>();
  #resolvedThreadDefaults = new Map<string, ResolvedThreadDefaults>();
  #stderrTail: string[] = [];
  #hasExited = false;
  #onEvent: ((event: RuntimeEvent) => void) | undefined;

  private constructor(options: CodexAppServerTransportOptions) {
    this.cwd = options.cwd;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#startupHandshakeTimeoutMs = options.startupHandshakeTimeoutMs ?? 120_000;
    this.#onEvent = options.onEvent;
    this.#process = spawn(options.codexBin, ["app-server"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });

    this.#wireReader();
    this.#wireStderr();
    this.#process.once("exit", (code, signal) => {
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
    const config = options.webSearch ? { web_search: "live" } : {};
    const requestParams = {
      cwd: options.cwd ?? this.cwd,
      approvalPolicy: "never",
      sandbox: options.sandbox,
      ephemeral: true,
      config
    };
    const result = await this.#request("thread/start", requestParams);

    const resultObject = asJsonObject(result);
    const directThreadId = resultObject?.threadId;
    const nestedThread = asJsonObject(resultObject?.thread);
    const nestedThreadId = nestedThread?.id;

    const threadId = typeof directThreadId === "string" ? directThreadId : typeof nestedThreadId === "string" ? nestedThreadId : null;
    if (threadId !== null) {
      // codex-cli 0.144.0's v2 ThreadStartResponse reports the effective model
      // and nullable reasoning effort. Retain them until this ephemeral thread's
      // turn finishes so an unpinned call can disclose what it actually used.
      this.#resolvedThreadDefaults.set(threadId, {
        ...(typeof resultObject?.model === "string" ? { model: resultObject.model } : {}),
        ...(typeof resultObject?.reasoningEffort === "string" ? { effort: resultObject.reasoningEffort } : {})
      });
      this.#transcripts.set(threadId, {
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

  async runTurn(threadId: string, prompt: string, options: TurnStartOptions): Promise<TurnResult> {
    const state = this.#createTurnState(threadId, options.timeoutMs);
    this.#turns.set(threadId, state);

    try {
      const params: JsonObject = {
        threadId,
        input: [{ type: "text", text: prompt }]
      };
      if (options.schema !== undefined) {
        params.outputSchema = options.schema;
      }
      if (options.model !== undefined) {
        params.model = options.model;
      }
      if (options.effort !== undefined) {
        params.effort = options.effort;
      }

      this.#appendTranscript(threadId, {
        direction: "client",
        method: "turn/start",
        params,
        recordedAt: new Date().toISOString()
      });
      await this.#request("turn/start", params);
      return await state.promise;
    } catch (error) {
      this.#turns.delete(threadId);
      // A failed turn's transcript has no reader (failed attempts archive no
      // transcripts), so drop it rather than let the map grow.
      this.#transcripts.delete(threadId);
      this.#resolvedThreadDefaults.delete(threadId);
      clearTimeout(state.timeout);
      throw error;
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
    for (const turn of this.#turns.values()) {
      clearTimeout(turn.timeout);
      turn.reject(new AppServerExitedError("codex app-server closed"));
    }
    this.#turns.clear();
    this.#transcripts.clear();
    this.#resolvedThreadDefaults.clear();

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

  async #writeLine(line: string): Promise<void> {
    if (this.#hasExited) {
      throw new AppServerExitedError("codex app-server is not running");
    }
    await new Promise<void>((resolve, reject) => {
      this.#process.stdin.write(`${line}\n`, (error) => {
        if (error !== null && error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  #wireReader(): void {
    const reader = createInterface({ input: this.#process.stdout });
    reader.on("line", (line) => {
      this.#handleLine(line);
    });
    reader.once("close", () => {
      this.#failAll(new AppServerExitedError("codex app-server stdout closed"));
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

    const now = Date.now();
    if (method === "turn/started") {
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

    if (method === "turn/completed") {
      turn.completedAt = now;
      this.#completeTurn(threadId, turn);
      return;
    }

    if (method === "error") {
      turn.reject(
        appServerErrorFromPayload("turn notification", {
          code: undefined,
          message: "received scoped error notification",
          data: params
        })
      );
      this.#turns.delete(threadId);
      this.#transcripts.delete(threadId);
      clearTimeout(turn.timeout);
    }
  }

  #completeTurn(threadId: string, turn: TurnState): void {
    this.#turns.delete(threadId);
    clearTimeout(turn.timeout);
    const text = turn.itemText ?? turn.deltaText;
    const resolvedDefaults = this.#resolvedThreadDefaults.get(threadId);
    const result: TurnResult = {
      text,
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
    if (resolvedDefaults?.model !== undefined) {
      result.resolvedModel = resolvedDefaults.model;
    }
    if (resolvedDefaults?.effort !== undefined) {
      result.resolvedEffort = resolvedDefaults.effort;
    }
    if (turn.itemText !== undefined) {
      result.itemText = turn.itemText;
    }
    // The transcript is snapshotted into the result above; keeping the map entry
    // would retain every attempt's full event log for the life of the run.
    this.#transcripts.delete(threadId);
    this.#resolvedThreadDefaults.delete(threadId);
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

  #createTurnState(threadId: string, timeoutMs: number | undefined): TurnState {
    let resolveTurn: (result: TurnResult) => void = () => undefined;
    let rejectTurn: (reason: Error) => void = () => undefined;
    const promise = new Promise<TurnResult>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });

    const state: TurnState = {
      threadId,
      startedAt: Date.now(),
      firstDeltaAt: null,
      completedAt: null,
      deltaText: "",
      items: new Map<string, number>(),
      tokenUsageEvents: [],
      promise,
      resolve: resolveTurn,
      reject: rejectTurn,
      // No timeoutMs → no per-turn deadline; the turn runs until it completes or
      // the run is stopped. A backstop is the orchestrator's responsibility.
      timeout:
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.#turns.delete(threadId);
              state.reject(new TurnTimeoutError(`turn on ${threadId} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
    };
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

    for (const turn of this.#turns.values()) {
      clearTimeout(turn.timeout);
      turn.reject(wrapped);
    }
    this.#turns.clear();
    this.#transcripts.clear();
    this.#resolvedThreadDefaults.clear();
  }
}

export function appServerErrorFromPayload(method: string, errorPayload: RpcErrorPayload): Error {
  if (payloadContainsInvalidJsonSchema(errorPayload)) {
    return new CodexSchemaSubsetUnsupportedError(errorPayload);
  }
  if (errorPayload.code === -32001) {
    return new AppServerBackpressureError(method, errorPayload);
  }
  return new AppServerRequestError(method, errorPayload);
}

function payloadContainsInvalidJsonSchema(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes("invalid_json_schema");
  }
  if (Array.isArray(value)) {
    return value.some((item) => payloadContainsInvalidJsonSchema(item));
  }
  const object = asJsonObject(value);
  if (object === null) {
    return false;
  }
  return Object.values(object).some((item) => payloadContainsInvalidJsonSchema(item));
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
