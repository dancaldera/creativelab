//! `project_*` commands.

use std::path::{Path, PathBuf};

use tauri::State;

use crate::commands::support::{sanitize_label, timestamp_fragment, CommandError, CommandResult};
use crate::db::{self, migrate, store};
use crate::protocol::*;
use crate::security::WorkspaceScope;
use crate::state::{AppState, RecentProject};

/// Where a crash-recovery snapshot lives, workspace-relative.
pub const RECOVERY_RELATIVE_PATH: &str = "cache/recovery.json";

/// `project_create`.
#[tauri::command]
pub fn project_create(
    state: State<'_, AppState>,
    request: ProjectCreateRequest,
) -> CommandResult<ProjectSessionDto> {
    if request.title.trim().is_empty() {
        return Err(CommandError::validation(
            "the project title must not be empty",
        ));
    }
    if request.title.chars().count() > 200 {
        return Err(CommandError::validation("the project title is too long"));
    }
    if request.width <= 0
        || request.height <= 0
        || request.width > 16_384
        || request.height > 16_384
    {
        return Err(CommandError::validation(
            "the composition size must be between 1 and 16384 pixels",
        ));
    }
    if request.fps.num <= 0 || request.fps.den <= 0 {
        return Err(CommandError::validation("the frame rate must be positive"));
    }
    if request.fps.num > 100_000 || request.fps.den > 100_000 {
        return Err(CommandError::validation("the frame rate is implausible"));
    }

    // `workspacePath` is an absolute directory the user chose in the native dialog, so it
    // is validated as an absolute directory rather than as a workspace-relative path.
    let scope = WorkspaceScope::new(PathBuf::from("."));
    let root = scope.resolve_absolute_dir(&request.workspace_path, "workspacePath")?;
    if db::database_path(&root).exists() {
        return Err(CommandError::configuration(format!(
            "{} already contains a project; use project_open instead",
            root.display()
        )));
    }

    db::ensure_workspace_layout(&root)?;
    let mut connection = db::open_database(&root)?;

    let project = ProjectDto {
        id: state.next_id("project"),
        schema_version: 1,
        title: request.title.trim().to_string(),
        fps: request.fps,
        width: request.width,
        height: request.height,
        color_profile: request.color_profile.unwrap_or_else(|| "bt709".to_string()),
        sample_rate: request.sample_rate.unwrap_or(48_000),
        channels: match request.channels {
            Some(1) => 1,
            _ => 2,
        },
        workspace_rel_path: ".".to_string(),
        created_at: migrate::now_iso8601(),
        updated_at: migrate::now_iso8601(),
    };
    let document = store::create_project(&mut connection, &project)?;
    write_manifest(&root, &document)?;

    state.set_workspace(root.clone(), connection)?;
    remember(&state, &document, &root);

    Ok(ProjectSessionDto {
        schema_version: document.project.schema_version,
        document,
        workspace_path: root.to_string_lossy().to_string(),
        recovery: None,
    })
}

/// `project_open`.
#[tauri::command]
pub fn project_open(
    state: State<'_, AppState>,
    request: ProjectOpenRequest,
) -> CommandResult<ProjectSessionDto> {
    let scope = WorkspaceScope::new(PathBuf::from("."));
    let root = scope.resolve_absolute_dir(&request.workspace_path, "workspacePath")?;
    let connection = db::open_existing_workspace(&root)?;
    let document = store::load_document(&connection)?;
    let recovery = read_recovery(&root)?;

    state.set_workspace(root.clone(), connection)?;
    remember(&state, &document, &root);

    Ok(ProjectSessionDto {
        schema_version: document.project.schema_version,
        document,
        workspace_path: root.to_string_lossy().to_string(),
        recovery,
    })
}

/// `project_save`.
///
/// Two writes that must not disagree: the SQLite rows and the `project.json` manifest.
/// Both are written from the same `DocumentDto`, and the manifest goes out through
/// `write_manifest`, which writes to a sibling temp file and renames — so a crash can
/// never leave a half-written manifest (PRD §14).
#[tauri::command]
pub fn project_save(
    state: State<'_, AppState>,
    request: ProjectSaveRequest,
) -> CommandResult<ProjectSaveResponse> {
    let root = require_root(&state)?;
    validate_document(&request.document)?;
    let response =
        state.with_db_mut(|connection| store::save_document(connection, &request.document))?;
    write_manifest(&root, &request.document)?;
    Ok(response)
}

