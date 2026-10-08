//! One module per command group. Every function is an allowlisted `#[tauri::command]`.
//!
//! `lib.rs` registers exactly these handlers, which makes the `invoke_handler` a
//! compile-time allowlist; [`crate::security::assert_command_allowed`] is the matching
//! runtime check and `security.rs`'s `allowlist_matches_protocol_ts` test keeps the list in
//! step with `protocol.ts`.

pub mod assets;
pub mod credentials;
pub mod dialog;
pub mod jobs;
pub mod media;
pub mod project;
pub mod providers;
pub mod render;
pub mod settings;
pub mod support;
pub mod workspace;
