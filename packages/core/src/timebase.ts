/**
 * Timebase — the single source of truth for time in the studio.
 *
 * PRD §10: "Use integer frames or rational time for timeline coordinates, never
 * floating-point seconds as canonical clip boundaries."
 *
 * Everything in this module is pure and integer-exact except the explicitly named
 * `*AsSeconds` / `*AsMs` boundary conversions used for display and for talking to
 * FFmpeg and provider APIs.
 */

/** A frame rate expressed as an exact rational, e.g. 30000/1001 for 29.97. */
export interface FrameRate {
  readonly num: number;
  readonly den: number;
}

export type Rounding = "floor" | "round" | "ceil";
export type TimecodeFormat = "non-drop" | "drop";

/** Audio sample rate, kept as an integer alongside frames. */
export const DEFAULT_SAMPLE_RATE = 48_000;

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x === 0 ? 1 : x;
}

export function assertInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer frame count, received ${value}`);
  }
}

export function assertSafeInteger(value: number, label: string): void {
  assertInteger(value, label);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} exceeds the safe integer range: ${value}`);
  }
}

/** Build a validated, fully reduced frame rate. */
export function frameRate(num: number, den = 1): FrameRate {
  if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) {
    throw new RangeError(
      `Invalid frame rate ${num}/${den}: numerator and denominator must be positive integers`,
    );
  }
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

export function frameRateEquals(a: FrameRate, b: FrameRate): boolean {
  // Cross-multiply to avoid float comparison.
  return a.num * b.den === b.num * a.den;
}

/** Exact-ish decimal value of a frame rate, for display and FFmpeg arguments only. */
export function frameRateAsNumber(fr: FrameRate): number {
  return fr.num / fr.den;
}

/** Nominal (integer) frame rate used by timecode: 29.97 -> 30, 23.976 -> 24. */
export function nominalFps(fr: FrameRate): number {
  return Math.round(frameRateAsNumber(fr));
}

function isNtscRate(fr: FrameRate): boolean {
  return fr.den === 1001;
}

export function supportsDropFrame(fr: FrameRate): boolean {
  const fps = frameRateAsNumber(fr);
  return isNtscRate(fr) && (Math.abs(fps - 29.97) < 0.01 || Math.abs(fps - 59.94) < 0.01);
}

/** Frames dropped per minute (except every tenth minute) in drop-frame timecode. */
export function dropFrameCount(fr: FrameRate): number {
  if (!supportsDropFrame(fr)) return 0;
  return Math.round(nominalFps(fr) / 15); // 2 @ 29.97, 4 @ 59.94
}

/**
 * Common project presets. PRD §4 requires 24/25/30/60 presets; the NTSC variants are
 * included because imported US broadcast footage is 29.97/23.976.
 */
export const FRAME_RATE_PRESETS = [
  { id: "23.976", label: "23.976 fps (NTSC film)", rate: frameRate(24000, 1001) },
  { id: "24", label: "24 fps (film)", rate: frameRate(24, 1) },
  { id: "25", label: "25 fps (PAL)", rate: frameRate(25, 1) },
  { id: "29.97", label: "29.97 fps (NTSC)", rate: frameRate(30000, 1001) },
  { id: "30", label: "30 fps", rate: frameRate(30, 1) },
  { id: "50", label: "50 fps", rate: frameRate(50, 1) },
  { id: "59.94", label: "59.94 fps (NTSC)", rate: frameRate(60000, 1001) },
  { id: "60", label: "60 fps", rate: frameRate(60, 1) },
] as const satisfies ReadonlyArray<{ id: string; label: string; rate: FrameRate }>;

export function findFrameRatePreset(id: string): FrameRate | undefined {
  return FRAME_RATE_PRESETS.find((preset) => preset.id === id)?.rate;
}

// ---------------------------------------------------------------------------
// Frame <-> seconds / ms
// ---------------------------------------------------------------------------

