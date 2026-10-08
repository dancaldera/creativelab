//! Workspace scoping — the security-critical path validator.
//!
//! PRD §13 requires that native IPC be "allowlisted, scopes file permissions to approved
//! workspace paths and validates all command arguments". `packages/core/src/workspace.ts`
//! is the reference implementation (`assertSafeRelativePath` / `isInside` / `safeJoin`);
//! this module mirrors those rules for the Rust side.
//!
//! ## Why `canonicalize` and not a string prefix check
//!
//! A string check (`resolved.starts_with(root)`) is defeated by a symlink that lives
//! *inside* the workspace but points outside it: the joined path is textually inside, yet
//! the bytes on disk are not. [`WorkspaceScope::scope`] therefore canonicalizes both the
//! workspace root and the resolved candidate and re-checks containment on the real
//! (symlink-free) paths — see the `rejects_symlink_escape` test.
//!
//! ## The ALLOWED_COMMANDS allowlist
//!
//! [`ALLOWED_COMMANDS`] is byte-for-byte the same list as `IPC_COMMANDS` in
//! `apps/desktop/src/bridge/protocol.ts`. Tauri's `invoke_handler` is *already* a
//! compile-time allowlist (an unregistered command cannot be invoked at all), so this
//! list is the belt-and-braces second control: it lets Rust reject a name before any
//! handler logic runs, and the `allowlist_matches_protocol_ts` test fails the build if
//! the two lists ever drift.

use std::path::{Component, Path, PathBuf};

use crate::error::CommandError;

/// Every command the renderer may invoke. **Must equal `IPC_COMMANDS` in protocol.ts.**
pub const ALLOWED_COMMANDS: &[&str] = &[
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
];

/// Reject any command name that is not on the allowlist.
pub fn assert_command_allowed(command: &str) -> Result<(), CommandError> {
    if ALLOWED_COMMANDS.contains(&command) {
        return Ok(());
    }
    Err(CommandError::validation(format!(
        "command '{command}' is not on the IPC allowlist"
    )))
}

/// A path argument was rejected. Always maps to the `io` category, matching
/// `UnsafePathError` in `packages/core/src/errors.ts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathError {
    pub label: String,
    pub reason: String,
    pub candidate: String,
}

impl std::fmt::Display for PathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}: {}", self.label, self.reason, self.candidate)
    }
}

impl std::error::Error for PathError {}

impl From<PathError> for serde_json::Value {
    fn from(value: PathError) -> Self {
        serde_json::json!({
            "label": value.label,
            "reason": value.reason,
            "candidate": value.candidate,
        })
    }
}

fn reject(label: &str, reason: &str, candidate: &str) -> PathError {
    PathError {
        label: label.to_string(),
        reason: reason.to_string(),
        candidate: candidate.to_string(),
    }
}

/// True when the string contains a byte a filesystem path must never contain.
pub fn has_nul(value: &str) -> bool {
    value.contains('\0')
}

/// True when the string contains an ASCII control character, mirroring
/// `CONTROL_CHARS = /[\u0000-\u001f\u007f]/` in core.
pub fn has_control_char(value: &str) -> bool {
    value.chars().any(|c| c.is_ascii_control() || c == '\u{7f}')
}

/// True for `C:`-style drive prefixes, mirroring `/^[a-zA-Z]:/` in core.
fn has_drive_letter(value: &str) -> bool {
    let mut chars = value.chars();
    match (chars.next(), chars.next()) {
        (Some(letter), Some(':')) => letter.is_ascii_alphabetic(),
        _ => false,
    }
}

