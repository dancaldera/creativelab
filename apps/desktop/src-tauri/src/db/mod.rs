//! Database access: schema migration plus the `rusqlite` store.
//!
//! The migration file lives in `packages/core/migrations/` and is embedded verbatim, so
//! the TypeScript store (`node:sqlite`) and this store read and write the same database
//! with the same `schema_migrations` bookkeeping.

pub mod migrate;
pub mod store;

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::error::{CommandError, CommandResult};

pub const DATABASE_FILENAME: &str = "project.db";
pub const MANIFEST_FILENAME: &str = "project.json";

/// Project-relative directories, in creation order. Mirrors `WORKSPACE_DIRS` in
/// `packages/core/src/workspace.ts`.
pub const WORKSPACE_DIRS: &[&str] = &[
    "assets/originals",
    "assets/generated/image",
    "assets/generated/video",
    "assets/generated/audio",
    "cache/proxies",
    "cache/thumbnails",
    "cache/waveforms",
    "exports",
    "backups",
];

/// Directories that can always be rebuilt from originals; excluded from backups.
pub const REBUILDABLE_DIRS: &[&str] = &["cache/proxies", "cache/thumbnails", "cache/waveforms"];

pub fn database_path(workspace_root: &Path) -> PathBuf {
    workspace_root.join(DATABASE_FILENAME)
}

pub fn manifest_path(workspace_root: &Path) -> PathBuf {
    workspace_root.join(MANIFEST_FILENAME)
}

/// Create every directory in the layout. Idempotent.
pub fn ensure_workspace_layout(workspace_root: &Path) -> CommandResult<()> {
    std::fs::create_dir_all(workspace_root).map_err(|error| {
        CommandError::from_io(
            &format!("could not create {}", workspace_root.display()),
            &error,
        )
    })?;
    for directory in WORKSPACE_DIRS {
        let target = workspace_root.join(directory);
        std::fs::create_dir_all(&target).map_err(|error| {
            CommandError::from_io(&format!("could not create {}", target.display()), &error)
        })?;
    }
    Ok(())
}

/// Open the workspace database with foreign keys on and a busy timeout, then migrate it.
///
/// `foreign_keys` is required: the schema relies on `ON DELETE CASCADE` for the timeline
/// tables, and SQLite disables it by default.
pub fn open_database(workspace_root: &Path) -> CommandResult<Connection> {
    let path = database_path(workspace_root);
    let mut connection = Connection::open(&path).map_err(|error| {
        CommandError::new(
            crate::error::ErrorCategory::Io,
            format!("could not open {}: {error}", path.display()),
        )
    })?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;\
             PRAGMA journal_mode = WAL;\
             PRAGMA synchronous = NORMAL;\
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(|error| {
            CommandError::new(
                crate::error::ErrorCategory::Io,
                format!("could not configure SQLite: {error}"),
            )
        })?;
    migrate::run_migrations(&mut connection)?;
    Ok(connection)
}

/// Open an existing workspace and verify it really is a project.
pub fn open_existing_workspace(workspace_root: &Path) -> CommandResult<Connection> {
    if !workspace_root.is_dir() {
        return Err(CommandError::configuration(format!(
            "{} is not a directory",
            workspace_root.display()
        )));
    }
    let path = database_path(workspace_root);
    if !path.is_file() {
        return Err(CommandError::configuration(format!(
            "{} does not contain a {DATABASE_FILENAME}; it is not a Creative Studio project",
            workspace_root.display()
        )));
    }
    let connection = open_database(workspace_root)?;
    // Fail early with a clear message rather than on the first document read.
    store::project_ref(&connection)?;
    Ok(connection)
}

/// Recursively total a directory; symlinks are not followed. Mirrors `directoryUsage`.
pub fn directory_usage(directory: &Path) -> (i64, i64) {
    let mut bytes = 0i64;
    let mut files = 0i64;
    let walker = walkdir::WalkDir::new(directory)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok);
    for entry in walker {
        if entry.file_type().is_file() {
            if let Ok(metadata) = entry.metadata() {
                bytes += metadata.len() as i64;
                files += 1;
            }
        }
    }
    (bytes, files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_creation_is_idempotent_and_complete() {
        let root = std::env::temp_dir().join(format!("creativelab-layout-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        ensure_workspace_layout(&root).unwrap();
        ensure_workspace_layout(&root).unwrap();
        for directory in WORKSPACE_DIRS {
            assert!(root.join(directory).is_dir(), "{directory} missing");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn opening_a_directory_without_a_database_is_a_clear_error() {
        let root = std::env::temp_dir().join(format!("creativelab-nodb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let error = open_existing_workspace(&root).unwrap_err();
        assert!(
            error.message.contains("is not a Creative Studio project"),
            "{error}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn directory_usage_totals_files() {
        let root = std::env::temp_dir().join(format!("creativelab-usage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("a.bin"), vec![0u8; 100]).unwrap();
        std::fs::write(root.join("nested/b.bin"), vec![0u8; 50]).unwrap();
        let (bytes, files) = directory_usage(&root);
        assert_eq!(files, 2);
        assert_eq!(bytes, 150);
        let _ = std::fs::remove_dir_all(&root);
    }
}
