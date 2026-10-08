//! Shared helpers for the command modules.

pub use crate::error::{CommandError, CommandResult};

/// The six commands in `IPC_COMMANDS` that legitimately resolve a path the user chose in a
/// native dialog rather than a workspace-relative path. They are listed here so the
/// exception is explicit and greppable rather than implied. Every other path argument goes
/// through [`crate::security::WorkspaceScope`].
pub const ABSOLUTE_PATH_COMMANDS: &[&str] = &[
    "project_create",  // workspacePath: a directory the user picked
    "project_open",    // workspacePath: a directory the user picked
    "project_package", // destinationPath: a save-panel result
    "render_start",    // outputPath: a save-panel result
    "asset_import",    // sourcePaths: files the user picked
    "asset_relink",    // newPath: a file the user picked
];

/// Collapse a caller-visible label into something safe to use as a directory name.
///
/// Mirrors `sanitizeFileName` in `packages/core/src/workspace.ts` closely enough for
/// backup and package folder names; anything that would escape its parent is replaced
/// rather than rejected, because these are cosmetic labels.
pub fn sanitize_label(name: &str, fallback: &str) -> String {
    let mut cleaned: String = name
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            other if other.is_control() => '\u{0}',
            other => other,
        })
        .filter(|character| *character != '\u{0}')
        .collect();
    cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    cleaned = cleaned.trim().to_string();
    while cleaned.starts_with('.') {
        cleaned.remove(0);
    }
    cleaned = cleaned.trim_end_matches(['.', ' ']).to_string();
    if cleaned.is_empty() {
        cleaned = fallback.to_string();
    }
    if cleaned.len() > 180 {
        cleaned.truncate(180);
    }
    cleaned
}

/// A timestamp fragment usable in a directory name: `2024-01-01T00-00-00-000Z`.
pub fn timestamp_fragment() -> String {
    crate::db::migrate::now_iso8601().replace([':', '.'], "-")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::ALLOWED_COMMANDS;

    #[test]
    fn path_exceptions_are_real_commands() {
        for command in ABSOLUTE_PATH_COMMANDS {
            assert!(
                ALLOWED_COMMANDS.contains(command),
                "{command} is not an allowlisted command"
            );
        }
    }

    #[test]
    fn sanitize_label_neutralizes_directory_traversal() {
        assert_eq!(sanitize_label("My Project", "backup"), "My Project");
        // Mirrors `sanitizeFileName` in core: separators become `-` and *leading* dots are
        // stripped, so `../../x` collapses to something with no traversal in it.
        assert_eq!(
            sanitize_label("../../etc/passwd", "backup"),
            "-..-etc-passwd"
        );
        assert_eq!(sanitize_label("a/b\\c", "backup"), "a-b-c");
        assert_eq!(sanitize_label("", "backup"), "backup");
        assert_eq!(sanitize_label("   ", "backup"), "backup");
        assert_eq!(sanitize_label("...", "backup"), "backup");
        assert_eq!(sanitize_label("trailing.  ", "backup"), "trailing");
        assert_eq!(sanitize_label(&"x".repeat(400), "backup").len(), 180);
        // The security property that actually matters: no separator survives, and the
        // result is never `.` or `..`.
        for input in [
            "../..",
            "a/b",
            "..\\..",
            "/absolute",
            "C:\\Windows",
            "....",
            "./.",
        ] {
            let cleaned = sanitize_label(input, "backup");
            assert!(!cleaned.contains('/'), "{input} -> {cleaned}");
            assert!(!cleaned.contains('\\'), "{input} -> {cleaned}");
            assert!(cleaned != "." && cleaned != "..", "{input} -> {cleaned}");
            assert!(!cleaned.is_empty(), "{input} -> empty");
        }
    }

    #[test]
    fn timestamp_fragment_is_a_single_safe_segment() {
        let fragment = timestamp_fragment();
        assert!(!fragment.contains(':'));
        assert!(!fragment.contains('/'));
        assert!(fragment.ends_with('Z'), "{fragment}");
        assert_eq!(fragment.len(), 24, "{fragment}");
    }
}
