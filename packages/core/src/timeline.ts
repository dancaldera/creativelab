/**
 * Timeline algebra — pure, immutable edit operations.
 *
 * FR-03: "At least 3 video and 4 audio tracks; split, trim, move, overlap, snap and
 * reorder without modifying source files."
 *
 * Every function here is a pure transform over `readonly Clip[]` (or a whole
 * `EditorDocument`) and returns fresh objects. That is what makes undo/redo (§14) and
 * autosave snapshots trivially correct: state is never mutated in place, so a previous
 * document reference is always a valid restore point.
 *
 * Invariants enforced by `assertTimelineInvariants`:
 *   1. `durationFrames > 0` for every clip.
 *   2. `startFrame >= 0` and `sourceInFrame >= 0`.
 *   3. No two clips on the same track overlap.
 *   4. Every clip's `trackId` exists and `track.sequenceId === clip.sequenceId`.
 */
import type { Clip, ClipProperties, Effect, EditorDocument, Track, TrackKind } from "./schema.js";
import { ClipPropertiesSchema, DEFAULT_CLIP_PROPERTIES, TRACK_LIMITS } from "./schema.js";
import { newId } from "./ids.js";
import { ValidationError } from "./errors.js";
import { frameRate, type FrameRate } from "./timebase.js";

export interface FrameRange {
  readonly start: number;
  readonly end: number;
}

export type EditMode = "overwrite" | "insert" | "replace";

/** Raised when an edit would break a timeline invariant. */
export class TimelineError extends ValidationError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = "TimelineError";
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function clipEnd(clip: Clip): number {
  return clip.startFrame + clip.durationFrames;
}

export function clipRange(clip: Clip): FrameRange {
  return { start: clip.startFrame, end: clipEnd(clip) };
}

/** Source frames consumed by a clip, accounting for speed. */
export function sourceSpan(clip: Clip): number {
  const { num, den } = clip.properties.speed;
  return Math.ceil((clip.durationFrames * num) / den);
}

export function sourceRange(clip: Clip): FrameRange {
  const span = sourceSpan(clip);
  return { start: clip.sourceInFrame, end: clip.sourceInFrame + span };
}

export function rangesOverlap(a: FrameRange, b: FrameRange): boolean {
  return a.start < b.end && b.start < a.end;
}

export function clipsOnTrack(clips: readonly Clip[], trackId: string): Clip[] {
  return clips
    .filter((clip) => clip.trackId === trackId)
    .sort((a, b) => a.startFrame - b.startFrame);
}

export function clipsInRange(clips: readonly Clip[], range: FrameRange, trackId?: string): Clip[] {
  return clips
    .filter(
      (clip) =>
        (trackId === undefined || clip.trackId === trackId) &&
        rangesOverlap(clipRange(clip), range),
    )
    .sort((a, b) => a.startFrame - b.startFrame);
}

export function clipAtFrame(
  clips: readonly Clip[],
  trackId: string,
  frame: number,
): Clip | undefined {
  return clipsOnTrack(clips, trackId).find(
    (clip) => frame >= clip.startFrame && frame < clipEnd(clip),
  );
}

export function sequenceDurationFrames(clips: readonly Clip[]): number {
  return clips.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0);
}

export function contentEndFrame(clips: readonly Clip[]): number {
  return sequenceDurationFrames(clips);
}

export interface Overlap {
  readonly trackId: string;
  readonly a: Clip;
  readonly b: Clip;
  readonly frames: number;
}

export function detectOverlaps(clips: readonly Clip[]): Overlap[] {
  const overlaps: Overlap[] = [];
  const byTrack = new Map<string, Clip[]>();
  for (const clip of clips) {
    const list = byTrack.get(clip.trackId);
    if (list) list.push(clip);
    else byTrack.set(clip.trackId, [clip]);
  }
  for (const [trackId, list] of byTrack) {
    const sorted = [...list].sort((a, b) => a.startFrame - b.startFrame || clipEnd(a) - clipEnd(b));
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1]!;
      const current = sorted[i]!;
      if (current.startFrame < clipEnd(previous)) {
        overlaps.push({
          trackId,
          a: previous,
          b: current,
          frames: Math.min(clipEnd(previous), clipEnd(current)) - current.startFrame,
        });
      }
    }
  }
  return overlaps;
}

