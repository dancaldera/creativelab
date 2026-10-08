//! `asset_*` commands: import (copy or link), relink, probe, delete.
//!
//! FR-02 dedupe: an import whose SHA-256 already exists in the project reports the
//! existing asset as `duplicateOf` and does **not** copy the bytes again.
//!
//! PRD §9: "copy into the project by default; linking is an explicit advanced choice" —
//! so `mode: "copy"` is the default behaviour and `mode: "link"` stores an absolute path
//! with `relativePath: null`, exactly as the schema expects.

use std::path::{Path, PathBuf};

use tauri::State;

use crate::commands::support::{CommandError, CommandResult};
use crate::db::store;
use crate::media;
use crate::protocol::*;
use crate::security::WorkspaceScope;
use crate::state::AppState;

/// `asset_import`.
#[tauri::command]
pub fn asset_import(
    state: State<'_, AppState>,
    request: AssetImportRequest,
) -> CommandResult<AssetImportResponse> {
    let (root, scope) = super::workspace::scope_for_request(&state, &request.workspace_path)?;
    if request.source_paths.is_empty() {
        return Err(CommandError::validation("no source paths were supplied"));
    }
    if request.source_paths.len() > 500 {
        return Err(CommandError::validation(
            "import at most 500 files at a time",
        ));
    }
    let mode = match request.mode.as_str() {
        "copy" => "copy",
        "link" => "link",
        other => {
            return Err(CommandError::validation(format!(
                "unknown import mode '{other}'; expected 'copy' or 'link'"
            )))
        }
    };
    let project_id = state.project_ref()?.id;

    let mut imported = Vec::new();
    let mut errors = Vec::new();
    for source in &request.source_paths {
        match import_one(&state, &root, &scope, &project_id, source, mode) {
            Ok(asset) => imported.push(asset),
            Err(error) => errors.push(AssetImportError {
                path: source.clone(),
                message: error.message,
            }),
        }
    }
    Ok(AssetImportResponse { imported, errors })
}

fn import_one(
    state: &State<'_, AppState>,
    root: &Path,
    scope: &WorkspaceScope,
    project_id: &str,
    source: &str,
    mode: &str,
) -> CommandResult<ImportedAssetDto> {
    if source.is_empty() {
        return Err(CommandError::validation("the source path is empty"));
    }
    // The source is a file the user picked in the native dialog, so it is an absolute
    // path: validate it as one rather than trying to scope it into the workspace.
    let source_path = scope.resolve_absolute_file(source, "sourcePath")?;
    if !source_path.is_file() {
        return Err(CommandError::validation(format!(
            "{} is not a file",
            source_path.display()
        )));
    }

    let sha256 = media::hash_file(&source_path)?;
    let existing = state.with_db(|connection| store::find_asset_by_sha256(connection, &sha256))?;
    if let Some(existing) = existing {
        return Ok(ImportedAssetDto {
            asset: existing.clone(),
            duplicate_of: Some(existing.id),
            warnings: Vec::new(),
        });
    }

    let mut warnings = Vec::new();
    let now = crate::db::migrate::now_iso8601();
    let file_name = source_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| CommandError::validation("the source path has no file name"))?;
    let safe_name = crate::commands::support::sanitize_label(&file_name, "asset");

    let (uri, relative_path, storage_mode) = if mode == "copy" {
        let originals = scope.resolve("assets/originals")?;
        let taken = directory_names(&originals);
        let unique = media::unique_file_name(&taken, &safe_name);
        let destination = originals.join(&unique);
        std::fs::copy(&source_path, &destination).map_err(|error| {
            CommandError::from_io(
                &format!(
                    "could not copy {} into the workspace",
                    source_path.display()
                ),
                &error,
            )
        })?;
        (
            destination.to_string_lossy().to_string(),
            Some(format!("assets/originals/{unique}")),
            "copied",
        )
    } else {
        (source_path.to_string_lossy().to_string(), None, "linked")
    };

    let bytes = std::fs::metadata(&source_path)
        .map(|metadata| metadata.len() as i64)
        .ok();
    let extension_type = media::media_type_for_path(&source_path);
    let mut asset = AssetDto {
        id: state.next_id("asset"),
        project_id: project_id.to_string(),
        media_type: extension_type.to_string(),
        storage_mode: storage_mode.to_string(),
        uri: uri.clone(),
        relative_path: relative_path.clone(),
        sha256: Some(sha256),
        bytes,
        duration_frames: None,
        width: None,
        height: None,
        sample_rate: None,
        channels: None,
        fps: None,
        codec: None,
        container: None,
        origin: "imported".to_string(),
        parent_asset_id: None,
        generation_job_id: None,
        prompt_revision_id: None,
        probe: None,
        missing_at: None,
        created_at: now.clone(),
        updated_at: now,
    };

    // Probing is best-effort: a file ffprobe cannot read is still importable and
    // relinkable, and the warning tells the user why the timeline shows no duration.
    let probe_target = if mode == "copy" {
        scope.resolve(relative_path.as_deref().unwrap_or_default())?
    } else {
        PathBuf::from(&uri)
    };
    match media::probe_file_blocking(&probe_target) {
        Ok(probe) => media::apply_probe_to_asset(&mut asset, &probe),
        Err(error) => warnings.push(format!(
            "could not probe the imported file: {}",
            error.message
        )),
    }

    state.with_db(|connection| store::insert_asset(connection, &asset))?;
    let _ = root; // the workspace root was already validated by `scope_for_request`

    Ok(ImportedAssetDto {
        asset,
        duplicate_of: None,
        warnings,
    })
}