/** Exact seconds as a rational: frames * den / num. */
export function framesToSeconds(frames: number, fr: FrameRate): number {
  assertSafeInteger(frames, "frames");
  return (frames * fr.den) / fr.num;
}

export function secondsToFrames(
  seconds: number,
  fr: FrameRate,
  rounding: Rounding = "round",
): number {
  if (!Number.isFinite(seconds)) {
    throw new RangeError(`Cannot convert a non-finite duration to frames: ${seconds}`);
  }
  return applyRounding((seconds * fr.num) / fr.den, rounding);
}

export function framesToMs(frames: number, fr: FrameRate): number {
  return (frames * fr.den * 1000) / fr.num;
}

export function msToFrames(ms: number, fr: FrameRate, rounding: Rounding = "round"): number {
  return secondsToFrames(ms / 1000, fr, rounding);
}

/**
 * Round *half away from zero* so that negative frames (used by offset math before
 * clamping) behave symmetrically with positive ones.
 */
export function applyRounding(value: number, rounding: Rounding): number {
  switch (rounding) {
    case "floor":
      return Math.floor(value);
    case "ceil":
      return Math.ceil(value);
    case "round":
      return value < 0 ? -Math.round(-value) : Math.round(value);
    default: {
      const never: never = rounding;
      throw new Error(`Unhandled rounding mode: ${String(never)}`);
    }
  }
}

/**
 * Convert a duration measured at `from` rate into whole frames at `to` rate,
 * preserving wall-clock duration. Used when importing 29.97 footage into a 25 fps
 * project without drifting.
 */
export function convertFrames(
  frames: number,
  from: FrameRate,
  to: FrameRate,
  rounding: Rounding = "round",
): number {
  assertSafeInteger(frames, "frames");
  if (frameRateEquals(from, to)) return frames;
  return applyRounding((frames * from.den * to.num) / (from.num * to.den), rounding);
}

/** Drop or duplicate frames to resample a clip's duration across rate changes. */
export function retimeDuration(sourceFrames: number, speed: { num: number; den: number }): number {
  if (speed.num <= 0 || speed.den <= 0) throw new RangeError("Speed must be positive");
  return applyRounding((sourceFrames * speed.den) / speed.num, "round");
}

// ---------------------------------------------------------------------------
// Timecode
// ---------------------------------------------------------------------------

export interface TimecodeOptions {
  /** Force drop-frame formatting; only valid for 29.97/59.94. Defaults to auto. */
  format?: TimecodeFormat;
  /** Include a leading `HH:` even when hours are zero. Defaults to true. */
  includeHours?: boolean;
}

export interface TimecodeParts {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
  format: TimecodeFormat;
}

function resolveFormat(fr: FrameRate, options?: TimecodeOptions): TimecodeFormat {
  const requested = options?.format;
  if (requested === "drop" && !supportsDropFrame(fr)) {
    throw new RangeError(
      `Drop-frame timecode is only defined for 29.97 and 59.94 fps, not ${fr.num}/${fr.den}`,
    );
  }
  if (requested) return requested;
  return "non-drop";
}

/** Decompose a frame index into SMPTE timecode parts (drop-frame aware). */
export function framesToTimecodeParts(
  frames: number,
  fr: FrameRate,
  options?: TimecodeOptions,
): TimecodeParts {
  assertSafeInteger(frames, "frames");
  if (frames < 0) throw new RangeError(`Timecode is undefined for negative frames: ${frames}`);
  const format = resolveFormat(fr, options);
  const nominal = nominalFps(fr);
  let display = frames;

  if (format === "drop") {
    const dropped = dropFrameCount(fr);
    const framesPer10Min = Math.round(frameRateAsNumber(fr) * 600);
    const framesPerMin = nominal * 60 - dropped;
    const tenMinBlocks = Math.floor(frames / framesPer10Min);
    const remainder = frames % framesPer10Min;
    display +=
      remainder > dropped
        ? dropped * 9 * tenMinBlocks + dropped * Math.floor((remainder - dropped) / framesPerMin)
        : dropped * 9 * tenMinBlocks;
  }

  const frameOfSecond = display % nominal;
  const totalSeconds = Math.floor(display / nominal);
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor(totalSeconds / 60) % 60,
    seconds: totalSeconds % 60,
    frames: frameOfSecond,
    format,
  };
}