/** Throws when the timeline is inconsistent; used by tests and by the save path. */
export function assertTimelineInvariants(document: EditorDocument): void {
  const sequenceIds = new Set(document.sequences.map((sequence) => sequence.id));
  const clipIds = new Set<string>();

  for (const clip of document.clips) {
    if (clipIds.has(clip.id)) throw new TimelineError(`Duplicate clip id ${clip.id}`);
    clipIds.add(clip.id);
    if (!Number.isInteger(clip.startFrame) || clip.startFrame < 0) {
      throw new TimelineError(`Clip ${clip.id} has a non-integer or negative startFrame`, {
        startFrame: clip.startFrame,
      });
    }
    if (!Number.isInteger(clip.durationFrames) || clip.durationFrames <= 0) {
      throw new TimelineError(`Clip ${clip.id} must have a positive integer duration`, {
        durationFrames: clip.durationFrames,
      });
    }
    if (!Number.isInteger(clip.sourceInFrame) || clip.sourceInFrame < 0) {
      throw new TimelineError(`Clip ${clip.id} has an invalid sourceInFrame`, {
        sourceInFrame: clip.sourceInFrame,
      });
    }
    const track = document.tracks.find((candidate) => candidate.id === clip.trackId);
    if (!track) throw new TimelineError(`Clip ${clip.id} references unknown track ${clip.trackId}`);
    if (!sequenceIds.has(clip.sequenceId)) {
      throw new TimelineError(`Clip ${clip.id} references unknown sequence ${clip.sequenceId}`);
    }
    if (track.sequenceId !== clip.sequenceId) {
      throw new TimelineError(
        `Clip ${clip.id} belongs to sequence ${clip.sequenceId} but its track belongs to ${track.sequenceId}`,
      );
    }
  }

  const overlaps = detectOverlaps(document.clips);
  if (overlaps.length > 0) {
    const first = overlaps[0]!;
    throw new TimelineError(
      `Clips ${first.a.id} and ${first.b.id} overlap by ${first.frames} frames on track ${first.trackId}`,
      { trackId: first.trackId, frames: first.frames },
    );
  }
}

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

/** Everything a dragged edge can snap to: other clip edges, the playhead, and zero. */
export function collectSnapTargets(
  clips: readonly Clip[],
  options: {
    excludeClipIds?: readonly string[];
    playheadFrame?: number;
    markers?: readonly number[];
  } = {},
): number[] {
  const excluded = new Set(options.excludeClipIds ?? []);
  const targets = new Set<number>([0]);
  for (const clip of clips) {
    if (excluded.has(clip.id)) continue;
    targets.add(clip.startFrame);
    targets.add(clipEnd(clip));
  }
  if (options.playheadFrame !== undefined)
    targets.add(Math.max(0, Math.round(options.playheadFrame)));
  for (const marker of options.markers ?? []) targets.add(Math.round(marker));
  return [...targets].sort((a, b) => a - b);
}

export interface SnapResult {
  readonly frame: number;
  readonly snapped: boolean;
  readonly target?: number;
}

/**
 * Snap `frame` to the closest target within `thresholdFrames`.
 * Ties resolve to the earlier target so drags feel deterministic.
 */
export function snapFrame(
  frame: number,
  targets: readonly number[],
  thresholdFrames: number,
): SnapResult {
  if (!Number.isFinite(frame)) throw new TimelineError(`Cannot snap a non-finite frame: ${frame}`);
  if (thresholdFrames <= 0 || targets.length === 0)
    return { frame: Math.round(frame), snapped: false };
  let best: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const target of targets) {
    const distance = Math.abs(target - frame);
    if (distance <= thresholdFrames && distance < bestDistance - 1e-9) {
      best = target;
      bestDistance = distance;
    }
  }
  if (best === undefined) return { frame: Math.round(frame), snapped: false };
  return { frame: best, snapped: true, target: best };
}

