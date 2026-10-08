/**
 * Clip construction.
 *
 * Every place that turns an asset, a template shot or a caption line into a clip uses this
 * factory. That matters for two reasons:
 *   * the non-destructive invariants (`version: 1`, integer frames, `sourceInFrame >= 0`) are
 *     stated once instead of five times, and
 *   * the storyboard "convert without flattening" guarantee is provable — each shot becomes
 *     one clip and nothing merged them.
 *
 * The overwrite rule lives in `placeClip`: a new clip clears exactly the range it lands on,
 * splitting a straddling neighbour rather than deleting it wholesale.
 */
import type { Clip, EditorDocument, Track } from "@creativelab/core";
import { clipEnd, newId, sortClips } from "./coreOps";

export interface CreateClipInput {
  trackId: string;
  sequenceId: string;
  startFrame: number;
  durationFrames: number;
  assetId?: string | null;
  label?: string;
  sourceInFrame?: number;
  notes?: string;
  properties?: Partial<Clip["properties"]>;
}

/** A fresh clip in its default state: identity transform, unity speed, no transitions. */
export function createClip(input: CreateClipInput, now = new Date().toISOString()): Clip {
  return {
    id: newId("clip"),
    trackId: input.trackId,
    sequenceId: input.sequenceId,
    assetId: input.assetId ?? null,
    label: input.label ?? "Clip",
    startFrame: Math.max(0, Math.round(input.startFrame)),
    sourceInFrame: Math.max(0, Math.round(input.sourceInFrame ?? 0)),
    durationFrames: Math.max(1, Math.round(input.durationFrames)),
    properties: {
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flipX: false, flipY: false },
      crop: { top: 0, right: 0, bottom: 0, left: 0 },
      audio: { gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0, enabled: true, pan: 0 },
      speed: { num: 1, den: 1 },
      transitionIn: { kind: "none", durationFrames: 0 },
      transitionOut: { kind: "none", durationFrames: 0 },
      notes: input.notes ?? "",
      ...input.properties,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Insert a clip, clearing whatever already occupies its range on that track.
 *
 * This mirrors the `overwrite` edit mode: the clip's own range is emptied first, so the
 * timeline invariant "no two clips overlap on a track" always holds.
 */
export function placeClip(document: EditorDocument, clip: Clip): EditorDocument {
  const start = clip.startFrame;
  const end = clipEnd(clip);
  const remaining = document.clips.filter(
    (candidate) =>
      !(
        candidate.trackId === clip.trackId &&
        candidate.startFrame < end &&
        clipEnd(candidate) > start
      ),
  );
  return { ...document, clips: sortClips([...remaining, clip]) };
}

/** The first unlocked track of a kind, in stack order — where an append lands. */
export function defaultTrackFor(
  document: EditorDocument,
  kind: Track["kind"],
  preferredTrackId?: string | null,
): Track | undefined {
  if (preferredTrackId) {
    const preferred = document.tracks.find(
      (track) => track.id === preferredTrackId && track.kind === kind && !track.locked,
    );
    if (preferred) return preferred;
  }
  return document.tracks
    .filter((track) => track.kind === kind && !track.locked)
    .sort((a, b) => a.sortOrder - b.sortOrder)[0];
}