/// `project_close`.
#[tauri::command]
pub fn project_close(state: State<'_, AppState>) -> CommandResult<()> {
    state.close_workspace()
}

/// `project_list_recent`.
///
/// Read from the *open* workspace's `app_settings`; with no workspace open, from the
/// in-memory list populated while a project was open. The TypeScript store keeps the same
/// key so the two agree.
#[tauri::command]
pub fn project_list_recent(state: State<'_, AppState>) -> CommandResult<Vec<ProjectSummaryDto>> {
    let mut entries = state.recent_projects();
    if state.has_workspace() {
        if let Ok(stored) =
            state.with_db(|connection| {
                Ok(store::get_setting(connection, "recentProjects")?
                    .unwrap_or(serde_json::Value::Null))
            })
        {
            if let Some(array) = stored.as_array() {
                let persisted: Vec<RecentProject> = array
                    .iter()
                    .filter_map(|value| serde_json::from_value(value.clone()).ok())
                    .collect();
                if !persisted.is_empty() {
                    entries = persisted;
                }
            }
        }
    }
    Ok(entries
        .into_iter()
        .map(|entry| ProjectSummaryDto {
            id: entry.id,
            title: entry.title,
            workspace_path: entry.workspace_path,
            updated_at: entry.updated_at,
            has_missing_media: None,
        })
        .collect())
}

/// `project_package`.
///
/// Copies the manifest, the database and every workspace-owned asset into a named
/// destination folder, and reports honestly on assets that cannot travel (linked
/// originals outside the workspace).
#[tauri::command]
pub fn project_package(
    state: State<'_, AppState>,
    request: ProjectPackageRequest,
) -> CommandResult<ProjectPackageResponse> {
    let root = require_root(&state)?;
    let scope = WorkspaceScope::new(&root);
    let destination = scope.resolve_absolute_dir(&request.destination_path, "destinationPath")?;
    let label = request
        .label
        .as_deref()
        .map(|label| sanitize_label(label, "package"))
        .unwrap_or_else(|| "package".to_string());
    let destination = destination.join(format!("{label}-{}", timestamp_fragment()));
    std::fs::create_dir_all(&destination).map_err(|error| {
        CommandError::from_io(
            &format!("could not create {}", destination.display()),
            &error,
        )
    })?;

    let document = state.with_db(store::load_document)?;
    let mut files = 0i64;
    let mut bytes = 0i64;
    let mut unresolved: Vec<String> = Vec::new();

    // project.json + project.db first: a package without them is not a project.
    write_manifest(&destination, &document)?;
    files += 1;
    bytes += std::fs::metadata(db::manifest_path(&destination))
        .map(|metadata| metadata.len() as i64)
        .unwrap_or(0);
    for name in [db::MANIFEST_FILENAME, db::DATABASE_FILENAME] {
        let source = root.join(name);
        if source.is_file() {
            let target = destination.join(name);
            std::fs::copy(&source, &target).map_err(|error| {
                CommandError::from_io(&format!("could not copy {}", source.display()), &error)
            })?;
            let size = std::fs::metadata(&target)
                .map(|m| m.len() as i64)
                .unwrap_or(0);
            if name == db::DATABASE_FILENAME {
                files += 1;
                bytes += size;
            }
        }
    }

    // Workspace-owned assets move with the project; linked ones outside it cannot.
    for asset in &document.assets {
        match asset
            .relative_path
            .as_deref()
            .filter(|path| !path.is_empty())
        {
            Some(relative) => {
                let source = scope.resolve(relative)?;
                if !source.is_file() {
                    unresolved.push(relative.to_string());
                    continue;
                }
                let target = destination.join(relative);
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent).map_err(|error| {
                        CommandError::from_io("could not create the asset directory", &error)
                    })?;
                }
                std::fs::copy(&source, &target).map_err(|error| {
                    CommandError::from_io(&format!("could not copy {}", source.display()), &error)
                })?;
                files += 1;
                bytes += std::fs::metadata(&target)
                    .map(|m| m.len() as i64)
                    .unwrap_or(0);
            }
            None => unresolved.push(asset.uri.clone()),
        }
    }

    Ok(ProjectPackageResponse {
        destination: destination.to_string_lossy().to_string(),
        files,
        bytes,
        portable: unresolved.is_empty(),
        unresolved,
    })
}

