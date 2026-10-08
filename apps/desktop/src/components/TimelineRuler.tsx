/**
 * `TimelineRuler` — timecode ticks plus playhead scrubbing.
 *
 * Rendered as a `role="slider"` so screen readers get position information, and as a
 * pointer-driven scrub surface so it feels like an NLE. Tick density adapts to zoom: the
 * label interval is the smallest "nice" step whose pixel width clears ~90 px.
 */
import { useMemo, type PointerEvent as ReactPointerEvent } from "react";
import { formatTimecode, frameRateAsNumber } from "../state/coreOps";

export interface TimelineRulerProps {
  fps: { num: number; den: number };
  zoom: number;
  width: number;
  playheadFrame: number;
  durationFrames: number;
  onScrub: (frame: number) => void;
}

const SECOND_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export function TimelineRuler({ fps, zoom, width, playheadFrame, durationFrames, onScrub }: TimelineRulerProps) {
  const fpsValue = Math.max(1, frameRateAsNumber(fps));

  const { majorStepSeconds, minorStepFrames } = useMemo(() => {
    const targetPx = 96;
    const step = SECOND_STEPS.find((candidate) => candidate * fpsValue * zoom >= targetPx) ?? SECOND_STEPS[SECOND_STEPS.length - 1]!;
    return { majorStepSeconds: step, minorStepFrames: Math.max(1, Math.round((step * fpsValue) / 5)) };
  }, [fpsValue, zoom]);

  const ticks = useMemo(() => {
    const items: Array<{ frame: number; major: boolean; label: string | null }> = [];
    const majorFrames = majorStepSeconds * fpsValue;
    // Minor ticks exist only when they will not turn the ruler into a solid block.
    const minorPx = minorStepFrames * zoom;
    if (minorPx >= 6) {
      for (let frame = 0; frame <= durationFrames + majorFrames; frame += minorStepFrames) {
        const isMajor = frame % majorFrames === 0;
        items.push({ frame, major: isMajor, label: isMajor ? formatTimecode(frame, fps, false) : null });
      }
    } else {
      for (let frame = 0; frame <= durationFrames + majorFrames; frame += majorFrames) {
        items.push({ frame, major: true, label: formatTimecode(frame, fps, false) });
      }
    }
    return items;
  }, [durationFrames, fps, majorStepSeconds, minorStepFrames, zoom]);

  const frameForClientX = (clientX: number, element: HTMLElement): number => {
    const rect = element.getBoundingClientRect();
    const offset = clientX - rect.left + element.scrollLeft;
    return Math.max(0, Math.round(offset / zoom));
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    onScrub(frameForClientX(event.clientX, element));

    const onMove = (moveEvent: PointerEvent): void => {
      onScrub(frameForClientX(moveEvent.clientX, element));
    };
    const onUp = (): void => {
      element.releasePointerCapture(event.pointerId);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
      element.removeEventListener("pointercancel", onUp);
    };
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
    element.addEventListener("pointercancel", onUp);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? Math.round(fpsValue) : 1;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      onScrub(Math.min(durationFrames, playheadFrame + step));
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      onScrub(Math.max(0, playheadFrame - step));
    } else if (event.key === "Home") {
      event.preventDefault();
      onScrub(0);
    } else if (event.key === "End") {
      event.preventDefault();
      onScrub(durationFrames);
    }
  };

  return (
    <div
      className="ruler"
      style={{ width }}
      role="slider"
      tabIndex={0}
      aria-label="Timeline ruler"
      aria-valuemin={0}
      aria-valuemax={Math.max(1, durationFrames)}
      aria-valuenow={playheadFrame}
      aria-valuetext={formatTimecode(playheadFrame, fps)}
      aria-orientation="horizontal"
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    >
      {ticks.map((tick) => (
        <div key={`${tick.frame}-${tick.major ? "major" : "minor"}`}>
          <div
            className={tick.major ? "ruler__tick" : "ruler__tick ruler__tick--minor"}
            style={{ left: tick.frame * zoom }}
          />
          {tick.label ? (
            <span className="ruler__label" style={{ left: tick.frame * zoom }}>
              {tick.label}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
