import { describe, expect, it } from "vitest";
import {
  convertFrames,
  dropFrameCount,
  formatTimecode,
  frameRate,
  framesToClock,
  framesToMs,
  framesToSeconds,
  framesToTimecodeParts,
  msToFrames,
  nominalFps,
  parseTimecode,
  rational,
  retimeDuration,
  secondsToFrames,
  supportsDropFrame,
  FRAME_RATE_PRESETS,
} from "../src/timebase.js";

const fps24 = frameRate(24, 1);
const fps25 = frameRate(25, 1);
const fps30 = frameRate(30, 1);
const ntsc2997 = frameRate(30000, 1001);
const ntsc23976 = frameRate(24000, 1001);
const ntsc5994 = frameRate(60000, 1001);

describe("frameRate", () => {
  it("reduces to lowest terms and rejects invalid input", () => {
    expect(frameRate(30000, 1001)).toEqual({ num: 30000, den: 1001 });
    expect(frameRate(50, 2)).toEqual({ num: 25, den: 1 });
    expect(frameRate(60, 2)).toEqual({ num: 30, den: 1 });
    expect(() => frameRate(0, 1)).toThrow(RangeError);
    expect(() => frameRate(30, 0)).toThrow(RangeError);
    expect(() => frameRate(29.97, 1)).toThrow(RangeError);
  });

  it("exposes the PRD-required presets (24/25/30/60) plus NTSC variants", () => {
    const ids = FRAME_RATE_PRESETS.map((preset) => preset.id);
    for (const required of ["24", "25", "30", "60"]) {
      expect(ids).toContain(required);
    }
    expect(ids).toContain("23.976");
    expect(ids).toContain("29.97");
    expect(ids).toContain("59.94");
  });

  it("computes the nominal rate used by timecode", () => {
    expect(nominalFps(ntsc2997)).toBe(30);
    expect(nominalFps(ntsc23976)).toBe(24);
    expect(nominalFps(ntsc5994)).toBe(60);
  });

  it("identifies drop-frame-capable rates", () => {
    expect(supportsDropFrame(ntsc2997)).toBe(true);
    expect(supportsDropFrame(ntsc5994)).toBe(true);
    expect(supportsDropFrame(ntsc23976)).toBe(false);
    expect(supportsDropFrame(fps30)).toBe(false);
    expect(dropFrameCount(ntsc2997)).toBe(2);
    expect(dropFrameCount(ntsc5994)).toBe(4);
    expect(dropFrameCount(fps25)).toBe(0);
  });
});

describe("frame <-> wall clock conversion", () => {
  it("is exact for integer rates", () => {
    expect(framesToSeconds(24, fps24)).toBe(1);
    expect(framesToSeconds(1500, fps25)).toBe(60);
    expect(secondsToFrames(2.5, fps30)).toBe(75);
    expect(framesToMs(48, fps24)).toBe(2000);
    expect(msToFrames(2000, fps24)).toBe(48);
  });

  it("never produces a fractional frame index", () => {
    for (const rate of [fps24, fps25, fps30, ntsc2997, ntsc23976, ntsc5994]) {
      for (const seconds of [0, 0.001, 1 / 3, 2.5, 59.94, 3600.5]) {
        const frames = secondsToFrames(seconds, rate);
        expect(Number.isInteger(frames)).toBe(true);
      }
    }
  });

  it("round-trips NTSC durations without drift beyond one frame over an hour", () => {
    for (const rate of [ntsc2997, ntsc5994, ntsc23976]) {
      const oneHourFrames = Math.round(3600 * (rate.num / rate.den));
      const seconds = framesToSeconds(oneHourFrames, rate);
      // Quantising an hour to whole frames can lose at most half a frame, but never a
      // whole frame — that is the property that keeps an hour-long edit in sync.
      expect(Math.abs(seconds - 3600)).toBeLessThan(rate.den / rate.num);
      expect(secondsToFrames(seconds, rate)).toBe(oneHourFrames);
    }
  });

  it("applies the requested rounding mode symmetrically for negatives", () => {
    // 0.51s * 24fps = 12.24 frames, so the three modes must disagree.
    expect(secondsToFrames(0.51, fps24, "floor")).toBe(12);
    expect(secondsToFrames(0.51, fps24, "round")).toBe(12);
    expect(secondsToFrames(0.51, fps24, "ceil")).toBe(13);
    // `round` must break ties away from zero rather than toward +Infinity.
    expect(secondsToFrames(-0.51, fps24, "round")).toBe(-12);
    expect(secondsToFrames(-0.51, fps24, "floor")).toBe(-13);
    expect(secondsToFrames(-0.51, fps24, "ceil")).toBe(-12);
  });

  it("rejects non-finite input rather than silently producing NaN frames", () => {
    expect(() => secondsToFrames(Number.NaN, fps24)).toThrow(RangeError);
    expect(() => secondsToFrames(Number.POSITIVE_INFINITY, fps24)).toThrow(RangeError);
  });
});

