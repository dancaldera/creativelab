/**
 * Waveform peaks.
 *
 * FFmpeg decodes the file to mono 32-bit float PCM on stdout and the maths happens in JS
 * on a `Float32Array` view of that buffer. Two consequences worth knowing:
 *
 *   - the bucketing is pure and unit-testable without FFmpeg (`computeWaveformPeaks`);
 *   - the buffer is held in memory, so the default decode rate is deliberately low
 *     (8 kHz is plenty for a UI envelope) and the capture is capped.
 *
 * Silence must produce `0`, never `NaN`: an empty bucket, an all-zero bucket and an input
 * with fewer samples than buckets all resolve to `{ min: 0, max: 0 }`.
 */
import { basename, dirname, extname, join } from "node:path";
import { atomicWriteFile } from "@creativelab/core";
import { resolveFfmpegPath } from "./binaries.js";
import { MediaError, ffmpegFailureMessage, tailLines } from "./errors.js";
import { runProcessBinary } from "./exec.js";
import { runFfprobe } from "./ffmpeg.js";

export interface WaveformBucket {
  min: number;
  max: number;
}

export interface WaveformData {
  buckets: number;
  peaks: WaveformBucket[];
}

/** Peak resolution that a preview envelope actually needs. */
export const DEFAULT_WAVEFORM_SAMPLE_RATE = 8_000;
/** 256 MiB of f32 mono is ~2.3 hours at 8 kHz; beyond that the caller must downsample. */
const MAX_PCM_BYTES = 256 * 1024 * 1024;

export interface ExtractWaveformOptions {
  buckets: number;
  sampleRate?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ExtractWaveformFileOptions extends ExtractWaveformOptions {
  /** Explicit JSON destination. Takes precedence over `cacheDir`. */
  outPath?: string;
  /** Cache directory used to derive a name when `outPath` is not given. */
  cacheDir?: string;
}

export interface WaveformFileResult {
  path: string;
  bytes: number;
  data: WaveformData;
}

/**
 * Reinterpret little-endian float32 PCM bytes as samples.
 *
 * The bytes are copied into a fresh, 4-byte-aligned `ArrayBuffer` rather than viewed in
 * place: a `Buffer` slice from `Buffer.concat` is not guaranteed to be aligned, and an
 * unaligned `Float32Array` view throws at runtime.
 */
export function pcmF32ToSamples(pcm: Uint8Array): Float32Array {
  const usable = pcm.byteLength - (pcm.byteLength % 4);
  const copy = new Uint8Array(usable);
  if (usable > 0) copy.set(pcm.subarray(0, usable));
  return new Float32Array(copy.buffer, 0, usable / 4);
}

function clampSample(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
}

/**
 * Min/max envelope of `buckets` equal-width buckets over `samples`.
 *
 * Bucket bounds are `floor(i * n / buckets)`, so the buckets tile the input exactly with
 * no sample counted twice. When there are fewer samples than buckets the trailing buckets
 * are empty and report `{ min: 0, max: 0 }` (they represent silence, not "no data").
 */
export function computeWaveformPeaks(samples: Float32Array, buckets: number): WaveformBucket[] {
  if (!Number.isInteger(buckets) || buckets <= 0) {
    throw new MediaError(`Waveform buckets must be a positive integer, received ${buckets}`, {
      category: "validation",
    });
  }
  const total = samples.length;
  const peaks: WaveformBucket[] = new Array<WaveformBucket>(buckets);
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = Math.floor((bucket * total) / buckets);
    const end = Math.floor(((bucket + 1) * total) / buckets);
    if (end <= start) {
      peaks[bucket] = { min: 0, max: 0 };
      continue;
    }
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let index = start; index < end; index += 1) {
      const value = samples[index]!;
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    // A bucket made only of non-finite samples (which real PCM never contains) reports
    // silence rather than Infinity/NaN, so a JSON envelope is always serializable.
    const minOut = Number.isFinite(min) ? clampSample(min) : 0;
    const maxOut = Number.isFinite(max) ? clampSample(max) : 0;
    peaks[bucket] = { min: minOut, max: maxOut };
  }
  return peaks;
}

/** Interleaved `[min, max]` pairs, the shape the IPC bridge exposes to the UI. */
export function waveformPeaksToInterleaved(data: WaveformData): number[][] {
  return data.peaks.map((peak) => [peak.min, peak.max]);
}

/**
 * Decode `filePath` to mono float PCM and reduce it to peaks.
 *
 * Throws `MediaError` when the file has no audio stream or cannot be decoded.
 */
