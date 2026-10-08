/**
 * `Toolbar` — the single global control strip (PRD §6: "top global toolbar (project,
 * undo/redo, aspect, playback and export)").
 *
 * Also carries the connection/credential indicator required by PRD §14: "Generation buttons
 * visibly indicate connectivity and credentials".
 */
import { useEffect, useState } from "react";
import { ASPECT_PRESETS_LOCAL, FRAME_RATE_PRESETS_LOCAL, formatTimecode, frameRateEquals } from "../state/coreOps";
import { useEditorStore } from "../state/editorStore";
import { useUiStore } from "../state/uiStore";
import { useJobsStore } from "../state/jobsStore";
import { bridgeKind, bridgeDescription } from "../bridge";
import { useCredentials } from "../hooks/queries";
import { useCreateProject } from "../hooks/queries";

export interface ToolbarProps {
  onSave: () => void;
  onOpen: () => void;
  onPackage: () => void;
  saving: boolean;
  lastSavedAt: string | null;
}

export function Toolbar({ onSave, onOpen, onPackage, saving, lastSavedAt }: ToolbarProps) {
  const document = useEditorStore((state) => state.document);
  const workspacePath = useEditorStore((state) => state.workspacePath);
  const history = useEditorStore((state) => state.history);
  const playheadFrame = useEditorStore((state) => state.playheadFrame);
  const isPlaying = useEditorStore((state) => state.isPlaying);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const setPlayhead = useEditorStore((state) => state.setPlayhead);
  const setPlaying = useEditorStore((state) => state.setPlaying);
  const applyEdit = useEditorStore((state) => state.applyEdit);

  const exportOpen = useUiStore((state) => state.exportOpen);
  const setExportOpen = useUiStore((state) => state.setExportOpen);
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const setJobsOpen = useUiStore((state) => state.setJobsOpen);
  const storyboardOpen = useUiStore((state) => state.storyboardOpen);
  const setStoryboardOpen = useUiStore((state) => state.setStoryboardOpen);
  const setActivePanel = useUiStore((state) => state.setActivePanel);
  const showToast = useUiStore((state) => state.showToast);

  const unknownJobs = useJobsStore((state) => state.needsAttention.length);
  const credentials = useCredentials();
  const createProject = useCreateProject();

  const [title, setTitle] = useState(document.project.title);
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    setTitle(document.project.title);
  }, [document.project.title]);

  const sequence = document.sequences.find((candidate) => candidate.isActive) ?? document.sequences[0];
  const fps = sequence?.fps ?? document.project.fps;
  const aspect = ASPECT_PRESETS_LOCAL.find(
    (preset) =>
      preset.width / preset.height === document.project.width / document.project.height ||
      (preset.width === document.project.width && preset.height === document.project.height),
  );

  const commitTitle = (): void => {
    setRenaming(false);
    const next = title.trim() || document.project.title;
    if (next === document.project.title) {
      setTitle(document.project.title);
      return;
    }
    applyEdit("Rename project", (current) => ({
      ...current,
      project: { ...current.project, title: next, updatedAt: new Date().toISOString() },
    }));
  };

  const changeAspect = (presetId: string): void => {
    const preset = ASPECT_PRESETS_LOCAL.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    applyEdit(`Aspect ${preset.id}`, (current) => ({
      ...current,
      project: { ...current.project, width: preset.width, height: preset.height, updatedAt: new Date().toISOString() },
      sequences: current.sequences.map((entry) =>
        entry.isActive ? { ...entry, width: preset.width, height: preset.height, updatedAt: new Date().toISOString() } : entry,
      ),
    }));
  };

  const changeFps = (presetId: string): void => {
    const preset = FRAME_RATE_PRESETS_LOCAL.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    applyEdit(`Frame rate ${preset.id}`, (current) => ({
      ...current,
      project: { ...current.project, fps: preset.rate, updatedAt: new Date().toISOString() },
      sequences: current.sequences.map((entry) =>
        entry.isActive ? { ...entry, fps: preset.rate, updatedAt: new Date().toISOString() } : entry,
      ),
    }));
  };

  const credentialCount = credentials.data?.length ?? 0;
  const credentialState = credentials.isLoading
    ? "checking credentials"
    : credentials.isError
      ? "credentials unavailable"
      : credentialCount > 0
        ? `${credentialCount} credential${credentialCount === 1 ? "" : "s"}`
        : "no credentials";

  const connectionTone = credentials.isError ? "off" : credentialCount > 0 ? "ok" : "warn";

  return (
    <header className="toolbar" role="banner">
      <div className="toolbar__title">
        <button
          type="button"
          className="btn btn--ghost"
          aria-label="New project"
          title="New project"
          onClick={() => {
            void createProject.mutateAsync({
              title: "Untitled Project",
              fps: { num: 30, den: 1 },
              width: 1920,
              height: 1080,
              workspacePath: workspacePath ?? "/Users/studio/CreativeLab/Untitled",
            });
            showToast("Created a new project in the mock workspace.", "info");
          }}
        >
          ✦
        </button>
        <input
          className="toolbar__title-input"
          value={title}
          aria-label="Project name"
          onFocus={() => setRenaming(true)}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              setTitle(document.project.title);
              setRenaming(false);
              event.currentTarget.blur();
            }
            event.stopPropagation();
          }}
        />
        {renaming ? <span className="small muted">renaming…</span> : null}
      </div>

      <div className="toolbar__group">
        <button type="button" className="btn" onClick={onOpen} title="Open a project workspace">
          Open
        </button>
        <button type="button" className="btn" onClick={onSave} disabled={saving} title="Save the project">
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn" onClick={onPackage} title="Package the project with its media">
          Package
        </button>
      </div>

      <div className="toolbar__divider" />

      <div className="toolbar__group" role="group" aria-label="Undo and redo">
        <button
          type="button"
          className="btn btn--icon"
          onClick={undo}
          disabled={!history.canUndo}
          aria-label={history.undoLabel ? `Undo ${history.undoLabel}` : "Undo"}
          title={history.undoLabel ? `Undo ${history.undoLabel} (Cmd/Ctrl+Z)` : "Undo (Cmd/Ctrl+Z)"}
        >
          ↶
        </button>
        <button
          type="button"
          className="btn btn--icon"
          onClick={redo}
          disabled={!history.canRedo}
          aria-label={history.redoLabel ? `Redo ${history.redoLabel}` : "Redo"}
          title={history.redoLabel ? `Redo ${history.redoLabel} (Shift+Cmd/Ctrl+Z)` : "Redo (Shift+Cmd/Ctrl+Z)"}
        >
          ↷
        </button>
        <span className="small muted" aria-live="polite">
          {history.undoLabel ? `last: ${history.undoLabel}` : "no edits yet"}
        </span>
      </div>

      <div className="toolbar__divider" />

      <div className="toolbar__group">
        <label className="small muted" htmlFor="toolbar-aspect">
          Aspect
        </label>
        <select
          id="toolbar-aspect"
          className="select"
          style={{ width: 132 }}
          value={aspect?.id ?? ""}
          onChange={(event) => changeAspect(event.target.value)}
        >
          {aspect ? null : <option value="">Custom {document.project.width}×{document.project.height}</option>}
          {ASPECT_PRESETS_LOCAL.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>

        <label className="small muted" htmlFor="toolbar-fps">
          FPS
        </label>
        <select
          id="toolbar-fps"
          className="select"
          style={{ width: 132 }}
          value={FRAME_RATE_PRESETS_LOCAL.find((preset) => frameRateEquals(preset.rate, fps))?.id ?? ""}
          onChange={(event) => changeFps(event.target.value)}
        >
          {FRAME_RATE_PRESETS_LOCAL.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar__divider" />

      <div className="toolbar__group" role="group" aria-label="Transport">
        <button
          type="button"
          className="btn btn--icon"
          aria-label="Go to start"
          onClick={() => setPlayhead(0)}
        >
          ⏮
        </button>
        <button
          type="button"
          className="btn btn--icon"
          aria-label={isPlaying ? "Pause" : "Play"}
          onClick={() => setPlaying(!isPlaying, isPlaying ? 0 : 1)}
        >
          {isPlaying ? "❚❚" : "▶"}
        </button>
        <span className="timecode" aria-label="Playhead timecode" role="status">
          {formatTimecode(playheadFrame, fps)}
        </span>
      </div>

      <div className="spacer" />

      {unknownJobs > 0 ? (
        <button type="button" className="badge badge--warning" onClick={() => setJobsOpen(true)}>
          {unknownJobs} job{unknownJobs === 1 ? "" : "s"} need attention
        </button>
      ) : null}

      <button
        type="button"
        className="chip"
        aria-pressed={storyboardOpen}
        onClick={() => setStoryboardOpen(!storyboardOpen)}
        title="Storyboard view"
      >
        Storyboard
      </button>

      <button type="button" className="chip" onClick={() => setJobsOpen(true)} title="Job queue">
        Jobs
      </button>

      <button
        type="button"
        className="chip"
        onClick={() => setActivePanel("generate")}
        title="Open the generation panel"
      >
        Generate
      </button>

      <span className={`conn conn--${connectionTone}`} title={`Bridge: ${bridgeDescription()}. Credentials: ${credentialState}`}>
        <span className="conn__dot" aria-hidden="true" />
        <span>
          {bridgeKind === "tauri" ? "Native" : "Mock"} · {credentialState}
        </span>
      </span>

      <button type="button" className="btn" onClick={() => setSettingsOpen(true)} aria-expanded={settingsOpen}>
        Settings
      </button>
      <button type="button" className="btn btn--primary" onClick={() => setExportOpen(true)} aria-expanded={exportOpen}>
        Export
      </button>

      {lastSavedAt ? (
        <span className="small muted mono" title={lastSavedAt}>
          saved {new Date(lastSavedAt).toLocaleTimeString()}
        </span>
      ) : null}

      <span className="sr-only" role="status" aria-live="polite">
        {workspacePath ? `Workspace ${workspacePath}` : "No workspace open"}
      </span>
    </header>
  );
}
