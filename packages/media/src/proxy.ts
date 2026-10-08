/**
 * Proxy generation (FR-04: "proxy use handles heavier assets", PRD §14).
 *
 * A proxy is a small H.264/AAC MP4 that the preview plays while the export always renders
 * from the originals. Two invariants matter here:
 *
 *   - output dimensions stay even (`trunc(iw/2)*2`), because H.264 4:2:0 cannot encode an
 *     odd width and FFmpeg would otherwise fail on a source with odd dimensions;
 *   - the file is written to a sibling temp path and renamed into place, so a cancelled or
 *     failed proxy never replaces a good one (PRD §12 "temp output then atomic rename").
 */
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { MediaError } from "./errors.js";
import { runFfmpeg, type FfmpegProgress } from "./ffmpeg.js";
import { probeMedia } from "./probe.js";

export interface CreateProxyOptions {
  outPath: string;
  /** Cap on the encoded width; a smaller source is never upscaled. Defaults to 1280. */
  maxWidth?: number;
  /** x264 constant rate factor. Defaults to 23. */
  crf?: number;
  /** x264 speed preset. Defaults to `veryfast`. */
  preset?: string;
  audioBitrateKbps?: number;
  onProgress?: (progress: FfmpegProgress) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ProxyResult {
  path: string;
  width: number;
  height: number;
  bytes: number;
}

export const DEFAULT_PROXY_MAX_WIDTH = 1280;
export const DEFAULT_PROXY_CRF = 23;

/** Even-dimension scale expression; `min` keeps small sources at their native size. */
export function proxyScaleFilter(maxWidth: number): string {
  return `scale=w=min(${maxWidth}\\,trunc(iw/2)*2):h=-2`;
}

/** Even-dimension scale expression used when no width cap was requested. */
export const PROXY_EVEN_SCALE_FILTER = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

/** Transcode `filePath` into a preview-friendly MP4. */
export async function createProxy(
  filePath: string,
  options: CreateProxyOptions,
): Promise<ProxyResult> {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new MediaError("createProxy requires an input path", { category: "validation" });
  }
  if (typeof options.outPath !== "string" || options.outPath.length === 0) {
    throw new MediaError("createProxy requires an outPath", { category: "validation" });
  }
  const maxWidth = options.maxWidth ?? DEFAULT_PROXY_MAX_WIDTH;
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
    throw new MediaError(`Proxy maxWidth must be a positive number, received ${maxWidth}`, {
      category: "validation",
    });
  }
  const crf = options.crf ?? DEFAULT_PROXY_CRF;
  if (!Number.isInteger(crf) || crf < 0 || crf > 51) {
    throw new MediaError(`Proxy crf must be an integer between 0 and 51, received ${crf}`, {
      category: "validation",
    });
  }

  const directory = dirname(options.outPath);
  await mkdir(directory, { recursive: true });
  const tempPath = `${options.outPath}.tmp-${process.pid}.mp4`;
  const filter =
    options.maxWidth === undefined ? PROXY_EVEN_SCALE_FILTER : proxyScaleFilter(maxWidth);

  const args = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    filePath,
    "-vf",
    filter,
    "-c:v",
    "libx264",
    "-preset",
    options.preset ?? "veryfast",
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    `${options.audioBitrateKbps ?? 128}k`,
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    tempPath,
  ];

  try {
    await runFfmpeg(args, {
      onProgress: options.onProgress,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });

    const probe = await probeMedia(tempPath, { signal: options.signal });
    const video = probe.video;
    if (video === undefined || video.width === null || video.height === null) {
      throw new MediaError(`Proxy output has no decodable video stream: ${filePath}`, {
        details: { filePath, tempPath },
      });
    }

    const info = await stat(tempPath);
    await rename(tempPath, options.outPath);
    return {
      path: options.outPath,
      width: video.width,
      height: video.height,
      bytes: info.size,
    };
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
