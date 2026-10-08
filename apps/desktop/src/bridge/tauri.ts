/**
 * `TauriStudioBridge` — the real IPC implementation of `StudioBridge`.
 *
 * PRD §13 / ARCHITECTURE: "Native IPC is allowlisted". Every call funnels through
 * `#call`, which refuses any command that is not in `IPC_COMMANDS` *before* touching
 * Tauri. That keeps the allowlist enforced on the renderer side too, so a typo or a
 * refactor cannot reach a Rust command the UI was never granted.
 *
 * Dialogs use `@tauri-apps/plugin-dialog` rather than a raw `invoke`, because that is the
 * supported Tauri 2 surface for native file pickers.
 */
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  IPC_COMMANDS,
  type AssetDto,
  type AssetImportRequest,
  type AssetImportResponse,
  type CredentialRefDto,
  type CredentialSetRequest,
  type CredentialTestRequest,
  type CredentialTestResponse,
  type DialogResultDto,
  type FileFilter,
  type IpcCommand,
  type JobListRequest,
  type JobListResponse,
  type JobReconcileResponse,
  type MediaProxyRequest,
  type MediaProxyResponse,
  type MediaThumbnailRequest,
  type MediaThumbnailResponse,
  type MediaWaveformRequest,
  type MediaWaveformResponse,
  type ProjectCreateRequest,
  type ProjectPackageRequest,
  type ProjectPackageResponse,
  type ProjectSaveRequest,
  type ProjectSaveResponse,
  type ProjectSessionDto,
  type ProjectSummaryDto,
  type ProviderListModelsRequest,
  type ProviderListModelsResponse,
  type RenderCancelRequest,
  type RenderStartRequest,
  type RenderStartResponse,
  type RenderStatusRequest,
  type RenderStatusResponse,
  type SettingsGetRequest,
  type SettingsGetResponse,
  type SettingsSetRequest,
  type StudioBridge,
  type WorkspaceUsageRequest,
  type WorkspaceUsageResponse,
} from "./protocol";

const ALLOWED: ReadonlySet<string> = new Set<string>(IPC_COMMANDS);

export class TauriStudioBridge implements StudioBridge {
  readonly kind = "tauri" as const;

  /**
   * The single choke point for every privileged call.
   *
   * The allowlist assertion happens first and unconditionally; a rejected command throws
   * a `TypeError` locally instead of producing a Rust-side error round trip.
   */
  private async call<T>(command: IpcCommand, args?: Record<string, unknown>): Promise<T> {
    if (!ALLOWED.has(command)) {
      throw new TypeError(`IPC command "${String(command)}" is not in the allowlist (PRD §13)`);
    }
    return invoke<T>(command, args);
  }

  // -- projects ------------------------------------------------------------

  projectCreate(request: ProjectCreateRequest): Promise<ProjectSessionDto> {
    return this.call<ProjectSessionDto>("project_create", { request });
  }

  projectOpen(request: { workspacePath: string }): Promise<ProjectSessionDto> {
    return this.call<ProjectSessionDto>("project_open", { request });
  }

  projectSave(request: ProjectSaveRequest): Promise<ProjectSaveResponse> {
    return this.call<ProjectSaveResponse>("project_save", { request });
  }

  projectClose(): Promise<void> {
    return this.call<void>("project_close");
  }

  projectListRecent(): Promise<ProjectSummaryDto[]> {
    return this.call<ProjectSummaryDto[]>("project_list_recent");
  }

  projectPackage(request: ProjectPackageRequest): Promise<ProjectPackageResponse> {
    return this.call<ProjectPackageResponse>("project_package", { request });
  }

  projectBackup(request: { workspacePath: string; label?: string }): Promise<{ destination: string; files: number }> {
    return this.call<{ destination: string; files: number }>("project_backup", { request });
  }

  // -- workspace -----------------------------------------------------------

  workspaceUsage(request: WorkspaceUsageRequest): Promise<WorkspaceUsageResponse> {
    return this.call<WorkspaceUsageResponse>("workspace_usage", { request });
  }

  workspacePurgeCaches(request: WorkspaceUsageRequest): Promise<{ purged: string[] }> {
    return this.call<{ purged: string[] }>("workspace_purge_caches", { request });
  }

  // -- assets --------------------------------------------------------------

  assetImport(request: AssetImportRequest): Promise<AssetImportResponse> {
    return this.call<AssetImportResponse>("asset_import", { request });
  }

  assetRelink(request: { workspacePath: string; assetId: string; newPath: string }): Promise<AssetDto> {
    return this.call<AssetDto>("asset_relink", { request });
  }

