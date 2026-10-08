/**
 * Caption helpers kept separate from the component so the pure parts can be tested in the
 * node environment (no DOM needed).
 */
import { nominalFps } from "../state/coreOps";

const TIMECODE_PATTERN = /^(\d{1,3}):([0-5]?\d):([0-5]?\d)([:;.])(\d{1,3})$/;

/**
 * Parse `HH:MM:SS:FF` into a frame index, returning `null` instead of throwing.
 *
 * A caption timing field is edited character by character, so transient invalid input is
 * normal and must not crash the panel; the field simply keeps its last valid value.
 */
export function parseTimecodeSafe(timecode: string, fps: { num: number; den: number }): number | null {
  const match = TIMECODE_PATTERN.exec(timecode.trim());
  if (!match) return null;
  const [, hh, mm, ss, , ff] = match as unknown as [string, string, string, string, string, string];
  const nominal = nominalFps(fps);
  const frames = Number(ff);
  if (frames >= nominal) return null;
  const hours = Number(hh);
  const minutes = Number(mm);
  const seconds = Number(ss);
  if (minutes > 59 || seconds > 59) return null;
  return nominal * 3600 * hours + nominal * 60 * minutes + nominal * seconds + frames;
}

/** Compact `M:SS` / `H:MM:SS` label used by the caption list. */
export function formatShortSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const rest = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/** `HH:MM:SS,mmm` SRT timestamp from an integer frame count. */
export function srtTimestamp(frames: number, fps: { num: number; den: number }): string {
  const totalMs = Math.max(0, Math.round((frames * fps.den * 1000) / fps.num));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor(totalMs / 60_000) % 60;
  const seconds = Math.floor(totalMs / 1000) % 60;
  const millis = totalMs % 1000;
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}
