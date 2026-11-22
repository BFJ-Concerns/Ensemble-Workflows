import { createInterface } from "node:readline";

import { readBoundedLines } from "./bounded-line-reader.js";
import type { CommandContainment, CommandStop, ContainedCommand, ContainmentReach } from "./contained-command.js";
import {
  AcpExitedError,
  AcpProtocolError,
  AcpRequestError,
  AcpRequestTimeoutError,
  attachWorkerExitStatus,
  type WorkerExitStatus
} from "./errors.js";
import type { JsonObject } from "./types.js";

/**
 * A client for one Agent Client Protocol agent: a child process speaking
 * JSON-RPC 2.0 over its stdio, one JSON value per line. It carries the part
 * of the protocol a worker needs — `initialize`, `session/new`, the model
 * and thought-level settings, `session/prompt`, `session/cancel`, the
 * `session/update` stream and `session/request_permission` — and nothing of
 * any one agent's own: what an agent adds to the protocol passes through as
 * the JSON it sent (`AcpClient.agent`, `AcpSession.opened`, an update's
 * `body`), for the engine adapter that knows the agent to read.
 *
 * The framing is written here and the official SDK
 * (`@agentclientprotocol/sdk`) is not used. The launcher ships as one
 * self-contained file, and the SDK brings `zod` and an MCP server package
 * with it as peers and releases several times a month; the surface a worker
 * needs is seven methods; and two of the harness's promises need the frames
 * themselves — a frame that cannot be decoded leaves a diagnostic
 * (`onDecodeFailure`), and an agent's own fields survive to the adapter
 * instead of being dropped by a schema that does not know them.
 *
 * What the client guarantees an adapter:
 *
 * - **Order.** Frames are handled one at a time in the order they arrived.
 *   A session's `onUpdate` runs synchronously for each `session/update`, so
 *   every update the agent sent before a prompt's reply has been delivered
 *   by the time `prompt()` resolves, and an update that follows a
 *   `session/new` reply in the same read is delivered too, the session
 *   being registered as its reply is handled.
 * - **Permissions are answered at once**, by the policy the adapter gave,
 *   so a turn never waits on an approval nobody will give.
 * - **Failures keep their evidence.** A JSON-RPC error rejects with
 *   `AcpRequestError` carrying the agent's code; a dead process rejects
 *   every unanswered request with `AcpExitedError` carrying how it died and
 *   the end of its stderr; an undecodable or unattributable frame is
 *   reported and the stream carries on.
 * - **The process is the run's.** It starts inside the run's command
 *   containment, `close()` stops everything within its reach and returns
 *   the stop for the attempt's account (`unestablishedStopDiagnostics`),
 *   and a process that exits by itself is stopped the same way, since an
 *   exited agent can leave commands of its own running.
 *
 * What it leaves to the adapter: the turn deadline and the whitespace
 * bound (both end a turn with `cancel()` or `close()`), what a stop reason
 * or an error code means for the attempt, the transcript and the answer
 * text built from the updates, and the permission policy itself.
 */

/** The protocol version this client speaks and requires the agent to answer with. */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * The longest inbound frame assembled. A tool-call update carries a
 * command's output or a file's contents inline, so the bound sits well
 * above an ordinary frame; a longer one is dropped with a decode diagnostic.
 */
const MAX_ACP_LINE_BYTES = 8 * 1024 * 1024;
const DECODE_FAILURE_PREFIX_LENGTH = 512;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const STDERR_TAIL_LINES = 50;
const STDERR_LINE_LENGTH = 2_000;
/** How long an ended process's pipes may stay open, once its reach is stopped, before its end is declared. */
const PIPE_DRAIN_MS = 1_000;

/**
 * An inbound frame the client could not use: not JSON, not a JSON-RPC
 * message, longer than the bound, or a reply to no request it made. The
 * fields are the `transport/decodeFailed` runtime event's, which is how an
 * adapter puts the diagnostic on the agent records it belongs to.
 */
export interface AcpDecodeFailure {
  byteLength: number;
  linePrefix: string;
}

export type AcpPermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  /** One of `AcpPermissionOptionKind` on a conforming agent; kept as sent. */
  kind: string;
}

/** A `session/request_permission` as the agent sent it. */
export interface AcpPermissionRequest {
  sessionId: string;
  /** The tool call awaiting approval, the agent's own fields included. */
  toolCall: JsonObject;
  options: readonly AcpPermissionOption[];
}

