/**
 * Timeline export (FR-09, PRD §12).
 *
 * The render is `buildFilterGraph` + FFmpeg: one `-i` per distinct asset, one
 * `-filter_complex` describing the whole composition, explicit `-map`s and the H.264/AAC
 * encode arguments. Progress is reported as `renderedFrames / totalFrames` from FFmpeg's
 * `-progress pipe:1` stream, cancellation is SIGTERM-then-SIGKILL, and the encoder writes
 * to `<output>.tmp-<pid>.mp4` which is renamed only once the encode succeeded — a failed
 * render can never leave a truncated MP4 in the user's exports folder.
 */
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeFileName } from "@creativelab/core";
import type { EditorDocument, ExportPreset } from "@creativelab/core";
import { MediaError, tailLines } from "./errors.js";
import { runFfmpeg } from "./ffmpeg.js";
import { buildFilterGraph, type AssetResolver } from "./graph.js";

export interface RenderProgress {
  /** Frames written so far (from FFmpeg's `frame=` counter). */
  renderedFrames: number;
  totalFrames: number;
  /** `renderedFrames / totalFrames`, clamped to `[0, 1]`. */
  progress: number;
  frame: number;
  outTimeSeconds: number;
  done: boolean;
}

export interface RenderTimelineOptions {
  /** Destination directory; created when missing. */
  outputDir: string;
  preset: ExportPreset;
  assets: AssetResolver;
  /** Overrides the generated `<title>-<preset>-<timestamp>.mp4` name. */
  outputName?: string;
  onProgress?: (progress: RenderProgress) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** How many trailing stderr lines the result keeps. Defaults to 40. */
  logTailLines?: number;
}

export interface RenderTimelineResult {
  outputPath: string;
  frames: number;
  durationSeconds: number;
  logTail: string[];
}

/** `<title>-<presetId>-<utc timestamp>.mp4`, sanitized for the host filesystem. */
export function defaultExportName(document: EditorDocument, preset: ExportPreset): string {
  const title = sanitizeFileName(document.project.title, "export");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return sanitizeFileName(`${title}-${preset.id}-${stamp}`, "export").concat(".mp4");
}

/** Render a timeline document to an H.264/AAC MP4. */
export async function renderTimeline(
  document: EditorDocument,
  options: RenderTimelineOptions,
): Promise<RenderTimelineResult> {
  if (typeof options.outputDir !== "string" || options.outputDir.length === 0) {
    throw new MediaError("renderTimeline requires an outputDir", { category: "validation" });
  }
  const graph = buildFilterGraph(document, { preset: options.preset, assets: options.assets });

  const fileName = options.outputName ?? defaultExportName(document, options.preset);
  const outputPath = join(options.outputDir, fileName);
  await mkdir(options.outputDir, { recursive: true });
  const tempPath = `${outputPath}.tmp-${process.pid}.mp4`;

  const args: string[] = ["-hide_banner", "-nostdin", "-y"];
  for (const input of graph.inputs) args.push("-i", input);
  args.push("-filter_complex", graph.filterComplex);
  for (const map of graph.maps) args.push("-map", map);
  args.push(...graph.encodeArgs, tempPath);

  let renderedFrames = 0;
  const totalFrames = graph.totalFrames;

  try {
    const result = await runFfmpeg(args, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      onProgress: (progress) => {
        if (progress.frame > renderedFrames) renderedFrames = progress.frame;
        options.onProgress?.({
          renderedFrames,
          totalFrames,
          progress: totalFrames > 0 ? Math.min(1, renderedFrames / totalFrames) : 0,
          frame: progress.frame,
          outTimeSeconds: progress.outTimeSeconds,
          done: progress.done,
        });
      },
    });

    await rename(tempPath, outputPath);
    return {
      outputPath,
      frames: renderedFrames > 0 ? renderedFrames : totalFrames,
      durationSeconds: graph.durationSeconds,
      logTail: tailLines(result.stderr, options.logTailLines ?? 40),
    };
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Alias for the name used in `docs/ARCHITECTURE.md` ("buildExportGraph … renders the
 * timeline to H.264/AAC MP4 with progress + cancellation").
 */
export const buildExportGraph = renderTimeline;
