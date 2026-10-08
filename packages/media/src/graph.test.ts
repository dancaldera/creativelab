/**
 * Filter-graph contract tests.
 *
 * These run with no FFmpeg present: `buildFilterGraph` is pure, and the exact strings it
 * emits are the interface shared with the Rust implementation. Every expected value below
 * is therefore written out literally rather than recomputed from the same helpers.
 */
import { describe, expect, it } from "vitest";
import {
  ClipSchema,
  ExportPresetSchema,
  ProjectSchema,
  createInitialDocument,
  frameRate,
} from "@creativelab/core";
import type { Clip, EditorDocument, ExportPreset } from "@creativelab/core";
import { MediaError } from "./errors.js";
import { buildAtempoChain, buildFilterGraph, cropStage, formatFilterNumber } from "./graph.js";

const NOW = "2026-01-01T00:00:00.000Z";
/** 29.97 — the case where naive float seconds would drift. */
const FPS = frameRate(30_000, 1001);

const project = ProjectSchema.parse({
  id: "project-graph",
  schemaVersion: 1,
  title: "Graph fixture",
  fps: FPS,
  width: 1920,
  height: 1080,
  createdAt: NOW,
  updatedAt: NOW,
});

const preset: ExportPreset = ExportPresetSchema.parse({
  id: "fixture-1080p",
  label: "Fixture 1080p",
  width: 1920,
  height: 1080,
  fps: { num: 30_000, den: 1001 },
  videoBitrateKbps: 8_000,
  audioBitrateKbps: 192,
});

const base = createInitialDocument(project);
const sequence = base.sequences[0]!;
const videoTracks = base.tracks.filter((track) => track.kind === "video");
const audioTracks = base.tracks.filter((track) => track.kind === "audio");
const v1 = videoTracks[0]!;
const v2 = videoTracks[1]!;
const a1 = audioTracks[0]!;

function clip(overrides: {
  id: string;
  trackId: string;
  assetId: string;
  startFrame: number;
  durationFrames: number;
  sourceInFrame?: number;
  properties?: Record<string, unknown>;
}): Clip {
  return ClipSchema.parse({
    id: overrides.id,
    trackId: overrides.trackId,
    sequenceId: sequence.id,
    assetId: overrides.assetId,
    label: overrides.id,
    startFrame: overrides.startFrame,
    sourceInFrame: overrides.sourceInFrame ?? 0,
    durationFrames: overrides.durationFrames,
    properties: overrides.properties ?? {},
    createdAt: NOW,
    updatedAt: NOW,
  });
}

/** V1: 300 frames from source 1.001s, rotated, semi-transparent. */
const clipA = clip({
  id: "clip-a",
  trackId: v1.id,
  assetId: "asset-a",
  startFrame: 0,
  sourceInFrame: 30,
  durationFrames: 300,
  properties: {
    transform: { x: 120, y: -40, scale: 1.25, rotation: 90, opacity: 0.5 },
  },
});

/** V2 (composites on top): overlaps clip A, 2x speed, cropped. */
const clipB = clip({
  id: "clip-b",
  trackId: v2.id,
  assetId: "asset-b",
  startFrame: 150,
  durationFrames: 200,
  properties: {
    speed: { num: 2, den: 1 },
    crop: { left: 0.05, right: 0.05, top: 0.1, bottom: 0 },
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  },
});

/** A1: delayed audio with −6 dB gain and fades. */
const clipC = clip({
  id: "clip-c",
  trackId: a1.id,
  assetId: "asset-c",
  startFrame: 60,
  durationFrames: 120,
  properties: {
    audio: { gainDb: -6, fadeInFrames: 15, fadeOutFrames: 30 },
  },
});

const assets = new Map([
  ["asset-a", { path: "/media/a.mp4", durationFrames: 330, hasAudio: false }],
  ["asset-b", { path: "/media/b.mp4", durationFrames: 400, hasAudio: false }],
  ["asset-c", { path: "/media/c.wav", durationFrames: 120, hasAudio: true }],
]);

function documentWith(clips: Clip[]): EditorDocument {
  return { ...base, clips };
}

const fixture = documentWith([clipA, clipB, clipC]);
const graph = buildFilterGraph(fixture, { preset, assets });

