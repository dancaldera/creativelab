/**
 * Preview composition tests (FR-04: "Composition matches render for positioning and basic
 * transforms").
 *
 * `planFrame` is the geometry contract a renderer consumes, so testing it here is testing the
 * part of preview/render parity that can actually drift. Painting is not tested: what matters
 * is *which* clips are visible, in what order, and with what transform.
 */
import { describe, expect, it } from "vitest";
import type { Asset, Clip, EditorDocument, Track } from "@creativelab/core";
import { DEFAULT_CLIP_PROPERTIES } from "@creativelab/core";
import { audibleTracksAtFrame, clipsAtFrame, planFrame, sourceSecondsFor } from "./composeFrame";

const NOW = "2026-01-01T00:00:00.000Z";
const SEQUENCE_ID = "seq_000000000000000000000000";
const FPS = { num: 30, den: 1 };

function makeDocument(overrides: Partial<EditorDocument> = {}): EditorDocument {
  return {
    project: {
      id: "prj_000000000000000000000000",
      schemaVersion: 1,
      title: "Compose",
      fps: FPS,
      width: 1920,
      height: 1080,
      colorProfile: "bt709",
      sampleRate: 48_000,
      channels: 2,
      workspaceRelPath: ".",
      createdAt: NOW,
      updatedAt: NOW,
    },
    sequences: [
      {
        id: SEQUENCE_ID,
        projectId: "prj_000000000000000000000000",
        name: "Main",
        width: 1920,
        height: 1080,
        fps: FPS,
        durationFrames: 0,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    tracks: [
      track("trk_v1", "video", 0),
      track("trk_v2", "video", 1),
      track("trk_vhidden", "video", 2, { hidden: true }),
      track("trk_a1", "audio", 0),
      track("trk_c1", "caption", 0),
    ],
    clips: [],
    effects: [],
    keyframes: [],
    assets: [],
    ...overrides,
  };
}

function track(id: string, kind: Track["kind"], sortOrder: number, overrides: Partial<Track> = {}): Track {
  return {
    id,
    sequenceId: SEQUENCE_ID,
    kind,
    name: id,
    sortOrder,
    muted: false,
    locked: false,
    hidden: false,
    solo: false,
    volumeDb: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function clip(overrides: Partial<Clip> & { id: string; trackId: string }): Clip {
  return {
    id: overrides.id,
    trackId: overrides.trackId,
    sequenceId: SEQUENCE_ID,
    assetId: overrides.assetId ?? null,
    label: overrides.label ?? "clip",
    startFrame: overrides.startFrame ?? 0,
    sourceInFrame: overrides.sourceInFrame ?? 0,
    durationFrames: overrides.durationFrames ?? 30,
    properties: overrides.properties ?? DEFAULT_CLIP_PROPERTIES,
    version: overrides.version ?? 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function asset(overrides: Partial<Asset> & { id: string }): Asset {
  return {
    id: overrides.id,
    projectId: "prj_000000000000000000000000",
    mediaType: overrides.mediaType ?? "video",
    storageMode: overrides.storageMode ?? "copied",
    uri: overrides.uri ?? "/tmp/a.mp4",
    relativePath: overrides.relativePath ?? "assets/originals/a.mp4",
    sha256: null,
    bytes: overrides.bytes ?? 1,
    durationFrames: overrides.durationFrames ?? 300,
    width: overrides.width ?? 1920,
    height: overrides.height ?? 1080,
    sampleRate: null,
    channels: null,
    fps: FPS,
    codec: "h264",
    container: "mp4",
    origin: overrides.origin ?? "imported",
    parentAssetId: null,
    generationJobId: overrides.generationJobId ?? null,
    promptRevisionId: overrides.promptRevisionId ?? null,
    probe: overrides.probe ?? null,
    missingAt: overrides.missingAt ?? null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("clipsAtFrame", () => {
  it("uses a half-open range: the clip end frame belongs to the next clip", () => {
    const document = makeDocument({ clips: [clip({ id: "clp_a", trackId: "trk_v1", startFrame: 10, durationFrames: 20 })] });
    expect(clipsAtFrame(document, 9)).toHaveLength(0);
    expect(clipsAtFrame(document, 10)).toHaveLength(1);
    expect(clipsAtFrame(document, 29)).toHaveLength(1);
    expect(clipsAtFrame(document, 30)).toHaveLength(0);
  });
});

describe("planFrame", () => {
  it("reports the sequence dimensions so the preview box matches the render", () => {
    const plan = planFrame(makeDocument(), 0);
    expect(plan.width).toBe(1920);
    expect(plan.height).toBe(1080);
    expect(plan.frame).toBe(0);
  });

  it("excludes hidden tracks and audio, and keeps video layers", () => {
    const document = makeDocument({
      clips: [
        clip({ id: "clp_v1", trackId: "trk_v1", durationFrames: 60 }),
        clip({ id: "clp_v2", trackId: "trk_v2", durationFrames: 60 }),
        clip({ id: "clp_hidden", trackId: "trk_vhidden", durationFrames: 60 }),
        clip({ id: "clp_audio", trackId: "trk_a1", durationFrames: 60 }),
      ],
    });
    const plan = planFrame(document, 30);
    expect(plan.layers.map((layer) => layer.clipId).sort()).toEqual(["clp_v1", "clp_v2"]);
  });

  it("paints later sortOrder behind earlier ones, so V1 composites on top", () => {
    const document = makeDocument({
      clips: [
        clip({ id: "clp_v1", trackId: "trk_v1", durationFrames: 60 }),
        clip({ id: "clp_v2", trackId: "trk_v2", durationFrames: 60 }),
      ],
    });
    const plan = planFrame(document, 10);
    expect(plan.layers.map((layer) => layer.clipId)).toEqual(["clp_v2", "clp_v1"]);
  });

  it("carries transform, crop and opacity through unchanged", () => {
    const document = makeDocument({
      clips: [
        clip({
          id: "clp_a",
          trackId: "trk_v1",
          durationFrames: 60,
          properties: {
            ...DEFAULT_CLIP_PROPERTIES,
            transform: { x: 120, y: -40, scale: 1.5, rotation: 12, opacity: 0.4, flipX: true, flipY: false },
            crop: { top: 0.1, right: 0.2, bottom: 0.05, left: 0.15 },
          },
        }),
      ],
    });
    const [layer] = planFrame(document, 0).layers;
    expect(layer!.transform).toEqual({ x: 120, y: -40, scale: 1.5, rotation: 12, flipX: true, flipY: false });
    expect(layer!.crop).toEqual({ top: 0.1, right: 0.2, bottom: 0.05, left: 0.15 });
    expect(layer!.opacity).toBe(0.4);
  });

  it("flags a clip whose asset is offline instead of dropping it silently", () => {
    const document = makeDocument({
      assets: [asset({ id: "ast_gone", missingAt: NOW })],
      clips: [clip({ id: "clp_a", trackId: "trk_v1", assetId: "ast_gone", durationFrames: 60 })],
    });
    const plan = planFrame(document, 5);
    expect(plan.layers).toHaveLength(1);
    expect(plan.layers[0]!.missing).toBe(true);
    expect(plan.hasMissingMedia).toBe(true);
  });

  it("flags a clip with no asset at all", () => {
    const document = makeDocument({ clips: [clip({ id: "clp_a", trackId: "trk_v1", assetId: null, durationFrames: 10 })] });
    const plan = planFrame(document, 0);
    expect(plan.layers[0]!.missing).toBe(true);
    expect(plan.layers[0]!.mediaType).toBe("placeholder");
  });

  it("collects caption text for the burn-in preview", () => {
    const document = makeDocument({
      clips: [
        clip({
          id: "clp_c",
          trackId: "trk_c1",
          durationFrames: 60,
          label: "spoken line",
          properties: { ...DEFAULT_CLIP_PROPERTIES, notes: "Local-first editing" },
        }),
      ],
    });
    const plan = planFrame(document, 10);
    expect(plan.captions).toEqual(["Local-first editing"]);
    // Captions are not video layers.
    expect(plan.layers).toHaveLength(0);
  });
});

describe("sourceSecondsFor", () => {
  it("maps a timeline frame onto the source timecode of the asset", () => {
    const clipA = clip({ id: "clp_a", trackId: "trk_v1", startFrame: 100, sourceInFrame: 30, durationFrames: 60 });
    // 10 frames past the clip start + 30 source frames in = source frame 40 = 1.333s at 30fps.
    expect(sourceSecondsFor(clipA, 110, asset({ id: "ast_a" }), FPS)).toBeCloseTo(40 / 30, 9);
    expect(sourceSecondsFor(clipA, 100, asset({ id: "ast_a" }), FPS)).toBeCloseTo(1, 9);
  });

  it("accounts for clip speed", () => {
    const fast = clip({
      id: "clp_fast",
      trackId: "trk_v1",
      startFrame: 0,
      sourceInFrame: 0,
      durationFrames: 60,
      properties: { ...DEFAULT_CLIP_PROPERTIES, speed: { num: 2, den: 1 } },
    });
    // 10 output frames at 2x consume 20 source frames.
    expect(sourceSecondsFor(fast, 10, asset({ id: "ast_a" }), FPS)).toBeCloseTo(20 / 30, 9);
  });

  it("clamps to the last frame the asset actually has", () => {
    const long = clip({ id: "clp_l", trackId: "trk_v1", startFrame: 0, sourceInFrame: 0, durationFrames: 600 });
    const short = asset({ id: "ast_short", durationFrames: 45 });
    const seconds = sourceSecondsFor(long, 500, short, FPS);
    // Never ask the decoder for frame 500 of a 45-frame asset.
    expect(seconds).toBeCloseTo(44 / 30, 9);
  });
});

describe("audibleTracksAtFrame", () => {
  const withAudio = () =>
    makeDocument({
      clips: [
        clip({ id: "clp_a1", trackId: "trk_a1", startFrame: 0, durationFrames: 60 }),
        clip({ id: "clp_a2", trackId: "trk_a2", startFrame: 0, durationFrames: 60 }),
      ],
      tracks: [
        track("trk_v1", "video", 0),
        track("trk_a1", "audio", 0),
        track("trk_a2", "audio", 1),
      ],
    });

  it("honours mute", () => {
    const document = withAudio();
    document.tracks = document.tracks.map((entry) => (entry.id === "trk_a1" ? { ...entry, muted: true } : entry));
    expect(audibleTracksAtFrame(document, 10).map((entry) => entry.id)).toEqual(["trk_a2"]);
  });

  it("solo silences every other audio track, including muted ones", () => {
    const document = withAudio();
    document.tracks = document.tracks.map((entry) =>
      entry.id === "trk_a2" ? { ...entry, solo: true } : entry.id === "trk_a1" ? { ...entry, muted: true } : entry,
    );
    expect(audibleTracksAtFrame(document, 10).map((entry) => entry.id)).toEqual(["trk_a2"]);
  });

  it("excludes a track with no clip under the playhead", () => {
    const document = withAudio();
    expect(audibleTracksAtFrame(document, 500)).toEqual([]);
  });
});