/// Mirror of core's `assertSafeRelativePath`.
///
/// Rejects absolute paths, drive letters, backslashes, control characters, NUL bytes and
/// `..` traversal; returns the normalized POSIX-style relative path.
pub fn validate_relative_path(candidate: &str, label: &str) -> Result<String, PathError> {
    if candidate.is_empty() {
        return Err(reject(label, "must be a non-empty string", candidate));
    }
    if has_control_char(candidate) || has_nul(candidate) {
        return Err(reject(label, "contains control characters", candidate));
    }
    if candidate.contains('\\') {
        return Err(reject(label, "must use forward slashes", candidate));
    }
    if candidate.starts_with('/') || Path::new(candidate).is_absolute() {
        return Err(reject(
            label,
            "must be relative, received an absolute path",
            candidate,
        ));
    }
    if has_drive_letter(candidate) {
        return Err(reject(label, "must not contain a drive letter", candidate));
    }
    let mut segments: Vec<&str> = Vec::new();
    for segment in candidate.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err(reject(label, "escapes the workspace via \"..\"", candidate));
        }
        if segment.contains('\0') {
            return Err(reject(label, "contains a NUL byte", candidate));
        }
        segments.push(segment);
    }
    if segments.is_empty() {
        // `.` or `./` — core normalizes this to the empty string, which `safeJoin`
        // rejects. Keeping the empty result would silently resolve to the root, so be
        // explicit: an empty normalized path means "the workspace root" and callers that
        // need a file must say so.
        return Ok(String::new());
    }
    Ok(segments.join("/"))
}

/// Validate a single path segment that is used to *build* a new file name.
///
/// User-supplied labels (project titles, export labels, asset file names) become
/// directory entries. Anything that could escape the directory it is placed in is
/// refused rather than silently rewritten, so the caller can surface a real error.
pub fn validate_file_name(candidate: &str, label: &str) -> Result<String, PathError> {
    if candidate.is_empty() {
        return Err(reject(label, "must be a non-empty file name", candidate));
    }
    if has_control_char(candidate) {
        return Err(reject(label, "contains control characters", candidate));
    }
    if candidate.contains('/') || candidate.contains('\\') {
        return Err(reject(
            label,
            "must not contain a path separator",
            candidate,
        ));
    }
    if candidate == "." || candidate == ".." {
        return Err(reject(
            label,
            "must not be a relative directory reference",
            candidate,
        ));
    }
    if Path::new(candidate).is_absolute() || has_drive_letter(candidate) {
        return Err(reject(label, "must not be an absolute path", candidate));
    }
    if candidate.trim_end() != candidate {
        return Err(reject(label, "must not end in whitespace", candidate));
    }
    Ok(candidate.to_string())
}

/// Collapse `.` segments and repeated separators without touching `..`.
///
/// Component-wise on purpose: string replacement would corrupt a legitimate name such as
/// `assets/a..b/c.png`.
fn normalize_components(candidate: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for part in candidate.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        out.push(part);
    }
    out.join("/")
}

/// A workspace root that every path argument is resolved against.
///
/// Cheap to clone (one `PathBuf`), which lets commands lift the root out of the mutex
/// before doing any IO.
#[derive(Debug, Clone)]
pub struct WorkspaceScope {
    root: PathBuf,
}

impl WorkspaceScope {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The canonicalized root, or an error when the workspace does not exist.
    pub fn canonical_root(&self) -> Result<PathBuf, PathError> {
        std::fs::canonicalize(&self.root).map_err(|error| {
            reject(
                "workspaceRoot",
                &format!("could not be resolved ({error})"),
                &self.root.display().to_string(),
            )
        })
    }

    /// Resolve a workspace-relative path to an absolute, symlink-safe path.
    ///
    /// Steps, in order:
    ///  1. reject empty / NUL / control characters / absolute / drive letters / `..`;
    ///  2. canonicalize the workspace root;
    ///  3. canonicalize the deepest existing ancestor of the candidate and re-append the
    ///     missing tail (so a path to a not-yet-created cache file still works);
    ///  4. verify the real path is still inside the real root.
    pub fn scope(&self, workspace_root: &Path, candidate: &str) -> Result<PathBuf, PathError> {
        let normalized = validate_relative_path(candidate, "path")?;
        let root = std::fs::canonicalize(workspace_root).map_err(|error| {
            reject(
                "workspaceRoot",
                &format!("could not be resolved ({error})"),
                &workspace_root.display().to_string(),
            )
        })?;

        if normalized.is_empty() {
            return Ok(root);
        }

        let joined = root.join(&normalized);
        let resolved = canonicalize_allowing_missing(&joined)?;
        if !is_inside(&root, &resolved) {
            return Err(reject("path", "resolves outside the workspace", candidate));
        }
        Ok(resolved)
    }

    /// Resolve with `self.root()` as the workspace root.
    pub fn resolve(&self, candidate: &str) -> Result<PathBuf, PathError> {
        self.scope(&self.root.clone(), candidate)
    }

