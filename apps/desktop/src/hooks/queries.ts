/**
 * TanStack Query wrappers around the `StudioBridge` (PRD §9: "TanStack Query for async
 * state"). Nothing here talks to Tauri or the mock directly — always `getBridge()`.
 *
 * Stale times are chosen per data class:
 *   * models and settings change rarely → minutes,
 *   * the job queue and render/workspace usage are live → seconds,
 *   * assets change only when the user imports or generates → tens of seconds, but the
 *     cache is invalidated explicitly after those mutations.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getBridge } from "../bridge";
import type {
  AssetImportRequest,
  CredentialSetRequest,
  MediaThumbnailRequest,
  MediaWaveformRequest,
  ProjectCreateRequest,
  SettingsSetRequest,
  WorkspaceUsageRequest,
} from "../bridge/protocol";
import { useEditorStore } from "../state/editorStore";

export const queryKeys = {
  bridgeKind: ["bridge", "kind"] as const,
  assets: (workspacePath: string | null) => ["assets", workspacePath] as const,
  jobs: (workspacePath: string | null, statuses: readonly string[] = []) =>
    ["jobs", workspacePath, [...statuses].sort()] as const,
  models: (providerId?: string) => ["models", providerId ?? "all"] as const,
  settings: (key: string) => ["settings", key] as const,
  workspaceUsage: (workspacePath: string | null) => ["workspace-usage", workspacePath] as const,
  credentials: ["credentials"] as const,
  recentProjects: ["projects", "recent"] as const,
  renderStatus: (exportJobId: string | null) => ["render-status", exportJobId] as const,
  thumbnail: (request: MediaThumbnailRequest | null) =>
    ["thumbnail", request?.workspacePath, request?.assetId, request?.atSeconds, request?.width] as const,
  waveform: (request: MediaWaveformRequest | null) => ["waveform", request?.workspacePath, request?.assetId, request?.buckets] as const,
} as const;

/** Workspace path of the open project; `null` before a project exists. */
export function useWorkspacePath(): string | null {
  return useEditorStore((state) => state.workspacePath);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Assets come from the editor document, which already holds the authoritative list for the
 * open project; panels read `document.assets` directly and this key exists so mutations can
 * invalidate the derived media queries as a group.
 */
export function useAssets(): { queryKey: readonly unknown[] } {
  const document = useEditorStore((state) => state.document);
  return { queryKey: queryKeys.assets(document.project.id) };
}

export function useJobs(statuses: readonly string[] = [], enabled = true) {
  const workspacePath = useWorkspacePath();
  return useQuery({
    queryKey: queryKeys.jobs(workspacePath, statuses),
    queryFn: async () => getBridge().jobList({ workspacePath: workspacePath ?? "", status: [...statuses], limit: 100 }),
    enabled: enabled && workspacePath !== null,
    staleTime: 2_000,
    refetchInterval: 3_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
}

export function useJobReconcile(enabled = false) {
  const workspacePath = useWorkspacePath();
  return useQuery({
    queryKey: ["jobs", "reconcile", workspacePath] as const,
    queryFn: async () => getBridge().jobReconcile({ workspacePath: workspacePath ?? "" }),
    enabled: enabled && workspacePath !== null,
    staleTime: 0,
    gcTime: 0,
    retry: 0,
  });
}

export function useModels(providerId?: string) {
  return useQuery({
    queryKey: queryKeys.models(providerId),
    queryFn: async () => getBridge().providerListModels({ providerId }),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });
}

export function useSettings<T>(key: string, fallback: T) {
  return useQuery({
    queryKey: queryKeys.settings(key),
    queryFn: async () => {
      const response = await getBridge().settingsGet({ key });
      return (response.value ?? fallback) as T;
    },
    initialData: fallback,
    staleTime: 60_000,
  });
}

export function useWorkspaceUsage(enabled = true) {
  const workspacePath = useWorkspacePath();
  return useQuery({
    queryKey: queryKeys.workspaceUsage(workspacePath),
    queryFn: async () =>
      getBridge().workspaceUsage({ workspacePath: workspacePath ?? "" } satisfies WorkspaceUsageRequest),
    enabled: enabled && workspacePath !== null,
    staleTime: 15_000,
  });
}

export function useCredentials() {
  return useQuery({
    queryKey: queryKeys.credentials,
    queryFn: async () => getBridge().credentialList(),
    staleTime: 30_000,
  });
}

export function useRecentProjects() {
  return useQuery({
    queryKey: queryKeys.recentProjects,
    queryFn: async () => getBridge().projectListRecent(),
    staleTime: 20_000,
  });
}

/** Short-lived poll for an in-flight export (FR-09 progress + log tail). */
export function useRenderStatus(exportJobId: string | null, enabled = true) {
  const workspacePath = useWorkspacePath();
  return useQuery({
    queryKey: queryKeys.renderStatus(exportJobId),
    queryFn: async () =>
      getBridge().renderStatus({ workspacePath: workspacePath ?? "", exportJobId: exportJobId ?? "" }),
    enabled: enabled && exportJobId !== null,
    staleTime: 0,
    refetchInterval: 700,
    refetchIntervalInBackground: true,
    retry: 0,
  });
}

/**
 * Thumbnails and waveforms are inert derived data: cache them for a long time, never
 * refetch on focus, and key them on the exact request.
 */
export function useThumbnail(request: MediaThumbnailRequest | null) {
  return useQuery({
    queryKey: queryKeys.thumbnail(request),
    queryFn: async () => getBridge().mediaThumbnail(request!),
    enabled: request !== null && request.assetId !== "",
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useWaveform(request: MediaWaveformRequest | null) {
  return useQuery({
    queryKey: queryKeys.waveform(request),
    queryFn: async () => getBridge().mediaWaveform(request!),
    enabled: request !== null && request.assetId !== "",
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useImportAssets() {
  const queryClient = useQueryClient();
  const loadDocument = useEditorStore((state) => state.loadDocument);
  return useMutation({
    mutationFn: async (request: AssetImportRequest) => getBridge().assetImport(request),
    onSuccess: async (response, request) => {
      // The bridge returns the new asset DTOs; fold them into the editor document so the
      // media panel and timeline see them without a project reload.
      const document = useEditorStore.getState().document;
      const assets = [...document.assets];
      for (const entry of response.imported) {
        const existingIndex = assets.findIndex((asset) => asset.id === entry.asset.id);
        const asset = {
          ...entry.asset,
          probe: entry.asset.probe ?? null,
        } as (typeof document.assets)[number];
        if (existingIndex >= 0) assets[existingIndex] = asset;
        else assets.push(asset);
      }
      loadDocument({ ...document, assets }, request.workspacePath);
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
    },
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  const loadDocument = useEditorStore((state) => state.loadDocument);
  return useMutation({
    mutationFn: async (request: ProjectCreateRequest) => getBridge().projectCreate(request),
    onSuccess: async (session) => {
      loadDocument(session.document as never, session.workspacePath);
      await queryClient.invalidateQueries({ queryKey: queryKeys.recentProjects });
    },
  });
}

export function useSaveProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const document = useEditorStore.getState().document;
      return getBridge().projectSave({ document: document as never });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.recentProjects });
    },
  });
}

export function usePurgeCaches() {
  const queryClient = useQueryClient();
  const workspacePath = useWorkspacePath();
  return useMutation({
    mutationFn: async () => getBridge().workspacePurgeCaches({ workspacePath: workspacePath ?? "" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["workspace-usage"] });
    },
  });
}

export function useSetCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: CredentialSetRequest) => getBridge().credentialSet(request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.credentials });
    },
  });
}

export function useDeleteCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (providerId: string) => getBridge().credentialDelete({ providerId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.credentials });
    },
  });
}

export function useTestCredential() {
  return useMutation({
    mutationFn: async (providerId: string) => getBridge().credentialTest({ providerId }),
  });
}

export function useRefreshCatalog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (providerId?: string) => getBridge().providerCatalogRefresh({ providerId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["models"] });
    },
  });
}

export function useSetSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: SettingsSetRequest) => getBridge().settingsSet(request),
    onSuccess: async (_result, request) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings(request.key) });
    },
  });
}

export function useCancelJob() {
  const queryClient = useQueryClient();
  const workspacePath = useWorkspacePath();
  return useMutation({
    mutationFn: async (jobId: string) => getBridge().jobCancel({ workspacePath: workspacePath ?? "", jobId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });
}

export function useRetryJob() {
  const queryClient = useQueryClient();
  const workspacePath = useWorkspacePath();
  return useMutation({
    mutationFn: async (jobId: string) => getBridge().jobRetry({ workspacePath: workspacePath ?? "", jobId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });
}
