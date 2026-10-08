/**
 * Process-runner tests.
 *
 * The first test is the important one: it proves the architecture's "no shell injection"
 * invariant by round-tripping a hostile argument through a real child process. If anything
 * in the path used `exec`, `shell: true` or string interpolation, the argument would arrive
 * mangled (or the payload would execute) instead of verbatim.
 */
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MediaError } from "./errors.js";
import { runProcess, runProcessBinary } from "./exec.js";

const HOSTILE = "; rm -rf / && $(whoami) `id` | tee /tmp/pwned";
const HOSTILE_SECOND = "second;arg $(touch /tmp/pwned) && echo";
const TIMEOUT = 30_000;

describe("runProcess", () => {
  it("passes arguments as an argv array, verbatim", async () => {
    const marker = join(tmpdir(), `creativelab-exec-${process.pid}-${Date.now()}`);
    const result = await runProcess(
      process.execPath,
      [
        "-e",
        "process.stdout.write(process.argv.slice(1).join('|'))",
        HOSTILE,
        HOSTILE_SECOND,
        marker,
      ],
      { timeoutMs: TIMEOUT },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${HOSTILE}|${HOSTILE_SECOND}|${marker}`);
    // A shell would have interpreted `;`, `$()` and backticks. Nothing was executed.
    expect(existsSync(marker)).toBe(false);
    rmSync(marker, { force: true });
  });

  it("captures stdout and stderr separately", async () => {
    const result = await runProcess(
      process.execPath,
      ["-e", "process.stdout.write('out');process.stderr.write('err')"],
      { timeoutMs: TIMEOUT },
    );
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.code).toBe(0);
  });

  it("resolves with the exit code instead of throwing on failure", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.exit(3)"], {
      timeoutMs: TIMEOUT,
    });
    expect(result.code).toBe(3);
  });

  it("keeps only the last N stderr lines in the ring buffer and streams every line", async () => {
    const lines: string[] = [];
    const result = await runProcess(
      process.execPath,
      ["-e", "for (let i = 0; i < 200; i += 1) console.error('line-' + i)"],
      { tailLines: 5, onStderrLine: (line) => lines.push(line), timeoutMs: TIMEOUT },
    );
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe("line-0");
    expect(lines[199]).toBe("line-199");
    expect(result.stderrTail).toEqual(["line-195", "line-196", "line-197", "line-198", "line-199"]);
    expect(result.stderr).toContain("line-0");
  });

  it("streams stdout lines and flushes a trailing partial line", async () => {
    const lines: string[] = [];
    await runProcess(process.execPath, ["-e", "process.stdout.write('a\\nb\\nno-newline')"], {
      onStdoutLine: (line) => lines.push(line),
      timeoutMs: TIMEOUT,
    });
    expect(lines).toEqual(["a", "b", "no-newline"]);
  });

  it("executes a real binary and returns its stdout", async () => {
    const result = await runProcess("/bin/echo", ["hello", "world"], { timeoutMs: TIMEOUT });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
  });

  it("rejects with a configuration error when the binary does not exist", async () => {
    await expect(
      runProcess("/nonexistent/definitely-not-here", [], { timeoutMs: TIMEOUT }),
    ).rejects.toBeInstanceOf(MediaError);
    await expect(
      runProcess("/nonexistent/definitely-not-here", [], { timeoutMs: TIMEOUT }),
    ).rejects.toMatchObject({
      category: "configuration",
    });
  });

  it("kills the child and rejects when the timeout expires", async () => {
    const started = Date.now();
    const error = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      timeoutMs: 300,
      killGraceMs: 200,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).category).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("kills the child and rejects when the signal aborts", async () => {
    const controller = new AbortController();
    const pending = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      signal: controller.signal,
      killGraceMs: 200,
    });
    setTimeout(() => controller.abort(), 150);
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).category).toBe("canceled");
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runProcess(process.execPath, ["-e", "process.exit(0)"], { signal: controller.signal }),
    ).rejects.toMatchObject({ category: "canceled" });
  });
});

describe("runProcessBinary", () => {
  it("returns raw stdout bytes", async () => {
    const result = await runProcessBinary(
      process.execPath,
      ["-e", "process.stdout.write(Buffer.from([0, 1, 2, 255]))"],
      { timeoutMs: TIMEOUT },
    );
    expect(result.code).toBe(0);
    expect([...result.stdout]).toEqual([0, 1, 2, 255]);
  });

  it("rejects when the capture limit would truncate the data", async () => {
    await expect(
      runProcessBinary(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(4096, 7))"], {
        maxStdoutBytes: 1024,
        timeoutMs: TIMEOUT,
      }),
    ).rejects.toThrow(/truncated/);
  });
});
