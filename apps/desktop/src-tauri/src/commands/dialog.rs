//! `dialog_*` commands.
//!
//! The native panels run in Rust, which is the only way the renderer can obtain an absolute
//! filesystem path: the capability file grants `dialog:default` and deliberately *not*
//! `fs:*`, so the webview cannot enumerate the filesystem on its own. Every path a dialog
//! returns is re-validated by [`crate::security::WorkspaceScope`] before any command uses it.
//!
//! ## Why these three commands are `async`
//! `tauri-plugin-dialog` documents `blocking_pick_*` as the correct API "for use in other
//! contexts" and explicitly warns against it on the main thread. An `async` Tauri command
//! runs on Tauri's async runtime, not the main event loop, so blocking there is exactly the
//! supported combination: the dialog opens, the event loop keeps running, and this task waits
//! for the result. Every other command in this crate stays synchronous so it can take a
//! blocking SQLite lock without parking the runtime.

use tauri::State;
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::commands::support::{CommandError, CommandResult};
use crate::protocol::*;
use crate::state::AppState;

/// `dialog_open_file`.
#[tauri::command]
pub async fn dialog_open_file(
    _state: State<'_, AppState>,
    app: tauri::AppHandle,
    request: Option<DialogOpenFileRequest>,
) -> CommandResult<DialogResultDto> {
    let request = request.unwrap_or_default();
    let multiple = request.multiple.unwrap_or(false);
    let mut builder = app.dialog().file();
    if let Some(filters) = request.filters {
        builder = apply_filters(builder, &filters)?;
    }
    let selection = if multiple {
        builder.blocking_pick_files()
    } else {
        builder.blocking_pick_file().map(|path| vec![path])
    };
    Ok(normalize(selection))
}

/// `dialog_open_directory`.
#[tauri::command]
pub async fn dialog_open_directory(
    _state: State<'_, AppState>,
    app: tauri::AppHandle,
    request: Option<DialogOpenDirectoryRequest>,
) -> CommandResult<DialogResultDto> {
    let request = request.unwrap_or_default();
    let mut builder = app.dialog().file().set_title(
        request
            .title
            .unwrap_or_else(|| "Choose a folder".to_string()),
    );
    if let Ok(current) = std::env::current_dir() {
        // A sensible starting point; the user can always navigate away.
        builder = builder.set_directory(current.to_string_lossy().to_string());
    }
    Ok(normalize(
        builder.blocking_pick_folder().map(|path| vec![path]),
    ))
}

/// `dialog_save_file`.
#[tauri::command]
pub async fn dialog_save_file(
    _state: State<'_, AppState>,
    app: tauri::AppHandle,
    request: Option<DialogSaveFileRequest>,
) -> CommandResult<DialogResultDto> {
    let request = request.unwrap_or_default();
    let mut builder = app.dialog().file();
    if let Some(default_path) = request.default_path {
        if !default_path.trim().is_empty() {
            builder = builder.set_file_name(sanitize_default_name(&default_path));
        }
    }
    if let Some(filters) = request.filters {
        builder = apply_filters(builder, &filters)?;
    }
    Ok(normalize(
        builder.blocking_save_file().map(|path| vec![path]),
    ))
}

/// Turn the plugin's optional selection into the frozen `DialogResultDto`.
fn normalize(selection: Option<Vec<FilePath>>) -> DialogResultDto {
    let paths: Vec<String> = selection
        .unwrap_or_default()
        .into_iter()
        .map(|path| path.to_string())
        .filter(|path| !path.trim().is_empty())
        .collect();
    DialogResultDto {
        canceled: paths.is_empty(),
        paths,
    }
}

fn apply_filters(
    mut builder: tauri_plugin_dialog::FileDialogBuilder<tauri::Wry>,
    filters: &[FileFilter],
) -> CommandResult<tauri_plugin_dialog::FileDialogBuilder<tauri::Wry>> {
    for filter in filters {
        if filter.name.trim().is_empty() {
            return Err(CommandError::validation("a file filter must have a name"));
        }
        if filter.extensions.is_empty() {
            continue;
        }
        // Extensions reach the OS panel, so they are validated as a plain list of
        // alphanumeric tokens: no globs, no paths, no separators.
        let mut owned: Vec<&str> = Vec::with_capacity(filter.extensions.len());
        for extension in &filter.extensions {
            let trimmed = extension.trim().trim_start_matches('.');
            if trimmed.is_empty()
                || !trimmed
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
            {
                return Err(CommandError::validation(format!(
                    "'{extension}' is not a valid file extension"
                )));
            }
            owned.push(trimmed);
        }
        builder = builder.add_filter(filter.name.clone(), &owned);
    }
    Ok(builder)
}

/// Reduce a suggested save path to a bare file name for the panel's default.
fn sanitize_default_name(default_path: &str) -> String {
    let name = default_path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(default_path)
        .trim();
    if name.is_empty() {
        return "untitled.mp4".to_string();
    }
    crate::commands::support::sanitize_label(name, "untitled.mp4")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plugin_selection_becomes_a_dialog_result() {
        let none = normalize(None);
        assert!(none.canceled);
        assert!(none.paths.is_empty());

        let empty = normalize(Some(Vec::new()));
        assert!(empty.canceled);

        // Paths that were returned are never reported as canceled.
        let dto = normalize(Some(vec![FilePath::Path(std::path::PathBuf::from(
            "/Users/x/out.mp4",
        ))]));
        assert!(!dto.canceled);
        assert_eq!(dto.paths, vec!["/Users/x/out.mp4".to_string()]);
    }

    #[test]
    fn default_save_names_are_single_segments() {
        assert_eq!(
            sanitize_default_name("/Users/x/Movies/final.mp4"),
            "final.mp4"
        );
        assert_eq!(
            sanitize_default_name("C:\\Users\\x\\final.mp4"),
            "final.mp4"
        );
        assert_eq!(sanitize_default_name(""), "untitled.mp4");
        assert_eq!(sanitize_default_name("   "), "untitled.mp4");
        assert_eq!(sanitize_default_name("../../evil.mp4"), "evil.mp4");
        // No separator survives.
        for input in ["a/b.mp4", "a\\b.mp4", "../x", "/etc/passwd"] {
            let name = sanitize_default_name(input);
            assert!(!name.contains('/'), "{input} -> {name}");
            assert!(!name.contains('\\'), "{input} -> {name}");
        }
    }

    #[test]
    fn filter_extensions_are_restricted_to_alphanumerics() {
        for good in ["mp4", ".mov", "wav", "M4A"] {
            let trimmed = good.trim().trim_start_matches('.');
            assert!(trimmed
                .chars()
                .all(|character| character.is_ascii_alphanumeric()));
        }
        for bad in ["*", "a/b", "a\\b", "..", "m p4", "m*p4"] {
            let trimmed = bad.trim().trim_start_matches('.');
            assert!(
                trimmed.is_empty()
                    || !trimmed
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric()),
                "{bad} should be rejected"
            );
        }
    }
}
