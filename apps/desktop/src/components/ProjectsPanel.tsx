/**
 * `ProjectsPanel` — recent projects, packaging, backups and storage management
 * (FR-01, PRD §11 and §14 "Storage management UI: cache size, available disk, cleanup and
 * project packaging").
 *
 * Cache cleanup and packaging are the only operations here that touch the filesystem, and
 * both go through allowlisted bridge commands with the workspace path as the scope.
 */
import { useState } from "react";
import { getBridge } from "../bridge";
import { usePurgeCaches, useRecentProjects, useWorkspaceUsage } from "../hooks/queries";
import { useEditorStore } from "../state/editorStore";
import { useUiStore } from "../state/uiStore";
import { formatBytes, formatTimestamp } from "../utils/format";

const SEGMENT_COLOURS = ["#6aa9ff", "#56d68b", "#ffc460", "#b48ce0", "#ff8080"];

export function ProjectsPanel() {
  const workspacePath = useEditorStore((state) => state.workspacePath);
  const loadDocument = useEditorStore((state) => state.loadDocument);
  const showToast = useUiStore((state) => state.showToast);
  const recent = useRecentProjects();
  const usage = useWorkspaceUsage();
  const purge = usePurgeCaches();
  const [packaging, setPackaging] = useState(false);

  const openProject = async (path: string): Promise<void> => {
    try {
      const session = await getBridge().projectOpen({ workspacePath: path });
      loadDocument(session.document as never, session.workspacePath);
      showToast(`Opened ${path}`, "info");
    } catch (error) {
      showToast(`Could not open ${path}: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  const packageProject = async (): Promise<void> => {
    if (!workspacePath) return;
    setPackaging(true);
    try {
      const dialog = await getBridge().dialogSaveFile({ defaultPath: `${workspacePath}/exports/project-package.zip` });
      if (dialog.canceled || dialog.paths.length === 0) {
        showToast("Packaging canceled.", "info");
        return;
      }
      const response = await getBridge().projectPackage({ destinationPath: dialog.paths[0]! });
      showToast(
        `Packaged ${response.files} files (${formatBytes(response.bytes)})${
          response.portable ? "" : ` — ${response.unresolved.length} linked asset(s) could not be made portable`
        }.`,
        response.portable ? "info" : "warn",
      );
    } catch (error) {
      showToast(`Packaging failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setPackaging(false);
    }
  };

  const backup = async (): Promise<void> => {
    if (!workspacePath) return;
    try {
      const response = await getBridge().projectBackup({ workspacePath, label: "manual" });
      showToast(`Backup written to ${response.destination} (${response.files} files).`, "info");
    } catch (error) {
      showToast(`Backup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  const total = usage.data?.totalBytes ?? 0;
  const cacheReclaimable = usage.data?.cacheReclaimableBytes ?? 0;

  return (
    <div className="panel-scroll">
      <div className="panel-toolbar">
        <button type="button" className="btn" onClick={() => void openProject(workspacePath ?? "")} disabled={!workspacePath}>
          Reopen workspace
        </button>
        <button type="button" className="btn" onClick={() => void packageProject()} disabled={!workspacePath || packaging}>
          {packaging ? "Packaging…" : "Package project"}
        </button>
        <button type="button" className="btn" onClick={() => void backup()} disabled={!workspacePath}>
          Backup
        </button>
      </div>

      <div className="field">
        <span className="field-label">Recent projects</span>
        {recent.isLoading ? <p className="small muted">Loading…</p> : null}
        {recent.data && recent.data.length === 0 ? <p className="empty">No recent projects recorded yet.</p> : null}
        <ul className="list">
          {(recent.data ?? []).map((project) => (
            <li className="list__item" key={`${project.id}-${project.workspacePath}`}>
              <button type="button" className="btn btn--ghost" onClick={() => void openProject(project.workspacePath)}>
                {project.title}
              </button>
              <div className="spacer" />
              {project.hasMissingMedia ? <span className="badge badge--danger">missing media</span> : null}
              <span className="small muted">{formatTimestamp(project.updatedAt)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="field">
        <span className="field-label">Storage usage</span>
        {usage.isLoading ? <p className="small muted">Measuring the workspace…</p> : null}
        {usage.data ? (
          <>
            <div className="storage-bar" role="img" aria-label={`Workspace usage: ${formatBytes(total)} total`}>
              {(usage.data.directories.length > 0 ? usage.data.directories : [{ path: "workspace", bytes: total, files: 0 }]).map(
                (directory, index) => (
                  <span
                    key={directory.path}
                    className="storage-bar__seg"
                    style={{
                      width: `${total > 0 ? Math.max(2, (directory.bytes / total) * 100) : 100}%`,
                      background: SEGMENT_COLOURS[index % SEGMENT_COLOURS.length],
                    }}
                    title={`${directory.path} · ${formatBytes(directory.bytes)}`}
                  />
                ),
              )}
            </div>
            <div className="storage-legend">
              {(usage.data.directories.length > 0 ? usage.data.directories : [{ path: "workspace", bytes: total, files: 0 }]).map(
                (directory, index) => (
                  <span key={directory.path}>
                    <span
                      className="storage-legend__swatch"
                      style={{ background: SEGMENT_COLOURS[index % SEGMENT_COLOURS.length] }}
                      aria-hidden="true"
                    />
                    {directory.path} · {formatBytes(directory.bytes)} ({directory.files} files)
                  </span>
                ),
              )}
            </div>
            <dl className="provenance-grid">
              <dt>Total</dt>
              <dd className="mono">{formatBytes(usage.data.totalBytes)}</dd>
              <dt>Cache</dt>
              <dd className="mono">{formatBytes(usage.data.cacheBytes)}</dd>
              <dt>Reclaimable</dt>
              <dd className="mono">{formatBytes(cacheReclaimable)}</dd>
              <dt>Root</dt>
              <dd className="mono" style={{ wordBreak: "break-all" }}>
                {usage.data.root}
              </dd>
            </dl>
            <div className="row">
              <button
                type="button"
                className="btn"
                disabled={purge.isPending || cacheReclaimable === 0}
                onClick={() =>
                  void purge
                    .mutateAsync()
                    .then((response) => showToast(`Cleaned ${response.purged.length} cache directories.`, "info"))
                    .catch((error: unknown) =>
                      showToast(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "error"),
                    )
                }
              >
                {purge.isPending ? "Cleaning…" : `Clean cache (${formatBytes(cacheReclaimable)})`}
              </button>
              <span className="small muted">Caches are rebuildable; originals and exports are never touched.</span>
            </div>
          </>
        ) : null}
      </div>

      <p className="small muted">
        Packaging copies every dependency and validates relinking; linked originals outside the workspace cannot be made portable, and the
        result says so explicitly rather than failing silently (PRD §11).
      </p>
    </div>
  );
}
