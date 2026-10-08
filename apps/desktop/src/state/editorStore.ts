/**
 * Ephemeral editor state (Zustand).
 *
 * Design rules:
 *   * **Every** document mutation goes through `applyEdit`, which pushes onto the undo
 *     stack before swapping the document. There is no second path to `document`, so
 *     undo/redo cannot be bypassed (FR-01, PRD §14).
 *   * Timeline algebra is not re-implemented in React; each operation calls a pure
 *     function (`coreOps`, a type-checked mirror of `@creativelab/core`'s `timeline.ts` —
 *     see `coreOps.ts` for why the renderer cannot import core values directly).
 *   * The store factory is exported so tests can build isolated editors.
 */
import { create } from "zustand";
import type { Clip, EditorDocument, Track, TrackKind } from "@creativelab/core";
import type { DeepPartial } from "./coreOps";
import {
  addTrack as addTrackOp,
  clipEnd,
  clipsOnTrack,
  closeGaps as closeGapsOp,
  collectSnapTargets,
  createInitialDocument,
  deleteClips as deleteClipsOp,
  duplicateClips as duplicateClipsOp,
  moveClip as moveClipOp,
  removeTrack as removeTrackOp,
  reorderTrack as reorderTrackOp,
  sequenceDurationFrames,
  setClipProperties as setClipPropertiesOp,
  snapClipMove,
  sortClips,
  splitClip as splitClipOp,
  trimClip as trimClipOp,
  updateTrack as updateTrackOp,
} from "./coreOps";

export type EditMode = "overwrite" | "insert" | "replace";

export const MIN_ZOOM_PX_PER_FRAME = 0.05;
export const MAX_ZOOM_PX_PER_FRAME = 40;
export const DEFAULT_ZOOM_PX_PER_FRAME = 2;
/** How close (in frames) an edge must be to a snap target before it snaps. */
export const SNAP_THRESHOLD_FRAMES = 6;

