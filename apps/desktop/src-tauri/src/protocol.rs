//! Rust mirror of `apps/desktop/src/bridge/protocol.ts` (**FROZEN**).
//!
//! Every struct here is field-for-field identical to the TypeScript interface of the same
//! name, with `#[serde(rename_all = "camelCase")]` bridging the SQL-style snake_case used
//! internally. Optional fields are `Option<T>` and are *omitted* when `None` so the
//! renderer sees exactly the shape `protocol.ts` declares (`field?: T`), not `null`.
//!
//! Do not add a field here without adding it to `protocol.ts`: the other engineer is
//! coding the TypeScript side against that file.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrameRateDto {
    pub num: i64,
    pub den: i64,
}

impl FrameRateDto {
    pub fn new(num: i64, den: i64) -> Self {
        Self { num, den }
    }

    /// `num / den`, guarded against a zero denominator.
    pub fn as_f64(self) -> f64 {
        if self.den == 0 {
            0.0
        } else {
            self.num as f64 / self.den as f64
        }
    }

    /// Frames -> seconds, using the exact rational (never a rounded fps).
    pub fn frames_to_seconds(self, frames: i64) -> f64 {
        if self.num == 0 {
            0.0
        } else {
            frames as f64 * self.den as f64 / self.num as f64
        }
    }