/**
 * The engine's standing answer to every approval an agent asks for: the
 * `optionId` to select, or null to answer that the request was cancelled.
 * It is called synchronously as the request arrives and its answer is sent
 * at once. A policy that throws, or names an option the request did not
 * offer, is answered with a JSON-RPC internal error carrying the reason, so
 * the fault reaches the turn as the agent's failed tool call.
 */
export type AcpPermissionPolicy = (request: AcpPermissionRequest) => string | null;

/** The first option of the first kind listed that the request offers: how a policy says "allow, once if it can be". */
export function acpPermissionChoice(request: AcpPermissionRequest, ...kinds: AcpPermissionOptionKind[]): string | null {
  for (const kind of kinds) {
    const option = request.options.find((candidate) => candidate.kind === kind);
    if (option !== undefined) return option.optionId;
  }
  return null;
}

/** One `session/update` notification. */
export interface AcpSessionUpdate {
  /**
   * The update's `sessionUpdate` discriminator: `agent_message_chunk`,
   * `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`,
   * `usage_update`, `config_option_update` and the rest of the protocol's,
   * or an agent's own.
   */
  kind: string;
  /** The update object as sent, discriminator and agent's own fields included. */
  body: JsonObject;
  receivedAt: number;
}

/** The text of an update whose content is a text block — a message or thought chunk — and null for any other. */
export function acpUpdateText(update: AcpSessionUpdate): string | null {
  const content = asObject(update.body.content);
  return content !== null && content.type === "text" && typeof content.text === "string" ? content.text : null;
}

/**
 * One setting a session offers as a choice among values, from the
 * protocol's session config options. The categories a worker needs are
 * `model` and `thought_level`.
 */
export interface AcpSelect {
  /** The option's id, which `session/set_config_option` names. */
  id: string;
  category: string | null;
  current: string;
  /** Every value on offer, in the agent's order, groups flattened. */
  values: readonly string[];
}

/** A turn's token counts as the prompt's reply gave them; null for a count the agent left out. */
export interface AcpUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedReadTokens: number | null;
  cachedWriteTokens: number | null;
  thoughtTokens: number | null;
  totalTokens: number | null;
}

export interface AcpPromptResult {
  /** `end_turn`, `max_tokens`, `max_turn_requests`, `refusal` or `cancelled`, kept as sent. */
  stopReason: string;
  /** Null where the reply carried no usage. */
  usage: AcpUsage | null;
  /** The reply as sent. */
  reply: JsonObject;
}

/** How the agent's process ended, with the end of what it wrote to stderr. */
export interface AcpExit extends WorkerExitStatus {
  stderrTail: string;
}

export interface AcpClientOptions {
  /** The agent's command as an operator knows it (`agy acp`): it names the agent in errors and in a teardown report. */
  name: string;
  file: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** The run's command containment, which the agent's process starts inside. */
  commands: CommandContainment;
  clientInfo: { name: string; version: string };
  permissionPolicy: AcpPermissionPolicy;
  onDecodeFailure?: (failure: AcpDecodeFailure) => void;
  /** The bound on every request but a prompt. */
  requestTimeoutMs?: number;
}

export interface AcpNewSessionOptions {
  cwd: string;
  /**
   * Further `session/new` parameters, merged over the protocol's own
   * (`cwd`, an empty `mcpServers`): where an agent's own parameters go.
   */
  params?: JsonObject;
  /**
   * Every update of this session, synchronously, in arrival order. The
   * updates are the turn's answer, so a consumer that throws has lost part
   * of it: the client stops the agent and rejects what is unanswered with
   * the throw as the reason, and never carries on past it.
   */
  onUpdate: (update: AcpSessionUpdate) => void;
}

interface PendingRequest {
  method: string;
  /** Runs synchronously as the reply is handled, before any later frame. */
  settle: (result: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout | undefined;
}

export class AcpClient {
  /** Resolves once the agent's process has ended, however it ended. Never rejects. */
  readonly exited: Promise<AcpExit>;

