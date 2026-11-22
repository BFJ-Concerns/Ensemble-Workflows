import type { Readable } from "node:stream";

/**
 * Newline-delimited frames read off a child's stdout, each bounded before
 * it is decoded or parsed: the framing every JSON-RPC-over-stdio substrate
 * here shares (`codex app-server`, an Agent Client Protocol server).
 *
 * A line within the bound reaches `onLine` as UTF-8 text, without its
 * newline and without a carriage return before it. A line past the bound is
 * never assembled: it is discarded through its newline, so one hostile
 * frame can neither hold unbounded memory nor poison the frame after it,
 * and `onOversizedLine` is told how long it was and how it began. A final
 * line the stream ended without terminating is delivered the same way.
 *
 * Both callbacks run synchronously, in the order the lines arrived. The
 * reader's `end` listener is attached here, so a caller that attaches its
 * own afterwards sees the stream end only once the last line is delivered.
 */
export interface BoundedLineOptions {
  /** The longest line, in bytes before decoding, that is assembled and delivered. */
  maxLineBytes: number;
  /** How many leading bytes of an oversized line are kept for its report. */
  oversizedPrefixBytes: number;
  onLine: (line: string) => void;
  /** `byteLength` is the whole line's, discarded bytes included; `prefix` is its retained start, decoded. */
  onOversizedLine: (byteLength: number, prefix: string) => void;
}

export function readBoundedLines(stream: Readable, options: BoundedLineOptions): void {
  const { maxLineBytes, oversizedPrefixBytes, onLine, onOversizedLine } = options;
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
    if (prefix.length < oversizedPrefixBytes) {
      prefix = Buffer.concat([prefix, chunk.subarray(0, oversizedPrefixBytes - prefix.length)]);
    }
  };
  const reportOversizedLine = (): void => {
    const reportedByteLength = oversizedLineByteLength;
    const reportedPrefix = prefix.toString("utf8");
    resetLine();
    onOversizedLine(reportedByteLength, reportedPrefix);
  };
  const deliverRetainedLine = (): void => {
    // Match readline's CRLF treatment while applying the byte limit before
    // decoding or JSON parsing.
    const line = Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
    resetLine();
    onLine(line);
  };

  stream.on("data", (chunk: Buffer) => {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);

      if (discardingOversizedLine) {
        oversizedLineByteLength += segment.length;
        if (newline !== -1) {
          reportOversizedLine();
        }
      } else if (byteLength + segment.length <= maxLineBytes) {
        retain(segment);
        if (newline !== -1) {
          deliverRetainedLine();
        }
      } else {
        const retainedBytes = Math.max(0, maxLineBytes - byteLength);
        retain(segment.subarray(0, retainedBytes));
        // Discard through the newline. Count the discarded bytes as they
        // pass: the report gives the whole line's length, not the part kept.
        discardingOversizedLine = true;
        oversizedLineByteLength = byteLength + (segment.length - retainedBytes);
        if (newline !== -1) {
          reportOversizedLine();
        }
      }
      offset = newline === -1 ? chunk.length : newline + 1;
    }
  });
  stream.once("end", () => {
    // readline flushes a final unterminated line on EOF; so does this.
    if (discardingOversizedLine) {
      reportOversizedLine();
    } else if (byteLength > 0) {
      deliverRetainedLine();
    }
  });
}
