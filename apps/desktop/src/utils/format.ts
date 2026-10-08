/**
 * Small formatting helpers shared by the panels and the timeline.
 *
 * All time formatting goes through the mirror of core's `formatTimecode` so the editor,
 * the ruler and the transport always agree.
 */

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const sign = bytes < 0 ? "-" : "";
  return `${sign}${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatBytesPerDay(bytes: number): string {
  return `${formatBytes(bytes)}/day`;
}

/** Epoch millis -> short local timestamp, never throwing on a malformed ISO string. */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  const deltaSeconds = Math.round((now - parsed) / 1000);
  if (deltaSeconds < 5) return "just now";
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Human duration for media cards; sub-second values keep one decimal. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const total = Math.abs(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  if (minutes === 0) return `${rest.toFixed(total < 10 ? 1 : 0)}s`;
  return `${minutes}:${rest.toFixed(0).padStart(2, "0")}`;
}

export function truncate(value: string, max = 48): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/** Deterministic colour per asset id, used for preview/shot placeholders. */
export function hueFor(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 360;
  return hash;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function mediaTypeLabel(mediaType: string): string {
  switch (mediaType) {
    case "video":
      return "Video";
    case "image":
      return "Image";
    case "audio":
      return "Audio";
    case "subtitle":
      return "Captions";
    default:
      return mediaType;
  }
}

/** `trackId` -> a stable lane colour class suffix, without leaking track names. */
export function trackKindLabel(kind: string): string {
  switch (kind) {
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "caption":
      return "Caption";
    default:
      return kind;
  }
}

/** Frames -> seconds using an asset frame rate, tolerating a null rate. */
export function framesToSecondsSafe(
  frames: number | null | undefined,
  fps: { num: number; den: number } | null | undefined,
): number | null {
  if (frames === null || frames === undefined) return null;
  const rate = fps ?? { num: 30, den: 1 };
  if (!rate || rate.num <= 0) return null;
  return (frames * rate.den) / rate.num;
}