/**
 * Snap the two edges of a dragged clip independently and prefer the smaller correction,
 * which is how NLE users expect clip dragging to behave.
 */
export function snapClipMove(
  proposedStart: number,
  durationFrames: number,
  targets: readonly number[],
  thresholdFrames: number,
): SnapResult {
  const head = snapFrame(proposedStart, targets, thresholdFrames);
  const tail = snapFrame(proposedStart + durationFrames, targets, thresholdFrames);
  const headCost = head.snapped ? Math.abs(head.frame - proposedStart) : Number.POSITIVE_INFINITY;
  const tailCost = tail.snapped
    ? Math.abs(tail.frame - (proposedStart + durationFrames))
    : Number.POSITIVE_INFINITY;
  if (headCost === Number.POSITIVE_INFINITY && tailCost === Number.POSITIVE_INFINITY) {
    return { frame: Math.max(0, Math.round(proposedStart)), snapped: false };
  }
  if (headCost <= tailCost && head.snapped) {
    return { frame: Math.max(0, head.frame), snapped: true, target: head.target! };
  }
  if (tail.snapped) {
    return { frame: Math.max(0, tail.frame - durationFrames), snapped: true, target: tail.target! };
  }
  return { frame: Math.max(0, Math.round(proposedStart)), snapped: false };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface SourceConstraint {
  /** Total frames available in the source asset, when known. */
  readonly sourceDurationFrames?: number;
}

function touch(clip: Clip, now: string): Clip {
  return { ...clip, version: clip.version + 1, updatedAt: now };
}

/** Remove any clip range from a track, splitting clips that straddle it. */
function clearRange(
  clips: readonly Clip[],
  trackId: string,
  range: FrameRange,
  now: string,
  keepIds: ReadonlySet<string>,
): Clip[] {
  const result: Clip[] = [];
  for (const clip of clips) {
    if (clip.trackId !== trackId || keepIds.has(clip.id)) {
      result.push(clip);
      continue;
    }
    const range_ = clipRange(clip);
    if (!rangesOverlap(range_, range)) {
      result.push(clip);
      continue;
    }
    // Left remainder survives and keeps the original clip identity, so selections and
    // undo labels stay stable across an overwrite that clips a neighbour's tail.
    if (range_.start < range.start) {
      result.push(touch({ ...clip, durationFrames: range.start - range_.start }, now));
    }
    // Right remainder survives, with the source offset advanced.
    if (range_.end > range.end) {
      const advanced = range.end - range_.start;
      const { num, den } = clip.properties.speed;
      result.push(
        touch(
          {
            ...clip,
            id: newId("clip"),
            startFrame: range.end,
            sourceInFrame: clip.sourceInFrame + Math.round((advanced * num) / den),
            durationFrames: range_.end - range.end,
          },
          now,
        ),
      );
    }
  }
  return result;
}

export interface SplitResult {
  readonly clips: Clip[];
  readonly leftId: string;
  readonly rightId: string;
}

/** Split a clip at an absolute timeline frame. The frame must fall strictly inside. */
export function splitClip(
  clips: readonly Clip[],
  clipId: string,
  atFrame: number,
  now = isoNow(),
): SplitResult {
  const clip = clips.find((candidate) => candidate.id === clipId);
  if (!clip) throw new TimelineError(`Unknown clip ${clipId}`);
  const frame = Math.round(atFrame);
  if (frame <= clip.startFrame || frame >= clipEnd(clip)) {
    throw new TimelineError(
      `Split frame ${frame} must fall strictly inside clip ${clipId} [${clip.startFrame}, ${clipEnd(clip)})`,
    );
  }
  const leftDuration = frame - clip.startFrame;
  const rightDuration = clipEnd(clip) - frame;
  const { num, den } = clip.properties.speed;
  const rightId = newId("clip");

  const left = touch({ ...clip, durationFrames: leftDuration }, now);
  const right = touch(
    {
      ...clip,
      id: rightId,
      startFrame: frame,
      sourceInFrame: clip.sourceInFrame + Math.round((leftDuration * num) / den),
      durationFrames: rightDuration,
    },
    now,
  );

  const next: Clip[] = [];
  for (const candidate of clips) {
    if (candidate.id === clipId) next.push(left, right);
    else next.push(candidate);
  }
  return { clips: next, leftId: left.id, rightId };
}

export type TrimEdge = "start" | "end";

export interface TrimOptions extends SourceConstraint {
  /** Minimum duration a clip may be trimmed down to, in frames. */
  readonly minDurationFrames?: number;
}

/** Trim one edge of a clip to an absolute timeline frame, clamped to source bounds. */
export function trimClip(
  clips: readonly Clip[],
  clipId: string,
  edge: TrimEdge,
  toFrame: number,
  options: TrimOptions = {},
  now = isoNow(),
): Clip[] {
  const clip = clips.find((candidate) => candidate.id === clipId);
  if (!clip) throw new TimelineError(`Unknown clip ${clipId}`);
  const minDuration = Math.max(1, options.minDurationFrames ?? 1);
  const wanted = Math.round(toFrame);
  const { num, den } = clip.properties.speed;

  let next: Clip;
  if (edge === "start") {
    // Extending the head consumes source *before* `sourceInFrame`, so the only source
    // constraint is that the new `sourceInFrame` stays >= 0. The source tail — and
    // therefore the total source span — is unaffected by a head trim.
    const maxExtendLeft = Math.floor((clip.sourceInFrame * den) / num);
    const lowest = Math.max(0, clip.startFrame - maxExtendLeft);
    const highest = clipEnd(clip) - minDuration;
    const startFrame = clamp(wanted, Math.min(lowest, highest), Math.max(lowest, highest));
    const delta = startFrame - clip.startFrame;
    next = {
      ...clip,
      startFrame,
      sourceInFrame: clip.sourceInFrame + Math.round((delta * num) / den),
      durationFrames: clip.durationFrames - delta,
    };
  } else {
    // The tail may extend as far as the asset has frames left after `sourceInFrame`.
    const maxSpan =
      options.sourceDurationFrames === undefined
        ? Number.MAX_SAFE_INTEGER
        : Math.max(
            1,
            Math.floor(((options.sourceDurationFrames - clip.sourceInFrame) * den) / num),
          );
    const lowest = clip.startFrame + minDuration;
    const highest = Math.max(lowest, clip.startFrame + maxSpan);
    const end = clamp(wanted, lowest, highest);
    next = { ...clip, durationFrames: end - clip.startFrame };
  }

  if (next.sourceInFrame < 0)
    throw new TimelineError(`Trim would push clip ${clipId} before its source start`);
  if (next.durationFrames < minDuration) {
    throw new TimelineError(`Trim would leave clip ${clipId} shorter than ${minDuration} frames`);
  }

  return clips.map((candidate) => (candidate.id === clipId ? touch(next, now) : candidate));
}

export function clamp(value: number, min: number, max: number): number {
  if (min > max) return min;
  return Math.min(Math.max(value, min), max);
}

export interface MoveClipOptions extends SourceConstraint {
  readonly clipId: string;
  readonly toStartFrame: number;
  readonly toTrackId?: string;
  readonly mode?: EditMode;
  /** Clips to leave untouched by the overwrite/insert sweep (usually the dragged clip). */
  readonly excludeFromShift?: readonly string[];
  readonly minDurationFrames?: number;
}

/**
 * Move a clip to a new track and/or start frame.
 *
 * - `overwrite` (default) clears whatever occupies the destination range, splitting
 *   straddling clips — the standard "overwrite" NLE mode.
 * - `insert` ripples the affected track(s) right by the clip duration, closing nothing.
 * - `replace` swaps the clip in place of a single same-track neighbour, keeping length.
 */
export function moveClip(
  clips: readonly Clip[],
  tracks: readonly Track[],
  options: MoveClipOptions,
  now = isoNow(),
): Clip[] {
  const clip = clips.find((candidate) => candidate.id === options.clipId);
  if (!clip) throw new TimelineError(`Unknown clip ${options.clipId}`);
  const mode = options.mode ?? "overwrite";
  const targetTrackId = options.toTrackId ?? clip.trackId;
  const targetTrack = tracks.find((track) => track.id === targetTrackId);
  if (!targetTrack) throw new TimelineError(`Unknown track ${targetTrackId}`);
  if (targetTrack.locked) throw new TimelineError(`Track ${targetTrackId} is locked`);

  const start = Math.max(0, Math.round(options.toStartFrame));
  const moved: Clip = touch(
    { ...clip, startFrame: start, trackId: targetTrackId, sequenceId: targetTrack.sequenceId },
    now,
  );
  const targetRange: FrameRange = { start, end: start + clip.durationFrames };

  let working = clips.filter((candidate) => candidate.id !== clip.id);

  if (mode === "insert") {
    const delta = clip.durationFrames;
    const shiftTrackIds = new Set([clip.trackId, targetTrackId]);
    working = working.map((candidate) => {
      if (!shiftTrackIds.has(candidate.trackId)) return candidate;
      // Only ripple what lies at or after the insertion point.
      if (candidate.startFrame < targetRange.start) return candidate;
      return touch({ ...candidate, startFrame: candidate.startFrame + delta }, now);
    });
  } else if (mode === "overwrite") {
    const exclude = new Set(options.excludeFromShift ?? []);
    for (const trackId of new Set([clip.trackId, targetTrackId])) {
      working = clearRange(working, trackId, targetRange, now, exclude);
    }
  } else {
    // replace: drop exactly one overlapping neighbour on the target track, keep its slot.
    const victim = working.find(
      (candidate) =>
        candidate.trackId === targetTrackId && rangesOverlap(clipRange(candidate), targetRange),
    );
    if (victim) working = working.filter((candidate) => candidate.id !== victim.id);
  }

  return sortClips([...working, moved]);
}

export interface DeleteOptions {
  readonly ripple?: boolean;
}

/** Delete clips, optionally rippling later clips left to close the gap. */
export function deleteClips(
  clips: readonly Clip[],
  clipIds: readonly string[],
  options: DeleteOptions = {},
  now = isoNow(),
): Clip[] {
  const doomed = new Set(clipIds);
  if (doomed.size === 0) return [...clips];
  const removed = clips.filter((clip) => doomed.has(clip.id));
  let working = clips.filter((clip) => !doomed.has(clip.id));

  if (options.ripple) {
    // Ripple per track, from the latest removal backwards, so gaps collapse exactly.
    const byTrack = new Map<string, Clip[]>();
    for (const clip of removed) {
      const list = byTrack.get(clip.trackId);
      if (list) list.push(clip);
      else byTrack.set(clip.trackId, [clip]);
    }
    for (const [trackId, list] of byTrack) {
      const ranges = mergeRanges(list.map(clipRange));
      for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
        const delta = range.end - range.start;
        working = working.map((candidate) =>
          candidate.trackId === trackId && candidate.startFrame >= range.end
            ? touch({ ...candidate, startFrame: Math.max(0, candidate.startFrame - delta) }, now)
            : candidate,
        );
      }
    }
  }
  return sortClips(working);
}

