/**
 * `Timeline` — the multi-track editing surface (FR-03, PRD §6).
 *
 * Interaction model:
 *   * Pointer events only (`onPointerDown` + `setPointerCapture` on the content surface),
 *     so mouse, trackpad and pen behave identically and no `mousemove` listener leaks onto
 *     the document.
 *   * Drags keep the working geometry in React state and commit **one** history entry on
 *     pointer-up; the mid-drag preview moves the clip with `transform`, so a 60 fps drag
 *     never rewrites the document 60 times.
 *   * Empty-lane drags draw a marquee and select every intersecting clip.
 *   * The playhead is a single element moved with `transform: translateX`, so scrubbing
 *     does not re-layout track content.
 *   * Media drops arrive through native drag-and-drop on the lane container.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Clip, Track, TrackKind } from "@creativelab/core";
import { clipEnd, clipsOnTrack, frameRateAsNumber, sequenceDurationFrames } from "../state/coreOps";
import { createClip, defaultTrackFor, placeClip } from "../state/clipFactory";
import { useEditorStore } from "../state/editorStore";
import { useThumbnail, useWaveform } from "../hooks/queries";
import { ClipView } from "./ClipView";
import { TimelineRuler } from "./TimelineRuler";
import { GRID_STEP_VAR, timelineScale } from "./timelineScale";
import { TrackHeader } from "./TrackHeader";

const LANE_HEIGHT = 62;
const RULER_HEIGHT = 26;

interface MarqueeState {
  anchorX: number;
  anchorY: number;
  currentX: number;
  currentY: number;
}

interface DragState {
  kind: "move" | "trim";
  clipId: string;
  edge?: "start" | "end";
  /** Pointer offset inside the clip at drag start, in frames. */
  grabOffsetFrames: number;
  originStart: number;
  originTrackId: string;
  targetStart: number;
  targetTrackId: string;
  moved: boolean;
  pointerId: number;
}

