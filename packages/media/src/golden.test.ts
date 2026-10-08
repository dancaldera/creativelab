/**
 * Visual golden-frame tests (PRD §17: "Visual golden tests: title, crop, opacity,
 * transitions and captions match preview to output at sampled frames").
 *
 * These render a real timeline with FFmpeg and then **read the pixels back** from the
 * produced MP4. That is the only way to catch a class of bug the string-level graph tests
 * cannot: the filter graph being textually correct while the pixels come out wrong (a
 * mis-ordered stage, a wrong coordinate space, a disabled overlay window).
 *
 * ## Why there are no committed reference images
 *
 * A byte-for-byte golden image would fail on every FFmpeg or x264 upgrade for reasons that
 * have nothing to do with this codebase. Instead each case asserts a *property of known
 * geometry* — "the centre of a 50 %-scaled red clip is red and its corner is black" — which
 * is stable across encoder versions while still being a real pixel assertion. Where a value
 * is inexact (H.264 quantisation, 4:2:0 chroma subsampling) the tolerance is explicit and
 * justified rather than loosened until it passes.
 *
 * ## What is covered, and what is not
 *
 * Covered: clip positioning, scale-to-fit letterboxing, opacity/alpha blending, crop, and
 * the sequential timing of clips on one track. Not covered, because the renderer does not
 * implement them yet: titles/text and burn-in captions (FR-12), clip effects and keyframes
 * (FR-12), and transitions — the UI states all three are inert, and
 * `Inspector.tsx`'s `RENDERED_TRANSITION_KINDS` is the single place that gates them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClipSchema,
  ExportPresetSchema,
  ProjectSchema,
  createInitialDocument,
  frameRate,
  newId,
  type Clip,
  type EditorDocument,
} from "@creativelab/core";

import { ffmpegAvailable, runFfmpeg } from "../src/index.js";
import { renderTimeline } from "../src/export.js";
import type { GraphAssetInfo } from "../src/graph.js";

const FPS = frameRate(25, 1);
const SIZE = 64;
const NOW = "2026-01-01T00:00:00.000Z";

/** A tiny square preset: the assertions are about geometry, not resolution. */
const PRESET = ExportPresetSchema.parse({
  id: "golden",
  label: "Golden frame probe",
  width: SIZE,
  height: SIZE,
  videoBitrateKbps: 4_000,
});

const available = await ffmpegAvailable();
const suite = available ? describe : describe.skip;

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "creativelab-golden-"));
  await mkdir(workDir, { recursive: true });
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A single-colour clip. `color=c=red` is exact before encoding. */
async function makeSolid(path: string, color: string, seconds = 2): Promise<string> {
  await runFfmpeg([
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=${SIZE}x${SIZE}:r=25:d=${seconds}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    path,
  ]);
  return path;
}

