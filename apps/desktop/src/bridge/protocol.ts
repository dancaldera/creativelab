/**
 * Native IPC protocol — the frozen contract between the React webview and Rust.
 *
 * Both sides must agree on these shapes:
 *   * `StudioBridge` is the TypeScript interface the UI codes against.
 *   * Rust mirrors each request/response as a `serde` struct with matching field names
 *     and `camelCase` renaming.
 *
 * Security rules encoded here (PRD §13):
 *   * The command list is an allowlist. `TauriBridge.invoke` refuses anything else.
 *   * Credentials never appear in a response body: only opaque `credentialRef` handles
 *     and boolean `hasSecret` flags cross the boundary.
 *   * Paths are always workspace-relative where the renderer does not need the absolute
 *     path, and always validated Rust-side before use.
 */

/** Every command the renderer is permitted to call. Rust rejects anything else. */
export const IPC_COMMANDS = [
  "project_create",
  "project_open",
  "project_save",
  "project_close",
  "project_list_recent",
  "project_package",
  "project_backup",
  "workspace_usage",
  "workspace_purge_caches",
  "asset_import",
  "asset_relink",
  "asset_probe",
  "asset_delete",
  "media_thumbnail",
  "media_waveform",
  "media_proxy",
  "render_start",
  "render_cancel",
  "render_status",
  "credential_set",
  "credential_delete",
  "credential_list",
  "credential_test",
  "provider_list_models",
  "provider_catalog_refresh",
  "job_list",
  "job_cancel",
  "job_retry",
  "job_reconcile",
  "dialog_open_file",
  "dialog_open_directory",
  "dialog_save_file",
  "settings_get",
  "settings_set",
] as const;

export type IpcCommand = (typeof IPC_COMMANDS)[number];

// ---------------------------------------------------------------------------
// Shared primitives (structurally mirror @creativelab/core; no cross-import needed)
// ---------------------------------------------------------------------------

export interface FrameRateDto {
  num: number;
  den: number;
}

/** The editable document as it crosses the IPC boundary. */
export interface DocumentDto {
  project: ProjectDto;
  sequences: SequenceDto[];
  tracks: TrackDto[];
  clips: ClipDto[];
  effects: EffectDto[];
  keyframes: KeyframeDto[];
  assets: AssetDto[];
}