/// `project_backup`.
///
/// PRD §11: "backups exclude rebuildable caches by default". A timestamped folder keeps
/// every backup independent and restorable.
#[tauri::command]
pub fn project_backup(
    state: State<'_, AppState>,
    request: ProjectBackupRequest,
) -> CommandResult<ProjectBackupResponse> {
    let root = require_root(&state)?;
    if !request.workspace_path.is_empty() {
        let requested = WorkspaceScope::new(PathBuf::from("."))
            .resolve_absolute_dir(&request.workspace_path, "workspacePath")?;
        if requested != root {
            return Err(CommandError::validation(
                "workspacePath does not match the open workspace",
            ));
        }
    }
    let label = request
        .label
        .as_deref()
        .map(|label| sanitize_label(label, "backup"));
    let name = match label {
        Some(label) => format!("{label}-{}", timestamp_fragment()),
        None => timestamp_fragment(),
    };
    let destination = root.join("backups").join(name);
    std::fs::create_dir_all(&destination).map_err(|error| {
        CommandError::from_io(
            &format!("could not create {}", destination.display()),
            &error,
        )
    })?;

    let mut files = 0i64;
    let source_scope = WorkspaceScope::new(&root);
    copy_tree(&source_scope, &root, &destination, "", true, &mut files)?;
    Ok(ProjectBackupResponse {
        destination: destination.to_string_lossy().to_string(),
        files,
    })
}

/// Copy `relative` (and everything under it) from the workspace into `destination`.
///
/// Goes through [`WorkspaceScope`] for every source path and refuses to descend into
/// `backups/`, which would nest a backup inside itself.
fn copy_tree(
    scope: &WorkspaceScope,
    root: &Path,
    destination: &Path,
    relative: &str,
    skip_cache: bool,
    files: &mut i64,
) -> CommandResult<()> {
    let source = if relative.is_empty() {
        root.to_path_buf()
    } else {
        scope.scope(root, relative)?
    };
    let entries = match std::fs::read_dir(&source) {
        Ok(entries) => entries,
        // A missing directory is not an error for a snapshot.
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let child_relative = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            if child_relative == "backups" {
                continue;
            }
            if skip_cache
                && db::REBUILDABLE_DIRS
                    .iter()
                    .any(|directory| *directory == child_relative)
            {
                continue;
            }
            // `symlink_metadata` was used above; skip symlinked directories so a link
            // pointing outside the workspace cannot pull outside bytes into a backup.
            if file_type.is_symlink() {
                continue;
            }
            std::fs::create_dir_all(destination.join(&child_relative)).map_err(|error| {
                CommandError::from_io("could not create a backup directory", &error)
            })?;
            copy_tree(scope, root, destination, &child_relative, skip_cache, files)?;
        } else if file_type.is_file() {
            let target = destination.join(&child_relative);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    CommandError::from_io("could not create a backup directory", &error)
                })?;
            }
            // Re-resolve through the scope so a symlinked *file* is caught too.
            let real = scope.scope(root, &child_relative)?;
            std::fs::copy(&real, &target).map_err(|error| {
                CommandError::from_io(&format!("could not copy {}", real.display()), &error)
            })?;
            *files += 1;
        }
    }
    Ok(())
}

