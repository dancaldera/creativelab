/**
 * `ExportDialog` — preset picker, output path, burn-in captions, progress with cancel, log
 * tail and "reveal in Finder" (FR-09, PRD §6/§14).
 *
 * Progress is announced through `aria-live="polite"` so a screen-reader user hears about
 * completion without the polite region interrupting them every polling tick.
 */
import { useState } from "react";
import { getBridge } from "../bridge";
import { EXPORT_PRESETS_LOCAL } from "../state/coreOps";
import { useRenderStatus } from "../hooks/queries";
import { useEditorStore } from "../state/editorStore";
import { useUiStore } from "../state/uiStore";
import { formatPercent } from "../utils/format";

export function ExportDialog() {
  const exportOpen = useUiStore((state) => state.exportOpen);
  const setExportOpen = useUiStore((state) => state.setExportOpen);
  const showToast = useUiStore((state) => state.showToast);
  const document = useEditorStore((state) => state.document);
  const workspacePath = useEditorStore((state) => state.workspacePath);

  const [presetId, setPresetId] = useState("1080p");
  const [outputPath, setOutputPath] = useState("");
  const [burnIn, setBurnIn] = useState(false);
  const [exportJobId, setExportJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `useRenderStatus` owns the polling cadence and stops once the render is terminal.
  const status = useRenderStatus(exportJobId);

  if (!exportOpen) return null;

  const preset =
    EXPORT_PRESETS_LOCAL.find((candidate) => candidate.id === presetId) ?? EXPORT_PRESETS_LOCAL[0]!;
  const sequence =
    document.sequences.find((candidate) => candidate.isActive) ?? document.sequences[0];
  const terminal = status.data
    ? ["completed", "failed", "canceled"].includes(status.data.status)
    : false;

  const chooseOutput = async (): Promise<void> => {
    const suggested = workspacePath
      ? `${workspacePath}/exports/${document.project.title.replace(/[^\w.-]+/g, "-") || "export"}-${preset.id}.mp4`
      : "export.mp4";
    const dialog = await getBridge().dialogSaveFile({
      defaultPath: suggested,
      filters: [{ name: "MP4 video", extensions: ["mp4"] }],
    });
    if (dialog.canceled || dialog.paths.length === 0) return;
    setOutputPath(dialog.paths[0]!);
  };

  const start = async (): Promise<void> => {
    if (!sequence) {
      setError("There is no active sequence to render.");
      return;
    }
    setStarting(true);
    setError(null);
    setRevealed(false);
    try {
      let destination = outputPath;
      if (!destination) {
        const dialog = await getBridge().dialogSaveFile({
          defaultPath: `${workspacePath ?? "."}/exports/${preset.id}.mp4`,
          filters: [{ name: "MP4 video", extensions: ["mp4"] }],
        });
        if (dialog.canceled || dialog.paths.length === 0) {
          setStarting(false);
          return;
        }
        destination = dialog.paths[0]!;
        setOutputPath(destination);
      }
      const response = await getBridge().renderStart({
        workspacePath: workspacePath ?? "",
        sequenceId: sequence.id,
        presetId: preset.id,
        outputPath: destination,
        burnInCaptions: burnIn,
      });
      setExportJobId(response.exportJobId);
      showToast(`Render queued: ${response.totalFrames} frames.`, "info");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (!exportJobId) return;
    try {
      await getBridge().renderCancel({ exportJobId });
      await status.refetch();
      showToast("Render canceled.", "warn");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const revealInFinder = async (): Promise<void> => {
    const path = status.data?.outputPath ?? outputPath;
    if (!path) return;
    const parent = path.replace(/\/[^/]*$/, "");
    try {
      // `plugin-opener` is the sanctioned way to hand a path to the OS; the renderer never
      // shells out itself (PRD §13).
      const opener = await import("@tauri-apps/plugin-opener");
      await opener.revealItemInDir(path);
      setFinalizing(false);
      setRevealed(true);
      showToast(`Revealed ${parent} in the file manager.`, "info");
    } catch {
      // In the browser mock there is no native opener; say so instead of pretending.
      setFinalizing(true);
      showToast("Reveal in Finder is only available in the native shell.", "warn");
    }
  };

  const progress = status.data?.progress ?? 0;

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Export">
      <div className="dialog dialog--wide">
        <div className="dialog__header">
          <h2 className="dialog__title">Export</h2>
          <button
            type="button"
            className="btn"
            onClick={() => setExportOpen(false)}
            aria-label="Close the export dialog"
          >
            Close
          </button>
        </div>

        <div className="dialog__body">
          <section className="stack">
            <h3 className="section-title">Preset</h3>
            <div className="preset-list" role="group" aria-label="Export preset">
              {EXPORT_PRESETS_LOCAL.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="preset-option"
                  aria-pressed={presetId === option.id}
                  onClick={() => setPresetId(option.id)}
                  disabled={exportJobId !== null && !terminal}
                >
                  <span>{option.label}</span>
                  <span className="small muted mono">
                    {option.width}×{option.height} ·{" "}
                    {option.crf === null ? `${option.videoBitrateKbps} kbps` : `CRF ${option.crf}`}{" "}
                    · H.264/AAC
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="stack">
            <h3 className="section-title">Output</h3>
            <div className="row">
              <input
                className="input"
                value={outputPath}
                placeholder="Choose an output path…"
                aria-label="Output file path"
                onChange={(event) => setOutputPath(event.target.value)}
              />
              <button type="button" className="btn" onClick={() => void chooseOutput()}>
                Choose…
              </button>
            </div>
            <label className="row small">
              <input
                type="checkbox"
                checked={burnIn}
                onChange={(event) => setBurnIn(event.target.checked)}
                disabled={exportJobId !== null && !terminal}
              />
              Burn in captions (uses the caption track at render time)
            </label>
            <p className="small muted">
              Export always renders from the originals at project settings, never from the preview
              proxies (PRD §12). Temp output is written and atomically renamed on success.
            </p>
          </section>

          <section className="stack">
            <h3 className="section-title">Progress</h3>
            <div
              className="progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
              aria-label="Export progress"
            >
              <div
                className={`progress__fill${status.data?.status === "completed" ? " progress__fill--success" : status.data?.status === "failed" ? " progress__fill--danger" : ""}`}
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <p className="small" aria-live="polite">
              {status.data
                ? `${status.data.status} · ${status.data.renderedFrames}/${status.data.totalFrames} frames (${formatPercent(progress)})`
                : "Not started."}
            </p>
            {status.data?.errors?.length ? (
              <p className="callout callout--danger" role="alert">
                {status.data.errors.join(" ")}
              </p>
            ) : null}
            {error ? (
              <p className="callout callout--danger" role="alert">
                {error}
              </p>
            ) : null}
            <pre className="log-tail" aria-label="Encoder log tail">
              {(status.data?.logTail ?? ["Waiting for the renderer…"]).join("\n")}
            </pre>
          </section>
        </div>

        <div className="dialog__footer">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void start()}
            disabled={starting || (exportJobId !== null && !terminal)}
          >
            {starting
              ? "Starting…"
              : exportJobId !== null && !terminal
                ? "Rendering…"
                : "Start render"}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => void cancel()}
            disabled={exportJobId === null || terminal}
          >
            Cancel render
          </button>
          <div className="spacer" />
          {status.data?.status === "completed" ? (
            <>
              <span className="badge badge--success">completed</span>
              <button type="button" className="btn" onClick={() => void revealInFinder()}>
                {finalizing ? "Unavailable here" : revealed ? "Revealed" : "Reveal in Finder"}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