describe("buildFilterGraph", () => {
  it("starts from a black composition base at the preset rate and full duration", () => {
    expect(graph.filterComplex.split(";")[0]).toBe(
      "color=c=black:s=1920x1080:r=30000/1001:d=11.678333[base]",
    );
  });

  it("emits one input per distinct asset, video clips first", () => {
    expect(graph.inputs).toEqual(["/media/a.mp4", "/media/b.mp4", "/media/c.wav"]);
  });

  it("describes video clips in track sort order with exact stage strings", () => {
    const stages = graph.filterComplex.split(";");
    // V1 has sortOrder 0, V2 has sortOrder 1: the lower track composites first.
    expect(stages[1]).toBe(
      "[0:v]trim=start=1.001:duration=10.01,setpts=(PTS-STARTPTS)/1," +
        "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2," +
        "rotate=1.570796:ow=rotw(1.570796):oh=roth(1.570796):c=none,format=rgba," +
        "colorchannelmixer=aa=0.5[v0]",
    );
    expect(stages[2]).toBe(
      "[base][v0]overlay=x=(1920-w)/2+120:y=(1080-h)/2-40:" + "enable='between(t,0,10.01)'[base]",
    );
    expect(stages[3]).toBe(
      "[1:v]trim=start=0:duration=6.673333,setpts=(PTS-STARTPTS)/2," +
        "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2," +
        "crop=1728:972:96:108,format=rgba[v1]",
    );
    expect(stages[4]).toBe(
      "[base][v1]overlay=x=(1920-w)/2+0:y=(1080-h)/2+0:" +
        "enable='between(t,5.005,11.678333)'[base]",
    );
  });

  it("describes the audio clip, then mixes it", () => {
    const stages = graph.filterComplex.split(";");
    expect(stages[5]).toBe(
      "[2:a]atrim=start=0:duration=4.004,asetpts=PTS-STARTPTS,adelay=2002|2002," +
        "volume=0.501187,afade=t=in:st=0:d=0.5005,afade=t=out:st=5.005:d=1.001[a0]",
    );
    expect(stages[6]).toBe("[a0]amix=inputs=1:normalize=0:dropout_transition=0[aout]");
    expect(stages).toHaveLength(7);
  });

  it("omits identity stages entirely", () => {
    const stages = graph.filterComplex.split(";");
    const rotated = stages[1]!;
    const cropped = stages[3]!;
    // clip A is not cropped
    expect(rotated).not.toContain("crop=");
    // clip B is neither rotated nor transparent, and is not time-stretched for audio
    expect(cropped).not.toContain("rotate=");
    expect(cropped).not.toContain("colorchannelmixer");
    expect(graph.filterComplex).not.toContain("atempo");
    // no clip sits at frame 0 with zero delay beyond the V1 clip
    expect(stages[5]).not.toContain("atempo");
  });

  it("reports the timeline duration in frames at the preset rate and in seconds", () => {
    expect(graph.totalFrames).toBe(350);
    expect(graph.durationSeconds).toBeCloseTo(11.678333, 6);
  });

  it("maps the composed video and the mixed audio", () => {
    expect(graph.maps).toEqual(["[base]", "[aout]"]);
  });

  it("emits the required H.264/AAC encode arguments", () => {
    expect(graph.encodeArgs).toEqual([
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "medium",
      "-b:v",
      "8000k",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      "-shortest",
    ]);
  });

  it("uses CRF and the veryfast preset when the preset sets crf", () => {
    const crfPreset = ExportPresetSchema.parse({
      id: "master",
      label: "Master",
      width: 1920,
      height: 1080,
      fps: { num: 30_000, den: 1001 },
      crf: 16,
    });
    const crfGraph = buildFilterGraph(fixture, { preset: crfPreset, assets });
    expect(crfGraph.encodeArgs).toContain("-crf");
    expect(crfGraph.encodeArgs).toContain("16");
    expect(crfGraph.encodeArgs).not.toContain("-b:v");
    expect(crfGraph.encodeArgs[crfGraph.encodeArgs.indexOf("-preset") + 1]).toBe("veryfast");
  });

  it("accepts a resolver function instead of a Map", () => {
    const resolverGraph = buildFilterGraph(fixture, {
      preset,
      assets: (id) => assets.get(id),
    });
    expect(resolverGraph.filterComplex).toBe(graph.filterComplex);
  });

  it("emits a silent audio base when the timeline has no audio clips", () => {
    const silent = buildFilterGraph(documentWith([clipA, clipB]), { preset, assets });
    expect(silent.filterComplex).toContain(
      "anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=11.678333,asetpts=PTS-STARTPTS[aout]",
    );
    expect(silent.maps).toEqual(["[base]", "[aout]"]);
  });

  it("still produces a black video track for an audio-only timeline", () => {
    const audioOnly = buildFilterGraph(documentWith([clipC]), { preset, assets });
    expect(audioOnly.filterComplex).toContain("color=c=black:s=1920x1080");
    expect(audioOnly.filterComplex).not.toContain(":v]");
    expect(audioOnly.filterComplex).toContain("amix=inputs=1");
    expect(audioOnly.maps).toEqual(["[base]", "[aout]"]);
  });

  it("skips clips whose audio is disabled or whose asset has no audio stream", () => {
    const mutedClip = clip({
      id: "clip-muted",
      trackId: audioTracks[1]!.id,
      assetId: "asset-c",
      startFrame: 0,
      durationFrames: 100,
      properties: { audio: { enabled: false } },
    });
    const videoAudio = clip({
      id: "clip-noaudio",
      trackId: a1.id,
      assetId: "asset-a",
      startFrame: 0,
      durationFrames: 100,
    });
    const skipped = buildFilterGraph(documentWith([clipA, mutedClip, videoAudio]), {
      preset,
      assets,
    });
    expect(skipped.filterComplex).toContain("anullsrc=");
    expect(skipped.filterComplex).not.toContain(":a]");
  });
});

