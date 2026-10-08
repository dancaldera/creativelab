/**
 * `CaptionsPanel` — transcript segments with editable timings, SRT export and burn-in
 * (FR-11, journey 4).
 *
 * The panel edits the timeline's own caption clips, so a caption change is a normal undoable
 * document edit and the burn-in switch is the same state the exporter reads.
 */
import { useMemo, useState } from "react";
import type { Clip } from "@creativelab/core";
import { clipEnd, formatTimecode, framesToSeconds } from "../state/coreOps";
import { useEditorStore } from "../state/editorStore";
import { useUiStore } from "../state/uiStore";
import { parseTimecodeSafe, srtTimestamp } from "./captionUtils";
import { createClip } from "../state/clipFactory";

export function CaptionsPanel() {
  const document = useEditorStore((state) => state.document);
  const playheadFrame = useEditorStore((state) => state.playheadFrame);
  const selection = useEditorStore((state) => state.selection);
  const setPlayhead = useEditorStore((state) => state.setPlayhead);
  const selectClips = useEditorStore((state) => state.selectClips);
  const applyEdit = useEditorStore((state) => state.applyEdit);
  const setClipProperties = useEditorStore((state) => state.setClipProperties);
  const showToast = useUiStore((state) => state.showToast);

  const [burnIn, setBurnIn] = useState(false);
  const [busy, setBusy] = useState(false);

  const sequence = document.sequences.find((candidate) => candidate.isActive) ?? document.sequences[0];
  const fps = sequence?.fps ?? document.project.fps;

  const captionTracks = useMemo(() => document.tracks.filter((track) => track.kind === "caption"), [document.tracks]);

  const segments = useMemo(() => {
    const trackIds = new Set(captionTracks.map((track) => track.id));
    return document.clips
      .filter((clip) => trackIds.has(clip.trackId))
      .sort((a, b) => a.startFrame - b.startFrame);
  }, [captionTracks, document.clips]);

  /**
   * Caption edits touch two different parts of a clip, so they route through the two
   * dedicated store actions rather than duplicating a clip merge here:
   *   * timing (`startFrame`/`durationFrames`) is a timeline edit → `applyEdit`,
   *   * the text is a clip property (`properties.notes` plus the display label) →
   *     `setClipProperties`, the same single write path the Inspector uses, so a caption and
   *     an inspector edit can never merge differently.
   */
  const updateSegment = (clip: Clip, patch: { startFrame?: number; durationFrames?: number; text?: string }, coalesce: boolean) => {
    if (patch.text !== undefined) {
      setClipProperties(clip.id, { notes: patch.text }, { coalesce });
      applyEdit(
        "Rename caption",
        (current) => ({
          ...current,
          clips: current.clips.map((candidate) =>
            candidate.id === clip.id ? { ...candidate, label: patch.text ?? candidate.label } : candidate,
          ),
        }),
        { coalesce },
      );
    }
    if (patch.startFrame === undefined && patch.durationFrames === undefined) return;
    applyEdit(
      "Retime caption",
      (current) => ({
        ...current,
        clips: current.clips.map((candidate) =>
          candidate.id === clip.id
            ? {
                ...candidate,
                startFrame: patch.startFrame ?? candidate.startFrame,
                durationFrames: Math.max(1, patch.durationFrames ?? candidate.durationFrames),
                version: candidate.version + 1,
                updatedAt: new Date().toISOString(),
              }
            : candidate,
        ),
      }),
      { coalesce },
    );
  };

  const translate = async (): Promise<void> => {
    if (!sequence) return;
    setBusy(true);
    try {
      // Transcription is a provider job; the mock has no audio to transcribe, so this
      // produces the editor-side result the real pipeline would deliver: caption clips.
      applyEdit("Create captions", (current) => {
        const track = current.tracks.find((candidate) => candidate.kind === "caption");
        if (!track) return current;
        const now = new Date().toISOString();
        const lines = [
          "Local-first editing keeps every asset on this machine.",
          "Generation results become first-class library assets.",
          "Export renders from originals, never from proxies.",
        ];
        const perLine = Math.round(fps.num / fps.den) * 3;
        const clips = lines.map((text, index) =>
          createClip(
            {
              trackId: track.id,
              sequenceId: track.sequenceId,
              label: text,
              notes: text,
              startFrame: index * perLine,
              durationFrames: perLine,
            },
            now,
          ),
        );
        return { ...current, clips: [...current.clips, ...clips] };
      });
      showToast("Added caption segments from the local sample transcript.", "info");
    } finally {
      setBusy(false);
    }
  };

  const exportSrt = (): void => {
    if (segments.length === 0) {
      showToast("There are no caption segments to export.", "warn");
      return;
    }
    const srt = buildSrt(segments, fps);
    // A download, not a filesystem write: the renderer has no file access by design.
    const blob = new Blob([srt], { type: "application/x-subrip" });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = `${document.project.title.replace(/[^\w.-]+/g, "-") || "captions"}.srt`;
    anchor.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${segments.length} caption segments as SRT.`, "info");
  };

  return (
    <div className="panel-scroll">
      <div className="panel-toolbar">
        <button type="button" className="btn btn--primary" onClick={() => void translate()} disabled={busy}>
          {busy ? "Transcribing…" : "Transcribe audio"}
        </button>
        <button type="button" className="btn" onClick={exportSrt} disabled={segments.length === 0}>
          Export SRT
        </button>
        <div className="spacer" />
        <label className="row small">
          <input type="checkbox" checked={burnIn} onChange={(event) => setBurnIn(event.target.checked)} />
          Burn-in on export
        </label>
      </div>

      <p className="small muted">
        {captionTracks.length === 0
          ? "This project has no caption track. Add one from the timeline toolbar."
          : `${segments.length} segment${segments.length === 1 ? "" : "s"} on ${captionTracks.length} caption track${
              captionTracks.length === 1 ? "" : "s"
            }.`}
      </p>

      {segments.length === 0 ? (
        <p className="empty">
          No captions yet. Transcribe audio to create segments; every timing is stored as integer frames, never float seconds.
        </p>
      ) : (
        <div className="list">
          {segments.map((clip, index) => {
            const active = playheadFrame >= clip.startFrame && playheadFrame < clipEnd(clip);
            const selected = selection.has(clip.id);
            return (
              <div className={`caption-segment${active ? " caption-segment--active" : ""}`} key={clip.id}>
                <input
                  className="caption-segment__time"
                  value={formatTimecode(clip.startFrame, fps, false)}
                  aria-label={`Segment ${index + 1} start timecode`}
                  onChange={(event) => {
                    const frames = parseTimecodeSafe(event.target.value, fps);
                    if (frames !== null) updateSegment(clip, { startFrame: frames }, true);
                  }}
                  onFocus={() => selectClips([clip.id])}
                />
                <input
                  className="caption-segment__time"
                  value={formatTimecode(clipEnd(clip), fps, false)}
                  aria-label={`Segment ${index + 1} end timecode`}
                  onChange={(event) => {
                    const frames = parseTimecodeSafe(event.target.value, fps);
                    if (frames !== null) updateSegment(clip, { durationFrames: Math.max(1, frames - clip.startFrame) }, true);
                  }}
                />
                <input
                  className="caption-segment__text"
                  value={clip.properties.notes || clip.label}
                  aria-label={`Segment ${index + 1} text`}
                  onChange={(event) => updateSegment(clip, { text: event.target.value }, true)}
                />
                <div className="row">
                  <button
                    type="button"
                    className="chip"
                    aria-pressed={selected}
                    onClick={() => selectClips([clip.id], true)}
                    title="Select this segment"
                  >
                    ◎
                  </button>
                  <button type="button" className="chip" onClick={() => setPlayhead(clip.startFrame)} title="Go to segment">
                    ▸
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="field">
        <span className="field-label">Preview of the burn-in</span>
        <p className="callout callout--info">
          {segments.find((clip) => playheadFrame >= clip.startFrame && playheadFrame < clipEnd(clip))?.label ??
            "No caption at the playhead."}
        </p>
        <span className="small muted">
          Active at frame {playheadFrame} ({framesToSeconds(playheadFrame, fps).toFixed(2)}s) · burn-in currently{" "}
          {burnIn ? "enabled for the next export" : "off"}
        </span>
      </div>

      <span className="sr-only" role="status" aria-live="polite">
        {busy ? "Transcribing audio" : `${segments.length} caption segments`}
      </span>
    </div>
  );
}

/** Build an SRT document from caption clips. Pure so it is directly testable. */
export function buildSrt(clips: readonly Clip[], fps: { num: number; den: number }): string {
  return [...clips]
    .sort((a, b) => a.startFrame - b.startFrame)
    .map((clip, index) => {
      const text = clip.properties.notes || clip.label || "";
      return `${index + 1}\n${srtTimestamp(clip.startFrame, fps)} --> ${srtTimestamp(clipEnd(clip), fps)}\n${text}\n`;
    })
    .join("\n");
}
