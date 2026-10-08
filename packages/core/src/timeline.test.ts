import { describe, expect, it } from "vitest";
import {
  addTrack,
  assertTimelineInvariants,
  clipAtFrame,
  clipEnd,
  clipsOnTrack,
  closeGaps,
  collectSnapTargets,
  createInitialDocument,
  deleteClips,
  detectOverlaps,
  duplicateClips,
  moveClip,
  removeTrack,
  reorderTrack,
  sequenceDurationFrames,
  setClipProperties,
  snapClipMove,
  snapFrame,
  sortClips,
  sourceRange,
  splitClip,
  TimelineError,
  trimClip,
  updateTrack,
} from "../src/timeline.js";
import { ClipSchema, ProjectSchema, type Clip, type EditorDocument } from "../src/schema.js";
import { newId } from "../src/ids.js";
import { frameRate } from "../src/timebase.js";

const NOW = "2026-01-01T00:00:00.000Z";
const FPS = frameRate(30, 1);

function makeDocument(): EditorDocument {
  const project = ProjectSchema.parse({
    id: "prj_test000000000000000001",
    schemaVersion: 1,
    title: "Timeline fixture",
    fps: FPS,
    width: 1920,
    height: 1080,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return createInitialDocument(project);
}

function videoTracks(document: EditorDocument) {
  return document.tracks
    .filter((track) => track.kind === "video")
    .sort((a, b) => a.sortOrder - b.sortOrder);
}
function audioTracks(document: EditorDocument) {
  return document.tracks
    .filter((track) => track.kind === "audio")
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

interface ClipOverrides {
  sourceInFrame?: number;
  speed?: { num: number; den: number };
  label?: string;
  id?: string;
  opacity?: number;
  x?: number;
}

function makeClip(
  document: EditorDocument,
  trackId: string,
  startFrame: number,
  durationFrames: number,
  overrides: ClipOverrides = {},
): Clip {
  const sequenceId = document.tracks.find((track) => track.id === trackId)!.sequenceId;
  return ClipSchema.parse({
    id: overrides.id ?? newId("clip"),
    trackId,
    sequenceId,
    startFrame,
    sourceInFrame: overrides.sourceInFrame ?? 0,
    durationFrames,
    label: overrides.label ?? "",
    properties: {
      speed: overrides.speed ?? { num: 1, den: 1 },
      transform: { opacity: overrides.opacity ?? 1, x: overrides.x ?? 0 },
    },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function withClips(document: EditorDocument, clips: Clip[]): EditorDocument {
  return { ...document, clips };
}

describe("createInitialDocument", () => {
  it("satisfies the FR-03 minimum of 3 video and 4 audio tracks", () => {
    const document = makeDocument();
    expect(document.tracks.filter((track) => track.kind === "video")).toHaveLength(3);
    expect(document.tracks.filter((track) => track.kind === "audio")).toHaveLength(4);
    expect(document.tracks.filter((track) => track.kind === "caption")).toHaveLength(1);
    expect(document.sequences).toHaveLength(1);
    expect(document.sequences[0]!.isActive).toBe(true);
    expect(() => assertTimelineInvariants(document)).not.toThrow();
  });

  it("names tracks in NLE convention and orders them contiguously", () => {
    const document = makeDocument();
    expect(videoTracks(document).map((track) => track.name)).toEqual(["V1", "V2", "V3"]);
    expect(audioTracks(document).map((track) => track.name)).toEqual(["A1", "A2", "A3", "A4"]);
    expect(videoTracks(document).map((track) => track.sortOrder)).toEqual([0, 1, 2]);
  });
});

describe("splitClip (FR-03)", () => {
  it("splits a clip into two with contiguous source offsets", () => {
    const document = makeDocument();
    const track = videoTracks(document)[0]!.id;
    const clip = makeClip(document, track, 0, 100, { sourceInFrame: 10, label: "shot-1" });

    const result = splitClip([clip], clip.id, 40, NOW);

    expect(result.clips).toHaveLength(2);
    const [left, right] = sortClips(result.clips) as [Clip, Clip];
    expect(left.id).toBe(clip.id);
    expect([left.startFrame, left.durationFrames, left.sourceInFrame]).toEqual([0, 40, 10]);
    expect(right.id).toBe(result.rightId);
    expect([right.startFrame, right.durationFrames, right.sourceInFrame]).toEqual([40, 60, 50]);
    // The cut is lossless: the two halves cover exactly the original timeline span.
    expect(clipEnd(left)).toBe(right.startFrame);
    expect(clipEnd(right)).toBe(clipEnd(clip));
    expect(left.durationFrames + right.durationFrames).toBe(clip.durationFrames);
  });

  it("advances the source offset by the retimed amount for speed-adjusted clips", () => {
    const document = makeDocument();
    const track = videoTracks(document)[0]!.id;
    // 2x speed: 40 timeline frames consume 80 source frames.
    const clip = makeClip(document, track, 0, 100, {
      sourceInFrame: 10,
      speed: { num: 2, den: 1 },
    });

    const result = splitClip([clip], clip.id, 40, NOW);
    const right = result.clips.find((candidate) => candidate.id === result.rightId)!;

    expect(right.sourceInFrame).toBe(10 + 80);
    expect(sourceRange(right).end - sourceRange(clip).start).toBeLessThanOrEqual(
      sourceRange(clip).end - sourceRange(clip).start,
    );
  });

  it("bumps the version so downstream caches invalidate", () => {
    const document = makeDocument();
    const clip = makeClip(document, videoTracks(document)[0]!.id, 0, 100);
    const result = splitClip([clip], clip.id, 50, NOW);
    expect(result.clips.every((candidate) => candidate.version === clip.version + 1)).toBe(true);
  });

  it("refuses to split outside or exactly on a clip boundary", () => {
    const document = makeDocument();
    const clip = makeClip(document, videoTracks(document)[0]!.id, 10, 50);
    expect(() => splitClip([clip], clip.id, 10)).toThrow(TimelineError);
    expect(() => splitClip([clip], clip.id, 60)).toThrow(TimelineError);
    expect(() => splitClip([clip], clip.id, 5)).toThrow(TimelineError);
    expect(() => splitClip([clip], "clp_missing000000000000", 20)).toThrow(TimelineError);
  });

  it("leaves every other clip untouched", () => {
    const document = makeDocument();
    const track = videoTracks(document)[0]!.id;
    const other = makeClip(document, videoTracks(document)[1]!.id, 0, 30);
    const target = makeClip(document, track, 0, 100);
    const result = splitClip([target, other], target.id, 50, NOW);
    expect(result.clips.find((candidate) => candidate.id === other.id)).toBe(other);
  });
});

describe("trimClip (FR-03)", () => {
  it("trims the tail without moving the head", () => {
    const document = makeDocument();
    const clip = makeClip(document, videoTracks(document)[0]!.id, 0, 100);
    const [trimmed] = trimClip([clip], clip.id, "end", 60, {}, NOW);
    expect([trimmed!.startFrame, trimmed!.durationFrames, trimmed!.sourceInFrame]).toEqual([
      0, 60, 0,
    ]);
  });

  it("trims the head by advancing the source offset", () => {
    const document = makeDocument();
    const clip = makeClip(document, videoTracks(document)[0]!.id, 0, 100);
    const [trimmed] = trimClip([clip], clip.id, "start", 20, {}, NOW);
    expect([trimmed!.startFrame, trimmed!.durationFrames, trimmed!.sourceInFrame]).toEqual([
      20, 80, 20,
    ]);
    // Head trimming never changes the source tail.
    expect(sourceRange(trimmed!).end).toBe(sourceRange(clip).end);
  });

  it("clamps the tail to the end of the source asset", () => {
    const document = makeDocument();
    const clip = makeClip(document, videoTracks(document)[0]!.id, 0, 100);
    const [trimmed] = trimClip([clip], clip.id, "end", 500, { sourceDurationFrames: 80 }, NOW);
    expect(trimmed!.durationFrames).toBe(80);
  });

  it("clamps a head extension at the first frame of the source", () => {
    const document = makeDocument();
    const clip = makeClip(document, videoTracks(document)[0]!.id, 100, 100, { sourceInFrame: 10 });
    // Only 10 source frames exist before sourceInFrame, so the head can move left by 10.
    const [trimmed] = trimClip([clip], clip.id, "start", 0, {}, NOW);
    expect([trimmed!.startFrame, trimmed!.sourceInFrame, trimmed!.durationFrames]).toEqual([
      90, 0, 110,
    ]);
    expect(sourceRange(trimmed!).end).toBe(sourceRange(clip).end);
  });

  it("enforces the minimum clip duration", () => {
    const document = makeDocument();
    const clip = makeClip(document, videoTracks(document)[0]!.id, 0, 100);
    const [trimmed] = trimClip([clip], clip.id, "end", 5, { minDurationFrames: 20 }, NOW);
    expect(trimmed!.durationFrames).toBe(20);
    const [headTrimmed] = trimClip([clip], clip.id, "start", 95, { minDurationFrames: 20 }, NOW);
    expect(headTrimmed!.durationFrames).toBe(20);
  });

  it("is a no-op when asked to trim to the current edge", () => {
    const document = makeDocument();
    const clip = makeClip(document, videoTracks(document)[0]!.id, 0, 100);
    const [trimmed] = trimClip([clip], clip.id, "end", 100, {}, NOW);
    expect([trimmed!.startFrame, trimmed!.durationFrames]).toEqual([0, 100]);
  });
});

describe("moveClip (FR-03)", () => {
  it("moves within a track in overwrite mode, clipping the neighbour's tail", () => {
    const document = makeDocument();
    const v1 = videoTracks(document)[0]!.id;
    const a = makeClip(document, v1, 0, 50, { label: "a" });
    const b = makeClip(document, v1, 100, 50, { label: "b" });

    const result = moveClip([a, b], document.tracks, { clipId: b.id, toStartFrame: 25 }, NOW);
    const moved = result.find((clip) => clip.id === b.id)!;
    const clipped = result.find((clip) => clip.id === a.id)!;

    expect(moved.startFrame).toBe(25);
    expect(moved.durationFrames).toBe(50);
    expect([clipped.startFrame, clipped.durationFrames]).toEqual([0, 25]);
    expect(detectOverlaps(result)).toHaveLength(0);
  });

  it("splits a clip that fully straddles the overwrite range", () => {
    const document = makeDocument();
    const v1 = videoTracks(document)[0]!.id;
    const v2 = videoTracks(document)[1]!.id;
    const long = makeClip(document, v1, 0, 100, { sourceInFrame: 0 });
    const moving = makeClip(document, v2, 500, 20, { sourceInFrame: 0 });

    const result = moveClip(
      [long, moving],
      document.tracks,
      { clipId: moving.id, toStartFrame: 40, toTrackId: v1 },
      NOW,
    );

    const remainders = result
      .filter((clip) => clip.id !== moving.id)
      .sort((x, y) => x.startFrame - y.startFrame);
    expect(remainders).toHaveLength(2);
    expect([remainders[0]!.startFrame, remainders[0]!.durationFrames]).toEqual([0, 40]);
    expect([remainders[1]!.startFrame, remainders[1]!.durationFrames]).toEqual([60, 40]);
    // The tail keeps its source continuity through the cut.
    expect(remainders[1]!.sourceInFrame).toBe(60);
    expect(detectOverlaps(result)).toHaveLength(0);
  });

  it("ripples later clips right in insert mode instead of overwriting", () => {
    const document = makeDocument();
    const v1 = videoTracks(document)[0]!.id;
    const v2 = videoTracks(document)[1]!.id;
    const first = makeClip(document, v1, 0, 50);
    const second = makeClip(document, v1, 100, 50);
    const incoming = makeClip(document, v2, 0, 30);

    const result = moveClip([first, second, incoming], document.tracks, {
      clipId: incoming.id,
      toTrackId: v1,
      toStartFrame: 60,
      mode: "insert",
    });

    expect(result.find((clip) => clip.id === first.id)!.startFrame).toBe(0);
    expect(result.find((clip) => clip.id === second.id)!.startFrame).toBe(130);
    expect(result.find((clip) => clip.id === incoming.id)!.startFrame).toBe(60);
    expect(detectOverlaps(result)).toHaveLength(0);
  });

  it("replaces exactly one overlapping neighbour in replace mode", () => {
    const document = makeDocument();
    const v1 = videoTracks(document)[0]!.id;
    const victim = makeClip(document, v1, 100, 50);
    const incoming = makeClip(document, videoTracks(document)[1]!.id, 0, 20);

    const result = moveClip([victim, incoming], document.tracks, {
      clipId: incoming.id,
      toTrackId: v1,
      toStartFrame: 110,
      mode: "replace",
    });

    expect(result.some((clip) => clip.id === victim.id)).toBe(false);
    expect(result).toHaveLength(1);
  });

  it("clamps a negative destination to frame zero", () => {
    const document = makeDocument();
    const clip = makeClip(document, videoTracks(document)[0]!.id, 100, 50);
    const result = moveClip([clip], document.tracks, { clipId: clip.id, toStartFrame: -500 }, NOW);
    expect(result[0]!.startFrame).toBe(0);
  });

  it("refuses to move onto a locked track", () => {
    const document = makeDocument();
    const locked = videoTracks(document)[1]!;
    const clip = makeClip(document, videoTracks(document)[0]!.id, 0, 50);
    const withLock = updateTrack(document, locked.id, { locked: true }, NOW);

    expect(() =>
      moveClip([clip], withLock.tracks, { clipId: clip.id, toTrackId: locked.id, toStartFrame: 0 }),
    ).toThrow(/locked/i);
    // The same move succeeds once the lock is released.
    expect(() =>
      moveClip([clip], document.tracks, { clipId: clip.id, toTrackId: locked.id, toStartFrame: 0 }),
    ).not.toThrow();
  });

  it("rejects unknown clips and tracks", () => {
    const document = makeDocument();
    const clip = makeClip(document, videoTracks(document)[0]!.id, 0, 50);
    expect(() =>
      moveClip([clip], document.tracks, { clipId: "clp_nope00000000000000", toStartFrame: 0 }),
    ).toThrow(TimelineError);
    expect(() =>
      moveClip([clip], document.tracks, {
        clipId: clip.id,
        toTrackId: "trk_nope00000000000000",
        toStartFrame: 0,
      }),
    ).toThrow(TimelineError);
  });
});

describe("deleteClips (FR-03)", () => {
  it("removes clips without touching the gap by default", () => {
    const document = makeDocument();
    const v1 = videoTracks(document)[0]!.id;
    const a = makeClip(document, v1, 0, 50);
    const b = makeClip(document, v1, 100, 50);

    const result = deleteClips([a, b], [a.id]);
    expect(result.map((clip) => clip.id)).toEqual([b.id]);
    expect(result[0]!.startFrame).toBe(100);
  });

  it("closes the gap in ripple mode", () => {
    const document = makeDocument();
    const v1 = videoTracks(document)[0]!.id;
    const a = makeClip(document, v1, 0, 50);
    const b = makeClip(document, v1, 100, 50);

    const result = deleteClips([a, b], [a.id], { ripple: true });
    expect(result[0]!.startFrame).toBe(50);
  });

  it("ripples only the tracks that lost clips", () => {
    const document = makeDocument();
    const v1 = videoTracks(document)[0]!.id;
    const v2 = videoTracks(document)[1]!.id;
    const a = makeClip(document, v1, 0, 50);
    const onV1 = makeClip(document, v1, 100, 50);
    const untouched = makeClip(document, v2, 100, 50);

    const result = deleteClips([a, onV1, untouched], [a.id], { ripple: true });
    expect(result.find((clip) => clip.id === onV1.id)!.startFrame).toBe(50);
    expect(result.find((clip) => clip.id === untouched.id)!.startFrame).toBe(100);
  });

  it("is a no-op for an empty selection", () => {
    const document = makeDocument();
    const clip = makeClip(document, videoTracks(document)[0]!.id, 0, 10);
    expect(deleteClips([clip], [])).toEqual([clip]);
  });
});

describe("duplicateClips and closeGaps (FR-03)", () => {
  it("places a duplicate immediately after its source", () => {
    const document = makeDocument();
    const v1 = videoTracks(document)[0]!.id;
    const clip = makeClip(document, v1, 20, 30);
    const { clips, newIds } = duplicateClips([clip], [clip.id], NOW);
    expect(newIds).toHaveLength(1);
    expect(clips.find((candidate) => candidate.id === newIds[0])!.startFrame).toBe(50);
    expect(clips.find((candidate) => candidate.id === newIds[0])!.sourceInFrame).toBe(
      clip.sourceInFrame,
    );
  });

  it("packs clips left, preserving order and durations", () => {
    const document = makeDocument();
    const v1 = videoTracks(document)[0]!.id;
    const a = makeClip(document, v1, 0, 50);
    const b = makeClip(document, v1, 100, 30);
    const c = makeClip(document, v1, 300, 20);

    const result = closeGaps([a, b, c], v1, NOW);
    const packed = clipsOnTrack(result, v1);
    expect(packed.map((clip) => [clip.startFrame, clip.durationFrames])).toEqual([
      [0, 50],
      [50, 30],
      [80, 20],
    ]);
  });
});

describe("snapping (PRD §6)", () => {
  it("collects clip edges, zero, the playhead and markers as targets", () => {
    const document = makeDocument();
    const v1 = videoTracks(document)[0]!.id;
    const a = makeClip(document, v1, 10, 40);
    const b = makeClip(document, v1, 100, 25);

    const targets = collectSnapTargets([a, b], { playheadFrame: 77, markers: [200] });
    expect(targets).toEqual([0, 10, 50, 77, 100, 125, 200]);
  });

  it("excludes the clips being dragged", () => {
    const document = makeDocument();
    const v1 = videoTracks(document)[0]!.id;
    const a = makeClip(document, v1, 10, 40);
    const b = makeClip(document, v1, 100, 25);
    expect(collectSnapTargets([a, b], { excludeClipIds: [a.id] })).toEqual([0, 100, 125]);
  });

  it("snaps within the threshold and leaves the frame alone outside it", () => {
    expect(snapFrame(48, [0, 50, 100], 3)).toEqual({ frame: 50, snapped: true, target: 50 });
    expect(snapFrame(60, [0, 50, 100], 3)).toEqual({ frame: 60, snapped: false });
    expect(snapFrame(48, [0, 50], 0)).toEqual({ frame: 48, snapped: false });
  });

  it("snaps a moved clip by whichever edge is closer", () => {
    // Head is 2 frames from 50, tail is 4 frames from 100 -> snap the head.
    expect(snapClipMove(48, 48, [50, 100], 6)).toEqual({ frame: 50, snapped: true, target: 50 });
    // Head is far, tail is 1 frame from 100 -> snap the tail, moving the start back.
    expect(snapClipMove(50, 51, [0, 100], 3)).toEqual({ frame: 49, snapped: true, target: 100 });
  });

  it("never returns a negative start frame", () => {
    expect(snapClipMove(1, 100, [0], 50).frame).toBeGreaterThanOrEqual(0);
  });

  it("rejects a non-finite frame rather than producing NaN geometry", () => {
    expect(() => snapFrame(Number.NaN, [0], 5)).toThrow(TimelineError);
  });
});

describe("invariants (PRD §10)", () => {
  it("detects and reports overlaps with their frame count", () => {
    const document = makeDocument();
    const v1 = videoTracks(document)[0]!.id;
    const a = makeClip(document, v1, 0, 100);
    const b = makeClip(document, v1, 60, 100);

    const overlaps = detectOverlaps([a, b]);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]!.frames).toBe(40);
    expect(overlaps[0]!.trackId).toBe(v1);
    expect(() => assertTimelineInvariants(withClips(document, [a, b]))).toThrow(/overlap/i);
  });

  it("allows clips to overlap across different tracks", () => {
    const document = makeDocument();
    const a = makeClip(document, videoTracks(document)[0]!.id, 0, 100);
    const b = makeClip(document, videoTracks(document)[1]!.id, 0, 100);
    expect(detectOverlaps([a, b])).toHaveLength(0);
    expect(() => assertTimelineInvariants(withClips(document, [a, b]))).not.toThrow();
  });

  it("rejects a clip on an unknown track or a mismatched sequence", () => {
    const document = makeDocument();
    const orphan = ClipSchema.parse({
      id: newId("clip"),
      trackId: "trk_ghost00000000000000",
      sequenceId: document.sequences[0]!.id,
      startFrame: 0,
      durationFrames: 10,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(() => assertTimelineInvariants(withClips(document, [orphan]))).toThrow(/unknown track/i);

    // Keep the tracks (so they resolve) but drop the sequences they point at.
    const mismatched = makeClip(document, videoTracks(document)[0]!.id, 0, 10);
    expect(() =>
      assertTimelineInvariants({ ...document, sequences: [], clips: [mismatched] }),
    ).toThrow(/unknown sequence/i);
  });

  it("rejects duplicate clip ids", () => {
    const document = makeDocument();
    const clip = makeClip(document, videoTracks(document)[0]!.id, 0, 10);
    expect(() => assertTimelineInvariants(withClips(document, [clip, clip]))).toThrow(
      /duplicate clip id/i,
    );
  });

  it("rejects non-integer and non-positive geometry", () => {
    const document = makeDocument();
    const clip = makeClip(document, videoTracks(document)[0]!.id, 0, 10);
    expect(() =>
      assertTimelineInvariants(withClips(document, [{ ...clip, startFrame: 1.5 }])),
    ).toThrow(/non-integer/i);
    expect(() =>
      assertTimelineInvariants(withClips(document, [{ ...clip, durationFrames: 0 }])),
    ).toThrow(/positive integer duration/i);
  });
});

describe("track management (FR-03)", () => {
  it("adds a track and reports the limit instead of silently ignoring the request", () => {
    let document = makeDocument();
    const added = addTrack(document, "video", NOW);
    document = added.document;
    expect(document.tracks.filter((track) => track.kind === "video")).toHaveLength(4);
    expect(added.track.name).toBe("V4");

    // Fill up to the configured limit, then expect a refusal.
    for (
      let index = document.tracks.filter((track) => track.kind === "video").length;
      index < 8;
      index += 1
    ) {
      document = addTrack(document, "video", NOW).document;
    }
    expect(() => addTrack(document, "video", NOW)).toThrow(/limit reached/i);
  });

  it("removes a track together with its clips but never the last one of a kind", () => {
    const document = makeDocument();
    const audio = audioTracks(document)[0]!;
    const clip = makeClip(document, audio.id, 0, 10);
    const withClip = withClips(document, [clip]);

    const trimmed = removeTrack(withClip, audio.id);
    expect(trimmed.tracks.some((track) => track.id === audio.id)).toBe(false);
    expect(trimmed.clips).toHaveLength(0);
    expect(() => removeTrack(trimmed, audioTracks(trimmed)[2]!.id)).not.toThrow();
  });

  it("reorders tracks within their kind and renumbers contiguously", () => {
    const document = makeDocument();
    const [first, second, third] = videoTracks(document);
    const reordered = reorderTrack(document, third!.id, -1, NOW);
    const names = videoTracks(reordered).map((track) => track.name);
    expect(names).toEqual(["V1", "V3", "V2"]);
    expect(videoTracks(reordered).map((track) => track.sortOrder)).toEqual([0, 1, 2]);
    expect(reordered.tracks.find((track) => track.id === first!.id)!.sortOrder).toBe(0);
    expect(reordered.tracks.find((track) => track.id === second!.id)!.sortOrder).toBe(2);
    // Reordering past the end is a no-op rather than an error.
    expect(reorderTrack(reordered, third!.id, -5)).toBe(reordered);
  });

  it("updates flags without being able to change a track's identity", () => {
    const document = makeDocument();
    const track = videoTracks(document)[0]!;
    const updated = updateTrack(
      document,
      track.id,
      { muted: true, locked: true, name: "Main" },
      NOW,
    );
    const patched = updated.tracks.find((candidate) => candidate.id === track.id)!;
    expect([patched.muted, patched.locked, patched.name]).toEqual([true, true, "Main"]);
    expect(patched.sequenceId).toBe(track.sequenceId);
  });
});

describe("setClipProperties", () => {
  it("deep-merges a nested patch and preserves untouched groups", () => {
    const document = makeDocument();
    const clip = makeClip(document, videoTracks(document)[0]!.id, 0, 30, { opacity: 1 });
    const [patched] = setClipProperties(
      [clip],
      clip.id,
      { transform: { opacity: 0.4 }, audio: { gainDb: -6 } },
      NOW,
    );

    expect(patched!.properties.transform.opacity).toBe(0.4);
    expect(patched!.properties.audio.gainDb).toBe(-6);
    // Untouched sibling fields survive the merge.
    expect(patched!.properties.transform.scale).toBe(1);
    expect(patched!.properties.speed).toEqual({ num: 1, den: 1 });
    expect(patched!.version).toBe(clip.version + 1);
  });

  it("rejects out-of-range values instead of clamping silently", () => {
    const document = makeDocument();
    const clip = makeClip(document, videoTracks(document)[0]!.id, 0, 30);
    expect(() => setClipProperties([clip], clip.id, { transform: { opacity: 5 } })).toThrow();
  });
});

describe("queries", () => {
  it("finds the clip under a frame and reports sequence duration", () => {
    const document = makeDocument();
    const v1 = videoTracks(document)[0]!.id;
    const a = makeClip(document, v1, 0, 50);
    const b = makeClip(document, v1, 100, 50);
    const clips = [a, b];

    expect(clipAtFrame(clips, v1, 0)?.id).toBe(a.id);
    expect(clipAtFrame(clips, v1, 49)?.id).toBe(a.id);
    expect(clipAtFrame(clips, v1, 50)).toBeUndefined();
    expect(clipAtFrame(clips, v1, 149)?.id).toBe(b.id);
    expect(clipAtFrame(clips, v1, 150)).toBeUndefined();
    expect(sequenceDurationFrames(clips)).toBe(150);
    expect(clipEnd(b)).toBe(150);
  });
});
