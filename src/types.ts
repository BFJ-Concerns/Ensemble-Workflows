export type JsonObject = Record<string, unknown>;
export type JsonSchema = JsonObject;

export type SandboxMode = "read-only" | "workspace-write";
export type TokenAccountingMode = "last-delta" | "total-cumulative";

export interface AgentOptions {
  schema?: JsonSchema;
  model?: string;
  effort?: string;
  webSearch?: boolean;
  sandbox?: SandboxMode;
  timeoutMs?: number;
  maxAttempts?: number;
  label?: string;
  phase?: string;
}

export interface RuntimeOptions {
  cwd?: string;
  codexBin?: string;
  concurrency?: number;
  budgetTotal?: number | null;
  requestTimeoutMs?: number;
  defaultTurnTimeoutMs?: number;
  defaultMaxAttempts?: number;
  clientName?: string;
  clientVersion?: string;
}

export interface Budget {
  total: number | null;
  spent(): number;
  remaining(): number;
}

export interface RuntimeEvent {
  method: string;
  params: JsonObject;
  receivedAt: number;
}

export interface TokenUsageBreakdown {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface TokenUsageEvent {
  threadId: string;
  turnId: string;
  last: TokenUsageBreakdown;
  total: TokenUsageBreakdown;
  raw: JsonObject;
}

export interface TurnResult {
  text: string;
  itemText?: string;
  deltaText: string;
  durationMs: number | null;
  firstDeltaMs: number | null;
  items: Record<string, number>;
  tokenUsageEvents: TokenUsageEvent[];
}

export interface TurnStartOptions {
  schema?: JsonSchema;
  model?: string;
  effort?: string;
  timeoutMs: number;
}

export interface ThreadStartOptions {
  webSearch: boolean;
  sandbox: SandboxMode;
}

export interface RuntimeTransport {
  openThread(options: ThreadStartOptions): Promise<string>;
  runTurn(threadId: string, prompt: string, options: TurnStartOptions): Promise<TurnResult>;
  close(): Promise<void>;
}
