/**
 * Thin FFmpeg / ffprobe wrappers.
 *
 * `runFfmpeg` adds `-progress pipe:1 -nostats` when the caller wants progress and parses
 * FFmpeg's key=value progress protocol into `{ frame, outTimeSeconds, done }`. A non-zero
 * exit becomes a `MediaError` that embeds the last stderr lines (PRD §12, architecture
 * hard requirement).
 */
import { resolveFfmpegPath, resolveFfprobePath } from "./binaries.js";
import { MediaError, ffmpegFailureMessage, tailLines } from "./errors.js";
import { runProcess, type RunProcessOptions } from "./exec.js";

export interface FfmpegProgress {
  /** Frames written so far. */
  frame: number;
  /** Output timestamp in seconds. */
  outTimeSeconds: number;
  /** True once FFmpeg reports `progress=end`. */
  done: boolean;
}

export interface FfmpegResult {
  command: string;
  args: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stderrTail: string[];
}

export interface FfmpegProgressOptions {
  onProgress?: (progress: FfmpegProgress) => void;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
  maxStdoutBytes?: number;
  tailLines?: number;
  /** Append `-progress pipe:1 -nostats`. Defaults to `onProgress !== undefined`. */
  progress?: boolean;
}

export interface RunFfprobeOptions extends RunProcessOptions {
  timeoutMs?: number;
}

/** Parse one `key=value` line of FFmpeg's progress protocol. */
export function parseProgressLine(line: string): { key: string; value: string } | undefined {
  const index = line.indexOf("=");
  if (index <= 0) return undefined;
  return { key: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
}

/** Mutable accumulator for FFmpeg progress lines, exported for unit tests. */
export interface FfmpegProgressState {
  frame: number;
  outTimeSeconds: number;
}

/**
 * Fold one progress line into `state`.
 *
 * Returns a progress snapshot on the lines that terminate a block (`progress=`), which is
 * exactly the cadence FFmpeg uses to emit stats. `out_time_ms` is deliberately treated as
 * microseconds: FFmpeg's own documentation and output use it that way despite the name.
 */
export function accumulateProgress(
  state: FfmpegProgressState,
  line: string,
): FfmpegProgress | undefined {
  const entry = parseProgressLine(line);
  if (entry === undefined) return undefined;
  switch (entry.key) {
    case "frame": {
      const frame = Number.parseInt(entry.value, 10);
      if (Number.isFinite(frame)) state.frame = frame;
      return undefined;
    }
    case "out_time_us":
    case "out_time_ms": {
      const micros = Number.parseInt(entry.value, 10);
      if (Number.isFinite(micros)) state.outTimeSeconds = micros / 1_000_000;
      return undefined;
    }
    case "out_time": {
      const seconds = parseClock(entry.value);
      if (seconds !== undefined) state.outTimeSeconds = seconds;
      return undefined;
    }
    case "progress": {
      return {
        frame: state.frame,
        outTimeSeconds: state.outTimeSeconds,
        done: entry.value === "end",
      };
    }
    default:
      return undefined;
  }
}

/** Parse `HH:MM:SS.ffffff` as used by `out_time=`. */
export function parseClock(value: string): number | undefined {
  const match = /^(\d+):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return undefined;
  const [, hours, minutes, seconds] = match as unknown as [string, string, string, string];
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/**
 * Run FFmpeg with an argument array.
 *
 * Resolves for a successful exit with the captured output; throws `MediaError` for a
 * non-zero exit, a timeout or a cancellation.
 */
export async function runFfmpeg(
  args: readonly string[],
  options: FfmpegProgressOptions = {},
): Promise<FfmpegResult> {
  const command = resolveFfmpegPath();
  const wantsProgress = options.progress ?? options.onProgress !== undefined;
  const fullArgs = wantsProgress ? [...args, "-progress", "pipe:1", "-nostats"] : [...args];

  const state: FfmpegProgressState = { frame: 0, outTimeSeconds: 0 };
  const result = await runProcess(command, fullArgs, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    killGraceMs: options.killGraceMs,
    maxStdoutBytes: options.maxStdoutBytes,
    tailLines: options.tailLines,
    onStderrLine: options.onStderrLine,
    onStdoutLine: (line) => {
      options.onStdoutLine?.(line);
      const progress = accumulateProgress(state, line);
      if (progress) options.onProgress?.(progress);
    },
  });

  if (result.code !== 0) {
    throw new MediaError(
      ffmpegFailureMessage(result.stderr, { exitCode: result.code, signal: result.signal }),
      {
        details: {
          command,
          args: fullArgs,
          code: result.code,
          stderrTail: tailLines(result.stderr, 20),
        },
      },
    );
  }

  return {
    command,
    args: fullArgs,
    code: result.code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    stderrTail: result.stderrTail,
  };
}

/**
 * Run ffprobe with an argument array.
 *
 * Unlike `runFfmpeg` this does **not** throw on a non-zero exit: ffprobe reports an
 * unreadable file as a JSON error payload on stdout plus a non-zero status, and the probe
 * layer needs both to produce a precise `MediaError`.
 */
export async function runFfprobe(
  args: readonly string[],
  options: RunFfprobeOptions = {},
): Promise<{
  command: string;
  args: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stderrTail: string[];
}> {
  const command = resolveFfprobePath();
  const result = await runProcess(command, args, {
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 30_000,
    killGraceMs: options.killGraceMs,
    maxStdoutBytes: options.maxStdoutBytes ?? 32 * 1024 * 1024,
    tailLines: options.tailLines,
    onStdoutLine: options.onStdoutLine,
    onStderrLine: options.onStderrLine,
  });
  return {
    command,
    args: [...args],
    code: result.code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    stderrTail: result.stderrTail,
  };
}
