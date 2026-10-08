/**
 * ffprobe normalization.
 *
 * Raw ffprobe JSON is a loosely-typed bag of strings (`"30000/1001"`, `"1.500000"`,
 * `"-90"`). Everything that crosses this boundary is normalized once, here, into the
 * shapes the editor stores on an `Asset` and the render graph consumes: exact rational
 * frame rates, integer rotation, numeric durations.
 */
import { frameRate, secondsToFrames } from "@creativelab/core";
import type { FrameRate } from "@creativelab/core";
import { MediaError } from "./errors.js";
import { runFfprobe } from "./ffmpeg.js";

export type MediaStreamType = "video" | "audio" | "subtitle" | "data" | "attachment" | "unknown";

export interface MediaStreamInfo {
  index: number;
  type: MediaStreamType;
  codec: string | null;
  profile: string | null;
  width: number | null;
  height: number | null;
  /** Exact rational rate; `null` when ffprobe reports `0/0` (e.g. audio, stills). */
  fps: FrameRate | null;
  pixFmt: string | null;
  bitrate: number | null;
  sampleRate: number | null;
  channels: number | null;
  channelLayout: string | null;
  durationSeconds: number | null;
  /** Display rotation in `[0, 360)`, normalized from ffprobe's signed values. */
  rotation: number;
  language: string | null;
  /** True for cover art (an MP3 with embedded artwork is not a video file). */
  attachedPicture: boolean;
  raw: Record<string, unknown>;
}

export type VideoStreamInfo = MediaStreamInfo & { type: "video" };
export type AudioStreamInfo = MediaStreamInfo & { type: "audio" };

export interface MediaProbe {
  /** ffprobe `format_name`, e.g. `"mov,mp4,m4a,3gp,3g2,mj2"`. */
  container: string | null;
  durationSeconds: number;
  streams: MediaStreamInfo[];
  video?: VideoStreamInfo;
  audio?: AudioStreamInfo;
  /** Unfiltered ffprobe JSON, stored on the asset so nothing is lost. */
  raw: Record<string, unknown>;
}

export interface ProbeMediaOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asIntOrNull(value: unknown): number | null {
  const parsed = asNumber(value);
  return parsed === null ? null : Math.round(parsed);
}

/**
 * Parse a rational frame-rate string into core's `FrameRate`.
 *
 * Accepts `"30000/1001"`, `"25/1"`, `"25"` and `"29.97"`. `"0/0"` (ffprobe's "unknown")
 * and anything non-positive resolve to `null` rather than throwing, because a still image
 * or an audio-only stream legitimately has no frame rate.
 */
export function parseRationalFrameRate(value: unknown): FrameRate | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return safeFrameRate(Math.round(value * 1000), 1000);
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0) return null;
  const slash = text.indexOf("/");
  if (slash === -1) {
    const numeric = Number(text);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return safeFrameRate(Math.round(numeric * 1000), 1000);
  }
  const numerator = Number(text.slice(0, slash));
  const denominator = Number(text.slice(slash + 1));
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) return null;
  if (numerator <= 0 || denominator <= 0) return null;
  return safeFrameRate(numerator, denominator);
}

function safeFrameRate(num: number, den: number): FrameRate | null {
  try {
    return frameRate(num, den);
  } catch {
    return null;
  }
}

/** Normalize an ffprobe rotation (`-90`, `"90"`, `270`) into `[0, 360)`. */
export function normalizeRotation(value: unknown): number {
  const parsed = asNumber(value);
  if (parsed === null) return 0;
  const rounded = Math.round(parsed);
  const normalized = ((rounded % 360) + 360) % 360;
  return normalized;
}

function streamType(value: unknown): MediaStreamType {
  switch (value) {
    case "video":
    case "audio":
    case "subtitle":
    case "data":
    case "attachment":
      return value;
    default:
      return "unknown";
  }
}

function readRotation(stream: Record<string, unknown>): number {
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
  for (const entry of sideData) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    if (record.rotation !== undefined && record.rotation !== null)
      return normalizeRotation(record.rotation);
  }
  const tags = asRecord(stream.tags);
  if (tags !== undefined && tags.rotate !== undefined) return normalizeRotation(tags.rotate);
  return 0;
}