/** Merge touching/overlapping ranges; used by ripple math. */
export function mergeRanges(ranges: readonly FrameRange[]): FrameRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: FrameRange[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (current.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, current.end) };
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

/** Close every gap on a track, packing clips left from frame 0. */
export function closeGaps(clips: readonly Clip[], trackId: string, now = isoNow()): Clip[] {
  let cursor = 0;
  const repacked = new Map<string, Clip>();
  for (const clip of clipsOnTrack(clips, trackId)) {
    if (clip.startFrame !== cursor)
      repacked.set(clip.id, touch({ ...clip, startFrame: cursor }, now));
    cursor += clip.durationFrames;
  }
  if (repacked.size === 0) return [...clips];
  return sortClips(clips.map((clip) => repacked.get(clip.id) ?? clip));
}

/** Duplicate clips onto the same track, immediately after the source clip's end. */
export function duplicateClips(
  clips: readonly Clip[],
  clipIds: readonly string[],
  now = isoNow(),
): { clips: Clip[]; newIds: string[] } {
  const newIds: string[] = [];
  const added: Clip[] = [];
  for (const id of clipIds) {
    const source = clips.find((clip) => clip.id === id);
    if (!source) continue;
    const copy = touch(
      { ...source, id: newId("clip"), startFrame: clipEnd(source), version: 1 },
      now,
    );
    newIds.push(copy.id);
    added.push(copy);
  }
  return { clips: sortClips([...clips, ...added]), newIds };
}