/** Format a frame index as `HH:MM:SS:FF`, or `HH:MM:SS;FF` in drop-frame. */
export function formatTimecode(frames: number, fr: FrameRate, options?: TimecodeOptions): string {
  const parts = framesToTimecodeParts(frames, fr, options);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  const separator = parts.format === "drop" ? ";" : ":";
  const body = `${pad(parts.minutes)}:${pad(parts.seconds)}${separator}${pad(parts.frames)}`;
  if (options?.includeHours === false && parts.hours === 0) return body;
  return `${pad(parts.hours)}:${body}`;
}

const TIMECODE_PATTERN = /^(\d{1,3}):([0-5]?\d):([0-5]?\d)([:;.])(\d{1,3})$/;

/** Parse `HH:MM:SS:FF` (or `;`/`.` separated) back into a frame index. */
export function parseTimecode(timecode: string, fr: FrameRate): number {
  const match = TIMECODE_PATTERN.exec(timecode.trim());
  if (!match) {
    throw new SyntaxError(`Invalid timecode "${timecode}"; expected HH:MM:SS:FF`);
  }
  const [, hh, mm, ss, separator, ff] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const dropRequested = separator === ";";
  if (dropRequested && !supportsDropFrame(fr)) {
    throw new RangeError(`Drop-frame timecode is not valid for ${fr.num}/${fr.den} fps`);
  }
  const nominal = nominalFps(fr);
  const hours = Number(hh);
  const minutes = Number(mm);
  const seconds = Number(ss);
  const frames = Number(ff);
  if (frames >= nominal) {
    throw new RangeError(`Frame field ${frames} is out of range for ${nominal} fps`);
  }
  if (dropRequested) {
    const dropped = dropFrameCount(fr);
    const totalMinutes = 60 * hours + minutes;
    return (
      nominal * 3600 * hours +
      nominal * 60 * minutes +
      nominal * seconds +
      frames -
      dropped * (totalMinutes - Math.floor(totalMinutes / 10))
    );
  }
  return nominal * 3600 * hours + nominal * 60 * minutes + nominal * seconds + frames;
}

/** Wall-clock `M:SS.mmm` used by transport UI; not a canonical representation. */
export function framesToClock(frames: number, fr: FrameRate): string {
  const totalMs = framesToMs(frames, fr);
  const sign = totalMs < 0 ? "-" : "";
  const abs = Math.abs(totalMs);
  const minutes = Math.floor(abs / 60_000);
  const seconds = Math.floor(abs / 1000) % 60;
  const millis = Math.round(abs % 1000);
  return `${sign}${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Rational helpers
// ---------------------------------------------------------------------------

/** Rational arithmetic on `{num, den}` pairs, always reduced. */
export const rational = {
  make(num: number, den = 1): { num: number; den: number } {
    if (den === 0) throw new RangeError("Rational denominator cannot be zero");
    const sign = den < 0 ? -1 : 1;
    const g = gcd(num, den);
    return { num: (sign * num) / g, den: (sign * den) / g };
  },
  mul(a: { num: number; den: number }, b: { num: number; den: number }) {
    return rational.make(a.num * b.num, a.den * b.den);
  },
  div(a: { num: number; den: number }, b: { num: number; den: number }) {
    if (b.num === 0) throw new RangeError("Division by a zero rational");
    return rational.make(a.num * b.den, a.den * b.num);
  },
  add(a: { num: number; den: number }, b: { num: number; den: number }) {
    return rational.make(a.num * b.den + b.num * a.den, a.den * b.den);
  },
  toNumber(a: { num: number; den: number }): number {
    return a.num / a.den;
  },
} as const;
