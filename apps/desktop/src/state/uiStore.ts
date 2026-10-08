/**
 * UI shell state: rail, panel visibility, splitters, workspace layouts.
 *
 * Persistence goes through the bridge's `settings_get` / `settings_set` pair rather than
 * `localStorage`, so the same layout follows the user between the webview and the native
 * shell, and nothing is written to disk by the renderer (PRD §13: privileged I/O is
 * allowlisted IPC only).
 */
import { create } from "zustand";

export const UI_SETTINGS_KEY = "ui.workspace.v1";

export type RailPanelId = "media" | "generate" | "audio" | "captions" | "templates" | "projects";

export const RAIL_PANELS: ReadonlyArray<{ id: RailPanelId; label: string; hint: string }> = [
  { id: "media", label: "Media", hint: "Library, import and provenance" },
  { id: "generate", label: "Generate", hint: "Image, video and audio generation" },
  { id: "audio", label: "Audio", hint: "Narration and voice revisions" },
  { id: "captions", label: "Captions", hint: "Transcript segments and SRT" },
  { id: "templates", label: "Templates", hint: "Reusable scenes and looks" },
  { id: "projects", label: "Projects", hint: "Recent projects and storage" },
];

export interface PanelVisibility {
  leftRail: boolean;
  inspector: boolean;
  timeline: boolean;
  storyboard: boolean;
}

export interface PanelSizes {
  /** px */
  leftRail: number;
  /** px */
  inspector: number;
  /** px */
  timeline: number;
}

export interface WorkspaceLayout {
  id: string;
  name: string;
  activePanel: RailPanelId;
  visibility: PanelVisibility;
  sizes: PanelSizes;
  savedAt: string;
}

export interface UiState {
  activePanel: RailPanelId;
  visibility: PanelVisibility;
  sizes: PanelSizes;
  layouts: WorkspaceLayout[];
  hydrated: boolean;
  saving: boolean;
  lastSavedAt: string | null;
  /** Whole-window overlay. */
  storyboardOpen: boolean;
  settingsOpen: boolean;
  exportOpen: boolean;
  jobsOpen: boolean;
  /** Non-null while a crash snapshot is on offer (PRD §14 recovery). */
  recoveryNotice: string | null;
  reducedMotion: boolean;
  toast: { message: string; tone: "info" | "warn" | "error" } | null;

  hydrate: (patch: Partial<PersistedUiState>) => void;
  setActivePanel: (panel: RailPanelId) => void;
  togglePanel: (panel: keyof PanelVisibility) => void;
  setPanelVisible: (panel: keyof PanelVisibility, visible: boolean) => void;
  setSize: (panel: keyof PanelSizes, pixels: number) => void;
  setStoryboardOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setExportOpen: (open: boolean) => void;
  setJobsOpen: (open: boolean) => void;
  setReducedMotion: (enabled: boolean) => void;
  setRecoveryNotice: (notice: string | null) => void;
  showToast: (message: string, tone?: "info" | "warn" | "error") => void;
  clearToast: () => void;

  saveLayout: (name: string) => WorkspaceLayout;
  applyLayout: (id: string) => void;
  deleteLayout: (id: string) => void;
  markSaving: (saving: boolean, savedAt?: string) => void;
  snapshot: () => PersistedUiState;
}

export interface PersistedUiState {
  activePanel: RailPanelId;
  visibility: PanelVisibility;
  sizes: PanelSizes;
  layouts: WorkspaceLayout[];
  reducedMotion: boolean;
}

const DEFAULT_VISIBILITY: PanelVisibility = {
  leftRail: true,
  inspector: true,
  timeline: true,
  storyboard: false,
};

const DEFAULT_SIZES: PanelSizes = { leftRail: 320, inspector: 340, timeline: 280 };

export const PANEL_LIMITS: Readonly<Record<keyof PanelSizes, { min: number; max: number }>> = {
  leftRail: { min: 220, max: 560 },
  inspector: { min: 240, max: 620 },
  timeline: { min: 160, max: 720 },
};

function clampSize(panel: keyof PanelSizes, pixels: number): number {
  const { min, max } = PANEL_LIMITS[panel];
  if (!Number.isFinite(pixels)) return DEFAULT_SIZES[panel];
  return Math.min(Math.max(Math.round(pixels), min), max);
}

