/** A turn must show whitespace before this bound applies. Activity resets the clock. */
const WHITESPACE_STREAM_LIMIT_MS = 120_000;

export class WhitespaceStream {
  #lastActivityAt: number;
  #streamingWhitespace = false;
  #timer: NodeJS.Timeout | undefined;
  #onExpiry: (() => void) | undefined;

  constructor(startedAt: number, onExpiry?: () => void) {
    this.#lastActivityAt = startedAt;
    this.#onExpiry = onExpiry;
  }

  observeText(text: string): void {
    if (text.length === 0) return;
    if (text.trim().length > 0) {
      this.observeActivity();
    } else if (!this.#streamingWhitespace) {
      this.#streamingWhitespace = true;
      if (this.#onExpiry !== undefined) {
        this.#timer = setTimeout(this.#onExpiry, Math.max(0, this.expiresAt() - Date.now()));
      }
    }
  }

  observeActivity(): void {
    this.#lastActivityAt = Date.now();
    this.clear();
  }

  expiresAt(): number {
    return this.#streamingWhitespace ? this.#lastActivityAt + WHITESPACE_STREAM_LIMIT_MS : Infinity;
  }

  clear(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#streamingWhitespace = false;
  }
}