  #options: AcpClientOptions;
  #command: ContainedCommand;
  #agent: JsonObject = {};
  #nextId = 0;
  #pending = new Map<number, PendingRequest>();
  #sessions = new Map<string, (update: AcpSessionUpdate) => void>();
  #stderrTail: string[] = [];
  #exit: WorkerExitStatus | null = null;
  /** Why the client itself ended the agent, where it did: the process could not run, or an update's consumer threw. */
  #fault: string | undefined;
  #ended = false;
  #closing = false;
  #stop: Promise<CommandStop> | null = null;
  #drain: NodeJS.Timeout | undefined;
  #resolveExited!: (exit: AcpExit) => void;

  /**
   * Start the agent and complete `initialize`. Rejects with the spawn
   * failure when the command cannot start (nothing ran), and otherwise
   * stops the process before rejecting: with `AcpProtocolError` for an
   * agent on another protocol version, or with whatever `initialize` failed
   * on.
   */
  static async start(options: AcpClientOptions): Promise<AcpClient> {
    const command = await options.commands.contain(options.name, options.file, options.args, {
      cwd: options.cwd,
      ...(options.env !== undefined ? { env: options.env } : {}),
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client = new AcpClient(options, command);
    try {
      client.#agent = await client.#request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        // The agent uses its own file and terminal tools: the client offers none.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: options.clientInfo
      }, (result) => {
        const reply = asObject(result);
        if (reply === null || reply.protocolVersion !== ACP_PROTOCOL_VERSION) {
          throw new AcpProtocolError(
            `${options.name}: initialize answered protocol version ${JSON.stringify(reply?.protocolVersion)}; this client speaks ${ACP_PROTOCOL_VERSION}`
          );
        }
        return reply;
      });
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  private constructor(options: AcpClientOptions, command: ContainedCommand) {
    this.#options = options;
    this.#command = command;
    this.exited = new Promise((resolve) => (this.#resolveExited = resolve));
    this.#wire();
  }

  /** The agent's `initialize` reply as sent: its capabilities, `agentInfo`, `authMethods`, and its own `_meta`. */
  get agent(): JsonObject {
    return this.#agent;
  }

  /** How far the run's ownership of the agent's process reaches. */
  get reach(): ContainmentReach {
    return this.#command.reach;
  }

  /**
   * Open a session. The model and thought level it reports are the agent's
   * defaults until set; `AcpSession.opened` holds the whole reply.
   */
  newSession(options: AcpNewSessionOptions): Promise<AcpSession> {
    return this.#request("session/new", { cwd: options.cwd, mcpServers: [], ...options.params }, (result) => {
      const reply = asObject(result);
      const id = reply?.sessionId;
      if (reply === null || typeof id !== "string" || id.length === 0) {
        throw new AcpProtocolError(`${this.#options.name}: session/new answered without a session id`);
      }
      return new AcpSession(id, reply, options.onUpdate, {
        request: (method, params, settle, bounded) => this.#request(method, { sessionId: id, ...params }, settle, bounded),
        notify: (method, params) => this.#notify(method, { sessionId: id, ...params }),
        updates: (deliver) => this.#sessions.set(id, deliver),
        name: this.#options.name
      });
    });
  }

  /**
   * Stop the agent's process and everything within its reach, and reject
   * what it had not answered. Returns the stop, whose `attemptAccount` the
   * adapter owes the attempt that made it. Every call shares one stop, and
   * a process that ended by itself has been stopped already. Never rejects.
   */
  close(): Promise<CommandStop> {
    if (this.#exit === null) this.#closing = true;
    return this.#stopCommand();
  }

  #stopCommand(): Promise<CommandStop> {
    this.#stop ??= this.#command.stop().then((stop) => {
      // Stopping the reach ends whatever held the pipes open; a holder that
      // escaped it cannot keep the client's end waiting.
      if (!this.#ended) {
        this.#drain = setTimeout(() => {
          const child = this.#command.child;
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          this.#end();
        }, PIPE_DRAIN_MS);
      }
      return stop;
    });
    return this.#stop;
  }

  #wire(): void {
    const child = this.#command.child;
    readBoundedLines(child.stdout!, {
      maxLineBytes: MAX_ACP_LINE_BYTES,
      oversizedPrefixBytes: DECODE_FAILURE_PREFIX_LENGTH,
      onLine: (line) => this.#handleLine(line),
      onOversizedLine: (byteLength, linePrefix) => this.#reportDecodeFailure(byteLength, linePrefix)
    });
    createInterface({ input: child.stderr! }).on("line", (line) => {
      this.#stderrTail.push(line.slice(0, STDERR_LINE_LENGTH));
      if (this.#stderrTail.length > STDERR_TAIL_LINES) this.#stderrTail.shift();
    });
    // A write to a dead agent fails the request that made it; the stream's
    // own error event has nothing further to say.
    child.stdin!.on("error", () => undefined);
    child.once("error", (error) => {
      this.#fault ??= `could not run: ${error.message}`;
      void this.#stopCommand();
    });
    child.once("exit", (exitCode, signal) => {
      this.#exit = { exitCode, signal };
      // An exited agent can leave commands of its own running, holding its
      // pipes: end them, and the pipes' close ends the client.
      void this.#stopCommand();
    });
    // Close follows the last byte of stdout, so every frame the agent wrote
    // before it died is handled before its unanswered requests are rejected.
    child.once("close", (exitCode, signal) => {
      this.#exit ??= { exitCode, signal };
      this.#end();
    });
    // Placement is asynchronous: the process may have ended before the
    // containment handed it back, its exit event already past.
    if (child.exitCode !== null || child.signalCode !== null) {
      this.#exit = { exitCode: child.exitCode, signal: child.signalCode };
      void this.#stopCommand();
    }
  }

  /** The process is over: reject what it never answered and publish how it ended. Runs once. */
  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    clearTimeout(this.#drain);
    const failure = this.#exitedError();
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(failure);
    }
    this.#resolveExited({ exitCode: this.#exit?.exitCode ?? null, signal: this.#exit?.signal ?? null, stderrTail: this.#stderrTail.join("\n") });
  }

  #exitedError(): AcpExitedError {
    const name = this.#options.name;
    let account: string;
    if (this.#fault !== undefined) {
      account = `${name} ${this.#fault}`;
    } else if (this.#closing) {
      account = `${name} was stopped by the harness`;
    } else if (this.#exit === null) {
      account = `${name} closed its output`;
    } else {
      account = this.#exit.signal !== null ? `${name} was ended by ${this.#exit.signal}` : `${name} exited with code ${this.#exit.exitCode}`;
    }
    const stderr = this.#stderrTail.join("\n").trim();
    const ownEnding = this.#fault === undefined && !this.#closing;
    const error = new AcpExitedError(stderr.length > 0 && ownEnding ? `${account}; its last stderr: ${stderr}` : account);
    return this.#exit === null ? error : attachWorkerExitStatus(error, this.#exit);
  }

  /**
   * Send a request and settle it from its reply. `settle` turns the result
   * into the value and runs synchronously as the reply frame is handled, so
   * state it sets — a registered session, a settings snapshot — is in place
   * before the next frame; a throw out of it rejects the request.
   */
  #request<T>(method: string, params: JsonObject, settle: (result: unknown) => T, bounded = true): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.#ended) {
        reject(this.#exitedError());
        return;
      }
      const id = ++this.#nextId;
      const timeoutMs = this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const timeout = bounded
        ? setTimeout(() => {
            this.#pending.delete(id);
            reject(new AcpRequestTimeoutError(this.#options.name, method, timeoutMs));
          }, timeoutMs)
        : undefined;
      this.#pending.set(id, {
        method,
        settle: (result) => {
          try {
            resolve(settle(result));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        reject,
        timeout
      });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  #notify(method: string, params: JsonObject): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  /** A frame written to a process that has gone is dropped: its request is rejected when the process's end is handled. */
  #write(frame: JsonObject): void {
    const stdin = this.#command.child.stdin!;
    if (this.#ended || stdin.destroyed || !stdin.writable) return;
    stdin.write(`${JSON.stringify(frame)}\n`);
  }

  #handleLine(line: string): void {
    if (line.trim().length === 0) return;
    const frame = parseFrame(line);
    const id = frame?.id;
    const method = frame?.method;
    if (frame === null) {
      this.#reportUnusable(line);
    } else if (typeof method === "string" && (typeof id === "string" || typeof id === "number")) {
      this.#answerAgentRequest(id, method, asObject(frame.params) ?? {});
    } else if (typeof method === "string") {
      // The one notification a client acts on. Any other, an agent's own
      // included, asks nothing of it.
      if (method === "session/update") this.#routeUpdate(asObject(frame.params) ?? {}, line);
    } else if (typeof id === "number" && this.#pending.has(id) && ("result" in frame || "error" in frame)) {
      const pending = this.#pending.get(id)!;
      this.#pending.delete(id);
      clearTimeout(pending.timeout);
      if ("error" in frame) {
        const error = asObject(frame.error);
        pending.reject(new AcpRequestError(this.#options.name, pending.method, {
          code: typeof error?.code === "number" ? error.code : undefined,
          message: typeof error?.message === "string" ? error.message : undefined,
          ...(error?.data !== undefined ? { data: error.data } : {})
        }));
      } else {
        pending.settle(frame.result);
      }
    } else {
      // Valid JSON that is no message of the protocol's, or a reply to
      // nothing this client asked: as unattributable as a frame that did not parse.
      this.#reportUnusable(line);
    }
  }

  #routeUpdate(params: JsonObject, line: string): void {
    const body = asObject(params.update);
    const deliver = typeof params.sessionId === "string" ? this.#sessions.get(params.sessionId) : undefined;
    if (body === null || typeof body.sessionUpdate !== "string" || deliver === undefined) {
      // An update for no session this client opened has no consumer to reach.
      this.#reportUnusable(line);
      return;
    }
    try {
      deliver({ kind: body.sessionUpdate, body, receivedAt: Date.now() });
    } catch (error) {
      this.#fault ??= `was stopped because the consumer of its updates threw: ${error instanceof Error ? error.message : String(error)}`;
      void this.#stopCommand();
    }
  }

  #answerAgentRequest(id: string | number, method: string, params: JsonObject): void {
    if (method !== "session/request_permission") {
      this.#write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    const request: AcpPermissionRequest = {
      sessionId: typeof params.sessionId === "string" ? params.sessionId : "",
      toolCall: asObject(params.toolCall) ?? {},
      options: (Array.isArray(params.options) ? params.options : []).flatMap((entry: unknown) => {
        const option = asObject(entry);
        return option !== null && typeof option.optionId === "string"
          ? [{ optionId: option.optionId, name: typeof option.name === "string" ? option.name : "", kind: typeof option.kind === "string" ? option.kind : "" }]
          : [];
      })
    };
    let choice: string | null;
    try {
      choice = this.#options.permissionPolicy(request);
      if (choice !== null && !request.options.some((option) => option.optionId === choice)) {
        throw new Error(`the permission policy chose ${JSON.stringify(choice)}, which the request did not offer`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#write({ jsonrpc: "2.0", id, error: { code: -32603, message: `the client could not answer the permission request: ${message}` } });
      return;
    }
    this.#write({
      jsonrpc: "2.0",
      id,
      result: { outcome: choice === null ? { outcome: "cancelled" } : { outcome: "selected", optionId: choice } }
    });
  }

  #reportUnusable(line: string): void {
    this.#reportDecodeFailure(Buffer.byteLength(line, "utf8"), line.slice(0, DECODE_FAILURE_PREFIX_LENGTH));
  }

  #reportDecodeFailure(byteLength: number, linePrefix: string): void {
    try {
      this.#options.onDecodeFailure?.({ byteLength, linePrefix });
    } catch {
      // Reporting cannot fail the stream it reports on.
    }
  }
}