export function sanitizePersisted(raw: unknown): Partial<PersistedUiState> {
  if (!raw || typeof raw !== "object") return {};
  const record = raw as Record<string, unknown>;
  const patch: Partial<PersistedUiState> = {};

  const panel = record["activePanel"];
  if (typeof panel === "string" && RAIL_PANELS.some((candidate) => candidate.id === panel)) {
    patch.activePanel = panel as RailPanelId;
  }

  const visibility = record["visibility"];
  if (visibility && typeof visibility === "object") {
    const source = visibility as Record<string, unknown>;
    patch.visibility = {
      leftRail: source["leftRail"] !== false,
      inspector: source["inspector"] !== false,
      timeline: source["timeline"] !== false,
      storyboard: source["storyboard"] === true,
    };
  }

  const sizes = record["sizes"];
  if (sizes && typeof sizes === "object") {
    const source = sizes as Record<string, unknown>;
    patch.sizes = {
      leftRail: clampSize("leftRail", Number(source["leftRail"] ?? DEFAULT_SIZES.leftRail)),
      inspector: clampSize("inspector", Number(source["inspector"] ?? DEFAULT_SIZES.inspector)),
      timeline: clampSize("timeline", Number(source["timeline"] ?? DEFAULT_SIZES.timeline)),
    };
  }

  if (Array.isArray(record["layouts"])) {
    patch.layouts = (record["layouts"] as unknown[])
      .filter((entry): entry is WorkspaceLayout => Boolean(entry) && typeof entry === "object" && typeof (entry as WorkspaceLayout).id === "string")
      .map((entry) => ({
        ...entry,
        visibility: { ...DEFAULT_VISIBILITY, ...(entry.visibility ?? {}) },
        sizes: {
          leftRail: clampSize("leftRail", Number(entry.sizes?.leftRail ?? DEFAULT_SIZES.leftRail)),
          inspector: clampSize("inspector", Number(entry.sizes?.inspector ?? DEFAULT_SIZES.inspector)),
          timeline: clampSize("timeline", Number(entry.sizes?.timeline ?? DEFAULT_SIZES.timeline)),
        },
      }));
  }

  if (typeof record["reducedMotion"] === "boolean") patch.reducedMotion = record["reducedMotion"];

  return patch;
}

export function createUiStore() {
  return create<UiState>((set, get) => ({
    activePanel: "media",
    visibility: { ...DEFAULT_VISIBILITY },
    sizes: { ...DEFAULT_SIZES },
    layouts: [],
    hydrated: false,
    saving: false,
    lastSavedAt: null,
    storyboardOpen: false,
    settingsOpen: false,
    exportOpen: false,
    jobsOpen: false,
    recoveryNotice: null,
    reducedMotion: false,
    toast: null,

    hydrate: (patch) =>
      set({
        ...patch,
        visibility: patch.visibility ? { ...patch.visibility } : get().visibility,
        sizes: patch.sizes ? { ...patch.sizes } : get().sizes,
        hydrated: true,
      }),

    setActivePanel: (activePanel) => set({ activePanel }),

    togglePanel: (panel) => set({ visibility: { ...get().visibility, [panel]: !get().visibility[panel] } }),

    setPanelVisible: (panel, visible) => set({ visibility: { ...get().visibility, [panel]: visible } }),

    setSize: (panel, pixels) => set({ sizes: { ...get().sizes, [panel]: clampSize(panel, pixels) } }),

    setStoryboardOpen: (storyboardOpen) => set({ storyboardOpen }),
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    setExportOpen: (exportOpen) => set({ exportOpen }),
    setJobsOpen: (jobsOpen) => set({ jobsOpen }),
    setReducedMotion: (reducedMotion) => set({ reducedMotion }),
    setRecoveryNotice: (recoveryNotice) => set({ recoveryNotice }),
    showToast: (message, tone = "info") => set({ toast: { message, tone } }),
    clearToast: () => set({ toast: null }),

    saveLayout: (name) => {
      const layout: WorkspaceLayout = {
        id: `layout-${Date.now().toString(36)}`,
        name: name.trim() || `Layout ${get().layouts.length + 1}`,
        activePanel: get().activePanel,
        visibility: { ...get().visibility },
        sizes: { ...get().sizes },
        savedAt: new Date().toISOString(),
      };
      set({ layouts: [...get().layouts.filter((entry) => entry.name !== layout.name), layout] });
      return layout;
    },

    applyLayout: (id) =>
      set((state) => {
        const layout = state.layouts.find((entry) => entry.id === id);
        if (!layout) return state;
        return {
          activePanel: layout.activePanel,
          visibility: { ...layout.visibility },
          sizes: { ...layout.sizes },
        };
      }),

    deleteLayout: (id) => set({ layouts: get().layouts.filter((entry) => entry.id !== id) }),

    markSaving: (saving, savedAt) =>
      set({ saving, lastSavedAt: savedAt === undefined ? get().lastSavedAt : savedAt }),

    snapshot: () => {
      const state = get();
      return {
        activePanel: state.activePanel,
        visibility: { ...state.visibility },
        sizes: { ...state.sizes },
        layouts: state.layouts.map((layout) => ({ ...layout })),
        reducedMotion: state.reducedMotion,
      };
    },
  }));
}

export const useUiStore = createUiStore();
