//! `workspace_*` commands — storage reporting and cache purging.

use std::path::PathBuf;

use tauri::State;

use crate::db;
use crate::protocol::*;
use crate::security::WorkspaceScope;
use crate::state::AppState;

use super::support::{CommandError, CommandResult};

/// The directories reported by `workspace_usage`, mirroring `workspaceUsage` in core.
const REPORTED_DIRS: &[&str] = &["assets", "cache", "exports", "backups"];

/// Resolve the workspace the request names and verify it is the one that is open.
///
/// The renderer may pass a `workspacePath`, but only the open workspace is ever touched:
/// a mismatch is a validation error, not an instruction to go somewhere else.
pub fn scope_for_request<'a>(
    state: &'a State<'_, AppState>,
    workspace_path: &str,
) -> CommandResult<(PathBuf, WorkspaceScope)> {
    let root = state.workspace_root().ok_or_else(|| {
        CommandError::configuration("no workspace is open; open or create a project first")
    })?;
    if !workspace_path.is_empty() {
        let requested = WorkspaceScope::new(PathBuf::from("."))
            .resolve_absolute_dir(workspace_path, "workspacePath")?;
        if requested != root {
            return Err(CommandError::validation(
                "workspacePath does not match the open workspace",
            ));
        }
    }
    let scope = WorkspaceScope::new(root.clone());
    Ok((root, scope))
}

/// `workspace_usage`.
#[tauri::command]
pub fn workspace_usage(
    state: State<'_, AppState>,
    request: WorkspaceUsageRequest,
) -> CommandResult<WorkspaceUsageResponse> {
    let (root, scope) = scope_for_request(&state, &request.workspace_path)?;
    let mut directories = Vec::new();
    let mut total_bytes = 0i64;
    let mut cache_bytes = 0i64;
    for relative in REPORTED_DIRS {
        let directory = scope.resolve(relative)?;
        let (bytes, files) = db::directory_usage(&directory);
        total_bytes += bytes;
        if *relative == "cache" {
            cache_bytes = bytes;
        }
        directories.push(DirectoryUsageDto {
            path: directory.to_string_lossy().to_string(),
            bytes,
            files,
        });
    }
    Ok(WorkspaceUsageResponse {
        root: root.to_string_lossy().to_string(),
        total_bytes,
        cache_bytes,
        // Everything under cache/ is derived data and can be rebuilt from originals.
        cache_reclaimable_bytes: cache_bytes,
        directories,
    })
}

/// `workspace_purge_caches`. Never touches assets, exports or backups.
#[tauri::command]
pub fn workspace_purge_caches(
    state: State<'_, AppState>,
    request: WorkspaceUsageRequest,
) -> CommandResult<WorkspacePurgeResponse> {
    let (_root, scope) = scope_for_request(&state, &request.workspace_path)?;
    let mut purged = Vec::new();
    for relative in db::REBUILDABLE_DIRS {
        // Re-derive the absolute path through the scope on every iteration: the delete is
        // the destructive step, so the containment check happens immediately before it.
        let target = scope.resolve(relative)?;
        if !target.starts_with(scope.root()) {
            return Err(CommandError::validation(format!(
                "{relative} resolved outside the workspace"
            )));
        }
        if target.exists() {
            std::fs::remove_dir_all(&target).map_err(|error| {
                CommandError::from_io(&format!("could not clear {}", target.display()), &error)
            })?;
        }
        std::fs::create_dir_all(&target).map_err(|error| {
            CommandError::from_io(&format!("could not recreate {}", target.display()), &error)
        })?;
        purged.push((*relative).to_string());
    }
    Ok(WorkspacePurgeResponse { purged })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reported_directories_are_a_subset_of_the_layout() {
        for directory in REPORTED_DIRS {
            assert!(
                db::WORKSPACE_DIRS
                    .iter()
                    .any(|candidate| candidate.starts_with(directory)),
                "{directory} is not part of the workspace layout"
            );
        }
    }

    #[test]
    fn purge_targets_are_the_rebuildable_directories_only() {
        for directory in db::REBUILDABLE_DIRS {
            assert!(directory.starts_with("cache/"), "{directory}");
            assert!(!directory.starts_with("assets"), "{directory}");
            assert!(!directory.starts_with("exports"), "{directory}");
            assert!(!directory.starts_with("backups"), "{directory}");
        }
        assert_eq!(db::REBUILDABLE_DIRS.len(), 3);
    }
}