/** Apply a partial property patch, deep-merging the nested property groups. */
export function setClipProperties(
  clips: readonly Clip[],
  clipId: string,
  patch: DeepPartial<ClipProperties>,
  now = isoNow(),
): Clip[] {
  return clips.map((clip) => {
    if (clip.id !== clipId) return clip;
    const merged = ClipPropertiesSchema.parse({
      ...clip.properties,
      ...patch,
      transform: { ...clip.properties.transform, ...(patch.transform ?? {}) },
      crop: { ...clip.properties.crop, ...(patch.crop ?? {}) },
      audio: { ...clip.properties.audio, ...(patch.audio ?? {}) },
      speed: { ...clip.properties.speed, ...(patch.speed ?? {}) },
      transitionIn: { ...clip.properties.transitionIn, ...(patch.transitionIn ?? {}) },
      transitionOut: { ...clip.properties.transitionOut, ...(patch.transitionOut ?? {}) },
    });
    return touch({ ...clip, properties: merged }, now);
  });
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export function sortClips(clips: readonly Clip[]): Clip[] {
  return [...clips].sort(
    (a, b) =>
      a.trackId.localeCompare(b.trackId) || a.startFrame - b.startFrame || a.id.localeCompare(b.id),
  );
}

// ---------------------------------------------------------------------------
// Track management
// ---------------------------------------------------------------------------

export interface TrackDefaults {
  readonly sequenceId: string;
  readonly kind: TrackKind;
  readonly name?: string;
}

export function createTrack(defaults: TrackDefaults, sortOrder: number, now = isoNow()): Track {
  return {
    id: newId("track"),
    sequenceId: defaults.sequenceId,
    kind: defaults.kind,
    name: defaults.name ?? defaultTrackName(defaults.kind, sortOrder),
    sortOrder,
    muted: false,
    locked: false,
    hidden: false,
    solo: false,
    volumeDb: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function defaultTrackName(kind: TrackKind, index: number): string {
  const prefix = kind === "video" ? "V" : kind === "audio" ? "A" : "C";
  return `${prefix}${index + 1}`;
}

export function addTrack(
  document: EditorDocument,
  kind: TrackKind,
  now = isoNow(),
): { document: EditorDocument; track: Track } {
  const existing = document.tracks.filter((track) => track.kind === kind);
  if (existing.length >= TRACK_LIMITS[kind]) {
    throw new TimelineError(`Track limit reached for ${kind} tracks (${TRACK_LIMITS[kind]})`);
  }
  const sequence =
    document.sequences.find((candidate) => candidate.isActive) ?? document.sequences[0];
  if (!sequence) throw new TimelineError("Cannot add a track before a sequence exists");
  const track = createTrack({ sequenceId: sequence.id, kind }, existing.length, now);
  return { document: { ...document, tracks: [...document.tracks, track] }, track };
}

export function removeTrack(document: EditorDocument, trackId: string): EditorDocument {
  const track = document.tracks.find((candidate) => candidate.id === trackId);
  if (!track) throw new TimelineError(`Unknown track ${trackId}`);
  const remaining = document.tracks.filter((candidate) => candidate.id !== trackId);
  if (remaining.filter((candidate) => candidate.kind === track.kind).length === 0) {
    throw new TimelineError(`Cannot remove the last ${track.kind} track`);
  }
  return {
    ...document,
    tracks: remaining,
    clips: document.clips.filter((clip) => clip.trackId !== trackId),
  };
}

export function updateTrack(
  document: EditorDocument,
  trackId: string,
  patch: Partial<Track>,
  now = isoNow(),
): EditorDocument {
  return {
    ...document,
    tracks: document.tracks.map((track) =>
      track.id === trackId ? { ...track, ...patch, id: track.id, updatedAt: now } : track,
    ),
  };
}

/** Move a track up/down in the stack and renumber `sortOrder` contiguously. */
export function reorderTrack(
  document: EditorDocument,
  trackId: string,
  direction: -1 | 1,
  now = isoNow(),
): EditorDocument {
  const track = document.tracks.find((candidate) => candidate.id === trackId);
  if (!track) throw new TimelineError(`Unknown track ${trackId}`);
  const peers = document.tracks
    .filter((candidate) => candidate.kind === track.kind)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const index = peers.findIndex((candidate) => candidate.id === trackId);
  const target = index + direction;
  if (target < 0 || target >= peers.length) return document;
  const reordered = [...peers];
  const [moved] = reordered.splice(index, 1);
  reordered.splice(target, 0, moved!);
  const orderById = new Map(reordered.map((candidate, position) => [candidate.id, position]));
  return {
    ...document,
    tracks: document.tracks.map((candidate) =>
      orderById.has(candidate.id)
        ? { ...candidate, sortOrder: orderById.get(candidate.id)!, updatedAt: now }
        : candidate,
    ),
  };
}

/** Build a fresh document with the FR-03 minimum track set already in place. */
export function createInitialDocument(project: EditorDocument["project"]): EditorDocument {
  const now = project.createdAt;
  const sequenceId = newId("sequence");
  const sequence = {
    id: sequenceId,
    projectId: project.id,
    name: "Main",
    width: project.width,
    height: project.height,
    fps: project.fps,
    durationFrames: 0,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
  const tracks: Track[] = [];
  for (let i = 0; i < 3; i += 1) tracks.push(createTrack({ sequenceId, kind: "video" }, i, now));
  for (let i = 0; i < 4; i += 1) tracks.push(createTrack({ sequenceId, kind: "audio" }, i, now));
  tracks.push(createTrack({ sequenceId, kind: "caption" }, 0, now));
  return {
    project,
    sequences: [sequence],
    tracks,
    clips: [],
    effects: [],
    keyframes: [],
    assets: [],
  };
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export function createEffect(
  clipId: string,
  kind: Effect["kind"],
  params: Effect["params"] = {},
  sortOrder = 0,
  now = isoNow(),
): Effect {
  return {
    id: newId("effect"),
    clipId,
    kind,
    sortOrder,
    enabled: true,
    params,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function isoNow(clock: () => number = Date.now): string {
  return new Date(clock()).toISOString();
}

/** Effective frame rate of a sequence, tolerating a missing sequence. */
export function sequenceFrameRate(document: EditorDocument): FrameRate {
  const sequence =
    document.sequences.find((candidate) => candidate.isActive) ?? document.sequences[0];
  const rate = sequence?.fps ?? document.project.fps;
  return frameRate(rate.num, rate.den);
}

export function emptyProperties(): ClipProperties {
  return { ...DEFAULT_CLIP_PROPERTIES };
}