/// `asset_relink`: point an asset at a new file on disk (PRD §11 relinking).
#[tauri::command]
pub fn asset_relink(
    state: State<'_, AppState>,
    request: AssetRelinkRequest,
) -> CommandResult<AssetDto> {
    let (_root, scope) = super::workspace::scope_for_request(&state, &request.workspace_path)?;
    let asset = state
        .with_db(|connection| store::find_asset(connection, &request.asset_id))?
        .ok_or_else(|| CommandError::validation(format!("unknown asset {}", request.asset_id)))?;

    let new_path = scope.resolve_absolute_file(&request.new_path, "newPath")?;
    if !new_path.is_file() {
        return Err(CommandError::validation(format!(
            "{} is not a file",
            new_path.display()
        )));
    }

    let sha256 = media::hash_file(&new_path)?;
    let mut patch = serde_json::json!({
        "uri": new_path.to_string_lossy(),
        "sha256": sha256,
        "missingAt": serde_json::Value::Null,
    });
    // A path inside the workspace can be stored relatively; anything else stays linked.
    if let Ok(relative) = relative_to(scope.root(), &new_path) {
        patch["relativePath"] = serde_json::json!(relative);
        patch["storageMode"] = serde_json::json!("copied");
    } else {
        patch["relativePath"] = serde_json::Value::Null;
        patch["storageMode"] = serde_json::json!("linked");
    }
    if let Ok(metadata) = std::fs::metadata(&new_path) {
        patch["bytes"] = serde_json::json!(metadata.len() as i64);
    }
    if let Ok(probe) = media::probe_file_blocking(&new_path) {
        let mut probed = asset.clone();
        media::apply_probe_to_asset(&mut probed, &probe);
        patch["mediaType"] = serde_json::json!(probed.media_type);
        patch["width"] = serde_json::to_value(probed.width).unwrap_or(serde_json::Value::Null);
        patch["height"] = serde_json::to_value(probed.height).unwrap_or(serde_json::Value::Null);
        patch["durationFrames"] =
            serde_json::to_value(probed.duration_frames).unwrap_or(serde_json::Value::Null);
        patch["sampleRate"] =
            serde_json::to_value(probed.sample_rate).unwrap_or(serde_json::Value::Null);
        patch["channels"] =
            serde_json::to_value(probed.channels).unwrap_or(serde_json::Value::Null);
        patch["fps"] = serde_json::to_value(probed.fps).unwrap_or(serde_json::Value::Null);
        patch["codec"] = serde_json::to_value(probed.codec).unwrap_or(serde_json::Value::Null);
        patch["container"] =
            serde_json::to_value(probed.container).unwrap_or(serde_json::Value::Null);
        patch["probe"] = probed.probe.unwrap_or(serde_json::Value::Null);
    }

    let updated =
        state.with_db(|connection| store::update_asset(connection, &request.asset_id, &patch))?;
    Ok(updated)
}