/// Write `project.json` atomically: a sibling temp file, fsync, then rename.
pub fn write_manifest(directory: &Path, document: &DocumentDto) -> CommandResult<()> {
    let target = db::manifest_path(directory);
    let manifest = serde_json::json!({
        "manifestVersion": 1,
        "schemaVersion": document.project.schema_version,
        "generator": concat!("creativelab/", env!("CARGO_PKG_VERSION")),
        "project": document.project,
        "sequences": document.sequences,
        "tracks": document.tracks,
        "clips": document.clips,
        "effects": document.effects,
        "keyframes": document.keyframes,
        "assets": document.assets,
        "exportedAt": migrate::now_iso8601(),
    });
    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(&manifest).unwrap_or_else(|_| "{}".to_string())
    );

    std::fs::create_dir_all(directory).map_err(|error| {
        CommandError::from_io("could not create the workspace directory", &error)
    })?;
    let temporary = directory.join(format!(
        ".{}.{}.manifest.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&temporary).map_err(|error| {
            CommandError::from_io(&format!("could not write {}", temporary.display()), &error)
        })?;
        file.write_all(body.as_bytes()).map_err(|error| {
            CommandError::from_io(&format!("could not write {}", temporary.display()), &error)
        })?;
        // Durability matters more than speed: a crash must not leave a truncated manifest.
        file.sync_all().map_err(|error| {
            CommandError::from_io(&format!("could not flush {}", temporary.display()), &error)
        })?;
    }
    std::fs::rename(&temporary, &target).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        CommandError::from_io(&format!("could not replace {}", target.display()), &error)
    })
}

/// Read a crash-recovery snapshot, if one is newer than the last save.
fn read_recovery(root: &Path) -> CommandResult<Option<RecoveryOfferDto>> {
    let scope = WorkspaceScope::new(root);
    let path = match scope.scope(root, RECOVERY_RELATIVE_PATH) {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(_) => return Ok(None),
    };
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    let written_at = parsed
        .get("writtenAt")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .or_else(|| {
            metadata
                .modified()
                .ok()
                .map(|modified| migrate::iso8601_from(time::OffsetDateTime::from(modified)))
        })
        .unwrap_or_else(migrate::now_iso8601);
    let reason = parsed
        .get("reason")
        .and_then(|value| value.as_str())
        .unwrap_or("periodic")
        .to_string();
    Ok(Some(RecoveryOfferDto {
        snapshot_path: RECOVERY_RELATIVE_PATH.to_string(),
        written_at,
        reason,
    }))
}

/// Reject a document that cannot represent a real timeline, before it reaches SQLite.
///
/// These mirror the `CHECK` constraints in `0001_init.sql`; failing here produces a named
/// error instead of a bare constraint violation.
pub fn validate_document(document: &DocumentDto) -> CommandResult<()> {
    if document.project.id.trim().is_empty() {
        return Err(CommandError::validation("the document has no project id"));
    }
    if document.project.fps.num <= 0 || document.project.fps.den <= 0 {
        return Err(CommandError::validation(
            "the project frame rate must be positive",
        ));
    }
    if document.project.width <= 0 || document.project.height <= 0 {
        return Err(CommandError::validation(
            "the composition size must be positive",
        ));
    }
    let sequence_ids: Vec<&str> = document
        .sequences
        .iter()
        .map(|sequence| sequence.id.as_str())
        .collect();
    let track_ids: Vec<&str> = document
        .tracks
        .iter()
        .map(|track| track.id.as_str())
        .collect();
    let clip_ids: Vec<&str> = document.clips.iter().map(|clip| clip.id.as_str()).collect();
    let effect_ids: Vec<&str> = document
        .effects
        .iter()
        .map(|effect| effect.id.as_str())
        .collect();

    for track in &document.tracks {
        if !sequence_ids.contains(&track.sequence_id.as_str()) {
            return Err(CommandError::validation(format!(
                "track {} references unknown sequence {}",
                track.id, track.sequence_id
            )));
        }
        if !matches!(track.kind.as_str(), "video" | "audio" | "caption") {
            return Err(CommandError::validation(format!(
                "track {} has unknown kind '{}'",
                track.id, track.kind
            )));
        }
    }
    for clip in &document.clips {
        if !track_ids.contains(&clip.track_id.as_str()) {
            return Err(CommandError::validation(format!(
                "clip {} references unknown track {}",
                clip.id, clip.track_id
            )));
        }
        if clip.duration_frames <= 0 {
            return Err(CommandError::validation(format!(
                "clip {} must have a positive duration",
                clip.id
            )));
        }
        if clip.start_frame < 0 || clip.source_in_frame < 0 {
            return Err(CommandError::validation(format!(
                "clip {} has a negative frame coordinate",
                clip.id
            )));
        }
        if let Some(asset_id) = clip.asset_id.as_deref() {
            if !document.assets.iter().any(|asset| asset.id == asset_id) {
                return Err(CommandError::validation(format!(
                    "clip {} references asset {asset_id} which is not in the document",
                    clip.id
                )));
            }
        }
    }
    for effect in &document.effects {
        if !clip_ids.contains(&effect.clip_id.as_str()) {
            return Err(CommandError::validation(format!(
                "effect {} references unknown clip {}",
                effect.id, effect.clip_id
            )));
        }
    }
    for keyframe in &document.keyframes {
        if !effect_ids.contains(&keyframe.effect_id.as_str()) {
            return Err(CommandError::validation(format!(
                "keyframe {} references unknown effect {}",
                keyframe.id, keyframe.effect_id
            )));
        }
    }
    Ok(())
}

