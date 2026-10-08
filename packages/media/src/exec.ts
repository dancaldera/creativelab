/**
 * Child-process execution — the only place in this package where a process is spawned.
 *
 * PRD §13 / architecture invariant: "Child processes are spawned with an argument
 * **array**, never a shell string." There is therefore no `exec`, no `shell: true` and no
 * string interpolation of a path anywhere in this package: a filename containing
 * `; rm -rf /` is passed as one argv entry and arrives verbatim.
 *
 * The runner supports what the media pipeline needs: bounded stdout/stderr capture with a
 * ring buffer of the tail lines, line callbacks, an overall timeout, and cancellation
 * (SIGTERM, then SIGKILL after a grace period).
 */
import { spawn } from "node:child_process";
import { MediaError } from "./errors.js";

/** Result of a text-mode run. `stderrTail` holds the last complete stderr lines. */
export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stderrTail: string[];
}

/** Result of a binary-mode run (raw stdout, e.g. raw PCM from FFmpeg). */
export interface BinaryProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  stderrTail: string[];
}

export interface RunProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Cancellation: SIGTERM, then SIGKILL after `killGraceMs`. */
  signal?: AbortSignal;
  /** Overall wall-clock budget. Exceeding it kills the process and rejects. */
  timeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL. Defaults to 2500 ms. */
  killGraceMs?: number;
  /** Cap on captured stdout bytes; the head is dropped once exceeded. */
  maxStdoutBytes?: number;
  /** Cap on captured stderr bytes; the head is dropped once exceeded. */
  maxStderrBytes?: number;
  /** Size of the stderr ring buffer exposed as `stderrTail`. Defaults to 50. */
  tailLines?: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Data to write to the child's stdin. When omitted stdin is `/dev/null`. */
  stdin?: string | Uint8Array;
}

const DEFAULT_KILL_GRACE_MS = 2_500;
const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 4 * 1024 * 1024;
const DEFAULT_TAIL_LINES = 50;
/** Last-resort delay after SIGKILL before we stop waiting for `close`. */
const FORCE_SETTLE_MS = 2_000;

/**
 * Byte sink that keeps at most `limit` bytes, dropping the oldest data first.
 *
 * Errors and logs are much more useful at the tail than at the head, so exceeding the cap
 * truncates the beginning instead of failing. `droppedBytes` lets binary callers detect
 * that what they received is incomplete.
 */
class BoundedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  droppedBytes = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (this.limit <= 0) {
      this.droppedBytes += chunk.byteLength;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.byteLength;
    while (this.size > this.limit && this.chunks.length > 1) {
      const head = this.chunks[0]!;
      const excess = this.size - this.limit;
      if (head.byteLength <= excess) {
        this.chunks.shift();
        this.size -= head.byteLength;
        this.droppedBytes += head.byteLength;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
        this.droppedBytes += excess;
      }
    }
    if (this.size > this.limit) {
      const only = this.chunks[0]!;
      const excess = this.size - this.limit;
      this.chunks[0] = only.subarray(excess);
      this.size -= excess;
      this.droppedBytes += excess;
    }
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.size);
  }
}

/** Fixed-size ring of the most recent complete lines. */
class LineRing {
  private readonly items: string[] = [];

  constructor(private readonly capacity: number) {}

  push(line: string): void {
    if (this.capacity <= 0) return;
    this.items.push(line);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }

  toArray(): string[] {
    return [...this.items];
  }
}

/** Incremental newline splitter that emits only complete lines. */
class LineSplitter {
  private partial = "";

  constructor(private readonly onLine: ((line: string) => void) | undefined) {}

  push(text: string): void {
    if (this.onLine === undefined) return;
    this.partial += text;
    let index = this.partial.indexOf("\n");
    while (index !== -1) {
      const line = this.partial.slice(0, index);
      this.partial = this.partial.slice(index + 1);
      this.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      index = this.partial.indexOf("\n");
    }
  }

  flush(): void {
    if (this.onLine === undefined) return;
    if (this.partial.length > 0)
      this.onLine(this.partial.endsWith("\r") ? this.partial.slice(0, -1) : this.partial);
    this.partial = "";
  }
}

interface Collected {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  stderrTail: string[];
}

type TerminationReason = "timeout" | "aborted";