export async function extractWaveform(
  filePath: string,
  options: ExtractWaveformOptions,
): Promise<WaveformData> {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new MediaError("extractWaveform requires an input path", { category: "validation" });
  }
  const buckets = options.buckets;
  if (!Number.isInteger(buckets) || buckets <= 0) {
    throw new MediaError(`Waveform buckets must be a positive integer, received ${buckets}`, {
      category: "validation",
    });
  }
  const sampleRate = options.sampleRate ?? DEFAULT_WAVEFORM_SAMPLE_RATE;
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new MediaError(
      `Waveform sample rate must be a positive integer, received ${sampleRate}`,
      {
        category: "validation",
      },
    );
  }

  const args = [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-i",
    filePath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(sampleRate),
    "-f",
    "f32le",
    "-",
  ];
  const result = await runProcessBinary(resolveFfmpegPath(), args, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxStdoutBytes: MAX_PCM_BYTES,
  });

  // Decoding a file with no audio stream is a *normal* input, not a failure: an imported
  // screen recording or a silent animated clip has video only. ffmpeg reports that as a
  // non-zero exit ("Output file does not contain any stream"), so check for the missing
  // stream before treating the exit code as an error. The extra probe is only paid on the
  // failure path, so the common case still costs one process.
  if (result.code !== 0 || result.stdout.byteLength === 0) {
    const audioStreams = await countAudioStreams(filePath, options.signal);
    // Exactly 0 means the probe succeeded and there is genuinely no audio: a flat
    // waveform is the honest answer. `null` means the file could not be probed at all,
    // so the original decode error is the more informative one and is allowed to surface.
    if (audioStreams === 0) {
      return { buckets, peaks: computeWaveformPeaks(EMPTY_SAMPLES, buckets) };
    }
  }

  if (result.code !== 0) {
    throw new MediaError(
      ffmpegFailureMessage(result.stderr, { exitCode: result.code, signal: result.signal }),
      {
        details: { filePath, args, stderrTail: tailLines(result.stderr, 20) },
      },
    );
  }
  if (result.stdout.byteLength === 0) {
    throw new MediaError(`No audio samples could be decoded from ${filePath}`, {
      details: { filePath, args, stderrTail: result.stderrTail },
    });
  }

  return { buckets, peaks: computeWaveformPeaks(pcmF32ToSamples(result.stdout), buckets) };
}

/** Shared empty sample buffer, so the no-audio path allocates nothing. */
const EMPTY_SAMPLES = new Float32Array(0);

/**
 * How many audio streams does this file have?
 *
 * `0` means "probed successfully, there is no audio" — silent media, which must not be
 * treated as an error. `null` means "could not probe it", i.e. broken or unsupported
 * media, which must *not* be silently downgraded to a flat waveform. Collapsing these two
 * into a single boolean would hide real corruption.
 */
async function countAudioStreams(filePath: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const probe = await runFfprobe(
      [
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=index",
        "-of",
        "json",
        filePath,
      ],
      { signal },
    );
    if (probe.code !== 0) return null;
    const parsed = JSON.parse(probe.stdout) as { streams?: unknown[] };
    if (!Array.isArray(parsed.streams)) return null;
    return parsed.streams.length;
  } catch {
    return null;
  }
}

/** Derive the cache path for a source file: `…/cache/waveforms/<name>.waveform.json`. */
export function waveformCachePath(filePath: string, cacheDir?: string): string {
  const extension = extname(filePath);
  const stem = basename(filePath, extension);
  const fileName = `${stem}${extension}.waveform.json`;
  return join(cacheDir ?? dirname(filePath), fileName);
}

/**
 * Extract peaks and persist them as compact JSON through core's `atomicWriteFile`.
 *
 * Callers pass the project's `cache/waveforms` directory; the file name is derived from
 * the source path so a rebuild simply overwrites the previous cache entry.
 */
export async function extractWaveformFile(
  filePath: string,
  options: ExtractWaveformFileOptions,
): Promise<WaveformFileResult> {
  const data = await extractWaveform(filePath, options);
  const outPath = options.outPath ?? waveformCachePath(filePath, options.cacheDir);
  const payload = {
    version: 1,
    buckets: data.buckets,
    sampleRate: options.sampleRate ?? DEFAULT_WAVEFORM_SAMPLE_RATE,
    peaks: data.peaks,
  };
  const serialized = JSON.stringify(payload);
  await atomicWriteFile(outPath, serialized);
  return { path: outPath, bytes: Buffer.byteLength(serialized, "utf8"), data };
}
