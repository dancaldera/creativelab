/**
 * `ClipView` — one clip: label, thumbnail strip or waveform, trim handles, a split handle,
 * selection state, fade wedges and provenance badges.
 *
 * The component is presentation plus three pointer affordances; the actual algebra lives in
 * the store (`moveClip`, `trimClipEdge`, `splitAtPlayhead`) so a drag and a keyboard edit
 * produce byte-identical results.
 */
import { memo, type PointerEvent as ReactPointerEvent } from "react";
import type { Asset, Clip } from "@creativelab/core";
import { clipEnd, sourceSpan } from "../state/coreOps";

export interface ClipViewProps {
  clip: Clip;
  asset: Asset | undefined;
  /** Track kind decides which content band is drawn. */
  trackKind: "video" | "audio" | "caption";
  laneHeight: number;
  zoom: number;
  selected: boolean;
  dragging: boolean;
  /** Playhead is strictly inside this clip, so a split is possible. */
  splittable: boolean;
  /** Thumbnail data URIs (video/image) or `null` while loading. */
  thumbnails: readonly string[];
  /** Interleaved min/max peaks for audio clips. */
  peaks: readonly number[][] | null;
  onPointerDownBody: (event: ReactPointerEvent<HTMLElement>, clipId: string) => void;
  onPointerDownHandle: (event: ReactPointerEvent<HTMLElement>, clipId: string, edge: "start" | "end") => void;
  onSplitHere: (clipId: string) => void;
}

function ClipViewImpl({
  clip,
  asset,
  trackKind,
  laneHeight,
  zoom,
  selected,
  dragging,
  splittable,
  thumbnails,
  peaks,
  onPointerDownBody,
  onPointerDownHandle,
  onSplitHere,
}: ClipViewProps) {
  const left = clip.startFrame * zoom;
  const width = Math.max(2, clip.durationFrames * zoom);
  const className = [
    "clip",
    trackKind === "audio" ? "clip--audio" : trackKind === "caption" ? "clip--caption" : "",
    selected ? "clip--selected" : "",
    dragging ? "clip--dragging" : "",
    asset?.missingAt ? "clip--missing" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const span = sourceSpan(clip);
  const fadeIn = clip.properties.audio.fadeInFrames;
  const fadeOut = clip.properties.audio.fadeOutFrames;
  const speed = clip.properties.speed;
  const speedLabel = speed.num === speed.den ? null : `${(speed.num / speed.den).toFixed(2)}x`;

  return (
    <div
      className={className}
      style={{ left, width, height: Math.max(18, laneHeight - 6) }}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${clip.label || "Clip"} ${
        trackKind === "audio" ? "audio" : trackKind === "caption" ? "caption" : "video"
      } clip, frames ${clip.startFrame} to ${clipEnd(clip)}${asset?.missingAt ? ", media offline" : ""}`}
      data-clip-id={clip.id}
      onPointerDown={(event) => onPointerDownBody(event, clip.id)}
    >
      {trackKind === "audio" && peaks ? (
        <Waveform peaks={peaks} width={width} height={Math.max(18, laneHeight - 6)} />
      ) : (
        <div className="clip__thumbs" aria-hidden="true">
          {thumbnails.slice(0, Math.max(1, Math.ceil(width / 74))).map((thumbnail, index) => (
            <img key={`${clip.id}-thumb-${index}`} className="clip__thumb" src={thumbnail} alt="" width={74} draggable={false} />
          ))}
        </div>
      )}

      {fadeIn > 0 ? (
        <div className="clip__fade" style={{ left: 0, width: Math.max(1, fadeIn * zoom) }} aria-hidden="true" />
      ) : null}
      {fadeOut > 0 ? (
        <div
          className="clip__fade clip__fade--out"
          style={{ right: 0, width: Math.max(1, fadeOut * zoom) }}
          aria-hidden="true"
        />
      ) : null}

      <span className="clip__label" title={clip.label}>
        {clip.label || asset?.relativePath || "Clip"}
      </span>

      <div className="clip__badges" aria-hidden="true">
        {speedLabel ? <span className="clip__badge">{speedLabel}</span> : null}
        {asset?.origin === "generated" ? <span className="clip__badge">AI</span> : null}
        {asset?.storageMode === "linked" ? <span className="clip__badge">link</span> : null}
        {asset?.missingAt ? <span className="clip__badge">missing</span> : null}
        <span className="clip__badge">{span}f src</span>
      </div>

      {splittable ? (
        <button
          type="button"
          className="clip__split"
          aria-label={`Split ${clip.label || "clip"} at the playhead`}
          title="Split at playhead (S)"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onSplitHere(clip.id);
          }}
        >
          ✂
        </button>
      ) : null}

      <div
        className="clip__handle clip__handle--start"
        role="separator"
        aria-label={`Trim start of ${clip.label || "clip"}`}
        onPointerDown={(event) => {
          event.stopPropagation();
          onPointerDownHandle(event, clip.id, "start");
        }}
      />
      <div
        className="clip__handle clip__handle--end"
        role="separator"
        aria-label={`Trim end of ${clip.label || "clip"}`}
        onPointerDown={(event) => {
          event.stopPropagation();
          onPointerDownHandle(event, clip.id, "end");
        }}
      />
    </div>
  );
}

function Waveform({ peaks, width, height }: { peaks: readonly number[][]; width: number; height: number }) {
  if (peaks.length === 0) return null;
  const mid = height / 2;
  const step = width / peaks.length;
  const path = peaks
    .map((pair, index) => {
      const min = pair[0] ?? 0;
      const max = pair[1] ?? 0;
      const x = index * step;
      return `M ${x.toFixed(2)} ${(mid - max * mid * 0.9).toFixed(2)} L ${x.toFixed(2)} ${(mid - min * mid * 0.9).toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg className="clip__waveform" viewBox={`0 0 ${Math.max(1, width)} ${Math.max(1, height)}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={path} stroke="rgba(255,255,255,0.85)" strokeWidth={1} fill="none" />
    </svg>
  );
}

/**
 * Memoized on the fields that actually affect paint. A drag that only changes the
 * playhead must not re-render every clip on the timeline.
 */
export const ClipView = memo(ClipViewImpl, (previous, next) => {
  if (previous.clip !== next.clip) return false;
  if (previous.zoom !== next.zoom || previous.laneHeight !== next.laneHeight) return false;
  if (previous.selected !== next.selected || previous.dragging !== next.dragging) return false;
  if (previous.splittable !== next.splittable) return false;
  if (previous.trackKind !== next.trackKind) return false;
  if (previous.asset !== next.asset) return false;
  if (previous.peaks !== next.peaks) return false;
  if (previous.thumbnails.length !== next.thumbnails.length) return false;
  for (let i = 0; i < previous.thumbnails.length; i += 1) {
    if (previous.thumbnails[i] !== next.thumbnails[i]) return false;
  }
  return true;
});