    /// Resolve a path that *may* point outside the workspace root but is still a
    /// deliberate, user-chosen absolute location (a save panel result).
    ///
    /// The renderer can only obtain such a path by going through a native dialog, and
    /// even then the value is re-validated here: no NUL bytes, no control characters,
    /// non-empty, an existing parent directory, and a sane final component.
    pub fn resolve_absolute_file(
        &self,
        candidate: &str,
        label: &str,
    ) -> Result<PathBuf, PathError> {
        if candidate.is_empty() {
            return Err(reject(label, "must be a non-empty path", candidate));
        }
        if has_nul(candidate) || has_control_char(candidate) {
            return Err(reject(label, "contains control characters", candidate));
        }
        let path = Path::new(candidate);
        if !path.is_absolute() {
            return Err(reject(
                label,
                "must be an absolute path (use the native dialog)",
                candidate,
            ));
        }
        let name = path
            .file_name()
            .ok_or_else(|| reject(label, "must name a file", candidate))?
            .to_string_lossy()
            .to_string();
        validate_file_name(&name, label)?;
        let parent = path
            .parent()
            .ok_or_else(|| reject(label, "must have a parent directory", candidate))?;
        std::fs::canonicalize(parent).map_err(|error| {
            reject(
                label,
                &format!("parent directory does not exist ({error})"),
                candidate,
            )
        })?;
        Ok(PathBuf::from(normalize_components(&path.to_string_lossy())))
    }

    /// Resolve an absolute directory the user picked in the native dialog.
    pub fn resolve_absolute_dir(&self, candidate: &str, label: &str) -> Result<PathBuf, PathError> {
        if candidate.is_empty() {
            return Err(reject(label, "must be a non-empty path", candidate));
        }
        if has_nul(candidate) || has_control_char(candidate) {
            return Err(reject(label, "contains control characters", candidate));
        }
        let path = Path::new(candidate);
        if !path.is_absolute() {
            return Err(reject(
                label,
                "must be an absolute path (use the native dialog)",
                candidate,
            ));
        }
        match std::fs::canonicalize(path) {
            Ok(real) if real.is_dir() => Ok(real),
            Ok(_) => Err(reject(label, "must be a directory", candidate)),
            Err(error) => Err(reject(
                label,
                &format!("does not exist ({error})"),
                candidate,
            )),
        }
    }
}

/// `true` when `target` is `root` itself or lives beneath it. Component-wise on the
/// *canonical* paths, so symlinks have already been resolved by the caller.
pub fn is_inside(root: &Path, target: &Path) -> bool {
    if root == target {
        return true;
    }
    match target.strip_prefix(root) {
        Ok(rest) => !rest.as_os_str().is_empty(),
        Err(_) => false,
    }
}

/// Canonicalize a path that may not exist yet by resolving its deepest existing
/// ancestor and re-appending the missing tail.
///
/// The tail is checked for `..` and absolute components first, so appending it cannot
/// climb out of the ancestor we just validated.
fn canonicalize_allowing_missing(target: &Path) -> Result<PathBuf, PathError> {
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    let mut current: &Path = target;
    loop {
        match std::fs::canonicalize(current) {
            Ok(mut real) => {
                for component in tail.iter().rev() {
                    let value = component.to_string_lossy();
                    // A parent-directory or absolute component here would mean the tail
                    // could climb back out of the ancestor that was just validated.
                    if value == ".." || Path::new(value.as_ref()).is_absolute() {
                        return Err(reject(
                            "path",
                            "contains an unexpected parent traversal",
                            &target.display().to_string(),
                        ));
                    }
                    real.push(value.as_ref());
                }
                return Ok(real);
            }
            Err(_) => {
                let name = current.file_name().ok_or_else(|| {
                    reject(
                        "path",
                        "has no existing ancestor directory",
                        &target.display().to_string(),
                    )
                })?;
                tail.push(name);
                current = current.parent().ok_or_else(|| {
                    reject(
                        "path",
                        "has no existing ancestor directory",
                        &target.display().to_string(),
                    )
                })?;
            }
        }
    }
}

