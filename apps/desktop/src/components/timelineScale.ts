/**
 * Timeline scale: how often the ruler labels, ticks and lane grid repeat at a given zoom.
 *
 * Kept as a pure module (no DOM, no React) for two reasons: the arithmetic is testable in the
 * node environment, and — more importantly — the ruler and the lane grid must be driven by
 * **one** computation. They previously were not, and the result was a real bug: the lane grid
 * used a CSS custom property that nothing ever assigned, so it fell back to a hardcoded 120 px
 * interval while the ruler ticks were positioned at `stepSeconds × fps × zoom`. The two agreed
 * only by coincidence, and at high zoom the grid became a dense band of meaningless lines.
 */
import { frameRateAsNumber } from "../state/coreOps";

/**
 * Candidate label intervals, in seconds. Sub-second steps are deliberately absent: at the
 * maximum zoom of 40 px/frame a one-second step is already 1200 px wide at 30 fps, so a
 * finer step would only matter for frame-level scrubbing, which the playhead itself covers.
 */
export const SECOND_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600] as const;

/** A major (labelled) tick should be roughly this far apart. */
const MAJOR_TARGET_PX = 96;
/** Minor ticks subdivide a major step this many ways before rounding to whole frames. */
const MINOR_PER_MAJOR = 5;
/** Below this, minor ticks would merge into a solid block, so they are dropped. */
const MIN_MINOR_TICK_PX = 6;
/** Below this, the lane grid uses the major step instead of the minor one. */
const MIN_GRID_PX = 12;

export interface TimelineScale {
  readonly fps: number;
  readonly zoom: number;
  readonly majorStepSeconds: number;
  readonly majorStepFrames: number;
  readonly minorStepFrames: number;
  /** Whether the ruler draws minor ticks at this zoom. */
  readonly minorTicksVisible: boolean;
  /** Frames between lane grid lines. Always exactly a ruler step — never an independent value. */
  readonly gridStepFrames: number;
  /** Pixels between lane grid lines, ready to be written to a CSS custom property. */
  readonly gridStepPx: number;
}

export interface FrameRateLike {
  readonly num: number;
  readonly den: number;
}

/**
 * Resolve the tick and grid intervals for a frame rate and zoom.
 *
 * `zoom` is pixels per frame. A non-finite or non-positive zoom falls back to 1 px/frame
 * rather than propagating `NaN`: an unset or `NaN` custom property makes the whole
 * `repeating-linear-gradient` invalid, which would silently drop the grid entirely.
 */
export function timelineScale(fps: FrameRateLike, zoom: number): TimelineScale {
  const fpsValue = Math.max(1, frameRateAsNumber(fps));
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;

  const majorStepSeconds =
    SECOND_STEPS.find((candidate) => candidate * fpsValue * safeZoom >= MAJOR_TARGET_PX) ??
    SECOND_STEPS[SECOND_STEPS.length - 1]!;

  const majorStepFrames = Math.max(1, Math.round(majorStepSeconds * fpsValue));
  const minorStepFrames = Math.max(1, Math.round(majorStepFrames / MINOR_PER_MAJOR));
  const minorStepPx = minorStepFrames * safeZoom;
  const minorTicksVisible = minorStepPx >= MIN_MINOR_TICK_PX;

  // The grid follows the ruler's own decision. Because these are derived from the same
  // numbers, `gridStepPx` is always exactly `minorStepPx` or `majorStepPx` — the invariant
  // that was violated when the grid was pinned to 120 px.
  const gridStepFrames = minorStepPx >= MIN_GRID_PX ? minorStepFrames : majorStepFrames;

  return {
    fps: fpsValue,
    zoom: safeZoom,
    majorStepSeconds,
    majorStepFrames,
    minorStepFrames,
    minorTicksVisible,
    gridStepFrames,
    gridStepPx: gridStepFrames * safeZoom,
  };
}

/**
 * The CSS custom property the lane background reads.
 *
 * Exported so the component and the stylesheet cannot drift apart on the name; the stylesheet
 * falls back to a value that draws nothing, so a rename cannot silently reintroduce a
 * mis-scaled grid.
 */
export const GRID_STEP_VAR = "--grid-step";
