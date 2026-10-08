/**
 * The renderer's domain surface is a set of **re-exports** of `@creativelab/core`, resolved
 * through core's browser-safe entry point. There is no mirrored logic left to drift, so the
 * useful thing to assert is not "does the copy agree with the original" (it *is* the
 * original) but:
 *
 *   1. the re-export surface is complete — a future rename in core must break this file
 *      loudly rather than silently resolving to `undefined` and crashing a panel at
 *      runtime, and
 *   2. the two genuine renderer adaptations (`activeSequence` and the boolean
 *      `formatTimecode` wrapper) behave correctly, including the drop-frame support the old
 *      hand-written copy lacked.
 *
 * Behavioural coverage for the timeline algebra itself lives in
 * `packages/core/src/timeline.test.ts` and its siblings; re-asserting it here through an
 * alias would add indirection without adding confidence.
 */
import { describe, expect, it } from "vitest";
import type { Clip, EditorDocument } from "@creativelab/core";
import * as core from "@creativelab/core";
import * as ops from "./coreOps";
import * as budget from "./budgetOps";
import * as money from "../utils/money";

const now = "2026-01-01T00:00:00.000Z";

function makeDocument(fps = { num: 30, den: 1 }): EditorDocument {
  const project = core.ProjectSchema.parse({
    id: "prj_test000000000000000001",
    schemaVersion: core.SCHEMA_VERSION,
    title: "Renderer fixture",
    fps,
    width: 1920,
    height: 1080,
    createdAt: now,
    updatedAt: now,
  });
  return core.createInitialDocument(project);
}

function makeClip(document: EditorDocument, startFrame: number, durationFrames: number): Clip {
  const track = document.tracks.find((candidate) => candidate.kind === "video")!;
  return core.ClipSchema.parse({
    id: core.newId("clip"),
    trackId: track.id,
    sequenceId: track.sequenceId,
    startFrame,
    durationFrames,
    createdAt: now,
    updatedAt: now,
  });
}

/** Names the UI calls through `coreOps`; each must be core's own function. */
const TIMELINE_OPS = [
  "addTrack",
  "assertTimelineInvariants",
  "clipAtFrame",
  "clipEnd",
  "clipRange",
  "clipsInRange",
  "clipsOnTrack",
  "closeGaps",
  "collectSnapTargets",
  "createEffect",
  "createInitialDocument",
  "createTrack",
  "defaultTrackName",
  "deleteClips",
  "detectOverlaps",
  "duplicateClips",
  "emptyProperties",
  "mergeRanges",
  "moveClip",
  "rangesOverlap",
  "removeTrack",
  "reorderTrack",
  "sequenceDurationFrames",
  "sequenceFrameRate",
  "setClipProperties",
  "snapClipMove",
  "snapFrame",
  "sortClips",
  "sourceRange",
  "sourceSpan",
  "splitClip",
  "trimClip",
  "updateTrack",
] as const;

const HELPER_OPS = [
  "frameRate",
  "frameRateAsNumber",
  "frameRateEquals",
  "framesToClock",
  "framesToMs",
  "framesToSeconds",
  "msToFrames",
  "nominalFps",
  "parseTimecode",
  "secondsToFrames",
  "supportsDropFrame",
  "isoNow",
  "newId",
  "newRunId",
  "isId",
  "TimelineError",
  "History",
] as const;

