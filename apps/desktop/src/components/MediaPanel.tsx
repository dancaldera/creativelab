/**
 * `MediaPanel` — the local media library (FR-02, PRD §6 "asset grid/list, filters by
 * type/provenance, folder tags, original/AI variants and drag-to-timeline").
 *
 * Import offers an explicit copy-vs-link choice because PRD §9 makes copying the default
 * and linking an *advanced* decision, and the user has to be told which one they are
 * choosing before media leaves its original location (or does not).
 */
import { useEffect, useMemo, useState } from "react";
import type { Asset, MediaType } from "@creativelab/core";
import { IMPORT_FILTERS } from "../bridge/protocol";
import { getBridge } from "../bridge";
import { useImportAssets } from "../hooks/queries";
import { useEditorStore } from "../state/editorStore";
import { useUiStore } from "../state/uiStore";
import { formatBytes, formatDuration, framesToSecondsSafe } from "../utils/format";
import { insertAssetAt, writeAssetDragPayload } from "./Timeline";

type TypeFilter = "all" | MediaType;
type ProvenanceFilter = "all" | "imported" | "generated";

export function MediaPanel() {
  const document = useEditorStore((state) => state.document);
  const workspacePath = useEditorStore((state) => state.workspacePath);
  const selectClips = useEditorStore((state) => state.selectClips);
  const showToast = useUiStore((state) => state.showToast);
  const importAssets = useImportAssets();

  const [view, setView] = useState<"grid" | "list">("grid");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [provenanceFilter, setProvenanceFilter] = useState<ProvenanceFilter>("all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<"copy" | "link" | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const asset of document.assets) {
      const probe = asset.probe ?? {};
      const assetTags = probe["tags"];
      if (Array.isArray(assetTags)) for (const tag of assetTags) if (typeof tag === "string") set.add(tag);
      set.add(asset.origin);
    }
    return [...set].sort();
  }, [document.assets]);

  const filtered = useMemo(
    () =>
      document.assets.filter((asset) => {
        if (typeFilter !== "all" && asset.mediaType !== typeFilter) return false;
        if (provenanceFilter !== "all" && asset.origin !== provenanceFilter) return false;
        if (tagFilter) {
          const probe = asset.probe ?? {};
          const assetTags = Array.isArray(probe["tags"]) ? (probe["tags"] as unknown[]) : [];
          if (asset.origin !== tagFilter && !assetTags.includes(tagFilter)) return false;
        }
        return true;
      }),
    [document.assets, provenanceFilter, tagFilter, typeFilter],
  );

  const duplicates = useMemo(() => {
    const byHash = new Map<string, Asset[]>();
    for (const asset of document.assets) {
      if (!asset.sha256) continue;
      const list = byHash.get(asset.sha256);
      if (list) list.push(asset);
      else byHash.set(asset.sha256, [asset]);
    }
    return new Set([...byHash.values()].filter((list) => list.length > 1).flatMap((list) => list.map((asset) => asset.id)));
  }, [document.assets]);

  const usedAssetIds = useMemo(
    () => new Set(document.clips.map((clip) => clip.assetId).filter((id): id is string => Boolean(id))),
    [document.clips],
  );

  const chooseAndImport = async (mode: "copy" | "link"): Promise<void> => {
    setImportMode(null);
    const dialog = await getBridge().dialogOpenFile({ multiple: true, filters: IMPORT_FILTERS });
    if (dialog.canceled || dialog.paths.length === 0) {
      showToast("Import canceled.", "info");
      return;
    }
    try {
      const response = await importAssets.mutateAsync({
        workspacePath: workspacePath ?? "",
        sourcePaths: dialog.paths,
        mode,
      });
      showToast(
        `Imported ${response.imported.length} file(s) as ${mode === "copy" ? "copied project media" : "linked originals"}${
          response.imported.some((entry) => entry.duplicateOf) ? " (duplicates detected)" : ""
        }.`,
        response.errors.length > 0 ? "warn" : "info",
      );
    } catch (error) {
      showToast(`Import failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  const addToTimeline = (asset: Asset): void => {
    const state = useEditorStore.getState();
    const kind = asset.mediaType === "audio" ? "audio" : asset.mediaType === "subtitle" ? "caption" : "video";
    const track = state.document.tracks
      .filter((candidate) => candidate.kind === kind && !candidate.locked)
      .sort((a, b) => a.sortOrder - b.sortOrder)[0];
    if (!track) {
      showToast(`No unlocked ${kind} track available.`, "warn");
      return;
    }
    const fps = state.document.sequences.find((entry) => entry.isActive)?.fps ?? state.document.project.fps;
    insertAssetAt(asset.id, state.playheadFrame, track.id, fps);
    void selectClips;
  };

  return (
    <>
      <div className="panel-scroll">
        <div className="panel-toolbar">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setImportMode("copy")}
            aria-haspopup="dialog"
            disabled={workspacePath === null}
          >
            Import media…
          </button>
          <div className="spacer" />
          <div className="row" role="group" aria-label="View mode">
            <button type="button" className="chip" aria-pressed={view === "grid"} onClick={() => setView("grid")}>
              Grid
            </button>
            <button type="button" className="chip" aria-pressed={view === "list"} onClick={() => setView("list")}>
              List
            </button>
          </div>
        </div>

        {workspacePath === null ? (
          <p className="callout callout--warning">
            No project workspace is open. Create or open a project before importing media — imports are scoped to the approved workspace
            path (PRD §13).
          </p>
        ) : null}

        <div className="filters" role="group" aria-label="Filter by media type">
          {(["all", "video", "image", "audio", "subtitle"] as const).map((type) => (
            <button key={type} type="button" className="chip" aria-pressed={typeFilter === type} onClick={() => setTypeFilter(type)}>
              {type}
            </button>
          ))}
        </div>

        <div className="filters" role="group" aria-label="Filter by provenance">
          {(["all", "imported", "generated"] as const).map((origin) => (
            <button
              key={origin}
              type="button"
              className="chip"
              aria-pressed={provenanceFilter === origin}
              onClick={() => setProvenanceFilter(origin)}
            >
              {origin}
            </button>
          ))}
        </div>

        {tags.length > 0 ? (
          <div className="filters" role="group" aria-label="Filter by tag">
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                className="chip"
                aria-pressed={tagFilter === tag}
                onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
              >
                #{tag}
              </button>
            ))}
          </div>
        ) : null}

        {document.assets.length === 0 ? (
          <p className="empty">
            The library is empty. Import footage or generate an asset; every result becomes a first-class library asset with its
            provenance recorded.
          </p>
        ) : filtered.length === 0 ? (
          <p className="empty">No assets match the current filters.</p>
        ) : (
          <div className={`asset-grid${view === "list" ? " asset-grid--list" : ""}`} role="list">
            {filtered.map((asset) => {
              const clipsUsing = document.clips.filter((clip) => clip.assetId === asset.id).length;
              return (
                <div
                  key={asset.id}
                  role="listitem"
                  className={`asset-card${view === "list" ? " asset-card--list" : ""}`}
                  aria-current={selectedAssetId === asset.id}
                  draggable
                  onDragStart={(event) => writeAssetDragPayload(event, asset.id)}
                  onClick={() => setSelectedAssetId(asset.id)}
                  onDoubleClick={() => addToTimeline(asset)}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") addToTimeline(asset);
                  }}
                  title="Drag onto the timeline, or press Enter to append at the playhead"
                >
                  <AssetThumb asset={asset} workspacePath={workspacePath} />
                  <div className="asset-card__meta">
                    <span className="asset-card__name" title={asset.relativePath ?? asset.uri}>
                      {asset.relativePath?.split("/").pop() ?? asset.uri.split("/").pop() ?? asset.id}
                    </span>
                    <span className="small muted">
                      {asset.mediaType}
                      {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ""}
                      {asset.durationFrames ? ` · ${formatDuration(framesToSecondsSafe(asset.durationFrames, asset.fps))}` : ""}
                      {asset.bytes ? ` · ${formatBytes(asset.bytes)}` : ""}
                    </span>
                    <div className="asset-card__tags">
                      <span className="tag">{asset.origin}</span>
                      <span className="tag">{asset.storageMode}</span>
                      {duplicates.has(asset.id) ? <span className="tag">duplicate</span> : null}
                      {asset.missingAt ? <span className="tag" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>missing</span> : null}
                      {!usedAssetIds.has(asset.id) ? <span className="tag">unused</span> : null}
                      {clipsUsing > 1 ? <span className="tag">{clipsUsing} clips</span> : null}
                      {asset.generationJobId ? <span className="tag">AI</span> : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {importMode !== null ? (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="Choose how to import">
          <div className="dialog dialog--narrow">
            <div className="dialog__header">
              <h2 className="dialog__title">How should these files be stored?</h2>
            </div>
            <div className="dialog__body">
              <p className="small">
                This choice is recorded per asset. PRD §9 makes copying the default; linking an original is an explicit advanced
                choice.
              </p>
              <button type="button" className="model-option" onClick={() => void chooseAndImport("copy")}>
                <span>
                  <strong>Copy into the project</strong>
                  <br />
                  <span className="small muted">
                    Media is copied under <code className="mono">assets/originals</code>. The project stays self-contained and offline;
                    packaging always works.
                  </span>
                </span>
              </button>
              <button type="button" className="model-option" onClick={() => void chooseAndImport("link")}>
                <span>
                  <strong>Link the originals</strong>
                  <br />
                  <span className="small muted">
                    Files stay where they are and are referenced in place. Nothing is duplicated on disk, but the project breaks if the
                    originals move or are deleted.
                  </span>
                </span>
              </button>
            </div>
            <div className="dialog__footer">
              <div className="spacer" />
              <button type="button" className="btn" onClick={() => setImportMode(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * Thumbnail for one asset. The mock returns a data URI and the native side returns a
 * workspace-relative path that Tauri's asset protocol resolves; either way this is a plain
 * `<img src>` and no bytes cross the IPC boundary.
 */
function AssetThumb({ asset, workspacePath }: { asset: Asset; workspacePath: string | null }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!workspacePath || asset.missingAt) {
      setSrc(null);
      return undefined;
    }
    let cancelled = false;
    getBridge()
      .mediaThumbnail({ workspacePath, assetId: asset.id, atSeconds: 0, width: 160 })
      .then((response) => {
        if (!cancelled) setSrc(response.relativePath);
      })
      .catch(() => {
        if (!cancelled) setSrc("");
      });
    return () => {
      cancelled = true;
    };
  }, [asset.id, asset.missingAt, workspacePath]);

  if (!src) {
    return (
      <div
        className="asset-card__thumb"
        aria-hidden="true"
        style={{ background: `hsl(${hashHue(asset.id)} 30% 18%)` }}
      />
    );
  }
  return <img className="asset-card__thumb" src={src} alt="" loading="lazy" draggable={false} />;
}

function hashHue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 360;
  return hash;
}