/** What a session reaches its client through. */
interface AcpSessionChannel {
  request<T>(method: string, params: JsonObject, settle: (result: unknown) => T, bounded?: boolean): Promise<T>;
  notify(method: string, params: JsonObject): void;
  /** Registers where the client delivers this session's updates. */
  updates(deliver: (update: AcpSessionUpdate) => void): void;
  name: string;
}

/**
 * One session on an agent: a conversation that keeps its context from one
 * prompt to the next, with a model and thought level of its own.
 */
export class AcpSession {
  readonly id: string;
  /** The `session/new` reply as sent, the agent's own fields included. */
  readonly opened: JsonObject;
  #selects: readonly AcpSelect[];
  #onUpdate: (update: AcpSessionUpdate) => void;
  #channel: AcpSessionChannel;

  /** Sessions are opened by `AcpClient.newSession`. */
  constructor(id: string, opened: JsonObject, onUpdate: (update: AcpSessionUpdate) => void, channel: AcpSessionChannel) {
    this.id = id;
    this.opened = opened;
    this.#selects = selectsOf(opened.configOptions);
    this.#onUpdate = onUpdate;
    this.#channel = channel;
    channel.updates((update) => {
      // The settings snapshot follows the agent's before the adapter is told.
      if (update.kind === "config_option_update") this.#selects = selectsOf(update.body.configOptions);
      this.#onUpdate(update);
    });
  }

