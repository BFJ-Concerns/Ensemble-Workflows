import type { EngineName } from "./types.js";

/**
 * How one engine's transcript can be followed while an attempt runs, and
 * the identity that transcript keeps once the attempt has ended.
 *
 * A running attempt's agent record names a transcript a reader can follow
 * (`current_attempt.transcript`, and the status file's `transcript`), and
 * the same transcript is what the archive links once the attempt has ended,
 * however it ended. Who holds the file while it grows is the one difference
 * between engines:
 *
 * - `archive`: the engine has no file of its own, so the harness captures
 *   the transcript. The engine hands each event to the attempt's
 *   `onTranscriptEvent` as it arrives, and the run record appends it as one
 *   JSONL line to a file in the archive (`RunRecordWriter.appendLiveTranscript`),
 *   publishing that file's path with the first line. The attempt's settled
 *   artefact carries this `filename` and `source`; where its content is the
 *   same events in the same order (`transcriptContent`), the file that grew
 *   stands as the archived transcript, and any other content replaces it.
 *   An attempt that ends with no artefact of its own — cancelled, or failed
 *   before the engine assembled one — keeps the file as a partial
 *   transcript, and so does one whose writer died mid-attempt.
 * - `engine`: the engine writes a transcript file of its own. It reports
 *   the file's absolute path to the attempt's `onTranscriptPath`, the run
 *   record publishes that path without copying a growing file
 *   (`RunRecordWriter.referenceEngineTranscript`), and the settled artefact,
 *   or the sweep that finds the writer dead, copies it into the archive
 *   under this `filename`.
 *
 * An engine with no row here has no live transcript: its attempt record's
 * `transcript` stays null while it runs.
 */
export interface LiveTranscript {
  held: "archive" | "engine";
  /** The settled artefact's `filename`, which also names the file in the archive. */
  filename: string;
  /** The settled artefact's `source`. */
  source: string;
}

export const CODEX_TRANSCRIPT = {
  held: "archive",
  filename: "transcript.codex.jsonl",
  source: "codex-app-server-events"
} as const satisfies LiveTranscript;

export const CLAUDE_TRANSCRIPT = {
  held: "engine",
  filename: "transcript.claude.jsonl",
  source: "claude-session-jsonl"
} as const satisfies LiveTranscript;

export const OPENCODE_TRANSCRIPT = {
  held: "archive",
  filename: "transcript.opencode.jsonl",
  source: "opencode run --format json"
} as const satisfies LiveTranscript;

/**
 * Every engine's live transcript. The runtime reads it to bind an attempt's
 * transcript observer and the run record to name, settle and recover the
 * file, so an engine gains a live transcript by adding its row and calling
 * the observer it is then handed; nothing else names the engine.
 */
export const LIVE_TRANSCRIPTS: Partial<Record<EngineName, LiveTranscript>> = {
  codex: CODEX_TRANSCRIPT,
  claude: CLAUDE_TRANSCRIPT,
  opencode: OPENCODE_TRANSCRIPT
};

/** One transcript event as the line an archive-held live transcript gains for it. */
export function transcriptLine(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * The settled content of an archive-held transcript: its events in the
 * order they were observed, each as `transcriptLine` writes it, so an
 * attempt that handed every one of them to `onTranscriptEvent` settles to
 * the bytes its live file already holds.
 */
export function transcriptContent(events: readonly unknown[]): string {
  return events.map(transcriptLine).join("");
}