/// `asset_probe`: re-run ffprobe and persist the refreshed metadata.
#[tauri::command]
pub fn asset_probe(state: State<'_, AppState>, request: AssetIdRequest) -> CommandResult<AssetDto> {
    let (_root, scope) = super::workspace::scope_for_request(&state, &request.workspace_path)?;
    let asset = state
        .with_db(|connection| store::find_asset(connection, &request.asset_id))?
        .ok_or_else(|| CommandError::validation(format!("unknown asset {}", request.asset_id)))?;
    let target = asset_path(&scope, &asset)?;
    if !target.is_file() {
        // Record the absence so the UI can offer a relink, then report it.
        state.with_db(|connection| {
            store::update_asset(
                connection,
                &request.asset_id,
                &serde_json::json!({ "missingAt": crate::db::migrate::now_iso8601() }),
            )
        })?;
        return Err(CommandError::io(format!(
            "the media for asset {} is missing at {}",
            asset.id,
            target.display()
        )));
    }
    let probe = media::probe_file_blocking(&target)?;
    let mut probed = asset.clone();
    media::apply_probe_to_asset(&mut probed, &probe);
    let patch = serde_json::json!({
        "mediaType": probed.media_type,
        "width": probed.width,
        "height": probed.height,
        "durationFrames": probed.duration_frames,
        "sampleRate": probed.sample_rate,
        "channels": probed.channels,
        "fps": probed.fps,
        "codec": probed.codec,
        "container": probed.container,
        "probe": probed.probe,
        "missingAt": serde_json::Value::Null,
    });
    Ok(state.with_db(|connection| store::update_asset(connection, &request.asset_id, &patch))?)
}