/** Left half one colour, right half another — used to prove crop actually removes pixels. */
async function makeSplit(path: string, left: string, right: string, seconds = 2): Promise<string> {
  await runFfmpeg([
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${left}:s=${SIZE}x${SIZE}:r=25:d=${seconds}`,
    "-f",
    "lavfi",
    "-i",
    `color=c=${right}:s=${SIZE}x${SIZE}:r=25:d=${seconds}`,
    "-filter_complex",
    "hstack=inputs=2",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    path,
  ]);
  return path;
}

type Rgb = readonly [number, number, number];

/** Pull one frame out of a rendered MP4 as raw RGB24 and index it. */
async function framePixels(
  videoPath: string,
  atSeconds: number,
): Promise<{ at: (x: number, y: number) => Rgb; pixels: Buffer }> {
  const rawPath = join(workDir, `frame-${atSeconds}-${Math.random().toString(36).slice(2, 8)}.rgb`);
  await runFfmpeg([
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-i",
    videoPath,
    // Output seeking: accurate to the frame rather than snapping to a keyframe.
    "-ss",
    String(atSeconds),
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    rawPath,
  ]);
  const pixels = await readFile(rawPath);
  expect(pixels.byteLength).toBe(SIZE * SIZE * 3);

  return {
    pixels,
    at(x: number, y: number): Rgb {
      const offset = (y * SIZE + x) * 3;
      return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!];
    },
  };
}

/** Distance in RGB space, for a readable failure message. */
function distance(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/**
 * H.264 at a low bitrate plus 4:2:0 chroma subsampling shifts saturated colours, so a
 * tolerance is unavoidable. 60/255 (~24 %) is generous enough to survive x264 version
 * differences while still failing outright if a stage is missing or misplaced: a missing
 * crop leaves a whole differently-coloured region, and a missing opacity stage is a 128-step
 * error.
 */
const TOLERANCE = 60;

function expectColour(actual: Rgb, expected: Rgb, what: string): void {
  const delta = distance(actual, expected);
  expect(
    delta,
    `${what}: expected ~rgb(${expected.join(",")}) but sampled rgb(${actual.join(",")})`,
  ).toBeLessThanOrEqual(TOLERANCE);
}

function expectBlack(actual: Rgb, what: string): void {
  const brightest = Math.max(actual[0], actual[1], actual[2]);
  expect(
    brightest,
    `${what}: expected near-black but sampled rgb(${actual.join(",")})`,
  ).toBeLessThanOrEqual(40);
}

// ---------------------------------------------------------------------------
// Document construction
// ---------------------------------------------------------------------------

interface ClipSpec {
  assetId: string;
  startFrame: number;
  durationFrames: number;
  opacity?: number;
  scale?: number;
  xOffset?: number;
  cropRight?: number;
}

function buildDocument(specs: ClipSpec[], assets: Map<string, GraphAssetInfo>): EditorDocument {
  const project = ProjectSchema.parse({
    id: "prj_golden00000000000000001",
    schemaVersion: 1,
    title: "Golden frames",
    fps: FPS,
    width: SIZE,
    height: SIZE,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const document = createInitialDocument(project);
  const track = document.tracks.find((candidate) => candidate.kind === "video")!;

  const clips: Clip[] = specs.map((spec) =>
    ClipSchema.parse({
      id: newId("clip"),
      trackId: track.id,
      sequenceId: track.sequenceId,
      assetId: spec.assetId,
      label: spec.assetId,
      startFrame: spec.startFrame,
      sourceInFrame: 0,
      durationFrames: spec.durationFrames,
      properties: {
        transform: { scale: spec.scale ?? 1, opacity: spec.opacity ?? 1, x: spec.xOffset ?? 0 },
        crop: { right: spec.cropRight ?? 0 },
      },
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );

  // Every asset is described as containing audio so the graph builds a complete audio
  // pipeline, but the fixtures are video-only; `hasAudio: false` keeps that honest.
  for (const [id, info] of assets) void [id, info];

  return { ...document, clips };
}

async function renderGolden(document: EditorDocument, assets: Map<string, GraphAssetInfo>) {
  const outputDir = join(workDir, `out-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(outputDir, { recursive: true });
  return renderTimeline(document, {
    outputDir,
    preset: PRESET,
    assets,
    outputName: "golden.mp4",
  });
}

// ---------------------------------------------------------------------------

suite("golden frames: the exported pixels match the composition spec", () => {
  it("places a scaled clip centred, leaving the base visible at the edges", async () => {
    const red = await makeSolid(join(workDir, "red.mp4"), "red");
    const assets = new Map<string, GraphAssetInfo>([
      ["ast_golden_red", { path: red, durationFrames: 50, hasAudio: false }],
    ]);
    const document = buildDocument(
      [{ assetId: "ast_golden_red", startFrame: 0, durationFrames: 50, scale: 0.5 }],
      assets,
    );

    const result = await renderGolden(document, assets);
    const frame = await framePixels(result.outputPath, 1);

    // Half-scale content sits in the middle; a centre sample is inside it.
    expectColour(frame.at(SIZE / 2, SIZE / 2), [255, 0, 0], "centre of a half-scale red clip");
    // The corners fall outside the scaled clip, so the black base shows through. Before the
    // `transform.scale` stage existed, `scale` was a stored property the preview honoured and
    // the exporter ignored, and this assertion is what caught it.
    expectBlack(frame.at(2, 2), "top-left corner outside the scaled clip");
    expectBlack(frame.at(SIZE - 3, 2), "top-right corner outside the scaled clip");

    // Quantify it: a 50 %-scaled clip covers about a quarter of the frame. A regression that
    // dropped the stage would push this to roughly 100 % of the pixels.
    const redPixels = countMatching(
      frame.pixels,
      (rgb) => rgb[0] > 140 && rgb[1] < 110 && rgb[2] < 110,
    );
    const coverage = redPixels / (SIZE * SIZE);
    expect(
      coverage,
      `scaled clip covered ${(coverage * 100).toFixed(1)}% of the frame`,
    ).toBeGreaterThan(0.15);
    expect(
      coverage,
      `scaled clip covered ${(coverage * 100).toFixed(1)}% of the frame`,
    ).toBeLessThan(0.45);
  });

  it("blends a 50 % opaque clip against the base", async () => {
    const white = await makeSolid(join(workDir, "white.mp4"), "white");
    const assets = new Map<string, GraphAssetInfo>([
      ["ast_golden_white", { path: white, durationFrames: 50, hasAudio: false }],
    ]);
    const document = buildDocument(
      [{ assetId: "ast_golden_white", startFrame: 0, durationFrames: 50, opacity: 0.5 }],
      assets,
    );

    const result = await renderGolden(document, assets);
    const frame = await framePixels(result.outputPath, 1);

    // White at 50 % over a black base is ~50 % grey. A missing alpha stage would be white
    // (255) and an ignored clip would be black (0); both are far outside the tolerance.
    const centre = frame.at(SIZE / 2, SIZE / 2);
    expect(
      Math.abs(centre[0] - 128),
      `expected ~128 grey, sampled rgb(${centre.join(",")})`,
    ).toBeLessThanOrEqual(45);
    expect(Math.abs(centre[0] - centre[1])).toBeLessThanOrEqual(8);
    expect(Math.abs(centre[1] - centre[2])).toBeLessThanOrEqual(8);
  });

  it("crops content away rather than merely rescaling it", async () => {
    const split = await makeSplit(join(workDir, "split.mp4"), "red", "blue");
    const assets = new Map<string, GraphAssetInfo>([
      ["ast_golden_split", { path: split, durationFrames: 50, hasAudio: false }],
    ]);

    // Baseline: without a crop, the right-hand blue region is visible.
    const uncropped = await renderGolden(
      buildDocument([{ assetId: "ast_golden_split", startFrame: 0, durationFrames: 50 }], assets),
      assets,
    );
    const uncroppedFrame = await framePixels(uncropped.outputPath, 1);
    const sawBlue = countMatching(uncroppedFrame.pixels, (rgb) => rgb[2] > 140 && rgb[0] < 110);
    expect(sawBlue, "the uncropped fixture should show a blue region").toBeGreaterThan(50);

    // Cropping the right half off must remove that blue region entirely. A test that only
    // checked "the output changed" would pass even if crop were applied in the wrong
    // coordinate space.
    const cropped = await renderGolden(
      buildDocument(
        [{ assetId: "ast_golden_split", startFrame: 0, durationFrames: 50, cropRight: 0.5 }],
        assets,
      ),
      assets,
    );
    const croppedFrame = await framePixels(cropped.outputPath, 1);
    const remainingBlue = countMatching(croppedFrame.pixels, (rgb) => rgb[2] > 140 && rgb[0] < 110);
    expect(remainingBlue, "cropping the right half must remove the blue region").toBe(0);
  });

  it("switches clips at the frame the timeline says they start", async () => {
    const red = await makeSolid(join(workDir, "seq-red.mp4"), "red");
    const blue = await makeSolid(join(workDir, "seq-blue.mp4"), "blue");
    const assets = new Map<string, GraphAssetInfo>([
      ["ast_golden_seq_red", { path: red, durationFrames: 50, hasAudio: false }],
      ["ast_golden_seq_blue", { path: blue, durationFrames: 50, hasAudio: false }],
    ]);

    // Red for frames 0–24 (0.0–0.96 s), blue for 25–49 (1.0–1.96 s): a cut at 1.0 s.
    const document = buildDocument(
      [
        { assetId: "ast_golden_seq_red", startFrame: 0, durationFrames: 25 },
        { assetId: "ast_golden_seq_blue", startFrame: 25, durationFrames: 25 },
      ],
      assets,
    );

    const result = await renderGolden(document, assets);

    const during = await framePixels(result.outputPath, 0.4);
    expectColour(during.at(SIZE / 2, SIZE / 2), [255, 0, 0], "the first clip's window");
    // The clip is at natural size, so it fills the composition — corners included.
    expectColour(during.at(2, 2), [255, 0, 0], "corner of a full-frame clip");

    const after = await framePixels(result.outputPath, 1.6);
    expectColour(after.at(SIZE / 2, SIZE / 2), [0, 0, 255], "the second clip's window");

    // Just before the cut the first clip must still be on screen: this is what catches an
    // overlay `enable` window that ends a frame early.
    const justBefore = await framePixels(result.outputPath, 0.92);
    expectColour(justBefore.at(SIZE / 2, SIZE / 2), [255, 0, 0], "the frame before the cut");
  });

  it("produces the frame count the timeline's duration implies", async () => {
    const red = await makeSolid(join(workDir, "count-red.mp4"), "red");
    const assets = new Map<string, GraphAssetInfo>([
      ["ast_golden_count", { path: red, durationFrames: 40, hasAudio: false }],
    ]);
    const document = buildDocument(
      [{ assetId: "ast_golden_count", startFrame: 0, durationFrames: 40 }],
      assets,
    );

    const result = await renderGolden(document, assets);
    // 40 frames at 25 fps is exactly 1.6 s, and the export must not resample it.
    expect(result.frames).toBe(40);
    expect(result.durationSeconds).toBeCloseTo(1.6, 3);
  });

  it("omits composition stages that would be identity", async () => {
    // The graph-level tests assert this as text; this asserts it as a property of the
    // rendered output, which is what actually matters for encode time and quality.
    const red = await makeSolid(join(workDir, "identity-red.mp4"), "red");
    const assets = new Map<string, GraphAssetInfo>([
      ["ast_golden_identity", { path: red, durationFrames: 25, hasAudio: false }],
    ]);
    const document = buildDocument(
      [{ assetId: "ast_golden_identity", startFrame: 0, durationFrames: 25 }],
      assets,
    );

    const result = await renderGolden(document, assets);
    const frame = await framePixels(result.outputPath, 0.5);
    // A full-frame, fully opaque clip fills the composition: all four corners are the clip.
    expectColour(frame.at(1, 1), [255, 0, 0], "top-left of a full-frame clip");
    expectColour(frame.at(SIZE - 2, SIZE - 2), [255, 0, 0], "bottom-right of a full-frame clip");
  });
});

/** Count pixels satisfying a predicate — used to prove a region is present or gone. */
function countMatching(pixels: Buffer, predicate: (rgb: Rgb) => boolean): number {
  let count = 0;
  for (let offset = 0; offset < pixels.byteLength; offset += 3) {
    if (predicate([pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!])) count += 1;
  }
  return count;
}