export interface ProjectDto {
  id: string;
  schemaVersion: number;
  title: string;
  fps: FrameRateDto;
  width: number;
  height: number;
  colorProfile: string;
  sampleRate: number;
  channels: number;
  workspaceRelPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface SequenceDto {
  id: string;
  projectId: string;
  name: string;
  width: number;
  height: number;
  fps: FrameRateDto;
  durationFrames: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TrackDto {
  id: string;
  sequenceId: string;
  kind: "video" | "audio" | "caption";
  name: string;
  sortOrder: number;
  muted: boolean;
  locked: boolean;
  hidden: boolean;
  solo: boolean;
  volumeDb: number;
  createdAt: string;
  updatedAt: string;
}

export interface ClipDto {
  id: string;
  trackId: string;
  sequenceId: string;
  assetId: string | null;
  label: string;
  startFrame: number;
  sourceInFrame: number;
  durationFrames: number;
  properties: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface EffectDto {
  id: string;
  clipId: string;
  kind: string;
  sortOrder: number;
  enabled: boolean;
  params: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface KeyframeDto {
  id: string;
  effectId: string;
  property: string;
  frame: number;
  value: number | string | boolean;
  easing: string;
  createdAt: string;
}

export interface AssetDto {
  id: string;
  projectId: string;
  mediaType: "video" | "image" | "audio" | "subtitle";
  storageMode: "copied" | "linked" | "generated";
  uri: string;
  relativePath: string | null;
  sha256: string | null;
  bytes: number | null;
  durationFrames: number | null;
  width: number | null;
  height: number | null;
  sampleRate: number | null;
  channels: number | null;
  fps: FrameRateDto | null;
  codec: string | null;
  container: string | null;
  origin: "imported" | "generated" | "derived";
  parentAssetId: string | null;
  generationJobId: string | null;
  promptRevisionId: string | null;
  probe: Record<string, unknown> | null;
  missingAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Requests / responses
// ---------------------------------------------------------------------------

export interface ProjectSummaryDto {
  id: string;
  title: string;
  workspacePath: string;
  updatedAt: string;
  /** True when the media referenced by the project is not all resolvable. */
  hasMissingMedia?: boolean;
}

export interface ProjectCreateRequest {
  title: string;
  fps: FrameRateDto;
  width: number;
  height: number;
  /** Absolute directory chosen by the user; Rust creates the project inside it. */
  workspacePath: string;
  colorProfile?: string;
  sampleRate?: number;
  channels?: 1 | 2;
}

export interface ProjectOpenRequest {
  workspacePath: string;
}

export interface ProjectSessionDto {
  document: DocumentDto;
  workspacePath: string;
  schemaVersion: number;
  /** Non-empty when a crash snapshot is newer than the last save. */
  recovery: RecoveryOfferDto | null;
}

export interface RecoveryOfferDto {
  snapshotPath: string;
  writtenAt: string;
  reason: "periodic" | "before-edit" | "manual";
}

export interface ProjectSaveRequest {
  document: DocumentDto;
}

export interface ProjectSaveResponse {
  savedAt: string;
  schemaVersion: number;
  clips: number;
  tracks: number;
}

export interface ProjectPackageRequest {
  destinationPath: string;
  label?: string;
}

export interface ProjectPackageResponse {
  destination: string;
  files: number;
  bytes: number;
  /** Assets that could not be made portable (linked originals outside the workspace). */
  unresolved: string[];
  portable: boolean;
}

export interface WorkspaceUsageRequest {
  workspacePath: string;
}

export interface DirectoryUsageDto {
  path: string;
  bytes: number;
  files: number;
}

export interface WorkspaceUsageResponse {
  root: string;
  totalBytes: number;
  cacheBytes: number;
  cacheReclaimableBytes: number;
  directories: DirectoryUsageDto[];
}

export interface AssetImportRequest {
  workspacePath: string;
  /** Absolute source paths chosen by the user. */
  sourcePaths: string[];
  /** PRD §9: copy into the project by default; linking is an explicit advanced choice. */
  mode: "copy" | "link";
}

export interface ImportedAssetDto {
  asset: AssetDto;
  /** True when an asset with the same sha256 already existed (FR-02 dedupe). */
  duplicateOf: string | null;
  warnings: string[];
}

export interface AssetImportResponse {
  imported: ImportedAssetDto[];
  errors: Array<{ path: string; message: string }>;
}

export interface MediaThumbnailRequest {
  workspacePath: string;
  assetId: string;
  atSeconds: number;
  width: number;
}

export interface MediaThumbnailResponse {
  /** Workspace-relative path of the generated thumbnail. */
  relativePath: string;
  width: number;
  height: number;
}

export interface MediaWaveformRequest {
  workspacePath: string;
  assetId: string;
  buckets: number;
}

export interface MediaWaveformResponse {
  relativePath: string;
  buckets: number;
  /** Interleaved min/max pairs in [-1, 1]. */
  peaks: number[][];
}

export interface MediaProxyRequest {
  workspacePath: string;
  assetId: string;
  maxWidth: number;
}

export interface MediaProxyResponse {
  relativePath: string;
  width: number;
  height: number;
  bytes: number;
}

export interface RenderStartRequest {
  workspacePath: string;
  sequenceId: string;
  presetId: string;
  outputPath: string;
  burnInCaptions?: boolean;
}

export interface RenderStartResponse {
  exportJobId: string;
  totalFrames: number;
}

export interface RenderStatusRequest {
  workspacePath: string;
  exportJobId: string;
}

export interface RenderStatusResponse {
  exportJobId: string;
  status: "queued" | "preparing" | "rendering" | "finalizing" | "completed" | "failed" | "canceled";
  progress: number;
  renderedFrames: number;
  totalFrames: number;
  /** Last lines of the FFmpeg log, for the export console (FR-09). */
  logTail: string[];
  outputPath: string;
  errors: string[];
}

export interface RenderCancelRequest {
  exportJobId: string;
}

/** Credentials: only handles and flags cross this boundary, never the secret itself. */
export interface CredentialSetRequest {
  providerId: string;
  secret: string;
}

export interface CredentialRefDto {
  providerId: string;
  credentialRef: string;
  hasSecret: boolean;
}

export interface CredentialTestRequest {
  providerId: string;
}

export interface CredentialTestResponse {
  ok: boolean;
  message: string;
  /** Round-trip latency of the credential check, in milliseconds. */
  latencyMs: number | null;
}

export interface ProviderModelDto {
  providerId: string;
  modelId: string;
  displayName: string;
  modality: string;
  capabilities: Record<string, unknown>;
  pricing: Record<string, unknown> | null;
  fetchedAt: string;
  isStale: boolean;
}

export interface ProviderListModelsRequest {
  providerId?: string;
  /** When true, bypass the local catalog cache and hit the provider. */
  refresh?: boolean;
}

export interface ProviderListModelsResponse {
  models: ProviderModelDto[];
  fetchedAt: string;
  errors: Array<{ providerId: string; message: string }>;
}

export interface JobDto {
  id: string;
  providerId: string;
  modelId: string;
  mode: string;
  modality: string;
  status: string;
  progress: number | null;
  providerJobId: string | null;
  retryCount: number;
  costEstimate: { amount: number; currency: string } | null;
  actualCost: { amount: number; currency: string } | null;
  outputAssetIds: string[];
  error: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobListRequest {
  workspacePath: string;
  status?: string[];
  limit?: number;
}

export interface JobListResponse {
  jobs: JobDto[];
}

export interface JobReconcileResponse {
  /** Jobs parked in `unknown` that need a human decision (PRD §12). */
  needsAttention: Array<{ jobId: string; reason: string }>;
  resumed: string[];
}

export interface DialogResultDto {
  paths: string[];
  canceled: boolean;
}

export interface SettingsGetRequest {
  key: string;
}

export interface SettingsGetResponse {
  value: unknown;
}

export interface SettingsSetRequest {
  key: string;
  value: unknown;
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

/**
 * The single privileged surface available to the renderer.
 *
 * `TauriStudioBridge` calls the real commands; `MockStudioBridge` implements the same
 * interface against `@creativelab/core` alone, which is what makes the UI runnable in a
 * plain browser and testable without a native build.
 */
export interface StudioBridge {
  readonly kind: "tauri" | "mock";

  projectCreate(request: ProjectCreateRequest): Promise<ProjectSessionDto>;
  projectOpen(request: ProjectOpenRequest): Promise<ProjectSessionDto>;
  projectSave(request: ProjectSaveRequest): Promise<ProjectSaveResponse>;
  projectClose(): Promise<void>;
  projectListRecent(): Promise<ProjectSummaryDto[]>;
  projectPackage(request: ProjectPackageRequest): Promise<ProjectPackageResponse>;
  projectBackup(request: { workspacePath: string; label?: string }): Promise<{ destination: string; files: number }>;

  workspaceUsage(request: WorkspaceUsageRequest): Promise<WorkspaceUsageResponse>;
  workspacePurgeCaches(request: WorkspaceUsageRequest): Promise<{ purged: string[] }>;

  assetImport(request: AssetImportRequest): Promise<AssetImportResponse>;
  assetRelink(request: { workspacePath: string; assetId: string; newPath: string }): Promise<AssetDto>;
  assetProbe(request: { workspacePath: string; assetId: string }): Promise<AssetDto>;
  assetDelete(request: { workspacePath: string; assetId: string }): Promise<void>;

  mediaThumbnail(request: MediaThumbnailRequest): Promise<MediaThumbnailResponse>;
  mediaWaveform(request: MediaWaveformRequest): Promise<MediaWaveformResponse>;
  mediaProxy(request: MediaProxyRequest): Promise<MediaProxyResponse>;

  renderStart(request: RenderStartRequest): Promise<RenderStartResponse>;
  renderStatus(request: RenderStatusRequest): Promise<RenderStatusResponse>;
  renderCancel(request: RenderCancelRequest): Promise<void>;

  credentialSet(request: CredentialSetRequest): Promise<CredentialRefDto>;
  credentialDelete(request: { providerId: string }): Promise<void>;
  credentialList(): Promise<CredentialRefDto[]>;
  credentialTest(request: CredentialTestRequest): Promise<CredentialTestResponse>;

  providerListModels(request: ProviderListModelsRequest): Promise<ProviderListModelsResponse>;
  providerCatalogRefresh(request: { providerId?: string }): Promise<ProviderListModelsResponse>;

  jobList(request: JobListRequest): Promise<JobListResponse>;
  jobCancel(request: { workspacePath: string; jobId: string }): Promise<void>;
  jobRetry(request: { workspacePath: string; jobId: string }): Promise<void>;
  jobReconcile(request: { workspacePath: string }): Promise<JobReconcileResponse>;

  dialogOpenFile(request: { multiple?: boolean; filters?: FileFilter[] }): Promise<DialogResultDto>;
  dialogOpenDirectory(request?: { title?: string }): Promise<DialogResultDto>;
  dialogSaveFile(request: { defaultPath?: string; filters?: FileFilter[] }): Promise<DialogResultDto>;

  settingsGet(request: SettingsGetRequest): Promise<SettingsGetResponse>;
  settingsSet(request: SettingsSetRequest): Promise<void>;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

/** Media filters reused by both the mock and the native dialog. */
export const IMPORT_FILTERS: FileFilter[] = [
  { name: "Media", extensions: ["mp4", "mov", "webm", "mkv", "m4v", "png", "jpg", "jpeg", "webp", "wav", "mp3", "m4a", "aac", "flac"] },
  { name: "Video", extensions: ["mp4", "mov", "webm", "mkv", "m4v"] },
  { name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] },
  { name: "Audio", extensions: ["wav", "mp3", "m4a", "aac", "flac"] },
];

export const VIDEO_FILTERS: FileFilter[] = [{ name: "MP4 video", extensions: ["mp4"] }];
