/**
 * End-to-end pipeline tests against a real FFmpeg/ffprobe.
 *
 * Fixtures are generated with `-f lavfi` (a 320x240 25 fps test pattern and a 440 Hz sine),
 * so the suite needs no binary assets and no network. The whole file skips when the binary
 * is missing, per the architecture's testing conventions.
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ClipSchema,
  ExportPresetSchema,
  ProjectSchema,
  createInitialDocument,
  frameRate,
} from "@creativelab/core";
import type { Clip, EditorDocument, ExportPreset } from "@creativelab/core";
import {
  ffmpegAvailable,
  ffmpegVersion,
  resolveFfmpegPath,
  resolveFfprobePath,
} from "./binaries.js";
import { MediaError } from "./errors.js";
import { renderTimeline } from "./export.js";
import { runFfmpeg } from "./ffmpeg.js";
import { probeDurationFrames, probeMedia } from "./probe.js";
import { createProxy } from "./proxy.js";
import { extractThumbnail } from "./thumbnail.js";
import { extractWaveform, extractWaveformFile } from "./waveform.js";

const hasFfmpeg = await ffmpegAvailable();
const NOW = "2026-01-01T00:00:00.000Z";
const FPS = frameRate(25, 1);

describe.skipIf(!hasFfmpeg)("media pipeline (integration)", () => {
  let workDir = "";
  let videoPath = "";
  let audioPath = "";

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "creativelab-media-"));
    videoPath = join(workDir, "testsrc.mp4");
    audioPath = join(workDir, "sine.wav");
    await runFfmpeg([
      "-hide_banner",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x240:rate=25:duration=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      videoPath,
    ]);
    await runFfmpeg([
      "-hide_banner",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:a",
      "pcm_s16le",
      audioPath,
    ]);
  });

  afterAll(async () => {
    if (workDir.length > 0) await rm(workDir, { recursive: true, force: true });
  });

  it("resolves and reports the FFmpeg binaries", async () => {
    expect(resolveFfmpegPath()).toContain("ffmpeg");
    expect(resolveFfprobePath()).toContain("ffprobe");
    expect(await ffmpegVersion()).toMatch(/^\d+\./);
  });

  it("generates the fixtures", async () => {
    expect((await stat(videoPath)).size).toBeGreaterThan(0);
    expect((await stat(audioPath)).size).toBeGreaterThan(0);
  });

  it("probes a generated video", async () => {
    const probe = await probeMedia(videoPath);
    expect(probe.container).toContain("mp4");
    expect(probe.durationSeconds).toBeGreaterThan(0.9);
    expect(probe.durationSeconds).toBeLessThan(1.2);
    expect(probe.video?.width).toBe(320);
    expect(probe.video?.height).toBe(240);
    expect(probe.video?.fps).toEqual({ num: 25, den: 1 });
    expect(probe.video?.codec).toBe("h264");
    expect(probe.audio).toBeUndefined();
    expect(probeDurationFrames(probe, FPS)).toBe(25);
  });

  it("probes a generated audio file", async () => {
    const probe = await probeMedia(audioPath);
    expect(probe.container).toContain("wav");
    expect(probe.video).toBeUndefined();
    expect(probe.audio?.codec).toBe("pcm_s16le");
    expect(probe.audio?.sampleRate).toBe(44_100);
    expect(probe.audio?.channels).toBe(1);
  });

  it("rejects an unreadable file with MediaError", async () => {
    const missing = join(workDir, "does-not-exist.mp4");
    await expect(probeMedia(missing)).rejects.toBeInstanceOf(MediaError);
    await expect(probeMedia(missing)).rejects.toMatchObject({ category: "media" });
  });

  it("extracts a thumbnail without upscaling", async () => {
    const thumbPath = join(workDir, "thumb.png");
    const thumb = await extractThumbnail(videoPath, {
      timeSeconds: 0.5,
      width: 160,
      outPath: thumbPath,
    });
    expect(thumb.path).toBe(thumbPath);
    expect(thumb.width).toBe(160);
    expect(thumb.height).toBe(120);
    expect(thumb.bytes).toBeGreaterThan(0);
    expect((await stat(thumbPath)).size).toBe(thumb.bytes);

    // A request wider than the source keeps the source width (never upscale).
    const bigPath = join(workDir, "thumb-big.jpg");
    const big = await extractThumbnail(videoPath, {
      timeSeconds: 0.2,
      width: 1000,
      outPath: bigPath,
    });
    expect(big.width).toBe(320);
    expect(big.height).toBe(240);
    expect(big.format).toBe("jpg");
  });

  it("computes waveform peaks from decoded audio", async () => {
    // FFmpeg's `sine` lavfi source is generated at 1/8 full scale, so the expected
    // envelope is ~0.125 rather than ~1 — the point here is the decode + bucketing, not
    // the generator's amplitude.
    const waveform = await extractWaveform(audioPath, { buckets: 16 });
    expect(waveform.buckets).toBe(16);
    expect(waveform.peaks).toHaveLength(16);
    for (const peak of waveform.peaks) {
      expect(peak.min).toBeGreaterThanOrEqual(-1);
      expect(peak.max).toBeLessThanOrEqual(1);
      expect(peak.max).toBeGreaterThan(0.1);
      expect(peak.min).toBeLessThan(-0.1);
      // A constant-amplitude tone must be symmetric in every bucket.
      expect(Math.abs(peak.min + peak.max)).toBeLessThan(0.01);
    }
  });

  it("writes a compact waveform cache file through atomicWriteFile", async () => {
    const cacheDir = join(workDir, "cache", "waveforms");
    const result = await extractWaveformFile(audioPath, { buckets: 8, sampleRate: 4000, cacheDir });
    expect(result.path.startsWith(cacheDir)).toBe(true);
    expect(result.path.endsWith(".waveform.json")).toBe(true);
    const parsed = JSON.parse(await readFile(result.path, "utf8")) as {
      buckets: number;
      sampleRate: number;
      peaks: { min: number; max: number }[];
    };
    expect(parsed.buckets).toBe(8);
    expect(parsed.sampleRate).toBe(4000);
    expect(parsed.peaks).toHaveLength(8);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("returns a flat waveform for a video with no audio stream instead of failing", async () => {
    // A video-only file is a completely ordinary import (screen recordings, silent
    // animated clips). ffmpeg exits non-zero for it, but that is not a media error: the
    // honest representation is a silent waveform, and failing here would break media
    // ingestion for a perfectly valid file (FR-02).
    const data = await extractWaveform(videoPath, { buckets: 8 });
    expect(data.buckets).toBe(8);
    expect(data.peaks).toHaveLength(8);
    expect(data.peaks.every((bucket) => bucket.min === 0 && bucket.max === 0)).toBe(true);
  });

  it("still rejects a waveform when the file itself cannot be decoded", async () => {
    // The no-audio tolerance above must not swallow a genuine failure.
    const corrupt = join(workDir, "corrupt.mp4");
    await writeFile(corrupt, "this is not a media file");
    await expect(extractWaveform(corrupt, { buckets: 8 })).rejects.toBeInstanceOf(MediaError);
  });

  it("creates an even-dimension H.264 proxy and never upscales", async () => {
    const proxyPath = join(workDir, "proxy.mp4");
    const proxy = await createProxy(videoPath, { outPath: proxyPath, maxWidth: 160 });
    expect(proxy.path).toBe(proxyPath);
    expect(proxy.width).toBe(160);
    expect(proxy.height).toBe(120);
    expect(proxy.bytes).toBeGreaterThan(0);

    const probed = await probeMedia(proxyPath);
    expect(probed.video?.width).toBe(160);
    expect(probed.video?.height).toBe(120);
    expect(probed.video?.codec).toBe("h264");

    const roomy = await createProxy(videoPath, {
      outPath: join(workDir, "proxy-full.mp4"),
      maxWidth: 1920,
    });
    expect(roomy.width).toBe(320);
    expect(roomy.height).toBe(240);
  });

  it("renders a two-clip timeline with progress and atomic rename", async () => {
    const document = buildFixtureDocument();
    const progress: number[] = [];
    let sawDone = false;

    const result = await renderTimeline(document, {
      outputDir: workDir,
      outputName: "render.mp4",
      preset: buildPreset(),
      assets: new Map([
        ["asset-video", { path: videoPath, durationFrames: 25, hasAudio: false }],
        ["asset-audio", { path: audioPath, durationFrames: 25, hasAudio: true }],
      ]),
      onProgress: (update) => {
        progress.push(update.renderedFrames);
        if (update.done) sawDone = true;
      },
    });

    expect(result.outputPath).toBe(join(workDir, "render.mp4"));
    expect(result.frames).toBe(25);
    expect(result.durationSeconds).toBeCloseTo(1, 6);
    expect(progress.length).toBeGreaterThan(0);
    expect(sawDone).toBe(true);
    expect(Array.isArray(result.logTail)).toBe(true);

    const probe = await probeMedia(result.outputPath);
    expect(probe.video?.width).toBe(320);
    expect(probe.video?.height).toBe(240);
    expect(probe.audio).toBeDefined();
    expect(probe.durationSeconds).toBeGreaterThan(0.9);

    const leftovers = (await readdir(workDir)).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("renders a clip using crop, rotation, opacity, speed and audio fades", async () => {
    // The unit tests pin the exact strings; this proves FFmpeg accepts the full graph
    // (crop=cw:ch:cx:cy, rotate with rotw/roth, colorchannelmixer, 2x setpts, atempo-free
    // audio with adelay/volume/afade) end to end.
    const document = buildFixtureDocument({
      videoProperties: {
        speed: { num: 2, den: 1 },
        crop: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 },
        transform: { x: 10, y: -10, scale: 1.1, rotation: 15, opacity: 0.8 },
      },
      audioProperties: { gainDb: -6, fadeInFrames: 4, fadeOutFrames: 4 },
      videoDurationFrames: 12,
      audioDurationFrames: 12,
      audioStartFrame: 3,
    });
    const result = await renderTimeline(document, {
      outputDir: workDir,
      outputName: "filtered.mp4",
      preset: buildPreset(),
      assets: new Map([
        ["asset-video", { path: videoPath, durationFrames: 25, hasAudio: false }],
        ["asset-audio", { path: audioPath, durationFrames: 25, hasAudio: true }],
      ]),
    });

    expect(result.frames).toBeGreaterThan(0);
    const probe = await probeMedia(result.outputPath);
    expect(probe.video?.width).toBe(320);
    expect(probe.video?.height).toBe(240);
    expect(probe.audio).toBeDefined();
  });

  it("cancels an in-flight render without leaving a partial file", async () => {
    const document = buildFixtureDocument();
    const controller = new AbortController();
    const outputName = "cancelled.mp4";
    const pending = renderTimeline(document, {
      outputDir: workDir,
      outputName,
      preset: buildPreset(),
      assets: new Map([
        ["asset-video", { path: videoPath, durationFrames: 25, hasAudio: false }],
        ["asset-audio", { path: audioPath, durationFrames: 25, hasAudio: true }],
      ]),
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(MediaError);
    await expect(stat(join(workDir, outputName))).rejects.toThrow();
    const leftovers = (await readdir(workDir)).filter((name) =>
      name.startsWith(`${outputName}.tmp-`),
    );
    expect(leftovers).toEqual([]);
  });
});

function buildPreset(): ExportPreset {
  return ExportPresetSchema.parse({
    id: "integration-320p",
    label: "Integration 320p",
    width: 320,
    height: 240,
    fps: { num: 25, den: 1 },
    videoBitrateKbps: 800,
    audioBitrateKbps: 128,
  });
}

interface FixtureOverrides {
  videoProperties?: Record<string, unknown>;
  audioProperties?: Record<string, unknown>;
  videoDurationFrames?: number;
  audioDurationFrames?: number;
  audioStartFrame?: number;
}

function buildFixtureDocument(overrides: FixtureOverrides = {}): EditorDocument {
  const project = ProjectSchema.parse({
    id: "project-integration",
    schemaVersion: 1,
    title: "Integration",
    fps: FPS,
    width: 320,
    height: 240,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const base = createInitialDocument(project);
  const sequence = base.sequences[0]!;
  const videoTrack = base.tracks.find((track) => track.kind === "video")!;
  const audioTrack = base.tracks.find((track) => track.kind === "audio")!;
  const make = (clip: {
    id: string;
    trackId: string;
    assetId: string;
    durationFrames: number;
    startFrame?: number;
    properties?: Record<string, unknown>;
  }): Clip =>
    ClipSchema.parse({
      id: clip.id,
      trackId: clip.trackId,
      sequenceId: sequence.id,
      assetId: clip.assetId,
      startFrame: clip.startFrame ?? 0,
      sourceInFrame: 0,
      durationFrames: clip.durationFrames,
      properties: clip.properties ?? {},
      createdAt: NOW,
      updatedAt: NOW,
    });
  return {
    ...base,
    clips: [
      make({
        id: "clip-video",
        trackId: videoTrack.id,
        assetId: "asset-video",
        durationFrames: overrides.videoDurationFrames ?? 25,
        properties: overrides.videoProperties,
      }),
      make({
        id: "clip-audio",
        trackId: audioTrack.id,
        assetId: "asset-audio",
        durationFrames: overrides.audioDurationFrames ?? 25,
        startFrame: overrides.audioStartFrame,
        properties: overrides.audioProperties,
      }),
    ],
  };
}
