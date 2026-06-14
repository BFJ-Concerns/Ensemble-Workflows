import { BudgetExceededError } from "./errors.js";

import type { Budget, JsonObject, TokenAccountingMode, TokenUsageEvent } from "./types.js";

export class TokenBudget implements Budget {
  total: number | null;

  readonly accountingMode: TokenAccountingMode = "last-delta";
  readonly events: TokenUsageEvent[] = [];

  #spent = 0;

  constructor(total: number | null = null) {
    this.total = total;
  }

  spent(): number {
    return this.#spent;
  }

  remaining(): number {
    if (this.total === null) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.max(0, this.total - this.#spent);
  }

  assertCanStart(): void {
    if (this.total !== null && this.#spent >= this.total) {
      throw new BudgetExceededError(this.total, this.#spent);
    }
  }

  record(event: TokenUsageEvent): void {
    this.events.push(event);
    this.#spent += event.last.totalTokens;
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
  const reasoningOutputTokens = numericField(value, "reasoningOutputTokens");
  const totalTokens = numericField(value, "totalTokens");

  if (
    cachedInputTokens === null ||
    inputTokens === null ||
    outputTokens === null ||
    reasoningOutputTokens === null ||
    totalTokens === null
  ) {
    return null;
  }

  return { cachedInputTokens, inputTokens, outputTokens, reasoningOutputTokens, totalTokens };
}

function numericField(source: JsonObject, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