export function Timeline() {
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const playheadFrame = useEditorStore((state) => state.playheadFrame);
  const zoom = useEditorStore((state) => state.zoom);
  const snapEnabled = useEditorStore((state) => state.snapEnabled);
  const editMode = useEditorStore((state) => state.editMode);
  const workspacePath = useEditorStore((state) => state.workspacePath);
  const setPlayhead = useEditorStore((state) => state.setPlayhead);
  const setZoom = useEditorStore((state) => state.setZoom);
  const zoomBy = useEditorStore((state) => state.zoomBy);
  const selectClips = useEditorStore((state) => state.selectClips);
  const toggleSelection = useEditorStore((state) => state.toggleSelection);
  const clearSelection = useEditorStore((state) => state.clearSelection);
  const toggleSnap = useEditorStore((state) => state.toggleSnap);
  const setEditMode = useEditorStore((state) => state.setEditMode);
  const splitAtPlayhead = useEditorStore((state) => state.splitAtPlayhead);
  const moveClip = useEditorStore((state) => state.moveClip);
  const snappingMove = useEditorStore((state) => state.snappingMove);
  const trimClipEdge = useEditorStore((state) => state.trimClipEdge);
  const updateTrack = useEditorStore((state) => state.updateTrack);
  const reorderTrack = useEditorStore((state) => state.reorderTrack);
  const removeTrack = useEditorStore((state) => state.removeTrack);
  const addTrack = useEditorStore((state) => state.addTrack);
  const closeGaps = useEditorStore((state) => state.closeGaps);

  const lanesRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const headersScrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const [trimPreview, setTrimPreview] = useState<{ edge: "start" | "end"; frame: number } | null>(
    null,
  );
  const [snapLine, setSnapLine] = useState<number | null>(null);

  const orderedTracks = useMemo(() => {
    const groups: Record<TrackKind, Track[]> = { video: [], audio: [], caption: [] };
    for (const track of document.tracks) groups[track.kind].push(track);
    for (const kind of Object.keys(groups) as TrackKind[]) {
      // Top of the stack first, matching the NLE convention that V1 composites on top.
      groups[kind].sort((a, b) => b.sortOrder - a.sortOrder);
    }
    return [...groups.video, ...groups.audio, ...groups.caption];
  }, [document.tracks]);

  const primarySequence =
    document.sequences.find((sequence) => sequence.isActive) ?? document.sequences[0];
  const fps = primarySequence?.fps ?? document.project.fps;
  const durationFrames = sequenceDurationFrames(document.clips);
  const contentFrames = Math.max(
    durationFrames + Math.round(frameRateAsNumber(fps) * 4),
    Math.round(frameRateAsNumber(fps) * 12),
  );
  const contentWidth = Math.max(320, Math.ceil(contentFrames * zoom));
  // One source of truth for tick and grid spacing; the ruler derives the same value from the
  // same function, so a zoom change cannot move one without the other.
  const gridScale = useMemo(() => timelineScale(fps, zoom), [fps, zoom]);
  const lanesHeight = Math.max(1, orderedTracks.length * LANE_HEIGHT);

  const onLanesScroll = useCallback(() => {
    const lanes = lanesRef.current;
    const headers = headersScrollRef.current;
    if (lanes && headers) headers.scrollTop = lanes.scrollTop;
  }, []);

  const frameForClientX = useCallback(
    (clientX: number): number => {
      const lanes = lanesRef.current;
      if (!lanes) return 0;
      const rect = lanes.getBoundingClientRect();
      return Math.max(0, Math.round((clientX - rect.left + lanes.scrollLeft) / zoom));
    },
    [zoom],
  );

  const localPoint = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const lanes = lanesRef.current;
    if (!lanes) return { x: 0, y: 0 };
    const rect = lanes.getBoundingClientRect();
    return { x: clientX - rect.left + lanes.scrollLeft, y: clientY - rect.top + lanes.scrollTop };
  }, []);

  const trackIdForClientY = useCallback(
    (clientY: number): string | null => {
      const { y } = localPoint(0, clientY);
      const laneY = y - RULER_HEIGHT;
      if (laneY < 0) return null;
      return orderedTracks[Math.floor(laneY / LANE_HEIGHT)]?.id ?? null;
    },
    [localPoint, orderedTracks],
  );

  // -- pointer lifecycle ----------------------------------------------------
  const captureOn = (element: HTMLElement, pointerId: number): void => {
    try {
      element.setPointerCapture(pointerId);
    } catch {
      // Capture is best-effort; bubbling still delivers move/up while inside.
    }
  };

  const onClipPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, clipId: string) => {
      if (event.button !== 0) return;
      const state = useEditorStore.getState();
      const clip = state.document.clips.find((candidate) => candidate.id === clipId);
      if (!clip) return;

      const additive = event.shiftKey;
      const toggle = event.metaKey || event.ctrlKey;
      if (toggle) toggleSelection(clipId);
      else if (!state.selection.has(clipId) || additive) selectClips([clipId], additive);

      const track = state.document.tracks.find((candidate) => candidate.id === clip.trackId);
      if (track?.locked) return;

      const surface = contentRef.current;
      if (surface) captureOn(surface, event.pointerId);
      const next: DragState = {
        kind: "move",
        clipId,
        grabOffsetFrames: Math.max(0, frameForClientX(event.clientX) - clip.startFrame),
        originStart: clip.startFrame,
        originTrackId: clip.trackId,
        targetStart: clip.startFrame,
        targetTrackId: clip.trackId,
        moved: false,
        pointerId: event.pointerId,
      };
      dragRef.current = next;
      setDrag(next);
    },
    [frameForClientX, selectClips, toggleSelection],
  );

  const onHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, clipId: string, edge: "start" | "end") => {
      if (event.button !== 0) return;
      const state = useEditorStore.getState();
      const clip = state.document.clips.find((candidate) => candidate.id === clipId);
      if (!clip) return;
      const track = state.document.tracks.find((candidate) => candidate.id === clip.trackId);
      if (track?.locked) return;
      const surface = contentRef.current;
      if (surface) captureOn(surface, event.pointerId);
      const next: DragState = {
        kind: "trim",
        clipId,
        edge,
        grabOffsetFrames: 0,
        originStart: clip.startFrame,
        originTrackId: clip.trackId,
        targetStart: edge === "start" ? clip.startFrame : clipEnd(clip),
        targetTrackId: clip.trackId,
        moved: false,
        pointerId: event.pointerId,
      };
      dragRef.current = next;
      setDrag(next);
    },
    [],
  );

  const onSurfacePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      // Clip and handle handlers already started a gesture and captured the pointer.
      if (dragRef.current) return;
      if (!event.shiftKey) clearSelection();
      const point = localPoint(event.clientX, event.clientY);
      captureOn(event.currentTarget, event.pointerId);
      setMarquee({ anchorX: point.x, anchorY: point.y, currentX: point.x, currentY: point.y });
    },
    [clearSelection, localPoint],
  );

  const onSurfacePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const current = dragRef.current;
      if (current) {
        const frame = frameForClientX(event.clientX);
        if (current.kind === "move") {
          const proposed = Math.max(0, frame - current.grabOffsetFrames);
          const snapped = snapEnabled
            ? snappingMove(current.clipId, proposed, current.targetTrackId)
            : proposed;
          const updated: DragState = {
            ...current,
            targetStart: Math.max(0, snapped),
            targetTrackId: trackIdForClientY(event.clientY) ?? current.targetTrackId,
            moved: true,
          };
          dragRef.current = updated;
          setDrag(updated);
          setSnapLine(snapped !== proposed ? snapped : null);
        } else {
          const updated: DragState = { ...current, targetStart: frame, moved: true };
          dragRef.current = updated;
          setDrag(updated);
          setTrimPreview({ edge: current.edge ?? "end", frame });
        }
        return;
      }

      setMarquee((previous) => {
        if (!previous) return previous;
        const point = localPoint(event.clientX, event.clientY);
        return { ...previous, currentX: point.x, currentY: point.y };
      });
    },
    [frameForClientX, localPoint, snapEnabled, snappingMove, trackIdForClientY],
  );

  const commitDrag = useCallback(
    (current: DragState | null) => {
      if (!current || !current.moved) return;
      if (current.kind === "move") {
        if (
          current.targetStart !== current.originStart ||
          current.targetTrackId !== current.originTrackId
        ) {
          moveClip(current.clipId, current.targetStart, {
            toTrackId: current.targetTrackId,
            mode: useEditorStore.getState().editMode,
            // Snapping was already applied while dragging; doing it twice would fight the user.
            disableSnap: true,
          });
        }
        return;
      }
      const clip = useEditorStore
        .getState()
        .document.clips.find((candidate) => candidate.id === current.clipId);
      if (!clip) return;
      const edge = current.edge ?? "end";
      const unchanged =
        edge === "start"
          ? current.targetStart === clip.startFrame
          : current.targetStart === clipEnd(clip);
      if (unchanged) return;
      trimClipEdge(current.clipId, edge, current.targetStart, { coalesce: false });
    },
    [moveClip, trimClipEdge],
  );

  const commitMarquee = useCallback(
    (state: MarqueeState | null, additive: boolean) => {
      if (!state) return;
      const left = Math.min(state.anchorX, state.currentX);
      const right = Math.max(state.anchorX, state.currentX);
      const top = Math.min(state.anchorY, state.currentY) - RULER_HEIGHT;
      const bottom = Math.max(state.anchorY, state.currentY) - RULER_HEIGHT;
      if (right - left < 2 && bottom - top < 2) return; // a click, not a drag
      const startFrame = Math.floor(left / zoom);
      const endFrame = Math.ceil(right / zoom);
      const firstLane = Math.max(0, Math.floor(top / LANE_HEIGHT));
      const lastLane = Math.floor(bottom / LANE_HEIGHT);
      const laneIds = new Set(
        orderedTracks.slice(firstLane, lastLane + 1).map((track) => track.id),
      );
      const hits = document.clips
        .filter(
          (clip) =>
            laneIds.has(clip.trackId) && clip.startFrame < endFrame && clipEnd(clip) > startFrame,
        )
        .map((clip) => clip.id);
      selectClips(hits, additive);
    },
    [document.clips, orderedTracks, selectClips, zoom],
  );

  const onSurfacePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const current = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      setTrimPreview(null);
      setSnapLine(null);
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Already released (pointercancel) — nothing to do.
      }
      if (current) {
        commitDrag(current);
        return;
      }
      commitMarquee(marquee, event.shiftKey);
      setMarquee(null);
    },
    [commitDrag, commitMarquee, marquee],
  );

  // A pointer released outside the surface must still commit rather than strand the drag.
  useEffect(() => {
    const onWindowUp = (): void => {
      const current = dragRef.current;
      if (!current) return;
      dragRef.current = null;
      setDrag(null);
      setTrimPreview(null);
      setSnapLine(null);
      commitDrag(current);
    };
    window.addEventListener("pointerup", onWindowUp);
    return () => window.removeEventListener("pointerup", onWindowUp);
  }, [commitDrag]);

  // -- media drop -----------------------------------------------------------
  const onLaneDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (Array.from(event.dataTransfer.types).includes(ASSET_DRAG_MIME)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const onLaneDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const assetId =
        event.dataTransfer.getData(ASSET_DRAG_MIME) || event.dataTransfer.getData("text/plain");
      if (!assetId) return;
      event.preventDefault();
      insertAssetAt(assetId, frameForClientX(event.clientX), trackIdForClientY(event.clientY), fps);
    },
    [frameForClientX, fps, trackIdForClientY],
  );

  const playheadX = playheadFrame * zoom;
  const topTrackId = orderedTracks[0]?.id ?? "";

  return (
    <section className="timeline" aria-label="Timeline">
      <div className="timeline__bar">
        <div className="row" role="group" aria-label="Timeline zoom">
          <button
            type="button"
            className="btn btn--icon"
            aria-label="Zoom out (-)"
            onClick={() => zoomBy(0.8)}
          >
            −
          </button>
          <input
            type="range"
            min={0.05}
            max={40}
            step={0.05}
            value={zoom}
            style={{ width: 110 }}
            aria-label="Timeline zoom, pixels per frame"
            aria-valuenow={Number(zoom.toFixed(2))}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
          <button
            type="button"
            className="btn btn--icon"
            aria-label="Zoom in (+)"
            onClick={() => zoomBy(1.25)}
          >
            +
          </button>
          <span className="small muted mono">{zoom.toFixed(2)} px/f</span>
        </div>

        <div className="toolbar__divider" />

        <div className="row" role="group" aria-label="Edit mode">
          {(["overwrite", "insert", "replace"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className="chip"
              aria-pressed={editMode === mode}
              onClick={() => setEditMode(mode)}
              title={
                mode === "overwrite"
                  ? "Overwrite: clear whatever the clip lands on"
                  : mode === "insert"
                    ? "Insert: ripple later clips right"
                    : "Replace: swap in place of one neighbour"
              }
            >
              {mode}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="chip"
          aria-pressed={snapEnabled}
          onClick={toggleSnap}
          title="Toggle snapping (N)"
        >
          snap {snapEnabled ? "on" : "off"}
        </button>

        <div className="toolbar__divider" />

        <div className="row" role="group" aria-label="Add track">
          <button type="button" className="chip" onClick={() => addTrack("video")}>
            + video
          </button>
          <button type="button" className="chip" onClick={() => addTrack("audio")}>
            + audio
          </button>
          <button type="button" className="chip" onClick={() => addTrack("caption")}>
            + caption
          </button>
        </div>

        <div className="spacer" />

        <button
          type="button"
          className="btn"
          onClick={splitAtPlayhead}
          title="Split at playhead (S)"
        >
          Split (S)
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => closeGaps(topTrackId)}
          disabled={!topTrackId}
          title="Pack clips left on the top track"
        >
          Close gaps
        </button>
        <span className="badge" aria-live="polite">
          {selection.size} selected
        </span>
      </div>

      <div className="timeline__body">
        <div className="timeline__headers">
          <div className="timeline__headers-spacer" />
          <div className="timeline__headers-scroll" ref={headersScrollRef}>
            {orderedTracks.map((track) => (
              <TrackHeader
                key={track.id}
                track={track}
                height={LANE_HEIGHT}
                selected={
                  selection.size > 0 &&
                  clipsOnTrack(document.clips, track.id).some((clip) => selection.has(clip.id))
                }
                clipCount={clipsOnTrack(document.clips, track.id).length}
                onSelect={() => undefined}
                onUpdate={(patch, options) => updateTrack(track.id, patch, options)}
                onRename={(name) =>
                  updateTrack(track.id, { name: name || track.name }, { coalesce: true })
                }
                onReorder={(direction) => reorderTrack(track.id, direction)}
                onRemove={() => removeTrack(track.id)}
              />
            ))}
          </div>
        </div>

        <div
          className="timeline__lanes"
          ref={lanesRef}
          onScroll={onLanesScroll}
          onDragOver={onLaneDragOver}
          onDrop={onLaneDrop}
        >
          {/*
            The lane grid is drawn on this element rather than on `.timeline__lanes`: the
            lanes element is the scroll container, and a background on a scroll container does
            not move with its content, so the grid would stay put while clips scrolled past it.
            This element is exactly `contentWidth` wide, so the gradient also starts at frame 0.
          */}
          <div
            className="timeline__content"
            // `as CSSProperties` is required only for the custom property: csstype has no index
            // signature for `--*` keys, so a computed key is otherwise rejected.
            style={
              {
                width: contentWidth,
                [GRID_STEP_VAR]: `${gridScale.gridStepPx}px`,
              } as CSSProperties
            }
          >
            <TimelineRuler
              fps={fps}
              zoom={zoom}
              width={contentWidth}
              playheadFrame={playheadFrame}
              durationFrames={durationFrames}
              onScrub={setPlayhead}
            />

            {orderedTracks.length === 0 ? (
              <p className="timeline__empty">No tracks yet. Add a video track to begin.</p>
            ) : null}

            <div className="timeline__tracks" style={{ height: lanesHeight }}>
              {orderedTracks.map((track) => (
                <div
                  key={track.id}
                  className={`track-lane${track.locked ? " track-lane--locked" : ""}${
                    drag?.kind === "move" &&
                    drag.targetTrackId === track.id &&
                    drag.targetTrackId !== drag.originTrackId
                      ? " track-lane--drop-target"
                      : ""
                  }`}
                  style={{ height: LANE_HEIGHT }}
                  data-track-id={track.id}
                  aria-hidden="true"
                >
                  {clipsOnTrack(document.clips, track.id).map((clip) => {
                    const isActiveDrag = drag?.clipId === clip.id;
                    const delta =
                      isActiveDrag && drag.kind === "move"
                        ? (drag.targetStart - drag.originStart) * zoom
                        : 0;
                    const trimming = trimPreview !== null && isActiveDrag;
                    const effectiveClip: Clip = trimming
                      ? trimPreview.edge === "start"
                        ? {
                            ...clip,
                            startFrame: trimPreview.frame,
                            durationFrames: Math.max(1, clipEnd(clip) - trimPreview.frame),
                          }
                        : {
                            ...clip,
                            durationFrames: Math.max(1, trimPreview.frame - clip.startFrame),
                          }
                      : clip;
                    return (
                      <div
                        key={clip.id}
                        style={{
                          position: "absolute",
                          inset: 0,
                          transform: delta !== 0 ? `translateX(${delta}px)` : undefined,
                          pointerEvents: "none",
                        }}
                      >
                        <ClipViewWithMedia
                          clip={effectiveClip}
                          assetId={clip.assetId}
                          trackKind={track.kind}
                          laneHeight={LANE_HEIGHT}
                          zoom={zoom}
                          selected={selection.has(clip.id)}
                          dragging={Boolean(isActiveDrag && drag.moved)}
                          splittable={
                            playheadFrame > clip.startFrame && playheadFrame < clipEnd(clip)
                          }
                          workspacePath={workspacePath}
                          onPointerDownBody={onClipPointerDown}
                          onPointerDownHandle={onHandlePointerDown}
                          onSplitHere={() => splitAtPlayhead()}
                        />
                      </div>
                    );
                  })}
                </div>
              ))}

              {snapLine !== null ? (
                <div className="snap-line" style={{ left: snapLine * zoom }} aria-hidden="true" />
              ) : null}

              {marquee !== null ? (
                <div
                  className="marquee"
                  style={{
                    left: Math.min(marquee.anchorX, marquee.currentX),
                    top: Math.min(marquee.anchorY, marquee.currentY) - RULER_HEIGHT,
                    width: Math.abs(marquee.currentX - marquee.anchorX),
                    height: Math.abs(marquee.currentY - marquee.anchorY),
                  }}
                />
              ) : null}
            </div>

            {/* One playhead element moved by transform: scrubbing never re-lays-out lanes. */}
            <div
              className="playhead"
              style={{
                transform: `translateX(${playheadX}px)`,
                height: lanesHeight + RULER_HEIGHT,
              }}
            >
              <span className="playhead__head" />
            </div>

            {/*
              The gesture surface. It sits *behind* the clips (z-index 0) so clip pointer
              events reach their own handlers and bubble up here for capture and marquee.
            */}
            <div
              ref={contentRef}
              className="timeline__gesture"
              style={{ height: lanesHeight }}
              onPointerDown={onSurfacePointerDown}
              onPointerMove={onSurfacePointerMove}
              onPointerUp={onSurfacePointerUp}
              onPointerCancel={onSurfacePointerUp}
              data-testid="timeline-gesture-surface"
              aria-hidden="true"
            />
          </div>
        </div>
      </div>

      <span className="sr-only" role="status" aria-live="polite">
        {trimPreview ? `Trimming clip to frame ${trimPreview.frame}` : ""}
        {snapLine !== null ? ` Snapped to frame ${snapLine}` : ""}
      </span>
    </section>
  );
}

/**
 * Insert an asset as a new clip at a frame/track, honouring the overwrite contract for the
 * destination range. Shared by drag-and-drop and the storyboard converter.
 */
export function insertAssetAt(
  assetId: string,
  frame: number,
  trackId: string | null,
  fps: { num: number; den: number },
): void {
  const state = useEditorStore.getState();
  const asset = state.document.assets.find((candidate) => candidate.id === assetId);
  if (!asset) {
    state.setError(`Unknown asset ${assetId}`);
    return;
  }
  const kind: TrackKind =
    asset.mediaType === "audio" ? "audio" : asset.mediaType === "subtitle" ? "caption" : "video";
  const track = defaultTrackFor(state.document, kind, trackId);
  if (!track) {
    state.setError(`No unlocked ${kind} track is available for this asset.`);
    return;
  }
  const duration = asset.durationFrames ?? Math.max(1, Math.round(frameRateAsNumber(fps)));
  state.applyEdit(`Add ${asset.mediaType}`, (current) =>
    placeClip(
      current,
      createClip({
        trackId: track.id,
        sequenceId: track.sequenceId,
        assetId: asset.id,
        label: asset.relativePath?.split("/").pop() ?? asset.mediaType,
        startFrame: Math.max(0, Math.round(frame)),
        durationFrames: Math.max(1, duration),
      }),
    ),
  );
}

interface ClipViewWithMediaProps {
  clip: Clip;
  assetId: string | null;
  trackKind: "video" | "audio" | "caption";
  laneHeight: number;
  zoom: number;
  selected: boolean;
  dragging: boolean;
  splittable: boolean;
  workspacePath: string | null;
  onPointerDownBody: (event: ReactPointerEvent<HTMLElement>, clipId: string) => void;
  onPointerDownHandle: (
    event: ReactPointerEvent<HTMLElement>,
    clipId: string,
    edge: "start" | "end",
  ) => void;
  onSplitHere: (clipId: string) => void;
}

/**
 * Loads the derived media a clip needs (thumbnail or waveform) and forwards it to the
 * memoized `ClipView`, keeping the query hooks in one place and `ClipView` presentational.
 */
function ClipViewWithMedia(props: ClipViewWithMediaProps) {
  const asset = useEditorStore((state) =>
    state.document.assets.find((candidate) => candidate.id === props.assetId),
  );
  const { clip, workspacePath, trackKind } = props;

  const thumbnailQuery = useThumbnail(
    workspacePath && asset && trackKind !== "audio"
      ? { workspacePath, assetId: asset.id, atSeconds: 0, width: 160 }
      : null,
  );
  const waveformQuery = useWaveform(
    workspacePath && asset && (trackKind === "audio" || asset.mediaType === "audio")
      ? { workspacePath, assetId: asset.id, buckets: 128 }
      : null,
  );

  const thumbnails = thumbnailQuery.data ? [thumbnailQuery.data.relativePath] : [];
  const peaks = waveformQuery.data?.peaks ?? null;

  return (
    <ClipView
      clip={clip}
      asset={asset}
      trackKind={trackKind}
      laneHeight={props.laneHeight}
      zoom={props.zoom}
      selected={props.selected}
      dragging={props.dragging}
      splittable={props.splittable}
      thumbnails={thumbnails}
      peaks={peaks}
      onPointerDownBody={props.onPointerDownBody}
      onPointerDownHandle={props.onPointerDownHandle}
      onSplitHere={props.onSplitHere}
    />
  );
}

/** The `dataTransfer` contract the Media panel writes and the timeline reads. */
export const ASSET_DRAG_MIME = "application/x-creativelab-asset";

export function writeAssetDragPayload(
  event: { dataTransfer: DataTransfer },
  assetId: string,
): void {
  event.dataTransfer.setData(ASSET_DRAG_MIME, assetId);
  event.dataTransfer.setData("text/plain", assetId);
  event.dataTransfer.effectAllowed = "copy";
}