  assetProbe(request: { workspacePath: string; assetId: string }): Promise<AssetDto> {
    return this.call<AssetDto>("asset_probe", { request });
  }

  assetDelete(request: { workspacePath: string; assetId: string }): Promise<void> {
    return this.call<void>("asset_delete", { request });
  }

  mediaThumbnail(request: MediaThumbnailRequest): Promise<MediaThumbnailResponse> {
    return this.call<MediaThumbnailResponse>("media_thumbnail", { request });
  }

  mediaWaveform(request: MediaWaveformRequest): Promise<MediaWaveformResponse> {
    return this.call<MediaWaveformResponse>("media_waveform", { request });
  }

  mediaProxy(request: MediaProxyRequest): Promise<MediaProxyResponse> {
    return this.call<MediaProxyResponse>("media_proxy", { request });
  }

  // -- render --------------------------------------------------------------

  renderStart(request: RenderStartRequest): Promise<RenderStartResponse> {
    return this.call<RenderStartResponse>("render_start", { request });
  }

  renderStatus(request: RenderStatusRequest): Promise<RenderStatusResponse> {
    return this.call<RenderStatusResponse>("render_status", { request });
  }

  renderCancel(request: RenderCancelRequest): Promise<void> {
    return this.call<void>("render_cancel", { request });
  }

  // -- credentials ---------------------------------------------------------

  credentialSet(request: CredentialSetRequest): Promise<CredentialRefDto> {
    // The secret travels one way only: request in, ref + hasSecret out.
    return this.call<CredentialRefDto>("credential_set", { request });
  }

  credentialDelete(request: { providerId: string }): Promise<void> {
    return this.call<void>("credential_delete", { request });
  }

  credentialList(): Promise<CredentialRefDto[]> {
    return this.call<CredentialRefDto[]>("credential_list");
  }

  credentialTest(request: CredentialTestRequest): Promise<CredentialTestResponse> {
    return this.call<CredentialTestResponse>("credential_test", { request });
  }

  // -- provider catalog ----------------------------------------------------

  providerListModels(request: ProviderListModelsRequest): Promise<ProviderListModelsResponse> {
    return this.call<ProviderListModelsResponse>("provider_list_models", { request });
  }

  providerCatalogRefresh(request: { providerId?: string }): Promise<ProviderListModelsResponse> {
    return this.call<ProviderListModelsResponse>("provider_catalog_refresh", { request });
  }

  // -- jobs ----------------------------------------------------------------

  jobList(request: JobListRequest): Promise<JobListResponse> {
    return this.call<JobListResponse>("job_list", { request });
  }

  jobCancel(request: { workspacePath: string; jobId: string }): Promise<void> {
    return this.call<void>("job_cancel", { request });
  }

  jobRetry(request: { workspacePath: string; jobId: string }): Promise<void> {
    return this.call<void>("job_retry", { request });
  }

  jobReconcile(request: { workspacePath: string }): Promise<JobReconcileResponse> {
    return this.call<JobReconcileResponse>("job_reconcile", { request });
  }

  // -- dialogs -------------------------------------------------------------

  async dialogOpenFile(request: { multiple?: boolean; filters?: FileFilter[] }): Promise<DialogResultDto> {
    const selection = await openDialog({
      multiple: request.multiple ?? false,
      directory: false,
      filters: request.filters,
    });
    return normalizeDialogResult(selection);
  }

  async dialogOpenDirectory(request?: { title?: string }): Promise<DialogResultDto> {
    const selection = await openDialog({ directory: true, multiple: false, title: request?.title });
    return normalizeDialogResult(selection);
  }

  async dialogSaveFile(request: { defaultPath?: string; filters?: FileFilter[] }): Promise<DialogResultDto> {
    const selection = await saveDialog({ defaultPath: request.defaultPath, filters: request.filters });
    return selection ? { paths: [selection], canceled: false } : { paths: [], canceled: true };
  }

  // -- settings ------------------------------------------------------------

  settingsGet(request: SettingsGetRequest): Promise<SettingsGetResponse> {
    return this.call<SettingsGetResponse>("settings_get", { request });
  }

  settingsSet(request: SettingsSetRequest): Promise<void> {
    return this.call<void>("settings_set", { request });
  }
}

/** Tauri may return `string | string[] | null`; normalize to the frozen DTO. */
function normalizeDialogResult(selection: string | string[] | null): DialogResultDto {
  if (selection === null) return { paths: [], canceled: true };
  return { paths: Array.isArray(selection) ? selection : [selection], canceled: false };
}
