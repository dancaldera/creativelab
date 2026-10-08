/**
 * `timelineScale` — the shared tick/grid arithmetic.
 *
 * These tests exist because this logic was previously duplicated and untested, and the lane
 * grid ended up driven by a CSS custom property (`--second-width`) that nothing ever assigned.
 * It silently fell back to a hardcoded 120 px interval while the ruler ticks sat at
 * `stepSeconds × fps × zoom` pixels, so the two only lined up by coincidence: at 0.05 px/frame
 * the ruler labelled every 180 px against a 120 px grid, and at 40 px/frame the grid became a
 * dense band of ~9 meaningless lines across a viewport showing 27 frames.
 *
 * The central assertion below is therefore not "the numbers look reasonable" but the invariant
 * that was broken: **the grid interval must be exactly one of the ruler's own steps.**
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GRID_STEP_VAR, SECOND_STEPS, timelineScale } from "./timelineScale";
import { frameRate } from "../state/coreOps";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLESHEET = readFileSync(join(HERE, "..", "styles", "timeline.css"), "utf8");

/** The zoom slider's range in `Timeline.tsx` / `editorStore.ts`. */
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 40;
/** Every frame-rate preset the project selector offers, plus the rational NTSC rates. */
const RATES = [
  frameRate(30, 1),
  frameRate(25, 1),
  frameRate(24, 1),
  frameRate(60, 1),
  frameRate(50, 1),
  frameRate(30000, 1001),
  frameRate(24000, 1001),
  frameRate(60000, 1001),
];

/** Zooms spanning the slider plus a spread of intermediate values. */
const ZOOMS = [ZOOM_MIN, 0.1, 0.25, 0.5, 1, 2, 4, 10, 20, ZOOM_MAX];

