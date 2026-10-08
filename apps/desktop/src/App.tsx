/**
 * `App` — composition root.
 *
 * Responsibilities, and nothing else:
 *   * choose the bridge (native vs. mock) and report which one is live,
 *   * restore the persisted UI layout and the startup recovery offer,
 *   * wire the keyboard shortcut layer,
 *   * mount the shell with its five regions plus the global overlays.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBridge } from "./bridge";
import type { RecoveryOfferDto } from "./bridge/protocol";
import { AppShell } from "./components/AppShell";
import { ExportDialog } from "./components/ExportDialog";
import { Inspector } from "./components/Inspector";
import { JobsPanel } from "./components/JobsPanel";
import { LeftRail } from "./components/LeftRail";
import { PreviewCanvas } from "./components/PreviewCanvas";
import { RecoveryBanner } from "./components/RecoveryBanner";
import { SettingsDialog } from "./components/SettingsDialog";
import { StoryboardView } from "./components/StoryboardView";
import { Timeline } from "./components/Timeline";
import { Toolbar } from "./components/Toolbar";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useSaveProject, useSettings } from "./hooks/queries";
import { useEditorStore } from "./state/editorStore";
import {
  UI_SETTINGS_KEY,
  sanitizePersisted,
  useUiStore,
  type PersistedUiState,
} from "./state/uiStore";

export function App() {
  const reducedMotion = useUiStore((state) => state.reducedMotion);
  const hydrate = useUiStore((state) => state.hydrate);
  const snapshot = useUiStore((state) => state.snapshot);
  const markSaving = useUiStore((state) => state.markSaving);
  const visibility = useUiStore((state) => state.visibility);
  const sizes = useUiStore((state) => state.sizes);
  const layouts = useUiStore((state) => state.layouts);
  const storyboardOpen = useUiStore((state) => state.storyboardOpen);
  const recoveryNotice = useUiStore((state) => state.recoveryNotice);
  const setRecoveryNotice = useUiStore((state) => state.setRecoveryNotice);
  const toast = useUiStore((state) => state.toast);
  const clearToast = useUiStore((state) => state.clearToast);
  const showToast = useUiStore((state) => state.showToast);

  const loadDocument = useEditorStore((state) => state.loadDocument);
  const lastError = useEditorStore((state) => state.lastError);
  const setError = useEditorStore((state) => state.setError);

  const saveProject = useSaveProject();
  const persistedSettings = useSettings<Partial<PersistedUiState> | null>(UI_SETTINGS_KEY, null);

  const [recoveryOffer, setRecoveryOffer] = useState<RecoveryOfferDto | null>(null);
  const workspacePathRef = useRef<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const hydratedRef = useRef(false);

  useKeyboardShortcuts(true);

  // -- restore the persisted layout ----------------------------------------
  useEffect(() => {
    if (persistedSettings.data && !hydratedRef.current) {
      hydratedRef.current = true;
      hydrate(sanitizePersisted(persistedSettings.data));
    }
  }, [hydrate, persistedSettings.data]);

  const persist = useCallback(async () => {
    markSaving(true);
    try {
      await getBridge().settingsSet({ key: UI_SETTINGS_KEY, value: snapshot() });
      markSaving(false, new Date().toISOString());
    } catch (error) {
      markSaving(false);
      showToast(
        `Could not save the layout: ${error instanceof Error ? error.message : String(error)}`,
        "warn",
      );
    }
  }, [markSaving, showToast, snapshot]);

  // Debounced: a splitter drag must not write once per pointer move.
  useEffect(() => {
    if (!hydratedRef.current) return undefined;
    const timer = window.setTimeout(() => {
      void persist();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [layouts, persist, reducedMotion, sizes, visibility]);

  // Reflect the reduced-motion preference on the root element so CSS can react to it.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset["reducedMotion"] = reducedMotion ? "true" : "false";
  }, [reducedMotion]);

  // -- startup: open (or create) a project and check for a recovery offer ----
  useEffect(() => {
    let cancelled = false;
    const bootstrap = async (): Promise<void> => {
      const bridge = getBridge();
      try {
        const session = await bridge.projectOpen({
          workspacePath: "/Users/studio/CreativeLab/Demo Project",
        });
        if (cancelled) return;
        workspacePathRef.current = session.workspacePath;
        loadDocument(session.document as never, session.workspacePath);
        if (session.recovery) {
          setRecoveryOffer(session.recovery);
          setRecoveryNotice(session.recovery.snapshotPath);
        }
      } catch (error) {
        if (cancelled) return;
        const fallback = await bridge.projectCreate({
          title: "Untitled Project",
          fps: { num: 30, den: 1 },
          width: 1920,
          height: 1080,
          workspacePath: "/Users/studio/CreativeLab/Untitled",
        });
        workspacePathRef.current = fallback.workspacePath;
        loadDocument(fallback.document as never, fallback.workspacePath);
        showToast(
          `Started a new project (${error instanceof Error ? error.message : String(error)}).`,
          "info",
        );
      }
    };
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [loadDocument, setRecoveryNotice, showToast]);

  // -- toast auto-dismiss ---------------------------------------------------
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => clearToast(), 4200);
    return () => window.clearTimeout(timer);
  }, [clearToast, toast]);

  const onSave = useCallback(async () => {
    try {
      const response = await saveProject.mutateAsync();
      setLastSavedAt(response.savedAt);
      showToast(`Saved ${response.clips} clips across ${response.tracks} tracks.`, "info");
    } catch (error) {
      showToast(`Save failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }, [saveProject, showToast]);

  const onOpen = useCallback(async () => {
    const dialog = await getBridge().dialogOpenDirectory({ title: "Open a project workspace" });
    if (dialog.canceled || dialog.paths.length === 0) return;
    try {
      const session = await getBridge().projectOpen({ workspacePath: dialog.paths[0]! });
      workspacePathRef.current = session.workspacePath;
      loadDocument(session.document as never, session.workspacePath);
      setRecoveryOffer(session.recovery);
      showToast(`Opened ${session.workspacePath}.`, "info");
    } catch (error) {
      showToast(
        `Could not open the project: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }, [loadDocument, showToast]);

  const onPackage = useCallback(async () => {
    const workspacePath = useEditorStore.getState().workspacePath;
    if (!workspacePath) {
      showToast("Open a project before packaging.", "warn");
      return;
    }
    const dialog = await getBridge().dialogSaveFile({
      defaultPath: `${workspacePath}/exports/project-package.zip`,
    });
    if (dialog.canceled || dialog.paths.length === 0) return;
    const response = await getBridge().projectPackage({ destinationPath: dialog.paths[0]! });
    showToast(
      `Packaged ${response.files} files (portable: ${response.portable ? "yes" : "no"}).`,
      response.portable ? "info" : "warn",
    );
  }, [showToast]);

  const preview = useMemo(() => <PreviewCanvas />, []);

  return (
    <>
      {recoveryOffer ? (
        <RecoveryBanner
          offer={recoveryOffer}
          onRecover={async () => {
            // Recovery is explicit and goes through the bridge: the native side is the only
            // thing that can read the snapshot, so we re-open the session and take whatever it
            // reports. A stale snapshot is never applied silently.
            const workspacePath = workspacePathRef.current;
            try {
              if (workspacePath) {
                const session = await getBridge().projectOpen({ workspacePath });
                loadDocument(session.document as never, session.workspacePath);
                const recovered = session.recovery ?? recoveryOffer;
                showToast(
                  `Recovered the ${recovered.reason} snapshot from ${new Date(recovered.writtenAt).toLocaleTimeString()}.`,
                  "info",
                );
              }
            } catch (error) {
              showToast(
                `Could not recover the snapshot: ${error instanceof Error ? error.message : String(error)}`,
                "error",
              );
            } finally {
              setRecoveryOffer(null);
              setRecoveryNotice(null);
            }
          }}
          onDiscard={async () => {
            setRecoveryOffer(null);
            setRecoveryNotice(null);
            showToast("Discarded the crash snapshot.", "warn");
          }}
        />
      ) : null}

      <AppShell
        toolbar={
          <Toolbar
            onSave={() => void onSave()}
            onOpen={() => void onOpen()}
            onPackage={() => void onPackage()}
            saving={saveProject.isPending}
            lastSavedAt={lastSavedAt}
          />
        }
        rail={<LeftRail />}
        preview={
          storyboardOpen ? (
            <div style={{ overflow: "auto", height: "100%" }}>
              <StoryboardView />
            </div>
          ) : (
            preview
          )
        }
        inspector={<Inspector />}
        timeline={<Timeline />}
      />

      <JobsPanel />
      <ExportDialog />
      <SettingsDialog />

      {lastError ? (
        <p className="toast toast--error" role="alert">
          {lastError}
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setError(null)}
            aria-label="Dismiss the error"
          >
            ✕
          </button>
        </p>
      ) : null}

      {toast ? (
        <p
          className={`toast${toast.tone === "warn" ? " toast--warn" : toast.tone === "error" ? " toast--error" : ""}`}
          role="status"
          aria-live="polite"
        >
          {toast.message}
          {recoveryNotice ? (
            <span className="sr-only"> Recovery snapshot available at {recoveryNotice}.</span>
          ) : null}
        </p>
      ) : null}
    </>
  );
}
