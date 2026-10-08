/**
 * Caption helper tests: SRT output and forgiving timecode parsing (FR-11).
 *
 * Both are pure functions, so a caption export bug is caught here rather than by watching a
 * subtitle file fail to load in a player.
 */
import { describe, expect, it } from "vitest";
import type { Clip } from "@creativelab/core";
import { DEFAULT_CLIP_PROPERTIES } from "@creativelab/core";
import { formatShortSeconds, parseTimecodeSafe, srtTimestamp } from "./captionUtils";
import { buildSrt } from "./CaptionsPanel";
import { createEditorStore } from "../state/editorStore";
import { createInitialDocument } from "../state/coreOps";

const NOW = "2026-01-01T00:00:00.000Z";
const FPS = { num: 30, den: 1 };

function captionClip(id: string, startFrame: number, durationFrames: number, text: string): Clip {
  return {
    id,
    trackId: "trk_c1",
    sequenceId: "seq_000000000000000000000000",
    assetId: null,
    label: text,
    startFrame,
    sourceInFrame: 0,
    durationFrames,
    properties: { ...DEFAULT_CLIP_PROPERTIES, notes: text },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("srtTimestamp", () => {
  it("formats frames as HH:MM:SS,mmm", () => {
    expect(srtTimestamp(0, FPS)).toBe("00:00:00,000");
    expect(srtTimestamp(30, FPS)).toBe("00:00:01,000");
    expect(srtTimestamp(45, FPS)).toBe("00:00:01,500");
    expect(srtTimestamp(30 * 60, FPS)).toBe("00:01:00,000");
    expect(srtTimestamp(30 * 3600, FPS)).toBe("01:00:00,000");
  });

  it("handles 29.97 correctly rather than assuming an integer rate", () => {
    const ntsc = { num: 30000, den: 1001 };
    // 30 frames at 29.97 is slightly more than one second of wall clock.
    expect(srtTimestamp(30, ntsc)).toBe("00:00:01,001");
  });

  it("clamps negative frames instead of emitting a negative timestamp", () => {
    expect(srtTimestamp(-10, FPS)).toBe("00:00:00,000");
  });
});

describe("buildSrt", () => {
  it("numbers segments from one and sorts them by start frame", () => {
    const srt = buildSrt(
      [captionClip("clp_b", 60, 30, "second line"), captionClip("clp_a", 0, 30, "first line")],
      FPS,
    );
    expect(srt).toBe(
      [
        "1",
        "00:00:00,000 --> 00:00:01,000",
        "first line",
        "",
        "2",
        "00:00:02,000 --> 00:00:03,000",
        "second line",
        "",
      ].join("\n"),
    );
  });

  it("produces an empty document for an empty caption track", () => {
    expect(buildSrt([], FPS)).toBe("");
  });

  it("falls back to the clip label when no note is recorded", () => {
    const clip: Clip = {
      ...captionClip("clp_a", 0, 15, "fallback"),
      properties: { ...DEFAULT_CLIP_PROPERTIES },
    };
    expect(buildSrt([clip], FPS)).toContain("fallback\n");
  });
});

describe("parseTimecodeSafe", () => {
  it("parses HH:MM:SS:FF into a frame index", () => {
    expect(parseTimecodeSafe("00:00:01:00", FPS)).toBe(30);
    expect(parseTimecodeSafe("00:01:00:15", FPS)).toBe(30 * 60 + 15);
    expect(parseTimecodeSafe("01:00:00:00", FPS)).toBe(30 * 3600);
  });

  it("returns null for transient invalid input instead of throwing", () => {
    for (const value of ["", "00:00", "abc", "00:00:00", "00:00:00:", "1:2:3"]) {
      expect(parseTimecodeSafe(value, FPS)).toBeNull();
    }
  });

  it("rejects a frame field at or beyond the nominal rate", () => {
    expect(parseTimecodeSafe("00:00:00:30", FPS)).toBeNull();
    expect(parseTimecodeSafe("00:00:00:29", FPS)).toBe(29);
  });

  it("rejects out-of-range minutes and seconds", () => {
    expect(parseTimecodeSafe("00:75:00:00", FPS)).toBeNull();
    expect(parseTimecodeSafe("00:00:75:00", FPS)).toBeNull();
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseTimecodeSafe("  00:00:02:00  ", FPS)).toBe(60);
  });
});

describe("formatShortSeconds", () => {
  it("omits the hour field under an hour", () => {
    expect(formatShortSeconds(0)).toBe("0:00");
    expect(formatShortSeconds(65)).toBe("1:05");
  });

  it("includes the hour field beyond an hour", () => {
    expect(formatShortSeconds(3661)).toBe("1:01:01");
  });
});

describe("caption segment edits reach the store through the undo stack", () => {
  /**
   * Guards the wiring between the captions panel and the editor store. The panel delegates
   * text to `setClipProperties` (the same path the Inspector uses) and timing to
   * `applyEdit`, so these assertions fail if either route stops reaching the document.
   */
  function captionHarness() {
    const base = createInitialDocument({
      id: "prj_000000000000000000000000",
      schemaVersion: 1,
      title: "Captions",
      fps: FPS,
      width: 1920,
      height: 1080,
      colorProfile: "bt709",
      sampleRate: 48_000,
      channels: 2,
      workspaceRelPath: ".",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const track = base.tracks.find((entry) => entry.kind === "caption")!;
    const clip = captionClip("clp_c", 0, 30, "first pass");
    const store = createEditorStore({
      ...base,
      clips: [{ ...clip, trackId: track.id, sequenceId: base.sequences[0]!.id }],
    });
    return { store, clipId: clip.id };
  }

  it("writes caption text as a clip property and makes it undoable", () => {
    const { store, clipId } = captionHarness();
    store.getState().setClipProperties(clipId, { notes: "edited line" }, { coalesce: false });
    expect(store.getState().document.clips[0]!.properties.notes).toBe("edited line");
    expect(store.getState().history.canUndo).toBe(true);
    store.getState().undo();
    expect(store.getState().document.clips[0]!.properties.notes).toBe("first pass");
  });

  it("retimes a caption segment without dropping its text", () => {
    const { store, clipId } = captionHarness();
    store.getState().applyEdit(
      "Retime caption",
      (current) => ({
        ...current,
        clips: current.clips.map((candidate) =>
          candidate.id === clipId
            ? { ...candidate, startFrame: 60, durationFrames: 45 }
            : candidate,
        ),
      }),
      { coalesce: false },
    );
    const clip = store.getState().document.clips[0]!;
    expect(clip.startFrame).toBe(60);
    expect(clip.durationFrames).toBe(45);
    // The text lives in `properties.notes`; a retime must not clear it.
    expect(clip.properties.notes).toBe("first pass");
  });
});
