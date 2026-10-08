//! `credential_*` commands.
//!
//! Every response is a [`CredentialRefDto`] — `{ providerId, credentialRef, hasSecret }`
//! and nothing else. The secret is written straight to the OS keychain, is never stored in
//! SQLite, and is never echoed back (PRD §9, §13).

use std::time::Duration;

use tauri::State;

use crate::commands::support::CommandResult;
use crate::credentials::CredentialVault;
use crate::protocol::*;
use crate::providers;
use crate::state::AppState;

/// How long a credential check may take before it is reported as a timeout.
const TEST_TIMEOUT: Duration = Duration::from_secs(15);

/// `credential_set`.
#[tauri::command]
pub fn credential_set(
    state: State<'_, AppState>,
    request: CredentialSetRequest,
) -> CommandResult<CredentialRefDto> {
    let vault = CredentialVault::new();
    let reference = vault.set(&request.provider_id, &request.secret)?;

    // Record only the opaque handle, and only when a workspace is open: the keychain
    // entry is global, so setting a provider key before opening a project must still work.
    if state.has_workspace() {
        state.with_db(|connection| {
            crate::db::store::upsert_provider_config(
                connection,
                &crate::db::store::ProviderConfigRow {
                    id: String::new(),
                    project_id: None,
                    provider_id: request.provider_id.clone(),
                    enabled: true,
                    base_url: None,
                    credential_ref: Some(reference.credential_ref.clone()),
                    auth_scheme: match providers::descriptor(&request.provider_id) {
                        Ok(descriptor) => match descriptor.auth {
                            providers::AuthScheme::Bearer => "bearer".to_string(),
                            providers::AuthScheme::Header(_) => "header".to_string(),
                        },
                        Err(_) => "bearer".to_string(),
                    },
                    extra_headers: serde_json::json!({}),
                    created_at: String::new(),
                    updated_at: String::new(),
                },
            )?;
            Ok(())
        })?;
    }
    Ok(reference)
}

/// `credential_delete`.
#[tauri::command]
pub fn credential_delete(
    _state: State<'_, AppState>,
    request: CredentialProviderRequest,
) -> CommandResult<()> {
    let vault = CredentialVault::new();
    vault.delete(&request.provider_id)
}

/// `credential_list`: one entry per known provider, with its presence flag.
#[tauri::command]
pub fn credential_list(_state: State<'_, AppState>) -> CommandResult<Vec<CredentialRefDto>> {
    Ok(CredentialVault::new().list())
}

/// `credential_test`: one real, lightweight authenticated request per provider.
///
/// A refused key is reported as `{ ok: false, message }` rather than as a command error,
/// because "your key was rejected" is information the UI must display, not a failure of
/// the call itself.
#[tauri::command]
pub fn credential_test(
    _state: State<'_, AppState>,
    request: CredentialTestRequest,
) -> CommandResult<CredentialTestResponse> {
    let descriptor = match providers::descriptor(&request.provider_id) {
        Ok(descriptor) => descriptor,
        Err(error) => {
            return Ok(CredentialTestResponse {
                ok: false,
                message: error.message,
                latency_ms: None,
            })
        }
    };
    if let Err(error) = crate::credentials::validate_provider_id(&request.provider_id) {
        return Ok(CredentialTestResponse {
            ok: false,
            message: error.message,
            latency_ms: None,
        });
    }

    let vault = CredentialVault::new();
    let secret = match vault.fetch(&request.provider_id) {
        Ok(Some(secret)) => secret,
        Ok(None) => {
            return Ok(CredentialTestResponse {
                ok: false,
                message: format!(
                    "no credential is stored for {}; add one first",
                    descriptor.display_name
                ),
                latency_ms: None,
            })
        }
        Err(error) => {
            return Ok(CredentialTestResponse {
                ok: false,
                message: error.message,
                latency_ms: None,
            })
        }
    };

    let client = match providers::http_client(TEST_TIMEOUT) {
        Ok(client) => client,
        Err(error) => {
            return Ok(CredentialTestResponse {
                ok: false,
                message: error.message,
                latency_ms: None,
            })
        }
    };
    // The secret goes into an HTTP header here and nowhere else, and the response is a
    // boolean plus a latency.
    Ok(super::media::block_on(providers::test_credential(
        &client, descriptor, &secret,
    ))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_carry_no_field_that_could_hold_a_secret() {
        let dto = CredentialRefDto {
            provider_id: "elevenlabs".into(),
            credential_ref: crate::credentials::credential_ref("elevenlabs"),
            has_secret: true,
        };
        let serialized = serde_json::to_string(&dto).unwrap();
        assert!(!serialized.contains("\"secret\""), "{serialized}");
        assert!(!serialized.contains("\"apiKey\""), "{serialized}");
        // And the credential ref is the frozen shape, not a value.
        assert_eq!(
            dto.credential_ref,
            "keyring:com.creativelab.studio:provider:elevenlabs"
        );
    }

    #[test]
    fn credential_test_responses_are_closed_shapes() {
        let value = serde_json::to_value(CredentialTestResponse {
            ok: false,
            message: "rejected".into(),
            latency_ms: Some(120),
        })
        .unwrap();
        let mut keys: Vec<&String> = value.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, vec!["latencyMs", "message", "ok"]);
    }

    #[test]
    fn the_test_timeout_is_bounded() {
        assert!(TEST_TIMEOUT.as_secs() >= 5 && TEST_TIMEOUT.as_secs() <= 60);
    }
}
