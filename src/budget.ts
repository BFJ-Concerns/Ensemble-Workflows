import { BudgetExceededError } from "./errors.js";

import type {
  Budget,
  EngineBudgetCeilings,
  EngineName,
  JsonObject,
  TokenAccountingMode,
  TokenUsageEvent
} from "./types.js";

export class TokenBudget implements Budget {
  readonly ceilings: Readonly<Record<EngineName, number | null>>;

  readonly accountingMode: TokenAccountingMode = "last-delta";
  readonly events: Array<{ engine: EngineName; event: TokenUsageEvent }> = [];

  #spent: Record<string, number> = {};

  constructor(ceilings: EngineBudgetCeilings = {}) {
    this.ceilings = {
      codex: ceilings.codex ?? null,
      claude: ceilings.claude ?? null,
      opencode: ceilings.opencode ?? null,
      ...ceilings
    };
  }

  spent(engine: EngineName): number {
    return this.#spent[engine] ?? 0;
  }

  remaining(engine: EngineName): number {
    const ceiling = this.ceilings[engine] ?? null;
    if (ceiling === null) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.max(0, ceiling - this.spent(engine));
  }

  assertCanStart(engine: EngineName): void {
    const ceiling = this.ceilings[engine] ?? null;
    const spent = this.spent(engine);
    if (ceiling !== null && spent >= ceiling) {
      throw new BudgetExceededError(engine, ceiling, spent);
    }
  }

  record(engine: EngineName, event: TokenUsageEvent): void {
    this.events.push({ engine, event });
    this.#spent[engine] = this.spent(engine) + event.last.totalTokens;
  }
}

export function tokenUsageEventFromParams(params: JsonObject): TokenUsageEvent | null {
  const threadId = params.threadId;
  const turnId = params.turnId;
  const tokenUsage = params.tokenUsage;

  if (typeof threadId !== "string" || typeof turnId !== "string" || !isJsonObject(tokenUsage)) {
    return null;
  }

  const last = breakdownFromUnknown(tokenUsage.last);
  const total = breakdownFromUnknown(tokenUsage.total);
  if (last === null || total === null) {
    return null;
  }

  return { threadId, turnId, last, total, raw: params };
}

function breakdownFromUnknown(value: unknown): TokenUsageEvent["last"] | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const cachedInputTokens = numericField(value, "cachedInputTokens");
  const inputTokens = numericField(value, "inputTokens");
  const outputTokens = numericField(value, "outputTokens");
  const reasoningOutputTokens = optionalNumericField(value, "reasoningOutputTokens");
  const cacheCreationInputTokens = optionalNumericField(value, "cacheWriteInputTokens");
  const totalTokens = numericField(value, "totalTokens");

  if (
    cachedInputTokens === null ||
    inputTokens === null ||
    outputTokens === null ||
    reasoningOutputTokens === null ||
    cacheCreationInputTokens === null ||
    totalTokens === null
  ) {
    return null;
  }

  return {
    cachedInputTokens,
    inputTokens,
    outputTokens,
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
    ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
    totalTokens
  };
}

function numericField(source: JsonObject, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalNumericField(source: JsonObject, key: string): number | null | undefined {
  return source[key] === undefined ? undefined : numericField(source, key);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