describe("timecode", () => {
  it("formats non-drop timecode", () => {
    expect(formatTimecode(0, fps24)).toBe("00:00:00:00");
    expect(formatTimecode(23, fps24)).toBe("00:00:00:23");
    expect(formatTimecode(24, fps24)).toBe("00:00:01:00");
    expect(formatTimecode(24 * 60, fps24)).toBe("00:01:00:00");
    expect(formatTimecode(24 * 3600, fps24)).toBe("01:00:00:00");
    expect(formatTimecode(90, fps30)).toBe("00:00:03:00");
  });

  it("honours includeHours: false", () => {
    expect(formatTimecode(48, fps24, { includeHours: false })).toBe("00:02:00");
    expect(formatTimecode(24 * 3600, fps24, { includeHours: false })).toBe("01:00:00:00");
  });

  it("skips frame numbers in drop-frame timecode", () => {
    // Frame numbers ;00 and ;01 do not exist at the top of a minute (except every tenth),
    // so the 1800th real frame is labelled 00:01:00;02 rather than 00:01:00;00.
    expect(formatTimecode(1800, ntsc2997, { format: "drop" })).toBe("00:01:00;02");
    expect(formatTimecode(1802, ntsc2997, { format: "drop" })).toBe("00:01:00;04");
    // Every tenth minute is not dropped at all.
    expect(formatTimecode(17982, ntsc2997, { format: "drop" })).toBe("00:10:00;00");
    // The same real frame in non-drop reads just under a minute.
    expect(formatTimecode(1798, ntsc2997)).toBe("00:00:59:28");
  });

  it("round-trips every timecode in a two-hour span, both formats", () => {
    for (const rate of [fps24, fps25, fps30, ntsc2997, ntsc5994]) {
      const formats: Array<"non-drop" | "drop"> = supportsDropFrame(rate)
        ? ["non-drop", "drop"]
        : ["non-drop"];
      for (const format of formats) {
        for (const frames of [0, 1, 24, 1798, 17982, 107892, 200_000, 215_000]) {
          const text = formatTimecode(frames, rate, { format });
          expect(parseTimecode(text, rate)).toBe(frames);
        }
      }
    }
  });

  it("rejects invalid drop-frame usage and malformed strings", () => {
    expect(() => formatTimecode(10, fps24, { format: "drop" })).toThrow(RangeError);
    expect(() => parseTimecode("00:00:05;10", fps24)).toThrow(RangeError);
    expect(() => parseTimecode("not a timecode", fps24)).toThrow(SyntaxError);
    expect(() => parseTimecode("00:00:00:30", fps30)).toThrow(RangeError);
  });

  it("decomposes parts consistently with the formatted string", () => {
    const parts = framesToTimecodeParts(90_015, fps30);
    expect(parts).toMatchObject({
      hours: 0,
      minutes: 50,
      seconds: 0,
      frames: 15,
      format: "non-drop",
    });
  });

  it("renders a readable transport clock", () => {
    expect(framesToClock(0, fps30)).toBe("0:00.000");
    expect(framesToClock(45, fps30)).toBe("0:01.500");
    expect(framesToClock(-15, fps30)).toBe("-0:00.500");
  });
});

describe("rate conversion and retiming", () => {
  it("preserves wall-clock duration across rates", () => {
    const frames = 600; // 10s @ 60fps
    expect(convertFrames(frames, frameRate(60, 1), frameRate(30, 1))).toBe(300);
    expect(convertFrames(300, frameRate(30, 1), frameRate(60, 1))).toBe(600);
    expect(convertFrames(1000, fps25, fps24)).toBe(960);
  });

  it("returns the input untouched for equal rates", () => {
    expect(convertFrames(1234, ntsc2997, frameRate(30000, 1001))).toBe(1234);
  });

  it("retimes a clip for speed changes", () => {
    // 2x faster consumes half the timeline frames.
    expect(retimeDuration(240, { num: 2, den: 1 })).toBe(120);
    // half speed takes double.
    expect(retimeDuration(240, { num: 1, den: 2 })).toBe(480);
    expect(retimeDuration(240, { num: 1, den: 1 })).toBe(240);
    expect(() => retimeDuration(240, { num: 0, den: 1 })).toThrow(RangeError);
  });
});

describe("rational helpers", () => {
  it("normalizes, adds, multiplies and divides exactly", () => {
    expect(rational.make(6, 4)).toEqual({ num: 3, den: 2 });
    expect(rational.make(1, -2)).toEqual({ num: -1, den: 2 });
    expect(rational.add({ num: 1, den: 3 }, { num: 1, den: 6 })).toEqual({ num: 1, den: 2 });
    expect(rational.mul({ num: 30000, den: 1001 }, { num: 1001, den: 30000 })).toEqual({
      num: 1,
      den: 1,
    });
    expect(rational.div({ num: 1, den: 2 }, { num: 1, den: 4 })).toEqual({ num: 2, den: 1 });
    expect(rational.toNumber({ num: 30000, den: 1001 })).toBeCloseTo(29.97002997, 8);
    expect(() => rational.div({ num: 1, den: 1 }, { num: 0, den: 1 })).toThrow(RangeError);
  });
});