/// Normalize a raw path for comparison: reject `..` and `.` components textually.
///
/// Used by the workspace-scoped *delete* paths, where a mistake is unrecoverable. Returns
/// the cleaned path or an error naming the offending component.
pub fn assert_no_parent_traversal(candidate: &Path, label: &str) -> Result<PathBuf, PathError> {
    let mut out = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::ParentDir => {
                return Err(reject(
                    label,
                    "contains a parent-directory component",
                    &candidate.display().to_string(),
                ))
            }
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) => out.push(component.as_os_str()),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Every command in `IPC_COMMANDS` (protocol.ts), transcribed as a fixture.
    ///
    /// The `allowlist_matches_protocol_ts` test below re-parses the real file; this const
    /// keeps the "accepts every allowlisted name" test independent of the parser.
    const EXPECTED: &[&str] = &[
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
    ];

    fn temp_workspace(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "creativelab-scope-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        // Canonicalize so the assertion compares real paths (macOS /var -> /private/var).
        fs::canonicalize(&base).unwrap()
    }

    #[test]
    fn rejects_parent_traversal() {
        let root = temp_workspace("traversal");
        let scope = WorkspaceScope::new(&root);
        for candidate in [
            "../etc/passwd",
            "a/../../b",
            "..",
            "assets/../../../../etc/passwd",
        ] {
            let error = scope.scope(&root, candidate).unwrap_err();
            assert!(
                error.reason.contains("..") || error.reason.contains("escapes the workspace"),
                "candidate {candidate} produced {error}"
            );
        }
    }

    #[test]
    fn rejects_absolute_paths() {
        let root = temp_workspace("absolute");
        let scope = WorkspaceScope::new(&root);
        for candidate in ["/etc/passwd", "/tmp/evil"] {
            let error = scope.scope(&root, candidate).unwrap_err();
            assert!(error.reason.contains("must be relative"), "{error}");
        }
    }

    #[test]
    fn rejects_nul_bytes() {
        let root = temp_workspace("nul");
        let scope = WorkspaceScope::new(&root);
        let error = scope.scope(&root, "assets/ori\0ginals/a.png").unwrap_err();
        assert!(error.reason.contains("control characters"), "{error}");
        let error = validate_relative_path("a\0b", "path").unwrap_err();
        assert!(error.reason.contains("control characters"), "{error}");
    }

    #[test]
    fn rejects_backslashes_and_drive_letters() {
        let root = temp_workspace("windows");
        let scope = WorkspaceScope::new(&root);
        assert!(scope.scope(&root, "assets\\evil").is_err());
        assert!(scope.scope(&root, "C:/Windows/System32").is_err());
        assert!(scope.scope(&root, "c:evil").is_err());
    }

    #[test]
    fn rejects_empty_paths() {
        let root = temp_workspace("empty");
        let scope = WorkspaceScope::new(&root);
        assert!(scope.scope(&root, "").is_err());
    }

    /// The core symlink-escape test: a link *inside* the workspace pointing outside it.
    /// A string prefix check would accept this; canonicalization must not.
    #[test]
    fn rejects_symlink_escape() {
        let root = temp_workspace("symlink-root");
        let outside = temp_workspace("symlink-outside");
        fs::write(outside.join("secret.txt"), b"classified").unwrap();

        let link = root.join("escape");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let scope = WorkspaceScope::new(&root);
        let error = scope.scope(&root, "escape/secret.txt").unwrap_err();
        assert!(
            error.reason.contains("resolves outside the workspace"),
            "symlink escape was not rejected: {error}"
        );

        // A symlinked *file* is the same attack through a different door.
        let file_link = root.join("secret-link.txt");
        std::os::unix::fs::symlink(outside.join("secret.txt"), &file_link).unwrap();
        let error = scope.scope(&root, "secret-link.txt").unwrap_err();
        assert!(
            error.reason.contains("resolves outside the workspace"),
            "{error}"
        );
    }

    #[test]
    fn accepts_a_legitimate_nested_relative_path() {
        let root = temp_workspace("nested");
        fs::create_dir_all(root.join("assets/generated/image")).unwrap();
        fs::write(root.join("assets/generated/image/shot.png"), b"png").unwrap();

        let scope = WorkspaceScope::new(&root);
        let resolved = scope
            .scope(&root, "assets/generated/image/shot.png")
            .expect("legitimate path must resolve");
        assert_eq!(resolved, root.join("assets/generated/image/shot.png"));

        // Redundant separators and `.` are folded, not rejected.
        let same = fs::canonicalize(root.join("assets/generated/image/shot.png")).unwrap();
        assert_eq!(
            scope
                .scope(&root, "./assets//generated/./image/shot.png")
                .unwrap(),
            same
        );

        // Whitespace inside a name is fine; only `..` is not.
        assert!(scope.scope(&root, "assets/originals/my clip 1.mov").is_ok());
    }

    #[test]
    fn allows_a_not_yet_existing_file_below_the_root() {
        let root = temp_workspace("missing-file");
        let scope = WorkspaceScope::new(&root);
        let resolved = scope
            .scope(&root, "cache/thumbnails/new.png")
            .expect("a not-yet-created cache file must resolve");
        assert_eq!(resolved, root.join("cache/thumbnails/new.png"));
        assert!(scope.scope(&root, "cache/../../outside.png").is_err());
    }

    #[test]
    fn assert_command_allowed_accepts_every_allowlisted_name() {
        for command in ALLOWED_COMMANDS {
            assert_command_allowed(command).unwrap_or_else(|error| {
                panic!("allowlisted command {command} was rejected: {error}")
            });
        }
        assert_eq!(ALLOWED_COMMANDS.len(), EXPECTED.len());
        for command in EXPECTED {
            assert!(
                ALLOWED_COMMANDS.contains(command),
                "{command} missing from allowlist"
            );
        }
    }

    #[test]
    fn assert_command_allowed_rejects_unknown_names() {
        for command in [
            "",
            "shell_exec",
            "project_delete",
            "PROJECT_SAVE",
            "fs_read",
            "..",
        ] {
            let error = assert_command_allowed(command).unwrap_err();
            assert!(
                error.message.contains("not on the IPC allowlist"),
                "{error}"
            );
        }
    }

    /// Parse the frozen protocol file and prove the Rust allowlist has not drifted.
    #[test]
    fn allowlist_matches_protocol_ts() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/bridge/protocol.ts");
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) => panic!("could not read {}: {error}", path.display()),
        };
        let start = text
            .find("export const IPC_COMMANDS")
            .expect("IPC_COMMANDS not found in protocol.ts");
        let opening = text[start..].find('[').expect("no array literal") + start;
        let closing = text[opening..].find("] as const").expect("no array end") + opening;
        let body = &text[opening + 1..closing];
        let from_ts: Vec<String> = body
            .split(',')
            .map(|entry| {
                entry
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string()
            })
            .filter(|entry| !entry.is_empty())
            .collect();
        let from_rust: Vec<String> = ALLOWED_COMMANDS.iter().map(|c| c.to_string()).collect();
        assert_eq!(
            from_rust, from_ts,
            "ALLOWED_COMMANDS drifted from protocol.ts"
        );
    }

    #[test]
    fn resolves_absolute_files_only_with_an_existing_parent() {
        let root = temp_workspace("absolute-file");
        let scope = WorkspaceScope::new(&root);
        let target = root.join("export.mp4");
        let resolved = scope
            .resolve_absolute_file(target.to_str().unwrap(), "outputPath")
            .unwrap();
        assert_eq!(resolved, target);
        assert!(scope
            .resolve_absolute_file("/definitely/not/here/out.mp4", "outputPath")
            .is_err());
        assert!(scope
            .resolve_absolute_file("relative.mp4", "outputPath")
            .is_err());
    }

    #[test]
    fn assert_no_parent_traversal_flags_parent_components() {
        assert!(assert_no_parent_traversal(Path::new("/a/b/../c"), "path").is_err());
        assert_eq!(
            assert_no_parent_traversal(Path::new("/a/./b/c"), "path").unwrap(),
            PathBuf::from("/a/b/c")
        );
    }

    #[test]
    fn validate_file_name_rejects_separators_and_reserved_names() {
        assert_eq!(
            validate_file_name("shot 01.mp4", "label").unwrap(),
            "shot 01.mp4"
        );
        assert!(validate_file_name("a/b", "label").is_err());
        assert!(validate_file_name("a\\b", "label").is_err());
        assert!(validate_file_name("..", "label").is_err());
        assert!(validate_file_name("", "label").is_err());
        assert!(validate_file_name("trailing ", "label").is_err());
    }
}