function spawnAndCollect(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
  binary: boolean,
): Promise<Collected> {
  return new Promise<Collected>((resolvePromise, rejectPromise) => {
    if (options.signal?.aborted) {
      rejectPromise(
        new MediaError(`Process was cancelled before it started: ${command}`, {
          category: "canceled",
        }),
      );
      return;
    }

    const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const stdoutSink = new BoundedBuffer(
      options.maxStdoutBytes ?? (binary ? Number.POSITIVE_INFINITY : DEFAULT_MAX_STDOUT_BYTES),
    );
    const stderrSink = new BoundedBuffer(options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES);
    const stderrRing = new LineRing(options.tailLines ?? DEFAULT_TAIL_LINES);
    const stdoutSplitter = new LineSplitter(options.onStdoutLine);
    const stderrSplitter = new LineSplitter((line) => {
      stderrRing.push(line);
      options.onStderrLine?.(line);
    });

    let child;
    try {
      child = spawn(command, [...args], {
        // Array argv, never a shell: no interpolation, no globbing, no injection.
        shell: false,
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      rejectPromise(
        new MediaError(`Failed to spawn ${command}: ${(error as Error).message}`, {
          category: "configuration",
          cause: error,
          details: { command, args: [...args] },
        }),
      );
      return;
    }

    let settled = false;
    let termination: TerminationReason | undefined;
    let exitObserved = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let killHandle: NodeJS.Timeout | undefined;
    let forceHandle: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      if (forceHandle) clearTimeout(forceHandle);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const signalChild = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal);
      } catch {
        // The process may have exited between the check and the kill; the close handler wins.
      }
    };

    const terminate = (reason: TerminationReason): void => {
      if (settled || termination !== undefined) return;
      termination = reason;
      signalChild("SIGTERM");
      killHandle = setTimeout(() => {
        if (!exitObserved) signalChild("SIGKILL");
      }, killGraceMs);
      // Never hang forever on an unkillable child (e.g. uninterruptible I/O).
      forceHandle = setTimeout(() => {
        if (!settled) settle();
      }, killGraceMs + FORCE_SETTLE_MS);
    };

    function onAbort(): void {
      terminate("aborted");
    }

    const settle = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      stdoutSplitter.flush();
      stderrSplitter.flush();
      const stderr = stderrSink.toBuffer().toString("utf8");
      const result: Collected = {
        code: child.exitCode,
        signal: child.signalCode,
        stdout: stdoutSink.toBuffer(),
        stderr,
        stderrTail: stderrRing.toArray(),
      };
      if (termination === "aborted") {
        rejectPromise(
          new MediaError(`Process was cancelled: ${command}`, {
            category: "canceled",
            details: { command, args: [...args], signal: result.signal },
          }),
        );
        return;
      }
      if (termination === "timeout") {
        rejectPromise(
          new MediaError(`Process exceeded its ${options.timeoutMs} ms budget: ${command}`, {
            category: "timeout",
            retryable: true,
            details: { command, args: [...args], stderrTail: result.stderrTail },
          }),
        );
        return;
      }
      if (binary && stdoutSink.droppedBytes > 0) {
        rejectPromise(
          new MediaError(
            `Captured stdout was truncated (${stdoutSink.droppedBytes} bytes dropped); raise maxStdoutBytes`,
            { details: { command, args: [...args] } },
          ),
        );
        return;
      }
      resolvePromise(result);
    };

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => terminate("timeout"), options.timeoutMs);
    }
    if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutSink.push(chunk);
      stdoutSplitter.push(chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrSink.push(chunk);
      stderrSplitter.push(chunk.toString("utf8"));
    });
    child.stdin?.on("error", () => {
      // A child that closes stdin early (e.g. `-nostdin` readers) is not an error.
    });
    if (options.stdin !== undefined && child.stdin) {
      child.stdin.end(options.stdin);
    }

    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(
        new MediaError(`Failed to run ${command}: ${error.message}`, {
          category: "configuration",
          cause: error,
          details: { command, args: [...args], code: (error as NodeJS.ErrnoException).code },
        }),
      );
    });

    child.on("close", () => {
      exitObserved = true;
      settle();
    });
  });
}

/** Run a process and capture its output as UTF-8 text. */
export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  const collected = await spawnAndCollect(command, args, options, false);
  return {
    code: collected.code,
    signal: collected.signal,
    stdout: collected.stdout.toString("utf8"),
    stderr: collected.stderr,
    stderrTail: collected.stderrTail,
  };
}

/**
 * Run a process and capture stdout as raw bytes.
 *
 * Needed for `-f f32le -` PCM decoding, where a UTF-8 round trip would corrupt the data.
 */
export async function runProcessBinary(
  command: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<BinaryProcessResult> {
  const collected = await spawnAndCollect(command, args, options, true);
  return {
    code: collected.code,
    signal: collected.signal,
    stdout: collected.stdout,
    stderr: collected.stderr,
    stderrTail: collected.stderrTail,
  };
}
