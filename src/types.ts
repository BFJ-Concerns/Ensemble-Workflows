export type JsonObject = Record<string, unknown>;
export type JsonSchema = JsonObject;

export type EngineName = "codex" | "claude" | "opencode";
export type IsolationMode = "worktree";
export type SandboxMode = "read-only" | "workspace-write";
export type TokenAccountingMode = "last-delta" | "total-cumulative";
export type EngineBudgetCeilings = Partial<Record<EngineName, number | null>>;
export type EngineConcurrencyCaps = Partial<Record<EngineName, number>>;

export interface AgentOptions {
  engine: EngineName;
  schema?: JsonSchema;
  model?: string;
  effort?: string;
  /** Claude only: declared degradation when the pinned model tier is unavailable. */
  fallbackModel?: string;
  webSearch?: boolean;
  isolation?: IsolationMode;
  sandbox?: SandboxMode;
  timeoutMs?: number;
  maxAttempts?: number;
  label?: string;
  phase?: string;
}

export interface RuntimeOptions {
  cwd?: string;
  codexBin?: string;
  concurrencyCaps?: EngineConcurrencyCaps;
  budgetCeilings?: EngineBudgetCeilings;
  requestTimeoutMs?: number;
  startupHandshakeTimeoutMs?: number;
  defaultTurnTimeoutMs?: number;
  defaultMaxAttempts?: number;
  clientName?: string;
  clientVersion?: string;
}

export interface Budget {
  spent(engine: EngineName): number;
  remaining(engine: EngineName): number;
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

export interface EngineTranscriptArtifact {
  filename: string;
  format: "jsonl" | "text";
  source: string;
  content: string;
  threadId?: string;
  sessionId?: string;
}

export interface TurnResult {
  text: string;
  resolvedModel?: string;
  itemText?: string;
  deltaText: string;
  durationMs: number | null;
  firstDeltaMs: number | null;
  items: Record<string, number>;
  tokenUsageEvents: TokenUsageEvent[];
  transcripts?: EngineTranscriptArtifact[];
}

export interface TurnStartOptions {
  schema?: JsonSchema;
  model?: string;
  effort?: string;
  // Omitted → no per-turn deadline (unbounded). There is no default; a backstop
  // is the orchestrator's choice (see the skill's backstop section).
  timeoutMs?: number;
}

export interface ThreadStartOptions {
  webSearch: boolean;
  sandbox: SandboxMode;
  cwd?: string;
}

export interface RuntimeTransport {
  readonly cwd: string;
  openThread(options: ThreadStartOptions): Promise<string>;
  runTurn(threadId: string, prompt: string, options: TurnStartOptions): Promise<TurnResult>;
  close(): Promise<void>;
}
