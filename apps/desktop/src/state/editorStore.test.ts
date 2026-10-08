/**
 * Editor store tests.
 *
 * These are pure-logic tests (no DOM): they drive the store exactly the way the UI does and
 * assert the timeline geometry that undo/redo and the render graph depend on. Every mutation
 * goes through `applyEdit`, so a passing geometry test here is also a statement about undo
 * correctness.
 */
import { describe, expect, it } from "vitest";
import type { Asset, Clip, EditorDocument } from "@creativelab/core";
import { DEFAULT_CLIP_PROPERTIES } from "@creativelab/core";
import {
  DEFAULT_ZOOM_PX_PER_FRAME,
  MAX_ZOOM_PX_PER_FRAME,
  MIN_ZOOM_PX_PER_FRAME,
  createEditorStore,
} from "./editorStore";
import { clipEnd, createInitialDocument, newId } from "./coreOps";

const NOW = "2026-01-01T00:00:00.000Z";

function project() {
  return {
    id: "prj_000000000000000000000000",
    schemaVersion: 1,
    title: "Store test",
    fps: { num: 30, den: 1 },
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

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: overrides.id ?? newId("asset"),
    projectId: "prj_000000000000000000000000",
    mediaType: overrides.mediaType ?? "video",
    storageMode: overrides.storageMode ?? "copied",
    uri: overrides.uri ?? "/tmp/source.mp4",
    relativePath: overrides.relativePath ?? "assets/originals/source.mp4",
    sha256: overrides.sha256 ?? null,
    bytes: overrides.bytes ?? 1_000,
    durationFrames: overrides.durationFrames ?? 300,
    width: overrides.width ?? 1920,
    height: overrides.height ?? 1080,
    sampleRate: overrides.sampleRate ?? null,
    channels: overrides.channels ?? null,
    fps: overrides.fps ?? { num: 30, den: 1 },
    codec: overrides.codec ?? "h264",
    container: overrides.container ?? "mp4",
    origin: overrides.origin ?? "imported",
    parentAssetId: overrides.parentAssetId ?? null,
    generationJobId: overrides.generationJobId ?? null,
    promptRevisionId: overrides.promptRevisionId ?? null,
    probe: overrides.probe ?? null,
    missingAt: overrides.missingAt ?? null,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

function makeClip(overrides: Partial<Clip> & { trackId: string }): Clip {
  return {
    id: overrides.id ?? newId("clip"),
    trackId: overrides.trackId,
    sequenceId: overrides.sequenceId ?? "seq_000000000000000000000000",
    assetId: overrides.assetId ?? null,
    label: overrides.label ?? "clip",
    startFrame: overrides.startFrame ?? 0,
    sourceInFrame: overrides.sourceInFrame ?? 0,
    durationFrames: overrides.durationFrames ?? 30,
    properties: overrides.properties ?? DEFAULT_CLIP_PROPERTIES,
    version: overrides.version ?? 1,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

type Store = ReturnType<typeof createEditorStore>;

interface Harness {
  store: Store;
  document: EditorDocument;
  videoTrackId: string;
  audioTrackId: string;
  /** Build a clip already keyed to a real track: `video` or `audio`. */
  clip: (kind: "video" | "audio", overrides?: Partial<Clip>) => Clip;
}

/**
 * Build a store whose document is loaded **through the store itself**, so the document and
 * the undo stack start in sync (loading via `setState` would leave the history pointing at a
 * different document and make every undo assertion meaningless).
 */
function setup(
  options: { clips?: Array<Partial<Clip> & { kind: "video" | "audio" }>; assets?: Asset[]; snap?: boolean } = {},
): Harness {
  const base = createInitialDocument(project());
  const videoTrackId = base.tracks.find((track) => track.kind === "video")!.id;
  const audioTrackId = base.tracks.find((track) => track.kind === "audio")!.id;
  const trackFor = (kind: "video" | "audio"): string => (kind === "video" ? videoTrackId : audioTrackId);

  const clips = (options?.clips ?? []).map(({ kind, ...overrides }) =>
    makeClip({ sequenceId: base.sequences[0]!.id, trackId: trackFor(kind), ...overrides }),
  );
  const document: EditorDocument = { ...base, clips, assets: options?.assets ?? [] };

  const store = createEditorStore(document);
  if (options?.snap === false) store.getState().toggleSnap();

  return {
    store,
    document,
    videoTrackId,
    audioTrackId,
    clip: (kind, overrides = {}) => makeClip({ trackId: trackFor(kind), sequenceId: base.sequences[0]!.id, ...overrides }),
  };
}

describe("editorStore: split at playhead", () => {
  it("produces two clips whose sourceInFrame accounts for the removed head", () => {
    const harness = setup({ clips: [{ kind: "video", id: "clp_whole", startFrame: 10, sourceInFrame: 100, durationFrames: 60 }] });
    const { store } = harness;
    const original = store.getState().document.clips[0]!;

    store.getState().setPlayhead(40);
    store.getState().splitAtPlayhead();

    const clips = store.getState().document.clips;
    expect(clips).toHaveLength(2);
    const left = clips.find((candidate) => candidate.startFrame === 10)!;
    const right = clips.find((candidate) => candidate.startFrame === 40)!;
    expect(left.durationFrames).toBe(30);
    expect(left.sourceInFrame).toBe(100);
    expect(right.durationFrames).toBe(30);
    // 30 frames of a 1:1 speed clip consumed → the source advances by exactly 30.
    expect(right.sourceInFrame).toBe(130);
    expect(clipEnd(right)).toBe(clipEnd(original));
    expect(left.trackId).toBe(right.trackId);
    // Both halves end up selected, so a follow-up trim is unambiguous.
    expect(store.getState().selection.size).toBe(2);
  });

  it("advances the source by the trimmed amount when a clip carries speed", () => {
    const harness = setup({ clips: [{ kind: "video", startFrame: 0, sourceInFrame: 0, durationFrames: 40 }] });
    const clip = harness.store.getState().document.clips[0]!;
    harness.store.getState().setClipProperties(clip.id, { speed: { num: 2, den: 1 } }, { coalesce: false });
    harness.store.getState().setPlayhead(20);
    harness.store.getState().splitAtPlayhead();
    const right = harness.store.getState().document.clips.find((candidate) => candidate.startFrame === 20)!;
    // 20 output frames at 2x speed consume 40 source frames.
    expect(right.sourceInFrame).toBe(40);
  });

  it("refuses to split when the playhead is not strictly inside a clip", () => {
    const harness = setup({ clips: [{ kind: "video", startFrame: 10, durationFrames: 20 }] });
    harness.store.getState().setPlayhead(10);
    harness.store.getState().splitAtPlayhead();
    expect(harness.store.getState().document.clips).toHaveLength(1);
    expect(harness.store.getState().lastError).toMatch(/nothing to split/i);
  });

  it("splits every clip under the playhead when nothing is selected", () => {
    const harness = setup({
      clips: [
        { kind: "video", startFrame: 0, durationFrames: 60 },
        { kind: "audio", startFrame: 0, durationFrames: 60 },
      ],
    });
    harness.store.getState().clearSelection();
    harness.store.getState().setPlayhead(30);
    harness.store.getState().splitAtPlayhead();
    expect(harness.store.getState().document.clips).toHaveLength(4);
  });

  it("never splits a clip on a locked track", () => {
    const harness = setup({ clips: [{ kind: "video", startFrame: 0, durationFrames: 60 }] });
    harness.store.getState().updateTrack(harness.videoTrackId, { locked: true }, { coalesce: false });
    harness.store.getState().clearSelection();
    harness.store.getState().setPlayhead(30);
    harness.store.getState().splitAtPlayhead();
    expect(harness.store.getState().document.clips).toHaveLength(1);
  });
});

describe("editorStore: trim clamps to source bounds", () => {
  it("cannot extend the head past source frame 0", () => {
    const harness = setup({ clips: [{ kind: "video", startFrame: 30, sourceInFrame: 5, durationFrames: 40 }] });
    const clip = harness.store.getState().document.clips[0]!;
    harness.store.getState().trimClipEdge(clip.id, "start", -100, { coalesce: false });
    const trimmed = harness.store.getState().document.clips[0]!;
    // Only 5 source frames exist before the in-point, so the head moves left by at most 5.
    expect(trimmed.startFrame).toBe(25);
    expect(trimmed.sourceInFrame).toBe(0);
    expect(trimmed.durationFrames).toBe(45);
    expect(clipEnd(trimmed)).toBe(clipEnd(clip));
  });

  it("cannot extend the tail past the end of the asset", () => {
    const asset = makeAsset({ id: "ast_000000000000000000000000", durationFrames: 40 });
    const harness = setup({
      clips: [{ kind: "video", assetId: asset.id, startFrame: 0, sourceInFrame: 10, durationFrames: 20 }],
      assets: [asset],
    });
    const clip = harness.store.getState().document.clips[0]!;
    harness.store.getState().trimClipEdge(clip.id, "end", 5000, { coalesce: false });
    const trimmed = harness.store.getState().document.clips[0]!;
    // 40 asset frames with sourceInFrame 10 → at most 30 output frames remain.
    expect(trimmed.durationFrames).toBe(30);
    expect(clipEnd(trimmed)).toBe(30);
  });

  it("cannot move the tail left past the asset start", () => {
    const asset = makeAsset({ id: "ast_000000000000000000000000", durationFrames: 40 });
    const harness = setup({
      clips: [{ kind: "video", assetId: asset.id, startFrame: 0, sourceInFrame: 10, durationFrames: 20 }],
      assets: [asset],
    });
    const clip = harness.store.getState().document.clips[0]!;
    harness.store.getState().trimClipEdge(clip.id, "end", 0, { coalesce: false });
    expect(harness.store.getState().document.clips[0]!.durationFrames).toBe(1);
  });

  it("never trims a clip below one frame", () => {
    const harness = setup({ clips: [{ kind: "video", startFrame: 0, durationFrames: 30 }] });
    const clip = harness.store.getState().document.clips[0]!;
    harness.store.getState().trimClipEdge(clip.id, "end", -10, { coalesce: false });
    expect(harness.store.getState().document.clips[0]!.durationFrames).toBe(1);
  });
});

describe("editorStore: move respects the edit mode", () => {
  it("overwrite clears the destination range and splits the neighbour's head off", () => {
    const harness = setup({
      clips: [
        { kind: "video", id: "clp_a", startFrame: 0, durationFrames: 30 },
        { kind: "video", id: "clp_b", startFrame: 100, durationFrames: 40 },
      ],
      snap: false,
    });
    const { store } = harness;
    const moving = store.getState().document.clips.find((clip) => clip.id === "clp_a")!;
    const stationary = store.getState().document.clips.find((clip) => clip.id === "clp_b")!;
    expect(moving.trackId).toBe(stationary.trackId);

    store.getState().setEditMode("overwrite");
    store.getState().moveClip(moving.id, 90, { mode: "overwrite" });

    const next = store.getState().document.clips.filter((clip) => clip.trackId === harness.videoTrackId);
    const moved = next.find((clip) => clip.id === moving.id)!;
    expect(moved.startFrame).toBe(90);
    expect(moved.durationFrames).toBe(30);

    // The stationary clip's head was overwritten; its right remainder survives from 120.
    expect(next.some((clip) => clip.id === stationary.id)).toBe(false);
    const remainder = next.find((clip) => clip.startFrame === 120);
    expect(remainder).toBeDefined();
    expect(remainder!.durationFrames).toBe(20);
    expect(remainder!.sourceInFrame).toBe(20);

    // Nothing on the track overlaps the destination range.
    const others = next.filter((clip) => clip.id !== moved.id);
    for (const clip of others) {
      expect(clip.startFrame < clipEnd(moved) && clipEnd(clip) > moved.startFrame).toBe(false);
    }
  });

  it("overwrite swallows a clip that is fully inside the destination range", () => {
    const harness = setup({
      clips: [
        { kind: "video", id: "clp_big", startFrame: 0, durationFrames: 100 },
        { kind: "video", id: "clp_small", startFrame: 50, durationFrames: 10 },
      ],
      snap: false,
    });
    const big = harness.store.getState().document.clips.find((clip) => clip.id === "clp_big")!;
    const small = harness.store.getState().document.clips.find((clip) => clip.id === "clp_small")!;
    harness.store.getState().moveClip(big.id, 40, { mode: "overwrite" });
    const next = harness.store.getState().document.clips;
    expect(next.some((clip) => clip.id === small.id)).toBe(false);
    expect(next.find((clip) => clip.id === big.id)!.startFrame).toBe(40);
  });

  it("insert ripples later clips right instead of deleting them", () => {
    const harness = setup({
      clips: [
        { kind: "video", id: "clp_a", startFrame: 0, durationFrames: 30 },
        { kind: "video", id: "clp_b", startFrame: 40, durationFrames: 20 },
      ],
      snap: false,
    });
    const moving = harness.store.getState().document.clips.find((clip) => clip.id === "clp_a")!;
    const stationary = harness.store.getState().document.clips.find((clip) => clip.id === "clp_b")!;

    harness.store.getState().moveClip(moving.id, 30, { mode: "insert" });

    const next = harness.store.getState().document.clips;
    expect(next).toHaveLength(2);
    expect(next.find((clip) => clip.id === moving.id)!.startFrame).toBe(30);
    const rippled = next.find((clip) => clip.id === stationary.id)!;
    expect(rippled.startFrame).toBe(40 + moving.durationFrames);
    expect(rippled.durationFrames).toBe(20);
  });

  it("replace swaps the clip onto one overlapping neighbour and keeps the count", () => {
    const harness = setup({
      clips: [
        { kind: "video", id: "clp_a", startFrame: 0, durationFrames: 30 },
        { kind: "video", id: "clp_b", startFrame: 60, durationFrames: 20 },
      ],
      snap: false,
    });
    harness.store.getState().moveClip("clp_a", 65, { mode: "replace" });
    const next = harness.store.getState().document.clips;
    expect(next.some((clip) => clip.id === "clp_b")).toBe(false);
    expect(next.find((clip) => clip.id === "clp_a")!.startFrame).toBe(65);
  });

  it("ignores a locked destination track and reports why", () => {
    const harness = setup({ clips: [{ kind: "video", startFrame: 0, durationFrames: 30 }] });
    const moving = harness.store.getState().document.clips[0]!;
    const otherVideo = harness.store.getState().document.tracks.filter((track) => track.kind === "video")[1]!;
    harness.store.getState().updateTrack(otherVideo.id, { locked: true }, { coalesce: false });
    harness.store.getState().moveClip(moving.id, 0, { toTrackId: otherVideo.id, disableSnap: true });
    expect(harness.store.getState().document.clips[0]!.trackId).toBe(moving.trackId);
    expect(harness.store.getState().lastError).toMatch(/locked/i);
  });

  it("moves a clip across tracks in overwrite mode", () => {
    const harness = setup({
      clips: [
        { kind: "video", id: "clp_a", startFrame: 0, durationFrames: 30 },
        { kind: "video", id: "clp_b", startFrame: 0, durationFrames: 30 },
      ],
      snap: false,
    });
    const target = harness.store.getState().document.tracks.filter((track) => track.kind === "video")[1]!;
    const moving = harness.store.getState().document.clips.find((clip) => clip.id === "clp_a")!;
    expect(target.id).not.toBe(moving.trackId);

    harness.store.getState().moveClip(moving.id, 10, { toTrackId: target.id, mode: "overwrite" });
    const moved = harness.store.getState().document.clips.find((clip) => clip.id === moving.id)!;
    expect(moved.trackId).toBe(target.id);
    expect(moved.startFrame).toBe(10);
    // The destination track's own clip was cleared, not the source track's.
    expect(harness.store.getState().document.clips.some((clip) => clip.trackId === target.id && clip.id !== moved.id)).toBe(false);
  });
});

describe("editorStore: undo and redo", () => {
  it("restores exact clip geometry across a multi-step edit", () => {
    const harness = setup({ clips: [{ kind: "video", startFrame: 0, sourceInFrame: 0, durationFrames: 60 }], snap: false });
    const { store } = harness;
    const original = structuredClone(store.getState().document.clips);

    store.getState().setPlayhead(30);
    store.getState().splitAtPlayhead();
    const afterSplit = structuredClone(store.getState().document.clips);
    expect(afterSplit).toHaveLength(2);

    const right = store.getState().document.clips.find((entry) => entry.startFrame === 30)!;
    store.getState().moveClip(right.id, 120, { mode: "overwrite" });
    const afterMove = structuredClone(store.getState().document.clips);
    expect(afterMove.find((entry) => entry.id === right.id)!.startFrame).toBe(120);

    store.getState().trimClipEdge(right.id, "end", 200, { coalesce: false });
    const afterTrim = structuredClone(store.getState().document.clips);
    expect(afterTrim.find((entry) => entry.id === right.id)!.durationFrames).toBe(80);

    store.getState().undo();
    expect(store.getState().document.clips).toEqual(afterMove);
    store.getState().undo();
    expect(store.getState().document.clips.map((entry) => [entry.id, entry.startFrame, entry.sourceInFrame, entry.durationFrames])).toEqual(
      afterSplit.map((entry) => [entry.id, entry.startFrame, entry.sourceInFrame, entry.durationFrames]),
    );
    store.getState().undo();
    expect(store.getState().document.clips).toEqual(original);
    expect(store.getState().history.canUndo).toBe(false);

    store.getState().redo();
    expect(store.getState().document.clips.map((entry) => [entry.id, entry.startFrame, entry.durationFrames])).toEqual(
      afterSplit.map((entry) => [entry.id, entry.startFrame, entry.durationFrames]),
    );
    store.getState().redo();
    store.getState().redo();
    expect(store.getState().document.clips).toEqual(afterTrim);
    expect(store.getState().history.canRedo).toBe(false);
  });

  it("coalesces repeated edits with the same label into one undo step", () => {
    const harness = setup({ clips: [{ kind: "video", startFrame: 0, durationFrames: 30 }] });
    const clip = harness.store.getState().document.clips[0]!;
    for (const opacity of [0.9, 0.8, 0.7]) {
      harness.store.getState().setClipProperties(clip.id, { transform: { opacity } }, { coalesce: true });
    }
    // `undoLabel` follows core's `History.state` convention: it names the snapshot that
    // `undo()` would travel back *to*, so three coalesced edits leave exactly one step whose
    // undo target is the initial state.
    expect(harness.store.getState().history.depth).toBe(1);
    expect(harness.store.getState().history.undoLabel).toBe("Initial state");
    harness.store.getState().undo();
    expect(harness.store.getState().history.canUndo).toBe(false);
    expect(harness.store.getState().document.clips[0]!.properties.transform.opacity).toBe(1);
  });

  it("keeps distinct labels as distinct undo steps", () => {
    const harness = setup({ clips: [{ kind: "video", startFrame: 0, durationFrames: 30 }] });
    const clip = harness.store.getState().document.clips[0]!;
    harness.store.getState().setClipProperties(clip.id, { transform: { opacity: 0.5 } }, { coalesce: false });
    harness.store.getState().trimClipEdge(clip.id, "end", 20, { coalesce: false });
    expect(harness.store.getState().history.depth).toBe(2);
    // Two distinct labels → two distinct undo steps, oldest first.
    expect(harness.store.getState().undoLabels).toEqual(["Initial state", "Adjust clip"]);
    harness.store.getState().undo();
    expect(harness.store.getState().document.clips[0]!.durationFrames).toBe(30);
    harness.store.getState().undo();
    expect(harness.store.getState().document.clips[0]!.properties.transform.opacity).toBe(1);
  });

  it("drops the redo branch as soon as a new edit lands", () => {
    const harness = setup({ clips: [{ kind: "video", startFrame: 0, durationFrames: 30 }] });
    const clip = harness.store.getState().document.clips[0]!;
    harness.store.getState().trimClipEdge(clip.id, "end", 20, { coalesce: false });
    expect(harness.store.getState().history.canUndo).toBe(true);
    harness.store.getState().undo();
    expect(harness.store.getState().history.canRedo).toBe(true);
    harness.store.getState().trimClipEdge(clip.id, "end", 10, { coalesce: false });
    expect(harness.store.getState().history.canRedo).toBe(false);
  });

  it("prunes selection entries that no longer exist after an undo", () => {
    const harness = setup({ clips: [{ kind: "video", id: "clp_original", startFrame: 0, durationFrames: 60 }] });
    harness.store.getState().setPlayhead(30);
    harness.store.getState().splitAtPlayhead();
    expect(harness.store.getState().selection.size).toBe(2);
    harness.store.getState().undo();
    // The left half keeps the original clip id, so it survives the prune; the generated right
    // half no longer exists and must be dropped rather than left dangling in the selection.
    const selection = harness.store.getState().selection;
    expect(selection.size).toBe(1);
    expect([...selection][0]).toBe("clp_original");
  });

  it("loadDocument clears history rather than making a project load undoable", () => {
    const harness = setup({ clips: [{ kind: "video", startFrame: 0, durationFrames: 30 }] });
    const clip = harness.store.getState().document.clips[0]!;
    harness.store.getState().trimClipEdge(clip.id, "end", 20, { coalesce: false });
    harness.store.getState().loadDocument(createInitialDocument(project()), "/tmp/other");
    expect(harness.store.getState().history.canUndo).toBe(false);
    expect(harness.store.getState().history.canRedo).toBe(false);
    expect(harness.store.getState().document.clips).toHaveLength(0);
    expect(harness.store.getState().workspacePath).toBe("/tmp/other");
  });
});

describe("editorStore: selection and delete", () => {
  it("deletes the selected clips and prunes the selection", () => {
    const harness = setup({
      clips: [
        { kind: "video", id: "clp_a", startFrame: 0, durationFrames: 30 },
        { kind: "video", id: "clp_b", startFrame: 40, durationFrames: 30 },
      ],
    });
    harness.store.getState().selectClips(["clp_a", "clp_b"]);
    harness.store.getState().deleteSelected();
    expect(harness.store.getState().document.clips).toHaveLength(0);
    expect(harness.store.getState().selection.size).toBe(0);
    harness.store.getState().undo();
    expect(harness.store.getState().document.clips).toHaveLength(2);
  });

  it("never deletes a clip living on a locked track", () => {
    const harness = setup({ clips: [{ kind: "video", startFrame: 0, durationFrames: 30 }] });
    const clip = harness.store.getState().document.clips[0]!;
    harness.store.getState().updateTrack(harness.videoTrackId, { locked: true }, { coalesce: false });
    harness.store.getState().selectClips([clip.id]);
    harness.store.getState().deleteSelected();
    expect(harness.store.getState().document.clips).toHaveLength(1);
  });

  it("ripple-deletes in insert mode, packing later clips left", () => {
    const harness = setup({
      clips: [
        { kind: "video", id: "clp_a", startFrame: 0, durationFrames: 30 },
        { kind: "video", id: "clp_b", startFrame: 30, durationFrames: 20 },
        { kind: "video", id: "clp_c", startFrame: 60, durationFrames: 10 },
      ],
      snap: false,
    });
    harness.store.getState().setEditMode("insert");
    harness.store.getState().selectClips(["clp_a"]);
    harness.store.getState().deleteSelected();
    const remaining = harness.store.getState().document.clips;
    expect(remaining).toHaveLength(2);
    expect(remaining.map((clip) => clip.startFrame)).toEqual([0, 30]);
  });

  it("leaves the gap in overwrite mode", () => {
    const harness = setup({
      clips: [
        { kind: "video", id: "clp_a", startFrame: 0, durationFrames: 30 },
        { kind: "video", id: "clp_b", startFrame: 30, durationFrames: 20 },
      ],
      snap: false,
    });
    harness.store.getState().setEditMode("overwrite");
    harness.store.getState().selectClips(["clp_a"]);
    harness.store.getState().deleteSelected();
    expect(harness.store.getState().document.clips[0]!.startFrame).toBe(30);
  });

  it("duplicates the selection immediately after the source clip's end", () => {
    const harness = setup({ clips: [{ kind: "video", id: "clp_a", startFrame: 10, durationFrames: 25 }] });
    harness.store.getState().selectClips(["clp_a"]);
    harness.store.getState().duplicateSelected();
    const clips = harness.store.getState().document.clips;
    expect(clips).toHaveLength(2);
    const copy = clips.find((clip) => clip.id !== "clp_a")!;
    expect(copy.startFrame).toBe(35);
    expect(copy.durationFrames).toBe(25);
    expect(harness.store.getState().selection.has(copy.id)).toBe(true);
  });

  it("toggles selection and clears it", () => {
    const harness = setup({ clips: [{ kind: "video", id: "clp_a", startFrame: 0, durationFrames: 30 }] });
    harness.store.getState().toggleSelection("clp_a");
    expect(harness.store.getState().selection.has("clp_a")).toBe(true);
    harness.store.getState().toggleSelection("clp_a");
    expect(harness.store.getState().selection.has("clp_a")).toBe(false);
    harness.store.getState().selectClips(["clp_a"]);
    harness.store.getState().clearSelection();
    expect(harness.store.getState().selection.size).toBe(0);
  });
});

describe("editorStore: zoom and playhead clamping", () => {
  it("clamps zoomBy to the supported range", () => {
    const harness = setup();
    expect(harness.store.getState().zoom).toBe(DEFAULT_ZOOM_PX_PER_FRAME);
    for (let i = 0; i < 60; i += 1) harness.store.getState().zoomBy(1.25);
    expect(harness.store.getState().zoom).toBe(MAX_ZOOM_PX_PER_FRAME);
    for (let i = 0; i < 200; i += 1) harness.store.getState().zoomBy(0.8);
    expect(harness.store.getState().zoom).toBe(MIN_ZOOM_PX_PER_FRAME);
  });

  it("clamps setZoom in both directions", () => {
    const harness = setup();
    harness.store.getState().setZoom(1e9);
    expect(harness.store.getState().zoom).toBe(MAX_ZOOM_PX_PER_FRAME);
    harness.store.getState().setZoom(-5);
    expect(harness.store.getState().zoom).toBe(MIN_ZOOM_PX_PER_FRAME);
    harness.store.getState().setZoom(3);
    expect(harness.store.getState().zoom).toBe(3);
  });

  it("clamps the playhead to the sequence duration", () => {
    const harness = setup({ clips: [{ kind: "video", startFrame: 0, durationFrames: 40 }] });
    harness.store.getState().setPlayhead(10_000);
    expect(harness.store.getState().playheadFrame).toBe(40);
    harness.store.getState().setPlayhead(-20);
    expect(harness.store.getState().playheadFrame).toBe(0);
  });

  it("clamps the monitor volume to [0, 1]", () => {
    const harness = setup();
    harness.store.getState().setVolume(4);
    expect(harness.store.getState().volume).toBe(1);
    harness.store.getState().setVolume(-1);
    expect(harness.store.getState().volume).toBe(0);
  });
});

describe("editorStore: tracks", () => {
  it("adds and removes tracks through the history stack", () => {
    const harness = setup();
    const before = harness.store.getState().document.tracks.length;
    const trackId = harness.store.getState().addTrack("video");
    expect(trackId).not.toBeNull();
    expect(harness.store.getState().document.tracks.length).toBe(before + 1);
    harness.store.getState().removeTrack(trackId!);
    expect(harness.store.getState().document.tracks.length).toBe(before);
    harness.store.getState().undo();
    expect(harness.store.getState().document.tracks.length).toBe(before + 1);
  });

  it("refuses to exceed the per-kind track limit", () => {
    const harness = setup();
    for (let i = 0; i < 20; i += 1) harness.store.getState().addTrack("caption");
    const captions = harness.store.getState().document.tracks.filter((track) => track.kind === "caption").length;
    expect(captions).toBe(4);
    expect(harness.store.getState().lastError).toMatch(/limit/i);
  });

  it("refuses to remove the last track of a kind", () => {
    const harness = setup();
    const caption = harness.store.getState().document.tracks.find((track) => track.kind === "caption")!;
    harness.store.getState().removeTrack(caption.id);
    expect(harness.store.getState().document.tracks.some((track) => track.id === caption.id)).toBe(true);
    expect(harness.store.getState().lastError).toMatch(/last caption track/i);
  });

  it("reorders a track within its own kind only", () => {
    const harness = setup();
    const videos = harness.store.getState().document.tracks.filter((track) => track.kind === "video");
    // FR-03 starts a project with three video tracks; moving V2 down swaps it with V3.
    expect(videos).toHaveLength(3);
    harness.store.getState().reorderTrack(videos[1]!.id, 1);
    const after = harness.store.getState().document.tracks
      .filter((track) => track.kind === "video")
      .sort((a, b) => a.sortOrder - b.sortOrder);
    expect(after.map((track) => track.id)).toEqual([videos[0]!.id, videos[2]!.id, videos[1]!.id]);
    expect(after.map((track) => track.sortOrder)).toEqual([0, 1, 2]);
    // Audio/caption ordering is untouched by a video reorder.
    expect(harness.store.getState().document.tracks.filter((track) => track.kind === "audio")).toHaveLength(4);
  });

  it("closes gaps on a track", () => {
    const harness = setup({
      clips: [
        { kind: "video", id: "clp_a", startFrame: 0, durationFrames: 10 },
        { kind: "video", id: "clp_b", startFrame: 50, durationFrames: 10 },
      ],
      snap: false,
    });
    harness.store.getState().closeGaps(harness.videoTrackId);
    expect(harness.store.getState().document.clips.map((clip) => clip.startFrame)).toEqual([0, 10]);
  });

  it("updates track flags through the history stack", () => {
    const harness = setup();
    harness.store.getState().updateTrack(harness.audioTrackId, { muted: true, solo: true }, { coalesce: false });
    const track = harness.store.getState().document.tracks.find((candidate) => candidate.id === harness.audioTrackId)!;
    expect(track.muted).toBe(true);
    expect(track.solo).toBe(true);
    harness.store.getState().undo();
    expect(harness.store.getState().document.tracks.find((candidate) => candidate.id === harness.audioTrackId)!.muted).toBe(false);
  });
});

describe("editorStore: snapping", () => {
  it("snaps a proposed move to a neighbouring edge", () => {
    const harness = setup({
      clips: [
        { kind: "video", id: "clp_a", startFrame: 0, durationFrames: 30 },
        { kind: "video", id: "clp_b", startFrame: 100, durationFrames: 20 },
      ],
    });
    // Head at 97 is within the threshold of the neighbour's head at 100.
    expect(harness.store.getState().snappingMove("clp_a", 97, harness.videoTrackId)).toBe(100);
    // A far-away target is left alone.
    expect(harness.store.getState().snappingMove("clp_a", 300, harness.videoTrackId)).toBe(300);
  });

  it("does not snap when snapping is disabled", () => {
    const harness = setup({
      clips: [
        { kind: "video", id: "clp_a", startFrame: 0, durationFrames: 30 },
        { kind: "video", id: "clp_b", startFrame: 100, durationFrames: 20 },
      ],
      snap: false,
    });
    expect(harness.store.getState().snapEnabled).toBe(false);
    expect(harness.store.getState().snappingMove("clp_a", 97, harness.videoTrackId)).toBe(97);
  });

  it("applies snapping when moving unless the caller opts out", () => {
    const harness = setup({
      clips: [
        { kind: "video", id: "clp_a", startFrame: 0, durationFrames: 30 },
        { kind: "video", id: "clp_b", startFrame: 100, durationFrames: 20 },
      ],
    });
    harness.store.getState().moveClip("clp_a", 97, { disableSnap: false });
    expect(harness.store.getState().document.clips.find((clip) => clip.id === "clp_a")!.startFrame).toBe(100);
  });
});

describe("editorStore: playback state", () => {
  it("tracks play/pause and the shuttle rate", () => {
    const harness = setup();
    expect(harness.store.getState().isPlaying).toBe(false);
    harness.store.getState().setPlaying(true, 1);
    expect(harness.store.getState().isPlaying).toBe(true);
    harness.store.getState().setPlaybackRate(-4);
    expect(harness.store.getState().playbackRate).toBe(-4);
    expect(harness.store.getState().isPlaying).toBe(true);
    harness.store.getState().setPlaying(false, 0);
    expect(harness.store.getState().playbackRate).toBe(0);
    expect(harness.store.getState().isPlaying).toBe(false);
  });
});
