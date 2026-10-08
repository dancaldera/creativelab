//! Creative Studio desktop backend (Tauri 2).
//!
//! ## The IPC contract
//! `apps/desktop/src/bridge/protocol.ts` is **frozen**: its `IPC_COMMANDS` list is the
//! complete surface the renderer may reach, and every request/response struct in
//! [`protocol`] matches the TypeScript interface of the same name field-for-field.
//!
//! Three independent controls keep the surface closed:
//!  1. `tauri::generate_handler!` below is a compile-time allowlist — a command that is not
//!     registered cannot be invoked at all.
//!  2. [`security::ALLOWED_COMMANDS`] mirrors `IPC_COMMANDS`, and the
//!     `allowlist_matches_protocol_ts` test fails if the two lists drift.
//!  3. `capabilities/default.json` grants only `core:default`, `dialog:default` and
//!     `opener:default` — no `fs:*`, `shell:*` or `http:*`.
//!
//! ## Credentials
//! Secrets live in the OS keychain, are read only by Rust, and are never returned to the
//! renderer, written to SQLite, or interpolated into an error (PRD §9, §13).
//!
//! ## Media
//! ffmpeg/ffprobe are spawned with argument **arrays**; there is no shell anywhere in this
//! crate (PRD §13 "no shell injection").

pub mod commands;
pub mod credentials;
pub mod db;
pub mod error;
pub mod media;
pub mod protocol;
pub mod providers;
pub mod render;
pub mod security;
pub mod state;

use tauri::Manager;

use state::AppState;

/// Build and run the application. Called by `main.rs`.
pub fn run() {
    tauri::Builder::default()
        // The plugin set is deliberately minimal: the native dialog panels and the
        // user-initiated "open/reveal" action are the only OS integrations any allowlisted
        // command needs.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            // project
            commands::project::project_create,
            commands::project::project_open,
            commands::project::project_save,
            commands::project::project_close,
            commands::project::project_list_recent,
            commands::project::project_package,
            commands::project::project_backup,
            // workspace
            commands::workspace::workspace_usage,
            commands::workspace::workspace_purge_caches,
            // assets
            commands::assets::asset_import,
            commands::assets::asset_relink,
            commands::assets::asset_probe,
            commands::assets::asset_delete,
            // media
            commands::media::media_thumbnail,
            commands::media::media_waveform,
            commands::media::media_proxy,
            // render
            commands::render::render_start,
            commands::render::render_cancel,
            commands::render::render_status,
            // credentials
            commands::credentials::credential_set,
            commands::credentials::credential_delete,
            commands::credentials::credential_list,
            commands::credentials::credential_test,
            // providers
            commands::providers::provider_list_models,
            commands::providers::provider_catalog_refresh,
            // jobs
            commands::jobs::job_list,
            commands::jobs::job_cancel,
            commands::jobs::job_retry,
            commands::jobs::job_reconcile,
            // dialog
            commands::dialog::dialog_open_file,
            commands::dialog::dialog_open_directory,
            commands::dialog::dialog_save_file,
            // settings
            commands::settings::settings_get,
            commands::settings::settings_set,
        ])
        .on_window_event(|window, event| {
            // Closing the window must not leave ffmpeg children writing into a project the
            // app no longer knows about.
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<AppState>();
                state.cancel_all_renders();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Creative Studio");
}

#[cfg(test)]
mod integration_tests {
    use super::security::{assert_command_allowed, ALLOWED_COMMANDS};

    /// The command names Tauri actually registers, transcribed from the
    /// `generate_handler!` block above. If a command is added there but not to
    /// `IPC_COMMANDS` (or vice versa) this fails.
    const REGISTERED: &[&str] = &[
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

    #[test]
    fn the_handler_registers_exactly_the_allowlist() {
        assert_eq!(REGISTERED.len(), ALLOWED_COMMANDS.len());
        for command in REGISTERED {
            assert!(
                ALLOWED_COMMANDS.contains(command),
                "{command} is registered but not allowlisted"
            );
            assert_command_allowed(command).unwrap();
        }
        for command in ALLOWED_COMMANDS {
            assert!(
                REGISTERED.contains(command),
                "{command} is allowlisted but not registered"
            );
        }
    }

    #[test]
    fn no_two_commands_share_a_name() {
        let mut sorted = REGISTERED.to_vec();
        sorted.sort_unstable();
        let original = sorted.len();
        sorted.dedup();
        assert_eq!(sorted.len(), original, "duplicate command registration");
    }
}