  /**
   * The models the session can run on and the one it will: null where the
   * agent offers no model setting.
   */
  get model(): AcpSelect | null {
    return this.#select("model");
  }

  /**
   * The thought levels the current model offers and the one in force. The
   * levels are the current model's alone, so they are read after
   * `setModel`; null where that model offers no choice of level.
   */
  get thoughtLevel(): AcpSelect | null {
    return this.#select("thought_level");
  }

  /** Every setting the session offers as a choice, as last reported. */
  get selects(): readonly AcpSelect[] {
    return this.#selects;
  }

  /** Rejects with the agent's `AcpRequestError` for a model it does not list. */
  setModel(value: string): Promise<void> {
    return this.#set("model", value);
  }

  /** Rejects with the agent's `AcpRequestError` for a level the current model does not offer. */
  setThoughtLevel(value: string): Promise<void> {
    return this.#set("thought_level", value);
  }

  /**
   * Run one turn. Resolves when the agent ends it, whatever the stop
   * reason: a refusal or a cancelled turn is a result here, and the adapter
   * says what each means for the attempt. The turn's text, tool calls and
   * thoughts arrive through `onUpdate` before this resolves. There is no
   * deadline: the adapter ends a turn it will not wait for with `cancel()`.
   * `onReply` runs as the reply is read, before any out-of-turn update.
   */
  prompt(prompt: string | readonly JsonObject[], onReply?: (reply: AcpPromptResult) => void): Promise<AcpPromptResult> {
    const blocks = typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt;
    return this.#channel.request("session/prompt", { prompt: blocks }, (result) => {
      const reply = asObject(result);
      if (reply === null || typeof reply.stopReason !== "string") {
        throw new AcpProtocolError(`${this.#channel.name}: session/prompt answered without a stop reason`);
      }
      const parsed = { stopReason: reply.stopReason, usage: usageOf(reply.usage), reply };
      onReply?.(parsed);
      return parsed;
    }, false);
  }

  /**
   * Ask the agent to end the turn in flight. The turn's `prompt()` then
   * resolves, with stop reason `cancelled` on a conforming agent, and the
   * session takes another prompt.
   */
  cancel(): void {
    this.#channel.notify("session/cancel", {});
  }

  #select(category: string): AcpSelect | null {
    return this.#selects.find((select) => select.category === category) ?? null;
  }

  #set(category: string, value: string): Promise<void> {
    const select = this.#select(category);
    if (select === null) {
      return Promise.reject(new AcpProtocolError(`${this.#channel.name}: session ${this.id} offers no ${category} setting`));
    }
    return this.#channel.request("session/set_config_option", { configId: select.id, value }, (result) => {
      // The reply restates every setting, since one choice can change what another offers.
      const reported = asObject(result)?.configOptions;
      if (reported !== undefined) this.#selects = selectsOf(reported);
    });
  }
}

