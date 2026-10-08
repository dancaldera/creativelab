/**
 * Renderer-side domain operations.
 *
 * ## Why this file is mostly re-exports
 *
 * This module used to contain hand-written **copies** of core's timeline algebra, budget
 * maths and money helpers — roughly 600 lines duplicating `packages/core/src/timeline.ts`,
 * `budget.ts` and `ids.ts`. The reason was real at the time: importing core *values* failed
 * the webview bundle, because the core barrel re-exported `ids.ts`, which imported
 * `node:crypto` (Vite resolves that to `__vite-browser-external` and Rollup then fails).
 *
 * That root cause is fixed:
 *
 *   1. `packages/core/src/ids.ts` now uses the Web Crypto API, which exists in Node 22+ and
 *      in the Tauri webview (a secure context), so one implementation serves both.
 *   2. `packages/core/src/browser.ts` exports the isomorphic subset (time, ids, errors,
 *      schema, timeline, history, jobs, budget) and the desktop app resolves
 *      `@creativelab/core` to it. `packages/core/src/browser.test.ts` enforces that this
 *      surface stays free of Node built-ins.
 *
 * So the renderer now runs the *same* implementation the host runs, and there is no mirrored
 * logic left to drift. The only genuine renderer adaptations remain below.
 *
 * The `*_LOCAL` aliases are kept so existing call sites did not have to churn; they are
 * aliases for core's tables, not copies. Treat the names as historical.
 */
import { formatTimecode as coreFormatTimecode } from "@creativelab/core";
import type { EditorDocument, FrameRate, Sequence } from "@creativelab/core";

// ---------------------------------------------------------------------------
// Isomorphic domain modules, re-exported from core
// ---------------------------------------------------------------------------

export {
  // Budget
  DEFAULT_BUDGET_POLICY,
  addMoney,
  dayKey,
  evaluateBudget,
  formatMoney,
  normalizeCost,
  roundMoney,
  spendOn,
} from "@creativelab/core";

export {
  // Time
  FRAME_RATE_PRESETS,
  frameRate,
  frameRateAsNumber,
  frameRateEquals,
  framesToClock,
  framesToMs,
  framesToSeconds,
  msToFrames,
  nominalFps,
  parseTimecode,
  secondsToFrames,
  supportsDropFrame,
} from "@creativelab/core";

export {
  // Schema tables
  ASPECT_PRESETS,
  EXPORT_PRESETS,
  JOB_STATUSES,
  TRACK_LIMITS,
} from "@creativelab/core";

export {
  // Timeline
  TimelineError,
  addTrack,
  assertTimelineInvariants,
  clipAtFrame,
  clipEnd,
  clipRange,
  clipsInRange,
  clipsOnTrack,
  closeGaps,
  collectSnapTargets,
  createEffect,
  createInitialDocument,
  createTrack,
  defaultTrackName,
  deleteClips,
  detectOverlaps,
  duplicateClips,
  emptyProperties,
  isId,
  mergeRanges,
  moveClip,
  rangesOverlap,
  removeTrack,
  reorderTrack,
  sequenceDurationFrames,
  sequenceFrameRate,
  setClipProperties,
  snapClipMove,
  snapFrame,
  sortClips,
  sourceRange,
  sourceSpan,
  splitClip,
  trimClip,
  updateTrack,
} from "@creativelab/core";

export { History } from "@creativelab/core";
export { isoNow, newId, newRunId } from "@creativelab/core";

export type {
  AspectRatio,
  Asset,
  AssetOrigin,
  Clip,
  ClipProperties,
  DeepPartial,
  EditMode,
  EditorDocument,
  Effect,
  FrameRange,
  FrameRate,
  IdKind,
  Keyframe,
  MediaType,
  MoveClipOptions,
  Project,
  Sequence,
  SnapResult,
  SplitResult,
  Track,
  TrackKind,
  TrimEdge,
  TrimOptions,
} from "@creativelab/core";

// ---------------------------------------------------------------------------
// Local aliases kept so existing call sites did not have to churn
// ---------------------------------------------------------------------------

/** Alias of `TRACK_LIMITS`. */
export { TRACK_LIMITS as TRACK_LIMITS_LOCAL } from "@creativelab/core";
/** Alias of `ASPECT_PRESETS`. */
export { ASPECT_PRESETS as ASPECT_PRESETS_LOCAL } from "@creativelab/core";
/** Alias of `FRAME_RATE_PRESETS`. */
export { FRAME_RATE_PRESETS as FRAME_RATE_PRESETS_LOCAL } from "@creativelab/core";
/** Alias of `EXPORT_PRESETS`. */
export { EXPORT_PRESETS as EXPORT_PRESETS_LOCAL } from "@creativelab/core";
/** Alias of `DEFAULT_BUDGET_POLICY`. */
export { DEFAULT_BUDGET_POLICY as DEFAULT_BUDGET_POLICY_LOCAL } from "@creativelab/core";

// ---------------------------------------------------------------------------
// The two genuine renderer adaptations
// ---------------------------------------------------------------------------

/**
 * The sequence the editor is working in: the flagged active one, else the first.
 *
 * Core does not need this — the host always operates on a known sequence — but a UI has to
 * tolerate a document in which nothing is flagged, for example immediately after a load.
 */
export function activeSequence(document: EditorDocument): Sequence | undefined {
  return document.sequences.find((candidate) => candidate.isActive) ?? document.sequences[0];
}

/**
 * `formatTimecode` with a boolean "show hours" argument.
 *
 * Core's signature takes an options object (`{ format, includeHours }`) because it also
 * supports drop-frame numbering at 29.97/59.94. This wrapper preserves the shorter call
 * sites used throughout the UI while delegating all of the timecode maths to core — which
 * means timestamps here are now drop-frame correct, where the previous copy was not.
 */
export function formatTimecode(frames: number, fr: FrameRate, includeHours = true): string {
  return coreFormatTimecode(frames, fr, { includeHours });
}