describe("buildFilterGraph rejections", () => {
  it("rejects an empty timeline", () => {
    expect(() => buildFilterGraph(documentWith([]), { preset, assets })).toThrow(MediaError);
    expect(() => buildFilterGraph(documentWith([]), { preset, assets })).toThrow(/empty timeline/i);
  });

  it("rejects a clip whose asset is unknown", () => {
    const orphan = clip({
      id: "clip-orphan",
      trackId: v1.id,
      assetId: "asset-missing",
      startFrame: 0,
      durationFrames: 10,
    });
    expect(() => buildFilterGraph(documentWith([orphan]), { preset, assets })).toThrow(
      /missing asset asset-missing/,
    );
  });

  it("rejects a clip that needs more source frames than the asset has", () => {
    const tooLong = clip({
      id: "clip-long",
      trackId: v1.id,
      assetId: "asset-a",
      startFrame: 0,
      sourceInFrame: 30,
      durationFrames: 400,
    });
    expect(() => buildFilterGraph(documentWith([tooLong]), { preset, assets })).toThrow(MediaError);
    expect(() => buildFilterGraph(documentWith([tooLong]), { preset, assets })).toThrow(
      /needs source frames \[30, 430\) but asset asset-a has only 330/,
    );
  });

  it("accounts for speed when validating the source range", () => {
    // 400 timeline frames at 2x consume 800 source frames from a 400-frame asset.
    expect(() => buildFilterGraph(documentWith([clipB]), { preset, assets })).not.toThrow();
    const faster = clip({
      id: "clip-faster",
      trackId: v1.id,
      assetId: "asset-b",
      startFrame: 0,
      durationFrames: 300,
      properties: { speed: { num: 2, den: 1 } },
    });
    expect(() => buildFilterGraph(documentWith([faster]), { preset, assets })).toThrow(
      /needs source frames \[0, 600\) but asset asset-b has only 400/,
    );
  });

  it("rejects a clip with no asset", () => {
    const unlinked = ClipSchema.parse({
      id: "clip-unlinked",
      trackId: v1.id,
      sequenceId: sequence.id,
      startFrame: 0,
      durationFrames: 10,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(() => buildFilterGraph(documentWith([unlinked]), { preset, assets })).toThrow(
      /has no asset/,
    );
  });
});

describe("buildAtempoChain", () => {
  it("omits the stage at unity speed", () => {
    expect(buildAtempoChain(1)).toEqual([]);
  });

  it("passes through speeds inside atempo's single-step range", () => {
    expect(buildAtempoChain(2)).toEqual(["atempo=2"]);
    expect(buildAtempoChain(0.5)).toEqual(["atempo=0.5"]);
    expect(buildAtempoChain(1.5)).toEqual(["atempo=1.5"]);
  });

  it("chains speeds above 2.0", () => {
    expect(buildAtempoChain(4)).toEqual(["atempo=2", "atempo=2"]);
    expect(buildAtempoChain(3)).toEqual(["atempo=2", "atempo=1.5"]);
  });

  it("chains speeds below 0.5", () => {
    expect(buildAtempoChain(0.25)).toEqual(["atempo=0.5", "atempo=0.5"]);
    expect(buildAtempoChain(0.4)).toEqual(["atempo=0.5", "atempo=0.8"]);
  });

  it("rejects non-positive speeds", () => {
    expect(() => buildAtempoChain(0)).toThrow(MediaError);
  });
});

describe("numeric helpers", () => {
  it("formats filter numbers deterministically", () => {
    expect(formatFilterNumber(2)).toBe("2");
    expect(formatFilterNumber(1.001)).toBe("1.001");
    expect(formatFilterNumber(300 / 30_000)).toBe("0.01");
    expect(formatFilterNumber(1 / 3)).toBe("0.333333");
    expect(formatFilterNumber(-0)).toBe("0");
  });

  it("omits crop and rotation when they are identity", () => {
    expect(cropStage(clipB, 1920, 1080)).toBe("crop=1728:972:96:108");
    expect(cropStage(clipA, 1920, 1080)).toBeUndefined();
  });
});