function selectsOf(configOptions: unknown): AcpSelect[] {
  if (!Array.isArray(configOptions)) return [];
  return configOptions.flatMap((entry: unknown) => {
    const option = asObject(entry);
    if (option === null || option.type !== "select" || typeof option.id !== "string" || typeof option.currentValue !== "string") {
      return [];
    }
    return [{
      id: option.id,
      category: typeof option.category === "string" ? option.category : null,
      current: option.currentValue,
      values: selectValues(option.options)
    }];
  });
}

/** A select's values, whether the agent lists them flat or in named groups. */
function selectValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((entry: unknown) => {
    const option = asObject(entry);
    if (option === null) return [];
    return typeof option.value === "string" ? [option.value] : selectValues(option.options);
  });
}

function usageOf(usage: unknown): AcpUsage | null {
  const reported = asObject(usage);
  if (reported === null) return null;
  const count = (key: string): number | null => (typeof reported[key] === "number" ? (reported[key] as number) : null);
  return {
    inputTokens: count("inputTokens"),
    outputTokens: count("outputTokens"),
    cachedReadTokens: count("cachedReadTokens"),
    cachedWriteTokens: count("cachedWriteTokens"),
    thoughtTokens: count("thoughtTokens"),
    totalTokens: count("totalTokens")
  };
}

function parseFrame(line: string): JsonObject | null {
  try {
    return asObject(JSON.parse(line) as unknown);
  } catch {
    return null;
  }
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}