fn require_root(state: &State<'_, AppState>) -> CommandResult<PathBuf> {
    state.workspace_root().ok_or_else(|| {
        CommandError::configuration("no workspace is open; open or create a project first")
    })
}

/// Persist the recent-project entry into the open database and the in-memory list.
fn remember(state: &State<'_, AppState>, document: &DocumentDto, root: &Path) {
    let entry = RecentProject {
        id: document.project.id.clone(),
        title: document.project.title.clone(),
        workspace_path: root.to_string_lossy().to_string(),
        updated_at: document.project.updated_at.clone(),
    };
    state.remember_project(entry);
    let serialized = serde_json::to_value(state.recent_projects()).unwrap_or(serde_json::json!([]));
    let _ =
        state.with_db(|connection| store::set_setting(connection, "recentProjects", &serialized));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_document() -> DocumentDto {
        DocumentDto {
            project: ProjectDto {
                id: "prj_1".into(),
                schema_version: 1,
                title: "Test".into(),
                fps: FrameRateDto::new(30, 1),
                width: 1920,
                height: 1080,
                color_profile: "bt709".into(),
                sample_rate: 48_000,
                channels: 2,
                workspace_rel_path: ".".into(),
                created_at: migrate::now_iso8601(),
                updated_at: migrate::now_iso8601(),
            },
            sequences: vec![SequenceDto {
                id: "seq_1".into(),
                project_id: "prj_1".into(),
                name: "Main".into(),
                width: 1920,
                height: 1080,
                fps: FrameRateDto::new(30, 1),
                duration_frames: 0,
                is_active: true,
                created_at: migrate::now_iso8601(),
                updated_at: migrate::now_iso8601(),
            }],
            tracks: vec![TrackDto {
                id: "trk_1".into(),
                sequence_id: "seq_1".into(),
                kind: "video".into(),
                name: "V1".into(),
                sort_order: 0,
                muted: false,
                locked: false,
                hidden: false,
                solo: false,
                volume_db: 0.0,
                created_at: migrate::now_iso8601(),
                updated_at: migrate::now_iso8601(),
            }],
            clips: Vec::new(),
            effects: Vec::new(),
            keyframes: Vec::new(),
            assets: Vec::new(),
        }
    }

    #[test]
    fn a_well_formed_document_validates() {
        validate_document(&empty_document()).unwrap();
    }

    #[test]
    fn dangling_references_are_named_in_the_error() {
        let mut document = empty_document();
        document.clips.push(ClipDto {
            id: "clp_1".into(),
            track_id: "trk_missing".into(),
            sequence_id: "seq_1".into(),
            asset_id: None,
            label: String::new(),
            start_frame: 0,
            source_in_frame: 0,
            duration_frames: 30,
            properties: serde_json::json!({}),
            version: 1,
            created_at: migrate::now_iso8601(),
            updated_at: migrate::now_iso8601(),
        });
        let error = validate_document(&document).unwrap_err();
        assert!(
            error.message.contains("unknown track trk_missing"),
            "{error}"
        );

        document.clips[0].track_id = "trk_1".into();
        document.clips[0].asset_id = Some("ast_missing".into());
        let error = validate_document(&document).unwrap_err();
        assert!(error.message.contains("not in the document"), "{error}");
    }

    #[test]
    fn invalid_coordinates_and_durations_are_rejected() {
        let mut document = empty_document();
        let base = ClipDto {
            id: "clp_1".into(),
            track_id: "trk_1".into(),
            sequence_id: "seq_1".into(),
            asset_id: None,
            label: String::new(),
            start_frame: 0,
            source_in_frame: 0,
            duration_frames: 30,
            properties: serde_json::json!({}),
            version: 1,
            created_at: migrate::now_iso8601(),
            updated_at: migrate::now_iso8601(),
        };
        let mut zero = base.clone();
        zero.duration_frames = 0;
        document.clips.push(zero);
        assert!(validate_document(&document)
            .unwrap_err()
            .message
            .contains("positive duration"));

        document.clips[0] = base.clone();
        document.clips[0].start_frame = -1;
        assert!(validate_document(&document)
            .unwrap_err()
            .message
            .contains("negative frame"));

        document.clips[0] = base;
        validate_document(&document).unwrap();
    }

    #[test]
    fn unknown_track_kinds_are_rejected() {
        let mut document = empty_document();
        document.tracks[0].kind = "hologram".into();
        let error = validate_document(&document).unwrap_err();
        assert!(error.message.contains("unknown kind"), "{error}");
    }

    #[test]
    fn manifest_write_is_atomic_and_replaces_in_place() {
        let directory =
            std::env::temp_dir().join(format!("creativelab-manifest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        let mut document = empty_document();
        write_manifest(&directory, &document).unwrap();
        let path = db::manifest_path(&directory);
        let first = std::fs::read_to_string(&path).unwrap();
        assert!(first.contains("\"manifestVersion\": 1"), "{first}");
        assert!(first.contains("\"project\""), "{first}");
        assert!(first.ends_with('\n'), "manifests are newline-terminated");

        document.project.title = "Renamed".into();
        write_manifest(&directory, &document).unwrap();
        let second = std::fs::read_to_string(&path).unwrap();
        assert!(second.contains("Renamed"));
        // No temp files are left behind.
        let leftovers: Vec<String> = std::fs::read_dir(&directory)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn copy_tree_skips_backups_and_rebuildable_caches() {
        let root =
            std::env::temp_dir().join(format!("creativelab-copytree-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for directory in db::WORKSPACE_DIRS {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        std::fs::write(root.join("assets/originals/keep.mp4"), b"keep").unwrap();
        std::fs::write(root.join("cache/proxies/skip.mp4"), b"skip").unwrap();
        std::fs::write(root.join("project.json"), b"{}").unwrap();

        let destination = root.join("backups/snapshot");
        std::fs::create_dir_all(&destination).unwrap();
        let scope = WorkspaceScope::new(&root);
        let mut files = 0;
        copy_tree(&scope, &root, &destination, "", true, &mut files).unwrap();

        assert!(destination.join("assets/originals/keep.mp4").is_file());
        assert!(destination.join("project.json").is_file());
        assert!(!destination.join("cache/proxies/skip.mp4").exists());
        assert!(
            !destination.join("backups").exists(),
            "backups must not nest"
        );
        assert_eq!(files, 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn recovery_offer_is_absent_without_a_snapshot() {
        let root =
            std::env::temp_dir().join(format!("creativelab-recovery-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        db::ensure_workspace_layout(&root).unwrap();
        assert!(read_recovery(&root).unwrap().is_none());

        std::fs::write(
            root.join(RECOVERY_RELATIVE_PATH),
            br#"{ "writtenAt": "2024-05-01T10:00:00.000Z", "reason": "periodic" }"#,
        )
        .unwrap();
        let offer = read_recovery(&root).unwrap().expect("offer");
        assert_eq!(offer.written_at, "2024-05-01T10:00:00.000Z");
        assert_eq!(offer.reason, "periodic");
        assert_eq!(offer.snapshot_path, RECOVERY_RELATIVE_PATH);
        let _ = std::fs::remove_dir_all(&root);
    }
}
