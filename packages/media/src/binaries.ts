/**
 * Binary discovery for FFmpeg and ffprobe.
 *
 * Resolution order (first match wins), identical for both tools:
 *   1. `CREATIVELAB_FFMPEG_PATH` / `CREATIVELAB_FFPROBE_PATH`
 *   2. `FFMPEG_PATH` / `FFPROBE_PATH`
 *   3. the executable of the same name on `PATH`
 *   4. the bare name, so a `spawn` failure reports the missing tool clearly
 *
 * A user override is honoured verbatim (no existence check) so that a deliberately
 * configured path produces the error message of the tool itself rather than ours.
 */
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { MediaError } from "./errors.js";
import { runProcess } from "./exec.js";

export type MediaBinary = "ffmpeg" | "ffprobe";

const OVERRIDE_ENV: Record<MediaBinary, readonly string[]> = {
  ffmpeg: ["CREATIVELAB_FFMPEG_PATH", "FFMPEG_PATH"],
  ffprobe: ["CREATIVELAB_FFPROBE_PATH", "FFPROBE_PATH"],
};

const resolved = new Map<MediaBinary, string>();
const versionCache = new Map<MediaBinary, Promise<string>>();

function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name: string): string | undefined {
  const pathValue = process.env.PATH;
  if (pathValue === undefined || pathValue.length === 0) return undefined;
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Resolve one tool, honouring the environment overrides then `PATH`. Cached. */
export function resolveBinaryPath(binary: MediaBinary): string {
  const cached = resolved.get(binary);
  if (cached !== undefined) return cached;
  for (const key of OVERRIDE_ENV[binary]) {
    const value = process.env[key];
    if (value !== undefined && value.trim().length > 0) {
      const override = value.trim();
      resolved.set(binary, override);
      return override;
    }
  }
  const found = findOnPath(binary) ?? binary;
  resolved.set(binary, found);
  return found;
}

export function resolveFfmpegPath(): string {
  return resolveBinaryPath("ffmpeg");
}

export function resolveFfprobePath(): string {
  return resolveBinaryPath("ffprobe");
}

/** Drop cached lookups. Only needed when the environment changes inside one process. */
export function resetBinaryResolution(): void {
  resolved.clear();
  versionCache.clear();
}

async function readVersion(binary: MediaBinary): Promise<string> {
  const command = resolveBinaryPath(binary);
  const result = await runProcess(command, ["-version"], {
    timeoutMs: 10_000,
    maxStdoutBytes: 256 * 1024,
  });
  if (result.code !== 0) {
    throw new MediaError(`${binary} -version failed (exit code ${result.code ?? "null"})`, {
      category: "configuration",
      details: { command, stderrTail: result.stderrTail },
    });
  }
  const firstLine = result.stdout.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const match = /^\S+ version (\S+)/.exec(firstLine);
  if (match?.[1]) return match[1];
  if (firstLine.length > 0) return firstLine;
  throw new MediaError(`${binary} -version produced no output`, {
    category: "configuration",
    details: { command },
  });
}

/** True when the resolved FFmpeg binary runs. Never throws. */
export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await ffmpegVersion();
    return true;
  } catch {
    return false;
  }
}

/** True when the resolved ffprobe binary runs. Never throws. */
export async function ffprobeAvailable(): Promise<boolean> {
  try {
    await ffprobeVersion();
    return true;
  } catch {
    return false;
  }
}

/** FFmpeg version token, e.g. `"9.0.2"`. Cached per process. */
export async function ffmpegVersion(): Promise<string> {
  const cached = versionCache.get("ffmpeg");
  if (cached) return cached;
  const promise = readVersion("ffmpeg");
  versionCache.set("ffmpeg", promise);
  try {
    return await promise;
  } catch (error) {
    versionCache.delete("ffmpeg");
    throw error;
  }
}

/** ffprobe version token, e.g. `"9.0.2"`. Cached per process. */
export async function ffprobeVersion(): Promise<string> {
  const cached = versionCache.get("ffprobe");
  if (cached) return cached;
  const promise = readVersion("ffprobe");
  versionCache.set("ffprobe", promise);
  try {
    return await promise;
  } catch (error) {
    versionCache.delete("ffprobe");
    throw error;
  }
}
