//! `settings_*` commands, backed by the `app_settings` key/value table.
//!
//! The same table the TypeScript store uses, so a setting written by one is read by the
//! other. `value_json` holds arbitrary JSON, and `settings_get` returns `null` for a key
//! that was never set rather than an error — a first-run app has no settings.

use tauri::State;

use crate::commands::support::{CommandError, CommandResult};
use crate::db::store;
use crate::protocol::*;
use crate::state::AppState;

/// Keys that must never be written through `settings_set`.
///
/// The whole point of the keychain is that secrets are not in the database, so a key that
/// looks like it is carrying one is refused rather than stored in plaintext (PRD §13).
const FORBIDDEN_KEYS: &[&str] = &["apiKey", "secret", "token", "password", "credential"];

fn validate_key(key: &str) -> CommandResult<()> {
    if key.is_empty() {
        return Err(CommandError::validation(
            "the setting key must not be empty",
        ));
    }
    if key.len() > 200 {
        return Err(CommandError::validation("the setting key is too long"));
    }
    if key.chars().any(|character| character.is_control()) {
        return Err(CommandError::validation(
            "the setting key must not contain control characters",
        ));
    }
    let lowered = key.to_ascii_lowercase();
    for forbidden in FORBIDDEN_KEYS {
        if lowered.contains(&forbidden.to_ascii_lowercase()) {
            return Err(CommandError::validation(format!(
                "'{key}' looks like a credential; store it in the OS keychain with credential_set instead"
            )));
        }
    }
    Ok(())
}

/// `settings_get`.
#[tauri::command]
pub fn settings_get(
    state: State<'_, AppState>,
    request: SettingsGetRequest,
) -> CommandResult<SettingsGetResponse> {
    validate_key(&request.key)?;
    let value = state
        .with_db(|connection| store::get_setting(connection, &request.key))?
        .unwrap_or(serde_json::Value::Null);
    Ok(SettingsGetResponse { value })
}

/// `settings_set`.
#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, request: SettingsSetRequest) -> CommandResult<()> {
    validate_key(&request.key)?;
    state.with_db(|connection| store::set_setting(connection, &request.key, &request.value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_keys_are_accepted() {
        for key in [
            "theme",
            "recentProjects",
            "budget.dailyUsd",
            "export.presetId",
            "onboarding.complete",
        ] {
            validate_key(key).unwrap_or_else(|error| panic!("{key}: {error}"));
        }
    }

    #[test]
    fn empty_and_oversized_keys_are_rejected() {
        assert!(validate_key("").is_err());
        assert!(validate_key(&"k".repeat(201)).is_err());
        assert!(validate_key("bad\u{0}key").is_err());
        assert!(validate_key("bad\nkey").is_err());
    }

    #[test]
    fn credential_shaped_keys_are_refused() {
        for key in [
            "apiKey",
            "elevenlabs.apiKey",
            "provider.secret",
            "auth.token",
            "db.password",
            "credentialRef",
        ] {
            let error = validate_key(key).unwrap_err();
            assert!(
                error.message.contains("OS keychain"),
                "{key} produced {error}"
            );
        }
    }

    #[test]
    fn settings_responses_round_trip_arbitrary_json() {
        for value in [
            serde_json::json!(null),
            serde_json::json!(true),
            serde_json::json!(3),
            serde_json::json!("dark"),
            serde_json::json!({ "nested": { "list": [1, 2, 3] } }),
        ] {
            let response = SettingsGetResponse {
                value: value.clone(),
            };
            let serialized = serde_json::to_value(&response).unwrap();
            assert_eq!(serialized["value"], value);
        }
    }
}