/// `asset_delete`: drop the database row. Media bytes are never modified in place
/// (PRD §4 non-destructive editing), and a copied original is only removed when it lives
/// in this workspace's `assets/originals`.
#[tauri::command]
pub fn asset_delete(state: State<'_, AppState>, request: AssetIdRequest) -> CommandResult<()> {
    let (_root, scope) = super::workspace::scope_for_request(&state, &request.workspace_path)?;
    let asset = state
        .with_db(|connection| store::find_asset(connection, &request.asset_id))?
        .ok_or_else(|| CommandError::validation(format!("unknown asset {}", request.asset_id)))?;

    state.with_db(|connection| store::delete_asset(connection, &request.asset_id))?;

    let cleanup = match asset.relative_path.as_deref() {
        Some(relative) if relative.starts_with("assets/originals/") => scope.resolve(relative).ok(),
        // Anything outside the workspace, or generated media the user may want to keep in
        // the exports/generated folders, is left on disk.
        _ => None,
    };
    if let Some(path) = cleanup {
        // Belt and braces: the resolved path must still be a plain workspace file.
        if path.is_file()
            && crate::security::is_inside(scope.root(), &path)
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some()
        {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}

/// Resolve the on-disk location of an asset: the workspace-relative path when there is
/// one, otherwise the stored absolute URI for a linked original.
pub fn asset_path(scope: &WorkspaceScope, asset: &AssetDto) -> CommandResult<PathBuf> {
    match asset
        .relative_path
        .as_deref()
        .filter(|path| !path.is_empty())
    {
        Some(relative) => Ok(scope.resolve(relative)?),
        None => {
            let uri = asset.uri.trim();
            if uri.is_empty() {
                return Err(CommandError::validation(format!(
                    "asset {} has neither a relative path nor a URI",
                    asset.id
                )));
            }
            if uri.starts_with("http://") || uri.starts_with("https://") {
                return Err(CommandError::validation(format!(
                    "asset {} is remote and has not been downloaded yet",
                    asset.id
                )));
            }
            let path = PathBuf::from(uri);
            if !path.is_absolute() {
                return Err(CommandError::validation(format!(
                    "asset {} has a non-absolute URI",
                    asset.id
                )));
            }
            Ok(path)
        }
    }
}

/// `Some(relative posix path)` when `target` is inside `root`, else `Err`.
fn relative_to(root: &Path, target: &Path) -> CommandResult<String> {
    let canonical_root = std::fs::canonicalize(root).map_err(|error| {
        CommandError::from_io("the workspace root could not be resolved", &error)
    })?;
    let canonical_target = std::fs::canonicalize(target)
        .map_err(|error| CommandError::from_io("the new path could not be resolved", &error))?;
    let relative = canonical_target
        .strip_prefix(&canonical_root)
        .map_err(|_| CommandError::validation("the new path is outside the workspace"))?;
    Ok(relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/"))
}

fn directory_names(directory: &Path) -> Vec<String> {
    std::fs::read_dir(directory)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::media::unique_file_name;

    #[test]
    fn unique_file_name_avoids_collisions() {
        let taken = vec!["clip.mp4".to_string()];
        assert_eq!(unique_file_name(&taken, "other.mp4"), "other.mp4");
        assert_eq!(unique_file_name(&taken, "clip.mp4"), "clip (2).mp4");
        let taken = vec!["clip.mp4".to_string(), "clip (2).mp4".to_string()];
        assert_eq!(unique_file_name(&taken, "clip.mp4"), "clip (3).mp4");
        // Extension-less and dot-leading names still work.
        assert_eq!(
            unique_file_name(&["README".to_string()], "README"),
            "README (2)"
        );
        assert_eq!(unique_file_name(&[".env".to_string()], ".env"), ".env (2)");
    }

    #[test]
    fn unique_file_name_stays_a_single_segment() {
        let taken: Vec<String> = Vec::new();
        for name in ["a b.mp4", "ünïcode.wav", "..hidden.png"] {
            let unique = unique_file_name(&taken, name);
            assert!(!unique.contains('/'), "{unique}");
            assert!(!unique.contains('\\'), "{unique}");
        }
    }

    #[test]
    fn asset_path_prefers_the_workspace_relative_path() {
        let base =
            std::env::temp_dir().join(format!("creativelab-assetpath-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        db::ensure_workspace_layout(&base).unwrap();
        // Canonicalize so the comparison sees /private/var rather than /var on macOS.
        let root = std::fs::canonicalize(&base).unwrap();
        std::fs::write(root.join("assets/originals/a.mp4"), b"x").unwrap();
        let scope = WorkspaceScope::new(&root);

        let mut asset = store::test_support::fixture_asset("ast_1");
        asset.relative_path = Some("assets/originals/a.mp4".into());
        asset.uri = "/somewhere/else.mp4".into();
        assert_eq!(
            asset_path(&scope, &asset).unwrap(),
            root.join("assets/originals/a.mp4")
        );

        // A linked original uses its absolute URI.
        asset.relative_path = None;
        asset.uri = "/tmp/linked-original.mov".into();
        assert_eq!(
            asset_path(&scope, &asset).unwrap(),
            PathBuf::from("/tmp/linked-original.mov")
        );

        // A relative URI on a linked asset is refused rather than resolved against the CWD.
        asset.uri = "relative.mov".into();
        assert!(asset_path(&scope, &asset).is_err());

        // A remote URI is refused with a clear message.
        asset.uri = "https://example.invalid/a.mp4".into();
        let error = asset_path(&scope, &asset).unwrap_err();
        assert!(error.message.contains("remote"), "{error}");

        // A traversing relative path is refused by the scope.
        asset.relative_path = Some("../../etc/passwd".into());
        asset.uri = String::new();
        assert!(asset_path(&scope, &asset).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn relative_to_refuses_paths_outside_the_root() {
        let root =
            std::env::temp_dir().join(format!("creativelab-relative-{}", std::process::id()));
        let outside =
            std::env::temp_dir().join(format!("creativelab-outside-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("assets/a.mp4"), b"x").unwrap();
        std::fs::write(outside.join("b.mp4"), b"x").unwrap();

        assert_eq!(
            relative_to(&root, &root.join("assets/a.mp4")).unwrap(),
            "assets/a.mp4"
        );
        assert!(relative_to(&root, &outside.join("b.mp4")).is_err());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn directory_names_lists_existing_entries() {
        let root =
            std::env::temp_dir().join(format!("creativelab-dirnames-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("one.txt"), b"").unwrap();
        std::fs::write(root.join("two.txt"), b"").unwrap();
        let mut names = directory_names(&root);
        names.sort();
        assert_eq!(names, vec!["one.txt", "two.txt"]);
        // A missing directory yields an empty list rather than an error.
        assert!(directory_names(&root.join("nope")).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
