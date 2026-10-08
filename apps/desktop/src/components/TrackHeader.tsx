/**
 * `TrackHeader` — lock / mute / solo / visibility / volume and stacking order for one
 * track (PRD §6 "Timeline: track headers, lock/mute/solo/visibility").
 *
 * Locked tracks refuse edits at the store level; this component only surfaces the state.
 */
import type { Track } from "@creativelab/core";
import { trackKindLabel } from "../utils/format";

export interface TrackHeaderProps {
  track: Track;
  height: number;
  selected: boolean;
  clipCount: number;
  onSelect: (trackId: string) => void;
  onUpdate: (patch: Partial<Track>, options?: { coalesce?: boolean }) => void;
  onRename: (name: string) => void;
  onReorder: (direction: -1 | 1) => void;
  onRemove: () => void;
}

export function TrackHeader({
  track,
  height,
  selected,
  clipCount,
  onSelect,
  onUpdate,
  onRename,
  onReorder,
  onRemove,
}: TrackHeaderProps) {
  const isAudio = track.kind === "audio";
  return (
    <div
      className={`track-header${selected ? " track-header--selected" : ""}`}
      style={{ height }}
      data-track-id={track.id}
      aria-label={`${track.name} ${trackKindLabel(track.kind)} track`}
    >
      <div className="track-header__order" role="group" aria-label={`Reorder ${track.name}`}>
        <button type="button" className="btn btn--ghost" onClick={() => onReorder(-1)} aria-label={`Move ${track.name} up`}>
          ▲
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => onReorder(1)} aria-label={`Move ${track.name} down`}>
          ▼
        </button>
      </div>

      <span className="track-header__kind" title={trackKindLabel(track.kind)}>
        {track.kind === "video" ? "V" : isAudio ? "A" : "C"}
      </span>

      <input
        className="track-header__name"
        value={track.name}
        aria-label={`Track name for ${track.name}`}
        onChange={(event) => onRename(event.target.value)}
        onFocus={() => onSelect(track.id)}
      />

      <div className="track-header__toggles" role="group" aria-label={`${track.name} toggles`}>
        <button
          type="button"
          className="toggle"
          aria-pressed={track.muted}
          aria-label={`${track.muted ? "Unmute" : "Mute"} ${track.name}`}
          title="Mute"
          onClick={() => onUpdate({ muted: !track.muted })}
        >
          M
        </button>
        {isAudio ? (
          <button
            type="button"
            className="toggle"
            aria-pressed={track.solo}
            aria-label={`${track.solo ? "Unsolo" : "Solo"} ${track.name}`}
            title="Solo"
            onClick={() => onUpdate({ solo: !track.solo })}
          >
            S
          </button>
        ) : (
          <button
            type="button"
            className="toggle"
            aria-pressed={track.hidden}
            aria-label={`${track.hidden ? "Show" : "Hide"} ${track.name}`}
            title="Visibility"
            onClick={() => onUpdate({ hidden: !track.hidden })}
          >
            {track.hidden ? "◌" : "◉"}
          </button>
        )}
        <button
          type="button"
          className="toggle toggle--danger"
          aria-pressed={track.locked}
          aria-label={`${track.locked ? "Unlock" : "Lock"} ${track.name}`}
          title="Lock"
          onClick={() => onUpdate({ locked: !track.locked })}
        >
          {track.locked ? "🔒" : "🔓"}
        </button>
      </div>

      {isAudio ? (
        <input
          className="track-header__volume"
          type="range"
          min={-60}
          max={12}
          step={0.5}
          value={track.volumeDb}
          aria-label={`${track.name} volume in decibels`}
          title={`${track.volumeDb.toFixed(1)} dB`}
          onChange={(event) => onUpdate({ volumeDb: Number(event.target.value) }, { coalesce: true })}
        />
      ) : null}

      <span className="small muted mono" title={`${clipCount} clip(s)`}>
        {clipCount}
      </span>

      <button
        type="button"
        className="btn btn--ghost btn--icon"
        aria-label={`Remove ${track.name}`}
        title="Remove track"
        onClick={onRemove}
      >
        ✕
      </button>
    </div>
  );
}