function normalizeStream(raw: unknown, fallbackIndex: number): MediaStreamInfo {
  const stream = asRecord(raw) ?? {};
  const tags = asRecord(stream.tags) ?? {};
  const disposition = asRecord(stream.disposition) ?? {};
  const type = streamType(stream.codec_type);
  const rotation = readRotation(stream);
  const average = parseRationalFrameRate(stream.avg_frame_rate);
  const raw_ = parseRationalFrameRate(stream.r_frame_rate);
  return {
    index: asIntOrNull(stream.index) ?? fallbackIndex,
    type,
    codec: asString(stream.codec_name),
    profile: asString(stream.profile),
    width: asIntOrNull(stream.width),
    height: asIntOrNull(stream.height),
    fps: average ?? raw_,
    pixFmt: asString(stream.pix_fmt),
    bitrate: asIntOrNull(stream.bit_rate),
    sampleRate: asIntOrNull(stream.sample_rate),
    channels: asIntOrNull(stream.channels),
    channelLayout: asString(stream.channel_layout),
    durationSeconds: asNumber(stream.duration),
    rotation,
    language: asString(tags.language),
    attachedPicture: asNumber(disposition.attached_pic) === 1,
    raw: stream,
  };
}

/**
 * Normalize a raw ffprobe JSON document.
 *
 * Exported because the same normalization runs on freshly probed files, on stored
 * `Asset.probe` payloads and in tests. Throws `MediaError` for an unreadable or
 * unsupported file (ffprobe's `error` payload, an empty document, or a document with
 * neither streams nor format).
 */
export function normalizeProbe(raw: unknown, source?: string): MediaProbe {
  const document = asRecord(raw);
  const label = source === undefined ? "" : ` for ${source}`;
  if (document === undefined) {
    throw new MediaError(`ffprobe returned no usable JSON${label}`, { details: { raw } });
  }
  const error = asRecord(document.error);
  if (error !== undefined && Object.keys(error).length > 0) {
    const message =
      asString(error.string) ??
      asString(error.detail) ??
      `ffprobe error code ${asString(error.code) ?? "unknown"}`;
    throw new MediaError(`Unreadable or unsupported media${label}: ${message}`, {
      details: { raw: document, ffprobeError: error },
    });
  }
  const streamsRaw = Array.isArray(document.streams) ? document.streams : [];
  const streams = streamsRaw.map((stream, index) => normalizeStream(stream, index));
  const format = asRecord(document.format);
  if (streams.length === 0 && (format === undefined || Object.keys(format).length === 0)) {
    throw new MediaError(`ffprobe found no streams or format information${label}`, {
      details: { raw: document },
    });
  }

  // Cover art (`attached_pic`) is an image attached to an audio file, not a video track.
  const video = streams.find(
    (stream): stream is VideoStreamInfo => stream.type === "video" && !stream.attachedPicture,
  );
  const audio = streams.find((stream): stream is AudioStreamInfo => stream.type === "audio");

  const formatDuration = asNumber(format?.duration);
  const streamDuration = streams.reduce<number | null>(
    (max, stream) =>
      stream.durationSeconds === null ? max : Math.max(max ?? 0, stream.durationSeconds),
    null,
  );
  const durationSeconds = formatDuration ?? streamDuration ?? 0;

  return {
    container: asString(format?.format_name),
    durationSeconds,
    streams,
    ...(video === undefined ? {} : { video }),
    ...(audio === undefined ? {} : { audio }),
    raw: document,
  };
}

/** Probe a media file with `ffprobe -show_format -show_streams -show_error`. */
export async function probeMedia(
  filePath: string,
  options: ProbeMediaOptions = {},
): Promise<MediaProbe> {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new MediaError("probeMedia requires a file path", { category: "validation" });
  }
  const result = await runFfprobe(
    [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      "-show_error",
      filePath,
    ],
    { signal: options.signal, timeoutMs: options.timeoutMs },
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    const tail = result.stderrTail.length > 0 ? `\n${result.stderrTail.join("\n")}` : "";
    throw new MediaError(
      `ffprobe did not return JSON for ${filePath} (exit code ${result.code ?? "null"})${tail}`,
      {
        cause: error,
        details: {
          command: result.command,
          args: result.args,
          stdout: result.stdout.slice(0, 2000),
        },
      },
    );
  }

  try {
    return normalizeProbe(parsed, filePath);
  } catch (error) {
    if (error instanceof MediaError && result.code !== 0 && result.stderrTail.length > 0) {
      throw new MediaError(`${error.message}${`\n${result.stderrTail.join("\n")}`}`, {
        details: { ...error.details, stderrTail: result.stderrTail },
      });
    }
    throw error;
  }
}

/** Nearest whole frame count for a probed duration at the given project rate. */
export function probeDurationFrames(probe: MediaProbe, rate: FrameRate): number {
  if (!Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0) return 0;
  return Math.max(0, secondsToFrames(probe.durationSeconds, rate));
}
