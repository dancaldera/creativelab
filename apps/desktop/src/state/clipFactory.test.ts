/**
 * Clip factory tests, including the storyboard guarantee that matters most:
 * **converting a storyboard to the timeline never flattens, merges or bakes anything.**
 *
 * The conversion is expressed with the same factory and overwrite rule as every other clip
 * insertion, so these tests cover both the factory and the "without flattening" requirement
 * (PRD §6).
 */
import { describe, expect, it } from "vitest";
import type { Clip, EditorDocument } from "@creativelab/core";
import { DEFAULT_CLIP_PROPERTIES } from "@creativelab/core";
import { createClip, defaultTrackFor, placeClip } from "./clipFactory";
import { clipEnd, createInitialDocument, sequenceDurationFrames } from "./coreOps";
import { createEditorStore } from "./editorStore";

const NOW = "2026-01-01T00:00:00.000Z";
const FPS = { num: 30, den: 1 };

function project() {
  return {
    id: "prj_000000000000000000000000",
    schemaVersion: 1,
    title: "Factory",
    fps: FPS,
    width: 1920,
    height: 1080,
    colorProfile: "bt709" as const,
    sampleRate: 48_000,
    channels: 2 as const,
    workspaceRelPath: ".",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function baseDocument(): EditorDocument {
  return createInitialDocument(project());
}

describe("createClip", () => {
  it("defaults to an identity transform, unity speed and no transitions", () => {
    const document = baseDocument();
    const track = defaultTrackFor(document, "video")!;
    const clip = createClip({
      trackId: track.id,
      sequenceId: track.sequenceId,
      startFrame: 10,
      durationFrames: 30,
    });
    expect(clip.properties).toEqual({ ...DEFAULT_CLIP_PROPERTIES, notes: "" });
    expect(clip.version).toBe(1);
    expect(clip.assetId).toBeNull();
    expect(clip.startFrame).toBe(10);
    expect(clip.sourceInFrame).toBe(0);
  });

  it("clamps impossible geometry instead of producing an invalid clip", () => {
    const document = baseDocument();
    const track = defaultTrackFor(document, "video")!;
    const clip = createClip({
      trackId: track.id,
      sequenceId: track.sequenceId,
      startFrame: -50,
      sourceInFrame: -12,
      durationFrames: 0,
    });
    expect(clip.startFrame).toBe(0);
    expect(clip.sourceInFrame).toBe(0);
    // A zero-length clip would violate the timeline invariant `durationFrames > 0`.
    expect(clip.durationFrames).toBe(1);
  });

  it("rounds fractional geometry to whole frames, never float seconds", () => {
    const document = baseDocument();
    const track = defaultTrackFor(document, "video")!;
    const clip = createClip({
      trackId: track.id,
      sequenceId: track.sequenceId,
      startFrame: 10.6,
      durationFrames: 29.4,
    });
    expect(Number.isInteger(clip.startFrame)).toBe(true);
    expect(Number.isInteger(clip.durationFrames)).toBe(true);
    expect(clip.startFrame).toBe(11);
    expect(clip.durationFrames).toBe(29);
  });

  it("applies a properties override on top of the defaults", () => {
    const document = baseDocument();
    const track = defaultTrackFor(document, "audio")!;
    const clip = createClip({
      trackId: track.id,
      sequenceId: track.sequenceId,
      startFrame: 0,
      durationFrames: 30,
      properties: {
        audio: { gainDb: -4, fadeInFrames: 6, fadeOutFrames: 0, enabled: true, pan: -0.3 },
      },
    });
    expect(clip.properties.audio.gainDb).toBe(-4);
    // The override must not drop the other groups.
    expect(clip.properties.transform.scale).toBe(1);
  });
});

describe("defaultTrackFor", () => {
  it("picks the lowest sortOrder unlocked track of the requested kind", () => {
    const document = baseDocument();
    const track = defaultTrackFor(document, "video")!;
    expect(track.kind).toBe("video");
    expect(track.sortOrder).toBe(0);
  });

  it("skips locked tracks", () => {
    const document = baseDocument();
    const videoTracks = document.tracks
      .filter((entry) => entry.kind === "video")
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const locked = {
      ...document,
      tracks: document.tracks.map((entry) =>
        entry.id === videoTracks[0]!.id ? { ...entry, locked: true } : entry,
      ),
    };
    expect(defaultTrackFor(locked, "video")!.id).toBe(videoTracks[1]!.id);
  });

  it("honours a preferred track only when it matches the kind and is unlocked", () => {
    const document = baseDocument();
    const videoTracks = document.tracks.filter((entry) => entry.kind === "video");
    const audio = document.tracks.find((entry) => entry.kind === "audio")!;
    expect(defaultTrackFor(document, "video", videoTracks[1]!.id)!.id).toBe(videoTracks[1]!.id);
    // A preferred track of the wrong kind falls back rather than creating an invalid clip.
    expect(defaultTrackFor(document, "video", audio.id)!.kind).toBe("video");
  });

  it("returns undefined when every track of the kind is locked", () => {
    const document = baseDocument();
    const allLocked = {
      ...document,
      tracks: document.tracks.map((entry) =>
        entry.kind === "video" ? { ...entry, locked: true } : entry,
      ),
    };
    expect(defaultTrackFor(allLocked, "video")).toBeUndefined();
  });
});

describe("placeClip", () => {
  it("clears exactly the destination range so no two clips overlap", () => {
    const document = baseDocument();
    const track = defaultTrackFor(document, "video")!;
    const existing = createClip({
      trackId: track.id,
      sequenceId: track.sequenceId,
      startFrame: 0,
      durationFrames: 100,
    });
    const withExisting = placeClip(document, existing);
    const incoming = createClip({
      trackId: track.id,
      sequenceId: track.sequenceId,
      startFrame: 40,
      durationFrames: 30,
    });
    const result = placeClip(withExisting, incoming);

    // The old clip is fully replaced inside [40, 70) and is gone entirely (it was swallowed).
    expect(result.clips.some((clip) => clip.id === existing.id)).toBe(false);
    const placed = result.clips.find((clip) => clip.id === incoming.id)!;
    expect(placed.startFrame).toBe(40);
    expect(clipEnd(placed)).toBe(70);
  });

  it("keeps clips on other tracks untouched", () => {
    const document = baseDocument();
    const video = defaultTrackFor(document, "video")!;
    const audio = defaultTrackFor(document, "audio")!;
    const audioClip = createClip({
      trackId: audio.id,
      sequenceId: audio.sequenceId,
      startFrame: 0,
      durationFrames: 60,
    });
    const withAudio = placeClip(document, audioClip);
    const videoClip = createClip({
      trackId: video.id,
      sequenceId: video.sequenceId,
      startFrame: 0,
      durationFrames: 60,
    });
    const result = placeClip(withAudio, videoClip);
    expect(result.clips).toHaveLength(2);
    expect(result.clips.some((clip) => clip.id === audioClip.id)).toBe(true);
  });
});

describe("storyboard conversion: creates clips without flattening", () => {
  interface Shot {
    label: string;
    durationSeconds: number;
    prompt: string;
    referenceAssetId: string | null;
  }

  /**
   * The exact conversion the storyboard view performs: one clip per shot, laid end to end on
   * the first unlocked video track. Nothing is merged and no rendered asset is produced.
   */
  function convertShots(
    document: EditorDocument,
    shots: Shot[],
  ): { document: EditorDocument; createdIds: string[] } {
    const track = defaultTrackFor(document, "video");
    if (!track) throw new Error("no track");
    let cursor = 0;
    let working = document;
    const createdIds: string[] = [];
    for (const shot of shots) {
      const clip = createClip({
        trackId: track.id,
        sequenceId: track.sequenceId,
        assetId: shot.referenceAssetId,
        label: shot.label,
        startFrame: cursor,
        durationFrames: Math.max(1, Math.round(shot.durationSeconds * (FPS.num / FPS.den))),
        notes: shot.prompt,
      });
      working = placeClip(working, clip);
      createdIds.push(clip.id);
      cursor = clipEnd(clip);
    }
    return { document: working, createdIds };
  }

  const shots: Shot[] = [
    {
      label: "Opening",
      durationSeconds: 4,
      prompt: "Wide establishing shot",
      referenceAssetId: null,
    },
    { label: "Subject", durationSeconds: 3, prompt: "Medium shot", referenceAssetId: null },
    { label: "Detail", durationSeconds: 2.5, prompt: "Macro detail", referenceAssetId: null },
    { label: "Payoff", durationSeconds: 4.5, prompt: "Reverse angle", referenceAssetId: null },
  ];

  it("produces one distinct clip per shot, never a single merged clip", () => {
    const result = convertShots(baseDocument(), shots);
    expect(result.createdIds).toHaveLength(shots.length);
    expect(new Set(result.createdIds).size).toBe(shots.length);
    // The failure mode this guards against: one flattened clip covering the whole duration.
    expect(result.document.clips).toHaveLength(shots.length);
    for (const id of result.createdIds) {
      expect(result.document.clips.some((clip) => clip.id === id)).toBe(true);
    }
  });

  it("lays the shots end to end with no gaps and no overlaps", () => {
    const result = convertShots(baseDocument(), shots);
    const ordered = [...result.document.clips].sort((a, b) => a.startFrame - b.startFrame);
    let cursor = 0;
    for (const clip of ordered) {
      expect(clip.startFrame).toBe(cursor);
      cursor = clipEnd(clip);
    }
    expect(sequenceDurationFrames(result.document.clips)).toBe(cursor);
    // 4 + 3 + 2.5 + 4.5 seconds at 30 fps.
    expect(cursor).toBe(Math.round(14 * 30));
  });

  it("preserves each shot's prompt and label on its own clip", () => {
    const result = convertShots(baseDocument(), shots);
    for (const shot of shots) {
      const clip = result.document.clips.find((candidate) => candidate.label === shot.label);
      expect(clip).toBeDefined();
      expect(clip!.properties.notes).toBe(shot.prompt);
    }
  });

  it("each created clip stays independently editable and retains its own geometry", () => {
    const store = createEditorStore(baseDocument());
    const track = defaultTrackFor(store.getState().document, "video")!;
    store.getState().applyEdit("Storyboard: Opening", (current) =>
      placeClip(
        current,
        createClip({
          trackId: track.id,
          sequenceId: track.sequenceId,
          label: "Opening",
          startFrame: 0,
          durationFrames: 120,
        }),
      ),
    );
    store.getState().applyEdit("Storyboard: Subject", (current) =>
      placeClip(
        current,
        createClip({
          trackId: track.id,
          sequenceId: track.sequenceId,
          label: "Subject",
          startFrame: 120,
          durationFrames: 90,
        }),
      ),
    );
    expect(store.getState().document.clips).toHaveLength(2);

    const second = store.getState().document.clips.find((clip) => clip.label === "Subject")!;
    store.getState().moveClip(second.id, 300, { mode: "overwrite", disableSnap: true });
    const moved = store.getState().document.clips.find((clip: Clip) => clip.id === second.id)!;
    expect(moved.startFrame).toBe(300);
    // The first clip was not touched: that is what "not flattened" buys the user.
    expect(
      store.getState().document.clips.find((clip: Clip) => clip.label === "Opening")!.startFrame,
    ).toBe(0);
  });
});
