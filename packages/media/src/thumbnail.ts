/**
 * Thumbnail extraction.
 *
 * Input seeking (`-ss` *before* `-i`) is used on purpose: FFmpeg then decodes from the
 * nearest keyframe instead of decoding the whole file, which is what makes scrubbing a
 * 4K timeline feel instant. The scale expression can only ever shrink, so a 320 px
 * request against a 4K source costs 320 px of decoding, and a small source is never
 * blown up (FR-02, FR-04, PRD §14).
 */
import { readFile, rm, stat } from "node:fs/promises";
import { atomicWriteFile } from "@creativelab/core";
import { MediaError } from "./errors.js";
import { runFfmpeg } from "./ffmpeg.js";
import { probeMedia } from "./probe.js";

export type ThumbnailFormat = "jpg" | "png" | "webp";

export interface ExtractThumbnailOptions {
  /** Destination image path; the directory is created when missing. */
  outPath: string;
  /** Seek position. Input seeking is used, so precision is keyframe-accurate. */
  timeSeconds?: number;
  /** Maximum width in pixels. Never upscales beyond the source width. */
  width?: number;
  format?: ThumbnailFormat;
  /** 1–31 for JPEG (higher is better), 0–100 for WebP. */
  quality?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ThumbnailResult {
  path: string;
  width: number;
  height: number;
  bytes: number;
  format: ThumbnailFormat;
}

const DEFAULT_QUALITY: Record<ThumbnailFormat, number> = { jpg: 3, png: 6, webp: 80 };

function formatFromPath(outPath: string): ThumbnailFormat {
  const match = /\.([a-z0-9]+)$/i.exec(outPath);
  switch (match?.[1]?.toLowerCase()) {
    case "png":
      return "png";
    case "webp":
      return "webp";
    case "jpg":
    case "jpeg":
      return "jpg";
    default:
      return "jpg";
  }
}

function codecArgs(format: ThumbnailFormat, quality: number | undefined): string[] {
  const value = quality ?? DEFAULT_QUALITY[format];
  switch (format) {
    case "png":
      return ["-c:v", "png", "-compression_level", String(value)];
    case "webp":
      return ["-c:v", "libwebp", "-q:v", String(value)];
    default:
      return ["-c:v", "mjpeg", "-q:v", String(value)];
  }
}

/** Scale down to at most `width`, keeping the aspect ratio and even dimensions. */
export function thumbnailScaleFilter(width: number): string {
  return `scale=w=min(${width}\\,trunc(iw/2)*2):h=-2`;
}

/**
 * Extract one frame as an image.
 *
 * FFmpeg writes to a sibling temp file; the bytes are then committed through core's
 * `atomicWriteFile`, so a reader never observes a half-written thumbnail and a failed
 * extraction leaves no file behind.
 */
export async function extractThumbnail(
  filePath: string,
  options: ExtractThumbnailOptions,
): Promise<ThumbnailResult> {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new MediaError("extractThumbnail requires an input path", { category: "validation" });
  }
  if (typeof options.outPath !== "string" || options.outPath.length === 0) {
    throw new MediaError("extractThumbnail requires an outPath", { category: "validation" });
  }
  const width = options.width;
  if (width !== undefined && (!Number.isFinite(width) || width <= 0)) {
    throw new MediaError(`Thumbnail width must be a positive number, received ${width}`, {
      category: "validation",
    });
  }
  const format = options.format ?? formatFromPath(options.outPath);
  const timeSeconds = options.timeSeconds ?? 0;

  const args: string[] = [
    "-hide_banner",
    "-nostdin",
    "-y",
    // Input seeking: must precede -i to seek by keyframe instead of decoding everything.
    ...(timeSeconds > 0 ? ["-ss", String(timeSeconds)] : []),
    "-i",
    filePath,
    "-frames:v",
    "1",
    "-an",
  ];
  if (width !== undefined) args.push("-vf", thumbnailScaleFilter(width));
  args.push(...codecArgs(format, options.quality));

  const tempPath = `${options.outPath}.tmp-${process.pid}.${format}`;
  args.push("-update", "1", tempPath);

  try {
    await runFfmpeg(args, { signal: options.signal, timeoutMs: options.timeoutMs });

    let bytes = 0;
    try {
      bytes = (await stat(tempPath)).size;
    } catch {
      bytes = 0;
    }
    if (bytes === 0) {
      throw new MediaError(
        `No frame could be extracted from ${filePath} at ${timeSeconds}s (the file may be shorter than that)`,
        { details: { filePath, timeSeconds } },
      );
    }

    const probe = await probeMedia(tempPath, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    const video = probe.video;
    if (video === undefined || video.width === null || video.height === null) {
      throw new MediaError(`Extracted thumbnail is not a decodable image: ${tempPath}`, {
        details: { filePath, tempPath },
      });
    }

    const data = await readFile(tempPath);
    await atomicWriteFile(options.outPath, data);
    return {
      path: options.outPath,
      width: video.width,
      height: video.height,
      bytes: data.byteLength,
      format,
    };
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}