describe("the grid is never independent of the ruler", () => {
  it("always places grid lines exactly on a ruler step", () => {
    for (const fps of RATES) {
      for (const zoom of ZOOMS) {
        const scale = timelineScale(fps, zoom);
        const minorPx = scale.minorStepFrames * zoom;
        const majorPx = scale.majorStepFrames * zoom;
        expect(
          [minorPx, majorPx],
          `fps ${fps.num}/${fps.den} at ${zoom} px/f: grid ${scale.gridStepPx}px is not a ruler step`,
        ).toContain(scale.gridStepPx);
      }
    }
  });

  it("keeps the grid coarse enough to be a guide rather than a block", () => {
    for (const fps of RATES) {
      for (let zoom = ZOOM_MIN; zoom <= ZOOM_MAX; zoom += 0.05) {
        const scale = timelineScale(fps, zoom);
        // Rounding the step to whole frames can shave a fraction off 12px; anything under
        // half of that would mean the minor step was chosen when it should not have been.
        expect(scale.gridStepPx, `fps ${fps.num}/${fps.den} at ${zoom}`).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it("never emits a value that would invalidate the CSS gradient", () => {
    for (const fps of RATES) {
      for (const zoom of ZOOMS) {
        const scale = timelineScale(fps, zoom);
        expect(Number.isFinite(scale.gridStepPx)).toBe(true);
        expect(scale.gridStepPx).toBeGreaterThan(0);
        expect(Number.isInteger(scale.gridStepFrames)).toBe(true);
        expect(scale.gridStepFrames).toBeGreaterThan(0);
      }
    }
  });
});

describe("concrete values at the zooms that showed the bug", () => {
  it("resolves 30 fps at the default zoom", () => {
    const scale = timelineScale(frameRate(30, 1), 2);
    expect(scale.majorStepSeconds).toBe(2);
    expect(scale.majorStepFrames).toBe(60);
    expect(scale.minorStepFrames).toBe(12);
    expect(scale.gridStepPx).toBe(24);
  });

  it("resolves 30 fps at the minimum zoom (the first screenshot)", () => {
    const scale = timelineScale(frameRate(30, 1), 0.05);
    // One label every 120 s = 3600 frames = 180px, so the grid must be 180px or 36px —
    // never the legacy hardcoded 120px, which sat between the two.
    expect(scale.majorStepSeconds).toBe(120);
    expect(scale.gridStepPx).toBe(36);
    expect(scale.gridStepPx).not.toBe(120);
  });

  it("resolves 30 fps at the maximum zoom (the second screenshot)", () => {
    const scale = timelineScale(frameRate(30, 1), 40);
    expect(scale.majorStepSeconds).toBe(1);
    expect(scale.majorStepFrames).toBe(30);
    expect(scale.gridStepPx).toBe(240);
    // The legacy grid was 120px here, so ~9 lines crossed a viewport holding 27 frames.
    expect(scale.gridStepPx).not.toBe(120);
  });

  it("refines the grid interval as you zoom in, never coarsens it", () => {
    // `ZOOMS` runs from the most zoomed out to the most zoomed in, so the frame interval must
    // be non-increasing: a closer view shows fewer frames and therefore wants a finer grid.
    const frames = ZOOMS.map((zoom) => timelineScale(frameRate(30, 1), zoom).gridStepFrames);
    for (let index = 1; index < frames.length; index += 1) {
      expect(frames[index]!, `zoom ${ZOOMS[index]}`).toBeLessThanOrEqual(frames[index - 1]!);
    }
    // And it must actually change, not sit on one value the way the hardcoded 120px grid did.
    expect(new Set(frames).size).toBeGreaterThan(1);
  });
});

describe("label spacing", () => {
  it("clears the ~96px label target, except at the clamped maximum step", () => {
    const maxStepSeconds = SECOND_STEPS[SECOND_STEPS.length - 1]!;
    for (const fps of RATES) {
      for (const zoom of ZOOMS) {
        const scale = timelineScale(fps, zoom);
        const majorPx = scale.majorStepFrames * zoom;
        if (scale.majorStepSeconds === maxStepSeconds) {
          // The list ran out: below ~0.0053 px/frame no candidate can clear the target, and
          // the slider's minimum is 0.05, so this branch is only reachable for absurd input.
          expect(zoom).toBeLessThan(0.01);
          continue;
        }
        expect(majorPx, `fps ${fps.num}/${fps.den} at ${zoom}`).toBeGreaterThanOrEqual(90);
      }
    }
  });

  it("drops minor ticks when they would merge into a solid line", () => {
    // At the minimum zoom the minor step is 720 frames = 36px, so minor ticks are drawn.
    expect(timelineScale(frameRate(30, 1), ZOOM_MIN).minorTicksVisible).toBe(true);
    // A hypothetical sub-pixel zoom must turn them off rather than draw thousands of lines.
    const dense = timelineScale(frameRate(30, 1), 0.001);
    expect(dense.minorTicksVisible).toBe(false);
  });
});

describe("degenerate input cannot leak NaN into CSS", () => {
  it.each([
    ["zero", 0],
    ["negative", -5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("falls back to a usable scale for %s zoom", (_label, zoom) => {
    const scale = timelineScale(frameRate(30, 1), zoom);
    expect(Number.isFinite(scale.gridStepPx)).toBe(true);
    expect(scale.gridStepPx).toBeGreaterThan(0);
    expect(scale.zoom).toBeGreaterThan(0);
  });

  it("tolerates a nonsense frame rate rather than dividing by zero", () => {
    const scale = timelineScale({ num: 0, den: 1 }, 2);
    expect(Number.isFinite(scale.gridStepPx)).toBe(true);
    expect(scale.fps).toBeGreaterThanOrEqual(1);
  });
});

describe("the stylesheet contract", () => {
  it("drives the lane grid from the shared variable", () => {
    expect(GRID_STEP_VAR).toBe("--grid-step");
    expect(STYLESHEET).toContain(`var(${GRID_STEP_VAR}`);
  });

  it("no longer references the variable that was never assigned", () => {
    // The regression guard: `--second-width` had a 120px fallback and no writer, which is
    // precisely how the grid came to ignore the zoom.
    expect(STYLESHEET).not.toContain("--second-width");
  });

  it("draws no grid at all if the variable is missing, rather than a fixed interval", () => {
    // A wrong-but-visible grid is worse than no grid, so the fallback must be effectively
    // infinite rather than a plausible-looking pixel value.
    expect(STYLESHEET).toMatch(/var\(--grid-step,\s*\d{4,}px\)/);
  });

  it("puts the grid on the scrolling content, not on the scroll container", () => {
    // A background on a scroll container does not move with its content, so the grid would
    // stay put while clips scrolled past it.
    const lanes = STYLESHEET.slice(
      STYLESHEET.indexOf(".timeline__lanes {"),
      STYLESHEET.indexOf(".timeline__content {"),
    );
    expect(lanes).not.toContain("repeating-linear-gradient");
    const content = STYLESHEET.slice(STYLESHEET.indexOf(".timeline__content {"));
    expect(content.slice(0, 600)).toContain("repeating-linear-gradient");
  });
});