export const DEFAULT_DOCUMENT: EditorDocument = createInitialDocument({
  id: "prj_000000000000000000000000",
  schemaVersion: 1,
  title: "Untitled Project",
  fps: { num: 30, den: 1 },
  width: 1920,
  height: 1080,
  colorProfile: "bt709",
  sampleRate: 48_000,
  channels: 2,
  workspaceRelPath: ".",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

export interface HistoryInfo {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
  readonly depth: number;
  readonly redoDepth: number;
}

interface Snapshot {
  readonly label: string;
  readonly state: EditorDocument;
  readonly at: number;
}

/**
 * Bounded undo/redo stack over immutable document snapshots.
 *
 * Mirrors the semantics of `@creativelab/core`'s `History<T>` (including the coalescing
 * window) so a slider drag or a repeated nudge collapses into one undo step.
 */
class DocumentHistory {
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private present: Snapshot;
  private lastPushAt: number;

  constructor(
    initial: EditorDocument,
    private readonly limit = 200,
    private readonly coalesceWindowMs = 400,
    private readonly clock: () => number = Date.now,
  ) {
    this.present = { label: "Initial state", state: initial, at: clock() };
    // Initialised to -Infinity so the very first edit can never coalesce into the initial
    // snapshot (there is nothing before it to merge with).
    this.lastPushAt = Number.NEGATIVE_INFINITY;
  }

  get current(): EditorDocument {
    return this.present.state;
  }

  get info(): HistoryInfo {
    return {
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
      undoLabel: this.past.at(-1)?.label ?? null,
      redoLabel: this.future[0]?.label ?? null,
      depth: this.past.length,
      redoDepth: this.future.length,
    };
  }

  push(label: string, next: EditorDocument, coalesce: boolean): void {
    const at = this.clock();
    const shouldCoalesce =
      coalesce &&
      this.future.length === 0 &&
      this.past.length > 0 &&
      this.present.label === label &&
      at - this.lastPushAt <= this.coalesceWindowMs;
    if (!shouldCoalesce) {
      this.past.push(this.present);
      if (this.past.length > this.limit) this.past.shift();
    }
    this.present = { label, state: next, at };
    this.lastPushAt = at;
    this.future = [];
  }

  /**
   * Replace the present without an undo step (project load, recovery, reconciliation).
   *
   * Loading a different project must not leave the previous project's edits on the undo
   * stack — undoing into a document from a different workspace would be data loss.
   */
  replacePresent(label: string, next: EditorDocument): void {
    this.present = { label, state: next, at: this.clock() };
    this.past = [];
    this.future = [];
    // -Infinity, not 0: an immediate follow-up edit must never coalesce into a snapshot that
    // no longer exists on the stack.
    this.lastPushAt = Number.NEGATIVE_INFINITY;
  }

  undo(): EditorDocument | undefined {
    const previous = this.past.pop();
    if (!previous) return undefined;
    this.future.unshift(this.present);
    this.present = previous;
    this.lastPushAt = Number.NEGATIVE_INFINITY;
    return this.present.state;
  }

  redo(): EditorDocument | undefined {
    const next = this.future.shift();
    if (!next) return undefined;
    this.past.push(this.present);
    if (this.past.length > this.limit) this.past.shift();
    this.present = next;
    this.lastPushAt = Number.NEGATIVE_INFINITY;
    return this.present.state;
  }

  labels(): string[] {
    return this.past.map((entry) => entry.label);
  }
}

export interface EditorState {
  workspacePath: string | null;
  document: EditorDocument;
  history: HistoryInfo;
  undoLabels: string[];
  selection: Set<string>;
  playheadFrame: number;
  zoom: number;
  snapEnabled: boolean;
  editMode: EditMode;
  volume: number;
  isPlaying: boolean;
  /** J/K/L shuttle rate; 1 = normal speed, negative = reverse, 0 = paused. */
  playbackRate: number;
  lastError: string | null;

  // -- lifecycle -----------------------------------------------------------
  loadDocument: (document: EditorDocument, workspacePath?: string | null) => void;

  // -- generic edits -------------------------------------------------------
  applyEdit: (
    label: string,
    mutator: (document: EditorDocument) => EditorDocument,
    options?: { coalesce?: boolean },
  ) => void;
  undo: () => void;
  redo: () => void;

  // -- ephemeral state -----------------------------------------------------
  selectClips: (clipIds: Iterable<string>, additive?: boolean) => void;
  toggleSelection: (clipId: string) => void;
  clearSelection: () => void;
  setPlayhead: (frame: number) => void;
  setZoom: (pixelsPerFrame: number) => void;
  zoomBy: (factor: number) => void;
  setEditMode: (mode: EditMode) => void;
  toggleSnap: () => void;
  setVolume: (volume: number) => void;
  setPlaying: (playing: boolean, rate?: number) => void;
  setPlaybackRate: (rate: number) => void;
  setError: (message: string | null) => void;

  // -- timeline operations -------------------------------------------------
  splitAtPlayhead: () => void;
  trimClipEdge: (
    clipId: string,
    edge: "start" | "end",
    toFrame: number,
    options?: { coalesce?: boolean },
  ) => void;
  moveClip: (
    clipId: string,
    toStartFrame: number,
    options?: { toTrackId?: string; mode?: EditMode; coalesce?: boolean; disableSnap?: boolean },
  ) => void;
  snappingMove: (clipId: string, toStartFrame: number, toTrackId?: string) => number;
  deleteSelected: () => void;
  duplicateSelected: () => void;
  addTrack: (kind: TrackKind) => string | null;
  removeTrack: (trackId: string) => void;
  updateTrack: (trackId: string, patch: Partial<Track>, options?: { coalesce?: boolean }) => void;
  reorderTrack: (trackId: string, direction: -1 | 1) => void;
  setClipProperties: (
    clipId: string,
    patch: DeepPartial<Clip["properties"]>,
    options?: { coalesce?: boolean },
  ) => void;
  closeGaps: (trackId: string) => void;

  // -- helpers -------------------------------------------------------------
  selectedClips: () => Clip[];
  sequenceDuration: () => number;
  sourceDurationFor: (clip: Clip) => number | undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Selected clips that live on unlocked tracks — locked tracks never accept edits. */
function editableSelection(document: EditorDocument, selection: ReadonlySet<string>): Clip[] {
  const locked = new Set(document.tracks.filter((track) => track.locked).map((track) => track.id));
  return document.clips.filter((clip) => selection.has(clip.id) && !locked.has(clip.trackId));
}

export function createEditorStore(initialDocument: EditorDocument = DEFAULT_DOCUMENT) {
  const history = new DocumentHistory(initialDocument);

  return create<EditorState>((set, get) => {
    const commit = (label: string, next: EditorDocument, coalesce = false): void => {
      history.push(label, next, coalesce);
      set({ document: next, history: history.info, undoLabels: history.labels(), lastError: null });
    };

    const sourceDuration = (clip: Clip): number | undefined => {
      const asset = get().document.assets.find((candidate) => candidate.id === clip.assetId);
      return asset?.durationFrames ?? undefined;
    };

    return {
      workspacePath: null,
      document: initialDocument,
      history: history.info,
      undoLabels: history.labels(),
      selection: new Set<string>(),
      playheadFrame: 0,
      zoom: DEFAULT_ZOOM_PX_PER_FRAME,
      snapEnabled: true,
      editMode: "overwrite",
      volume: 1,
      isPlaying: false,
      playbackRate: 0,
      lastError: null,

      loadDocument: (document, workspacePath) => {
        history.replacePresent("Project loaded", document);
        set({
          document,
          workspacePath: workspacePath === undefined ? get().workspacePath : workspacePath,
          history: history.info,
          undoLabels: history.labels(),
          selection: new Set<string>(),
          playheadFrame: 0,
          isPlaying: false,
          playbackRate: 0,
          lastError: null,
        });
      },

      applyEdit: (label, mutator, options) => {
        const current = get().document;
        const next = mutator(current);
        if (next === current) return;
        commit(label, next, options?.coalesce ?? false);
      },

      undo: () => {
        const previous = history.undo();
        if (!previous) return;
        const valid = new Set(previous.clips.map((clip) => clip.id));
        set({
          document: previous,
          history: history.info,
          undoLabels: history.labels(),
          selection: new Set([...get().selection].filter((id) => valid.has(id))),
        });
      },

      redo: () => {
        const next = history.redo();
        if (!next) return;
        const valid = new Set(next.clips.map((clip) => clip.id));
        set({
          document: next,
          history: history.info,
          undoLabels: history.labels(),
          selection: new Set([...get().selection].filter((id) => valid.has(id))),
        });
      },

      selectClips: (clipIds, additive = false) => {
        const next = additive ? new Set([...get().selection, ...clipIds]) : new Set(clipIds);
        set({ selection: next });
      },

      toggleSelection: (clipId) => {
        const next = new Set(get().selection);
        if (next.has(clipId)) next.delete(clipId);
        else next.add(clipId);
        set({ selection: next });
      },

      clearSelection: () => set({ selection: new Set<string>() }),

      setPlayhead: (frame) => {
        const duration = sequenceDurationFrames(get().document.clips);
        set({ playheadFrame: clamp(Math.round(frame), 0, Math.max(0, duration)) });
      },

      setZoom: (pixelsPerFrame) =>
        set({ zoom: clamp(pixelsPerFrame, MIN_ZOOM_PX_PER_FRAME, MAX_ZOOM_PX_PER_FRAME) }),

      zoomBy: (factor) =>
        set({ zoom: clamp(get().zoom * factor, MIN_ZOOM_PX_PER_FRAME, MAX_ZOOM_PX_PER_FRAME) }),

      setEditMode: (editMode) => set({ editMode }),

      toggleSnap: () => set({ snapEnabled: !get().snapEnabled }),

      setVolume: (volume) => set({ volume: clamp(volume, 0, 1) }),

      setPlaying: (isPlaying, rate) =>
        set({ isPlaying, playbackRate: rate ?? (isPlaying ? 1 : 0) }),

      setPlaybackRate: (rate) => set({ playbackRate: rate, isPlaying: rate !== 0 }),

      setError: (message) => set({ lastError: message }),

      splitAtPlayhead: () => {
        const { document, playheadFrame, selection } = get();
        const candidates = editableSelection(document, selection).filter(
          (clip) => playheadFrame > clip.startFrame && playheadFrame < clipEnd(clip),
        );
        // With nothing selected, split everything under the playhead (standard NLE feel).
        const targets =
          candidates.length > 0
            ? candidates
            : document.clips.filter((clip) => {
                const track = document.tracks.find((candidate) => candidate.id === clip.trackId);
                if (track?.locked) return false;
                return playheadFrame > clip.startFrame && playheadFrame < clipEnd(clip);
              });
        if (targets.length === 0) {
          set({ lastError: "Nothing to split at the playhead." });
          return;
        }
        let clips = document.clips;
        const newSelection = new Set<string>();
        for (const target of targets) {
          const result = splitClipOp(clips, target.id, playheadFrame);
          clips = result.clips;
          newSelection.add(result.leftId);
          newSelection.add(result.rightId);
        }
        commit("Split", { ...document, clips: sortClips(clips) });
        set({ selection: newSelection });
      },

      trimClipEdge: (clipId, edge, toFrame, options) => {
        const { document } = get();
        const clip = document.clips.find((candidate) => candidate.id === clipId);
        if (!clip) return;
        const clips = trimClipOp(document.clips, clipId, edge, toFrame, {
          sourceDurationFrames: sourceDuration(clip),
        });
        commit("Trim clip", { ...document, clips }, options?.coalesce ?? true);
      },

      moveClip: (clipId, toStartFrame, options) => {
        const { document, snapEnabled, editMode } = get();
        const clip = document.clips.find((candidate) => candidate.id === clipId);
        if (!clip) return;
        const locked = document.tracks.filter((track) => track.locked).map((track) => track.id);
        if (locked.includes(clip.trackId)) {
          set({ lastError: "That clip is on a locked track." });
          return;
        }
        const targetTrackId = options?.toTrackId ?? clip.trackId;
        if (options?.toTrackId && locked.includes(options.toTrackId)) {
          set({ lastError: "The destination track is locked." });
          return;
        }
        let start = Math.max(0, Math.round(toStartFrame));
        if (snapEnabled && options?.disableSnap !== true) {
          const targets = collectSnapTargets(document.clips, {
            excludeClipIds: [clipId],
            playheadFrame: get().playheadFrame,
          });
          start = snapClipMove(start, clip.durationFrames, targets, SNAP_THRESHOLD_FRAMES).frame;
        }
        try {
          const clips = moveClipOp(document.clips, document.tracks, {
            clipId,
            toStartFrame: start,
            toTrackId: targetTrackId,
            mode: options?.mode ?? editMode,
            excludeFromShift: [clipId],
          });
          commit("Move clip", { ...document, clips }, options?.coalesce ?? true);
        } catch (error) {
          set({ lastError: error instanceof Error ? error.message : String(error) });
        }
      },

      /** Snap preview for drag interactions: returns the frame the clip would land on. */
      snappingMove: (clipId, toStartFrame, toTrackId) => {
        const { document, snapEnabled, playheadFrame } = get();
        const clip = document.clips.find((candidate) => candidate.id === clipId);
        if (!clip) return Math.max(0, Math.round(toStartFrame));
        void toTrackId;
        if (!snapEnabled) return Math.max(0, Math.round(toStartFrame));
        const targets = collectSnapTargets(document.clips, {
          excludeClipIds: [clipId],
          playheadFrame,
        });
        return snapClipMove(
          Math.max(0, Math.round(toStartFrame)),
          clip.durationFrames,
          targets,
          SNAP_THRESHOLD_FRAMES,
        ).frame;
      },

      deleteSelected: () => {
        const { document, selection, editMode } = get();
        const targets = editableSelection(document, selection);
        if (targets.length === 0) return;
        const ids = targets.map((clip) => clip.id);
        // Insert mode is a ripple-close edit mode; overwrite/replace leave the gap.
        const clips = deleteClipsOp(document.clips, ids, { ripple: editMode === "insert" });
        commit(ids.length > 1 ? `Delete ${ids.length} clips` : "Delete clip", {
          ...document,
          clips,
        });
        set({ selection: new Set<string>() });
      },

      duplicateSelected: () => {
        const { document, selection } = get();
        const targets = editableSelection(document, selection);
        if (targets.length === 0) return;
        const result = duplicateClipsOp(
          document.clips,
          targets.map((clip) => clip.id),
        );
        commit("Duplicate clips", { ...document, clips: result.clips });
        set({ selection: new Set(result.newIds) });
      },

      addTrack: (kind) => {
        const { document } = get();
        try {
          const { document: next, track } = addTrackOp(document, kind);
          commit(`Add ${kind} track`, next);
          return track.id;
        } catch (error) {
          set({ lastError: error instanceof Error ? error.message : String(error) });
          return null;
        }
      },

      removeTrack: (trackId) => {
        const { document } = get();
        try {
          const next = removeTrackOp(document, trackId);
          commit("Remove track", next);
          set({ selection: new Set([...get().selection].filter((id) => id !== trackId)) });
        } catch (error) {
          set({ lastError: error instanceof Error ? error.message : String(error) });
        }
      },

      updateTrack: (trackId, patch, options) => {
        const { document } = get();
        commit("Update track", updateTrackOp(document, trackId, patch), options?.coalesce ?? true);
      },

      reorderTrack: (trackId, direction) => {
        const { document } = get();
        commit("Reorder tracks", reorderTrackOp(document, trackId, direction));
      },

      setClipProperties: (clipId, patch, options) => {
        const { document } = get();
        const clips = setClipPropertiesOp(document.clips, clipId, patch);
        commit("Adjust clip", { ...document, clips }, options?.coalesce ?? true);
      },

      closeGaps: (trackId) => {
        const { document } = get();
        const before = clipsOnTrack(document.clips, trackId);
        if (before.length === 0) return;
        commit("Close gaps", { ...document, clips: closeGapsOp(document.clips, trackId) });
      },

      selectedClips: () => {
        const { document, selection } = get();
        return document.clips.filter((clip) => selection.has(clip.id));
      },

      sequenceDuration: () => sequenceDurationFrames(get().document.clips),

      sourceDurationFor: (clip) => sourceDuration(clip),
    };
  });
}

export const useEditorStore = createEditorStore();

// ---------------------------------------------------------------------------
// Selectors used across components
// ---------------------------------------------------------------------------

export function selectActiveSequence(state: EditorState) {
  return (
    state.document.sequences.find((sequence) => sequence.isActive) ?? state.document.sequences[0]
  );
}

export function selectSelectedClip(state: EditorState): Clip | undefined {
  if (state.selection.size !== 1) return undefined;
  const [id] = state.selection;
  return state.document.clips.find((clip) => clip.id === id);
}

export { DocumentHistory };
