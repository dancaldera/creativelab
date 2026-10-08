/**
 * Media error taxonomy.
 *
 * Every failure this package raises is a `MediaError` so that callers (the job queue, the
 * IPC bridge, the CLI) can branch on one class. The category defaults to `"media"` — the
 * domain category defined in core for probing/decoding/encoding failures — but callers may
 * narrow it (a cancelled render is `"canceled"`, an exceeded timeout is `"timeout"`) so the
 * retry policy in core keeps working without special cases.
 */
import { CreativeLabError } from "@creativelab/core";
import type { CreativeLabErrorOptions, ErrorCategory } from "@creativelab/core";

export interface MediaErrorOptions extends Partial<Omit<CreativeLabErrorOptions, "category">> {
  /** Defaults to `"media"`. */
  category?: ErrorCategory;
}

export class MediaError extends CreativeLabError {
  constructor(message: string, options: MediaErrorOptions = {}) {
    super(message, { ...options, category: options.category ?? "media" });
    this.name = "MediaError";
  }
}

/** Split FFmpeg output into trimmed, non-empty lines. */
export function outputLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

/** The last `maxLines` non-empty lines — the part of an FFmpeg log worth keeping. */
export function tailLines(text: string, maxLines = 20): string[] {
  if (maxLines <= 0) return [];
  return outputLines(text).slice(-maxLines);
}

const FATAL_PATTERNS = [
  /conversion failed/i,
  /invalid argument/i,
  /no such file or directory/i,
  /not found/i,
  /unsupported/i,
  /could not (?:find|open|write|read)/i,
  /\berror\b/i,
  /\bfailed\b/i,
  /does not contain any stream/i,
];

/**
 * Reduce an FFmpeg stderr log to the single line that best explains the failure.
 *
 * FFmpeg is noisy: the interesting diagnosis is usually buried above per-stream warnings,
 * so we scan the tail for the first line that looks fatal and strip the
 * `[component @ 0x...]` prefix so the message is readable in a UI toast.
 */
export function parseFfmpegError(stderr: string, maxLines = 20): string {
  const lines = tailLines(stderr, maxLines);
  const match = lines.find((line) => FATAL_PATTERNS.some((pattern) => pattern.test(line)));
  const line = match ?? lines[lines.length - 1];
  if (line === undefined) return "FFmpeg failed without diagnostic output";
  return line.replace(/^(?:\[[^\]]*\]\s*)+/, "").trim();
}

export interface FfmpegFailureOptions {
  /** Exit code when the process exited normally with a non-zero status. */
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  /** How many stderr lines to embed in the message. Defaults to 20. */
  maxLines?: number;
}

/**
 * Build the human-readable message for a failed FFmpeg invocation, including the last
 * stderr lines (architecture hard requirement: "non-zero exit surfaces FFmpeg's last
 * stderr lines in the error").
 */
export function ffmpegFailureMessage(stderr: string, options: FfmpegFailureOptions = {}): string {
  const { exitCode = null, signal = null, maxLines = 20 } = options;
  const status =
    exitCode !== null && exitCode !== 0
      ? `exited with code ${exitCode}`
      : signal
        ? `was killed by ${signal}`
        : "failed";
  const summary = parseFfmpegError(stderr, maxLines);
  const tail = tailLines(stderr, maxLines);
  const detail = tail.length > 0 ? `\n${tail.map((line) => `  ${line}`).join("\n")}` : "";
  return `FFmpeg ${status}: ${summary}${detail}`;
}
