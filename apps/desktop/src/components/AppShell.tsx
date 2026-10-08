/**
 * `AppShell` — the PRD §6 layout: "top global toolbar … left rail … middle canvas preview;
 * right contextual inspector; full-width resizable bottom timeline. Panels can be resized or
 * hidden and workspace layouts saved."
 *
 * Splitters are `role="separator"` elements driven by pointer events with keyboard support
 * (arrow keys), because a drag-only splitter is unusable without a pointer.
 */
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { PANEL_LIMITS, useUiStore } from "../state/uiStore";

export interface AppShellProps {
  toolbar: ReactNode;
  rail: ReactNode;
  preview: ReactNode;
  inspector: ReactNode;
  timeline: ReactNode;
}

export function AppShell({ toolbar, rail, preview, inspector, timeline }: AppShellProps) {
  const visibility = useUiStore((state) => state.visibility);
  const sizes = useUiStore((state) => state.sizes);
  const setSize = useUiStore((state) => state.setSize);
  const togglePanel = useUiStore((state) => state.togglePanel);
  const dragRef = useRef<{
    panel: "leftRail" | "inspector" | "timeline";
    start: number;
    origin: number;
  } | null>(null);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const delta =
        drag.panel === "timeline" ? drag.start - event.clientY : event.clientX - drag.start;
      setSize(drag.panel, drag.origin + delta);
    },
    [setSize],
  );

  const stopDrag = useCallback(() => {
    dragRef.current = null;
    document.body.style.cursor = "";
  }, []);

  useEffect(() => {
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopDrag);
    };
  }, [onPointerMove, stopDrag]);

  const beginDrag = (
    panel: "leftRail" | "inspector" | "timeline",
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    dragRef.current = {
      panel,
      start: panel === "timeline" ? event.clientY : event.clientX,
      origin: sizes[panel],
    };
    document.body.style.cursor = panel === "timeline" ? "row-resize" : "col-resize";
  };

  const onSplitterKeyDown = (
    panel: "leftRail" | "inspector" | "timeline",
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void => {
    const step = event.shiftKey ? 40 : 12;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      setSize(panel, sizes[panel] - step);
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      setSize(panel, sizes[panel] + step);
    }
  };

  return (
    <div className="shell">
      {toolbar}
      <div className="shell__body">
        {visibility.leftRail ? (
          <>
            <div
              style={{
                width: sizes.leftRail,
                minWidth: sizes.leftRail,
                minHeight: 0,
                background: "var(--surface-1)",
              }}
            >
              {rail}
            </div>
            <div
              className="splitter splitter--vertical"
              role="separator"
              aria-orientation="vertical"
              tabIndex={0}
              aria-label="Resize the left rail"
              aria-valuenow={sizes.leftRail}
              aria-valuemin={PANEL_LIMITS.leftRail.min}
              aria-valuemax={PANEL_LIMITS.leftRail.max}
              onPointerDown={(event) => beginDrag("leftRail", event)}
              onKeyDown={(event) => onSplitterKeyDown("leftRail", event)}
            />
          </>
        ) : null}

        <div className="shell__center">
          <div className="shell__preview">{preview}</div>
          {visibility.timeline ? (
            <>
              <div
                className="splitter splitter--horizontal"
                role="separator"
                aria-orientation="horizontal"
                tabIndex={0}
                aria-label="Resize the timeline"
                aria-valuenow={sizes.timeline}
                aria-valuemin={PANEL_LIMITS.timeline.min}
                aria-valuemax={PANEL_LIMITS.timeline.max}
                onPointerDown={(event) => beginDrag("timeline", event)}
                onKeyDown={(event) => onSplitterKeyDown("timeline", event)}
              />
              <div className="shell__timeline" style={{ height: sizes.timeline }}>
                {timeline}
              </div>
            </>
          ) : null}
        </div>

        {visibility.inspector ? (
          <>
            <div
              className="splitter splitter--vertical"
              role="separator"
              aria-orientation="vertical"
              tabIndex={0}
              aria-label="Resize the inspector"
              aria-valuenow={sizes.inspector}
              aria-valuemin={PANEL_LIMITS.inspector.min}
              aria-valuemax={PANEL_LIMITS.inspector.max}
              onPointerDown={(event) => beginDrag("inspector", event)}
              onKeyDown={(event) => onSplitterKeyDown("inspector", event)}
            />
            <div
              className="shell__inspector"
              style={{ width: sizes.inspector, minWidth: sizes.inspector }}
            >
              {inspector}
            </div>
          </>
        ) : null}
      </div>

      {/* Panel visibility is also exposed as a compact strip so a hidden panel is always
          recoverable without a mouse (PRD §14 keyboard navigation). */}
      <div
        className="row small muted"
        style={{
          padding: "2px 10px",
          borderTop: "1px solid var(--border-subtle)",
          background: "var(--surface-1)",
        }}
      >
        <span>Panels:</span>
        {(
          [
            ["leftRail", "rail"],
            ["inspector", "inspector"],
            ["timeline", "timeline"],
            ["storyboard", "storyboard"],
          ] as const
        ).map(([panel, label]) => (
          <button
            key={panel}
            type="button"
            className="chip"
            aria-pressed={visibility[panel]}
            onClick={() => togglePanel(panel)}
          >
            {visibility[panel] ? "◉" : "◌"} {label}
          </button>
        ))}
      </div>
    </div>
  );
}