    /// Seconds -> frames, rounding to nearest.
    pub fn seconds_to_frames(self, seconds: f64) -> i64 {
        if self.den == 0 {
            return 0;
        }
        (seconds * self.num as f64 / self.den as f64).round() as i64
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDto {
    pub id: String,
    pub schema_version: i64,
    pub title: String,
    pub fps: FrameRateDto,
    pub width: i64,
    pub height: i64,
    pub color_profile: String,
    pub sample_rate: i64,
    pub channels: i64,
    pub workspace_rel_path: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceDto {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub width: i64,
    pub height: i64,
    pub fps: FrameRateDto,
    pub duration_frames: i64,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackDto {
    pub id: String,
    pub sequence_id: String,
    /// `"video" | "audio" | "caption"`.
    pub kind: String,
    pub name: String,
    pub sort_order: i64,
    pub muted: bool,
    pub locked: bool,
    pub hidden: bool,
    pub solo: bool,
    pub volume_db: f64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipDto {
    pub id: String,
    pub track_id: String,
    pub sequence_id: String,
    pub asset_id: Option<String>,
    pub label: String,
    pub start_frame: i64,
    pub source_in_frame: i64,
    pub duration_frames: i64,
    /// Free-form clip properties (`transform`, `crop`, `audio`, `speed`, …).
    pub properties: serde_json::Value,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectDto {
    pub id: String,
    pub clip_id: String,
    pub kind: String,
    pub sort_order: i64,
    pub enabled: bool,
    pub params: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyframeDto {
    pub id: String,
    pub effect_id: String,
    pub property: String,
    pub frame: i64,
    pub value: serde_json::Value,
    pub easing: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDto {
    pub id: String,
    pub project_id: String,
    /// `"video" | "image" | "audio" | "subtitle"`.
    pub media_type: String,
    /// `"copied" | "linked" | "generated"`.
    pub storage_mode: String,
    pub uri: String,
    pub relative_path: Option<String>,
    pub sha256: Option<String>,
    pub bytes: Option<i64>,
    pub duration_frames: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub sample_rate: Option<i64>,
    pub channels: Option<i64>,
    pub fps: Option<FrameRateDto>,
    pub codec: Option<String>,
    pub container: Option<String>,
    /// `"imported" | "generated" | "derived"`.
    pub origin: String,
    pub parent_asset_id: Option<String>,
    pub generation_job_id: Option<String>,
    pub prompt_revision_id: Option<String>,
    pub probe: Option<serde_json::Value>,
    pub missing_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDto {
    pub project: ProjectDto,
    pub sequences: Vec<SequenceDto>,
    pub tracks: Vec<TrackDto>,
    pub clips: Vec<ClipDto>,
    pub effects: Vec<EffectDto>,
    pub keyframes: Vec<KeyframeDto>,
    pub assets: Vec<AssetDto>,
}

// ---------------------------------------------------------------------------
// Project / workspace
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummaryDto {
    pub id: String,
    pub title: String,
    pub workspace_path: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_missing_media: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreateRequest {
    pub title: String,
    pub fps: FrameRateDto,
    pub width: i64,
    pub height: i64,
    /// Absolute directory chosen by the user; Rust creates the project inside it.
    pub workspace_path: String,
    #[serde(default)]
    pub color_profile: Option<String>,
    #[serde(default)]
    pub sample_rate: Option<i64>,
    #[serde(default)]
    pub channels: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOpenRequest {
    pub workspace_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSaveRequest {
    pub document: DocumentDto,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSaveResponse {
    pub saved_at: String,
    pub schema_version: i64,
    pub clips: i64,
    pub tracks: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryOfferDto {
    pub snapshot_path: String,
    pub written_at: String,
    /// `"periodic" | "before-edit" | "manual"`.
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSessionDto {
    pub document: DocumentDto,
    pub workspace_path: String,
    pub schema_version: i64,
    pub recovery: Option<RecoveryOfferDto>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPackageRequest {
    pub destination_path: String,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPackageResponse {
    pub destination: String,
    pub files: i64,
    pub bytes: i64,
    /// Assets that could not be made portable (linked originals outside the workspace).
    pub unresolved: Vec<String>,
    pub portable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBackupRequest {
    pub workspace_path: String,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBackupResponse {
    pub destination: String,
    pub files: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUsageRequest {
    pub workspace_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryUsageDto {
    pub path: String,
    pub bytes: i64,
    pub files: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUsageResponse {
    pub root: String,
    pub total_bytes: i64,
    pub cache_bytes: i64,
    pub cache_reclaimable_bytes: i64,
    pub directories: Vec<DirectoryUsageDto>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePurgeResponse {
    pub purged: Vec<String>,
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetImportRequest {
    pub workspace_path: String,
    /// Absolute source paths chosen by the user.
    pub source_paths: Vec<String>,
    /// `"copy" | "link"`.
    pub mode: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAssetDto {
    pub asset: AssetDto,
    /// Set when an asset with the same sha256 already existed (FR-02 dedupe).
    pub duplicate_of: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetImportError {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetImportResponse {
    pub imported: Vec<ImportedAssetDto>,
    pub errors: Vec<AssetImportError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRelinkRequest {
    pub workspace_path: String,
    pub asset_id: String,
    pub new_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetIdRequest {
    pub workspace_path: String,
    pub asset_id: String,
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaThumbnailRequest {
    pub workspace_path: String,
    pub asset_id: String,
    pub at_seconds: f64,
    pub width: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaThumbnailResponse {
    /// Workspace-relative path of the generated thumbnail.
    pub relative_path: String,
    pub width: i64,
    pub height: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaWaveformRequest {
    pub workspace_path: String,
    pub asset_id: String,
    pub buckets: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaWaveformResponse {
    pub relative_path: String,
    pub buckets: i64,
    /// Interleaved `[min, max]` pairs in `[-1, 1]`.
    pub peaks: Vec<Vec<f64>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProxyRequest {
    pub workspace_path: String,
    pub asset_id: String,
    pub max_width: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProxyResponse {
    pub relative_path: String,
    pub width: i64,
    pub height: i64,
    pub bytes: i64,
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderStartRequest {
    pub workspace_path: String,
    pub sequence_id: String,
    pub preset_id: String,
    pub output_path: String,
    #[serde(default)]
    pub burn_in_captions: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderStartResponse {
    pub export_job_id: String,
    pub total_frames: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderStatusRequest {
    pub workspace_path: String,
    pub export_job_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RenderStatus {
    Queued,
    Preparing,
    Rendering,
    Finalizing,
    Completed,
    Failed,
    Canceled,
}

impl RenderStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RenderStatus::Queued => "queued",
            RenderStatus::Preparing => "preparing",
            RenderStatus::Rendering => "rendering",
            RenderStatus::Finalizing => "finalizing",
            RenderStatus::Completed => "completed",
            RenderStatus::Failed => "failed",
            RenderStatus::Canceled => "canceled",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "queued" => Some(RenderStatus::Queued),
            "preparing" => Some(RenderStatus::Preparing),
            "rendering" => Some(RenderStatus::Rendering),
            "finalizing" => Some(RenderStatus::Finalizing),
            "completed" => Some(RenderStatus::Completed),
            "failed" => Some(RenderStatus::Failed),
            "canceled" => Some(RenderStatus::Canceled),
            _ => None,
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            RenderStatus::Completed | RenderStatus::Failed | RenderStatus::Canceled
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderStatusResponse {
    pub export_job_id: String,
    pub status: RenderStatus,
    pub progress: f64,
    pub rendered_frames: i64,
    pub total_frames: i64,
    /// Last lines of the FFmpeg log, for the export console (FR-09).
    pub log_tail: Vec<String>,
    pub output_path: String,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderCancelRequest {
    pub export_job_id: String,
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSetRequest {
    pub provider_id: String,
    pub secret: String,
}

/// Only handles and flags cross this boundary — never the secret itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRefDto {
    pub provider_id: String,
    pub credential_ref: String,
    pub has_secret: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialProviderRequest {
    pub provider_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialTestRequest {
    pub provider_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialTestResponse {
    pub ok: bool,
    pub message: String,
    /// Round-trip latency of the credential check, in milliseconds.
    pub latency_ms: Option<i64>,
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelDto {
    pub provider_id: String,
    pub model_id: String,
    pub display_name: String,
    pub modality: String,
    pub capabilities: serde_json::Value,
    pub pricing: Option<serde_json::Value>,
    pub fetched_at: String,
    pub is_stale: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderListModelsRequest {
    #[serde(default)]
    pub provider_id: Option<String>,
    /// When true, bypass the local catalog cache and hit the provider.
    #[serde(default)]
    pub refresh: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderErrorDto {
    pub provider_id: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderListModelsResponse {
    pub models: Vec<ProviderModelDto>,
    pub fetched_at: String,
    pub errors: Vec<ProviderErrorDto>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalogRefreshRequest {
    #[serde(default)]
    pub provider_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendDto {
    pub amount: f64,
    pub currency: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDto {
    pub id: String,
    pub provider_id: String,
    pub model_id: String,
    pub mode: String,
    pub modality: String,
    pub status: String,
    pub progress: Option<f64>,
    pub provider_job_id: Option<String>,
    pub retry_count: i64,
    pub cost_estimate: Option<SpendDto>,
    pub actual_cost: Option<SpendDto>,
    pub output_asset_ids: Vec<String>,
    pub error: Option<serde_json::Value>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobListRequest {
    pub workspace_path: String,
    #[serde(default)]
    pub status: Option<Vec<String>>,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobListResponse {
    pub jobs: Vec<JobDto>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobIdRequest {
    pub workspace_path: String,
    pub job_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobWorkspaceRequest {
    pub workspace_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobAttentionDto {
    pub job_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobReconcileResponse {
    /// Jobs parked in `unknown` that need a human decision (PRD §12).
    pub needs_attention: Vec<JobAttentionDto>,
    pub resumed: Vec<String>,
}

// ---------------------------------------------------------------------------
// Dialogs / settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogOpenFileRequest {
    #[serde(default)]
    pub multiple: Option<bool>,
    #[serde(default)]
    pub filters: Option<Vec<FileFilter>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogOpenDirectoryRequest {
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogSaveFileRequest {
    #[serde(default)]
    pub default_path: Option<String>,
    #[serde(default)]
    pub filters: Option<Vec<FileFilter>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogResultDto {
    pub paths: Vec<String>,
    pub canceled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsGetRequest {
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsGetResponse {
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSetRequest {
    pub key: String,
    pub value: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_rate_conversion_uses_the_exact_rational() {
        // 30000/1001 ("29.97") must not round to 30.
        let rate = FrameRateDto::new(30_000, 1001);
        assert_eq!(rate.frames_to_seconds(30_000), 1001.0);
        assert_eq!(rate.seconds_to_frames(1001.0), 30_000);
        assert!((rate.as_f64() - 29.970_029_97).abs() < 1e-6);
        assert_eq!(FrameRateDto::new(25, 1).frames_to_seconds(50), 2.0);
        assert_eq!(FrameRateDto::new(0, 1).frames_to_seconds(50), 0.0);
    }

    #[test]
    fn every_dto_round_trips_through_camel_case_json() {
        let project = ProjectDto {
            id: "prj_1".into(),
            schema_version: 1,
            title: "Demo".into(),
            fps: FrameRateDto::new(24, 1),
            width: 1920,
            height: 1080,
            color_profile: "bt709".into(),
            sample_rate: 48_000,
            channels: 2,
            workspace_rel_path: ".".into(),
            created_at: "2024-01-01T00:00:00.000Z".into(),
            updated_at: "2024-01-01T00:00:00.000Z".into(),
        };
        let value = serde_json::to_value(&project).unwrap();
        for key in [
            "schemaVersion",
            "colorProfile",
            "sampleRate",
            "workspaceRelPath",
            "createdAt",
            "updatedAt",
        ] {
            assert!(value.get(key).is_some(), "missing {key} in {value}");
        }
        let back: ProjectDto = serde_json::from_value(value).unwrap();
        assert_eq!(back, project);
    }

    #[test]
    fn optional_asset_fields_are_omitted_not_null() {
        let asset = AssetDto {
            id: "ast_1".into(),
            project_id: "prj_1".into(),
            media_type: "video".into(),
            storage_mode: "copied".into(),
            uri: "assets/originals/a.mp4".into(),
            relative_path: Some("assets/originals/a.mp4".into()),
            sha256: None,
            bytes: None,
            duration_frames: None,
            width: None,
            height: None,
            sample_rate: None,
            channels: None,
            fps: None,
            codec: None,
            container: None,
            origin: "imported".into(),
            parent_asset_id: None,
            generation_job_id: None,
            prompt_revision_id: None,
            probe: None,
            missing_at: None,
            created_at: "2024-01-01T00:00:00.000Z".into(),
            updated_at: "2024-01-01T00:00:00.000Z".into(),
        };
        let value = serde_json::to_value(&asset).unwrap();
        // `protocol.ts` declares these as `T | null`, so an explicit null is legal…
        assert_eq!(value["sha256"], serde_json::Value::Null);
        assert_eq!(value["fps"], serde_json::Value::Null);
        assert_eq!(value["relativePath"], "assets/originals/a.mp4");
        // …and mandatory fields are present under their camelCase names.
        assert!(value.get("mediaType").is_some());
        assert!(value.get("storageMode").is_some());
        assert!(value.get("createdAt").is_some());
    }

    #[test]
    fn render_status_serializes_lowercase_and_parses_both_ways() {
        assert_eq!(
            serde_json::to_value(RenderStatus::Rendering).unwrap(),
            serde_json::json!("rendering")
        );
        assert_eq!(
            RenderStatus::parse("canceled"),
            Some(RenderStatus::Canceled)
        );
        assert_eq!(RenderStatus::parse("nope"), None);
        assert!(RenderStatus::Completed.is_terminal());
        assert!(!RenderStatus::Finalizing.is_terminal());
    }

    #[test]
    fn credential_dtos_never_have_a_secret_field() {
        let value = serde_json::to_value(CredentialRefDto {
            provider_id: "elevenlabs".into(),
            credential_ref: "keyring:com.creativelab.studio:provider:elevenlabs".into(),
            has_secret: true,
        })
        .unwrap();
        let mut keys: Vec<&String> = value.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, vec!["credentialRef", "hasSecret", "providerId"]);
        let text = value.to_string();
        assert!(!text.contains("secret\""), "{text}");
    }
}