describe("re-export completeness (a tripwire for a core rename)", () => {
  it("exposes every timeline operation the editor calls, as core's own function", () => {
    for (const name of TIMELINE_OPS) {
      expect(typeof (ops as Record<string, unknown>)[name], `ops.${name}`).toBe("function");
      // Identity, not just availability: this proves there is no second implementation.
      expect((ops as Record<string, unknown>)[name], `ops.${name}`).toBe(
        (core as Record<string, unknown>)[name],
      );
    }
  });

  it("exposes the time, id and error helpers from core", () => {
    for (const name of HELPER_OPS) {
      expect((ops as Record<string, unknown>)[name], `ops.${name}`).toBeDefined();
      expect((ops as Record<string, unknown>)[name], `ops.${name}`).toBe(
        (core as Record<string, unknown>)[name],
      );
    }
  });

  it("exposes the preset tables and the budget/money helpers as aliases, not copies", () => {
    expect(ops.TRACK_LIMITS_LOCAL).toBe(core.TRACK_LIMITS);
    expect(ops.ASPECT_PRESETS_LOCAL).toBe(core.ASPECT_PRESETS);
    expect(ops.FRAME_RATE_PRESETS_LOCAL).toBe(core.FRAME_RATE_PRESETS);
    expect(ops.EXPORT_PRESETS_LOCAL).toBe(core.EXPORT_PRESETS);
    expect(ops.DEFAULT_BUDGET_POLICY_LOCAL).toBe(core.DEFAULT_BUDGET_POLICY);

    expect(budget.evaluateBudget).toBe(core.evaluateBudget);
    expect(money.roundMoney).toBe(core.roundMoney);
    expect(money.addMoney).toBe(core.addMoney);
    expect(money.formatMoney).toBe(core.formatMoney);
    expect(money.dayKey).toBe(core.dayKey);
    expect(money.spendOn).toBe(core.spendOn);
  });

  it("offers the frame rates and track minimums the UI promises", () => {
    // PRD §4 requires 24/25/30/60 presets and at least 3 video / 4 audio tracks.
    const ids = ops.FRAME_RATE_PRESETS_LOCAL.map((preset) => preset.id);
    for (const required of ["24", "25", "30", "60"]) expect(ids).toContain(required);
    expect(ops.TRACK_LIMITS_LOCAL.video).toBeGreaterThanOrEqual(3);
    expect(ops.TRACK_LIMITS_LOCAL.audio).toBeGreaterThanOrEqual(4);
  });
});

describe("activeSequence (a genuine renderer adaptation)", () => {
  it("prefers the flagged sequence", () => {
    const document = makeDocument();
    const first = { ...document.sequences[0]!, isActive: false };
    const second = {
      ...document.sequences[0]!,
      id: "seq_second000000000000001",
      name: "Second",
      isActive: true,
    };
    expect(ops.activeSequence({ ...document, sequences: [first, second] })?.id).toBe(second.id);
  });

  it("falls back to the first sequence when nothing is flagged", () => {
    // The case core never has to handle: a document loaded without an active flag.
    const document = makeDocument();
    const unflagged: EditorDocument = {
      ...document,
      sequences: document.sequences.map((sequence) => ({ ...sequence, isActive: false })),
    };
    expect(ops.activeSequence(unflagged)?.id).toBe(document.sequences[0]!.id);
  });

  it("returns undefined rather than throwing for a sequence-less document", () => {
    expect(ops.activeSequence({ ...makeDocument(), sequences: [] })).toBeUndefined();
  });

  it("agrees with the frame rate the timeline uses", () => {
    const document = makeDocument({ num: 30000, den: 1001 });
    expect(ops.sequenceFrameRate(document)).toEqual({ num: 30000, den: 1001 });
  });
});

describe("formatTimecode wrapper (a genuine renderer adaptation)", () => {
  it("delegates to core and matches it exactly", () => {
    const fps = ops.frameRate(30, 1);
    for (const frames of [0, 1, 29, 30, 90, 3600 * 30 + 15]) {
      expect(ops.formatTimecode(frames, fps)).toBe(
        core.formatTimecode(frames, fps, { includeHours: true }),
      );
    }
  });

  it("honours the boolean includeHours argument the call sites use", () => {
    const fps = ops.frameRate(30, 1);
    expect(ops.formatTimecode(30 * 90, fps)).toBe("00:01:30:00");
    expect(ops.formatTimecode(30 * 90, fps, false)).toBe("01:30:00");
  });

  it("can express drop-frame numbering at 29.97, which the previous copy could not", () => {
    const ntsc = ops.frameRate(30000, 1001);
    // Frame 1800 is the canonical check: ;00 and ;01 do not exist at the top of a minute.
    expect(core.formatTimecode(1800, ntsc, { format: "drop" })).toBe("00:01:00;02");
    // The wrapper's default remains non-drop, matching every existing call site.
    expect(ops.formatTimecode(1800, ntsc)).toBe("00:01:00:00");
  });
});

describe("the editor and the renderer agree on clip geometry", () => {
  it("splits, trims and moves through the same code the export path uses", () => {
    const document = makeDocument();
    const clip = makeClip(document, 0, 100);
    const split = ops.splitClip([clip], clip.id, 40);
    expect(split.clips).toHaveLength(2);

    const trimmed = ops.trimClip(split.clips, split.rightId, "end", 70);
    expect(trimmed.find((candidate) => candidate.id === split.rightId)!.durationFrames).toBe(30);

    const moved = ops.moveClip(trimmed, document.tracks, {
      clipId: split.rightId,
      toStartFrame: 200,
    });
    expect(moved.find((candidate) => candidate.id === split.rightId)!.startFrame).toBe(200);
    expect(ops.detectOverlaps(moved)).toHaveLength(0);
  });
});
