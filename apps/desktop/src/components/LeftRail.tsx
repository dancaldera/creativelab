/**
 * `LeftRail` — the six-panel navigation rail (PRD §6: "left rail (Media, Generate, Audio,
 * Captions, Templates, Projects)").
 *
 * The rail is a `tablist`: arrow keys move between panels, which is what makes the editor
 * usable without a pointer (PRD §14).
 */
import { useRef } from "react";
import { RAIL_PANELS, useUiStore, type RailPanelId } from "../state/uiStore";
import { AudioPanel } from "./AudioPanel";
import { CaptionsPanel } from "./CaptionsPanel";
import { GeneratePanel } from "./GeneratePanel";
import { MediaPanel } from "./MediaPanel";
import { ProjectsPanel } from "./ProjectsPanel";
import { TemplatesPanel } from "./TemplatesPanel";

const ICONS: Record<RailPanelId, string> = {
  media: "▦",
  generate: "✦",
  audio: "♪",
  captions: "⌘",
  templates: "❐",
  projects: "⛁",
};

export function LeftRail() {
  const activePanel = useUiStore((state) => state.activePanel);
  const setActivePanel = useUiStore((state) => state.setActivePanel);
  const tabRefs = useRef<Map<RailPanelId, HTMLButtonElement>>(new Map());

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Local copy: `RAIL_PANELS` is a readonly tuple, and the index arithmetic below is
    // clearer with a plain array.
    const panels: ReadonlyArray<{ id: RailPanelId; label: string; hint: string }> = [
      ...RAIL_PANELS,
    ];
    const index = panels.findIndex((panel) => panel.id === activePanel);
    if (index === -1) return;
    let nextIndex = index;
    if (event.key === "ArrowDown") nextIndex = (index + 1) % panels.length;
    else if (event.key === "ArrowUp") nextIndex = (index - 1 + panels.length) % panels.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = panels.length - 1;
    else return;
    event.preventDefault();
    const next = panels[nextIndex];
    if (!next) return;
    setActivePanel(next.id);
    tabRefs.current.get(next.id)?.focus();
  };

  const active = RAIL_PANELS.find((panel) => panel.id === activePanel) ?? RAIL_PANELS[0]!;

  return (
    <div className="rail">
      <nav
        className="rail__nav"
        role="tablist"
        aria-orientation="vertical"
        aria-label="Editor panels"
        onKeyDown={onKeyDown}
      >
        {RAIL_PANELS.map((panel) => (
          <button
            key={panel.id}
            type="button"
            role="tab"
            id={`rail-tab-${panel.id}`}
            aria-selected={activePanel === panel.id}
            aria-controls={`rail-panel-${panel.id}`}
            tabIndex={activePanel === panel.id ? 0 : -1}
            className="rail__tab"
            title={panel.hint}
            onClick={() => setActivePanel(panel.id)}
            ref={(element) => {
              if (element) tabRefs.current.set(panel.id, element);
              else tabRefs.current.delete(panel.id);
            }}
          >
            <span className="rail__tab-icon" aria-hidden="true">
              {ICONS[panel.id]}
            </span>
            {panel.label}
          </button>
        ))}
      </nav>

      <section
        className="rail__panel"
        role="tabpanel"
        id={`rail-panel-${active.id}`}
        aria-labelledby={`rail-tab-${active.id}`}
        tabIndex={-1}
      >
        <header className="rail__panel-header">
          <h2 className="rail__panel-title">{active.label}</h2>
          <span className="small muted">{active.hint}</span>
        </header>
        {activePanel === "media" ? <MediaPanel /> : null}
        {activePanel === "generate" ? <GeneratePanel /> : null}
        {activePanel === "audio" ? <AudioPanel /> : null}
        {activePanel === "captions" ? <CaptionsPanel /> : null}
        {activePanel === "templates" ? <TemplatesPanel /> : null}
        {activePanel === "projects" ? <ProjectsPanel /> : null}
      </section>
    </div>
  );
}
