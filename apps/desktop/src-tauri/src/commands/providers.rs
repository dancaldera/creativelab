//! `provider_*` commands: model listing and catalog refresh.
//!
//! PRD §9: the HTTP request is made **in Rust** and only model metadata crosses back, so
//! an API key never enters the webview. The catalog is cached in `model_catalog` and
//! treated as fresh for `providers::CATALOG_TTL`; `refresh: true` (or
//! `provider_catalog_refresh`) bypasses the cache.

use std::time::Duration;

use tauri::State;

use crate::commands::support::CommandResult;
use crate::db::store;
use crate::protocol::*;
use crate::providers::{self, CATALOG_TTL};
use crate::state::AppState;

/// Budget for a model-listing request.
const LIST_TIMEOUT: Duration = Duration::from_secs(30);

/// `provider_list_models`.
#[tauri::command]
pub fn provider_list_models(
    state: State<'_, AppState>,
    request: ProviderListModelsRequest,
) -> CommandResult<ProviderListModelsResponse> {
    list_or_refresh(state, request.provider_id, request.refresh.unwrap_or(false))
}

/// `provider_catalog_refresh` — same work, always hitting the provider.
#[tauri::command]
pub fn provider_catalog_refresh(
    state: State<'_, AppState>,
    request: ProviderCatalogRefreshRequest,
) -> CommandResult<ProviderListModelsResponse> {
    list_or_refresh(state, request.provider_id, true)
}

fn list_or_refresh(
    state: State<'_, AppState>,
    provider_id: Option<String>,
    refresh: bool,
) -> CommandResult<ProviderListModelsResponse> {
    // Which providers to consider: the requested one, or all known ones.
    let selected: Vec<&'static providers::ProviderDescriptor> = match provider_id.as_deref() {
        Some(provider_id) => vec![providers::descriptor(provider_id)?],
        None => providers::PROVIDERS.iter().collect(),
    };

    let now = time::OffsetDateTime::now_utc();
    let mut models: Vec<ProviderModelDto> = Vec::new();
    let mut errors: Vec<ProviderErrorDto> = Vec::new();
    let mut refreshed_at = crate::db::migrate::now_iso8601();

    for descriptor in &selected {
        // 1. Try the cache unless a refresh was explicitly requested.
        let cached = if state.has_workspace() {
            state
                .with_db(|connection| store::list_model_catalog(connection, Some(descriptor.id)))?
        } else {
            Vec::new()
        };
        let cache_is_usable = !cached.is_empty()
            && cached
                .iter()
                .all(|entry| providers::catalog_is_fresh(&entry.fetched_at, &now));
        if !refresh && cache_is_usable {
            models.extend(cached);
            continue;
        }

        // 2. Hit the provider. A missing key is reported per provider, not as a failure of
        //    the whole call, so one unconfigured provider cannot blank the model picker.
        let vault = crate::credentials::CredentialVault::new();
        let secret = match vault.fetch(descriptor.id) {
            Ok(Some(secret)) => secret,
            Ok(None) => {
                if !cached.is_empty() {
                    // Serve stale data rather than nothing, flagged as stale.
                    models.extend(cached.into_iter().map(|mut entry| {
                        entry.is_stale = true;
                        entry
                    }));
                }
                errors.push(ProviderErrorDto {
                    provider_id: descriptor.id.to_string(),
                    message: format!(
                        "no credential stored for {}; add one to refresh its catalog",
                        descriptor.display_name
                    ),
                });
                continue;
            }
            Err(error) => {
                errors.push(ProviderErrorDto {
                    provider_id: descriptor.id.to_string(),
                    message: error.message,
                });
                continue;
            }
        };

        let client = providers::http_client(LIST_TIMEOUT)?;
        // `block_on` adds one `CommandResult` layer; the inner one is the provider's own
        // error (a rejected key, a bad envelope), which is reported per provider rather
        // than failing the whole listing.
        match super::media::block_on(providers::fetch_models(&client, descriptor, &secret))? {
            Ok(fetched) => {
                if let Some(latest) = fetched.first() {
                    refreshed_at = latest.fetched_at.clone();
                }
                if state.has_workspace() {
                    state.with_db_mut(|connection| {
                        store::upsert_model_catalog(connection, &fetched)
                    })?;
                }
                models.extend(fetched);
            }
            Err(error) => {
                // Fall back to the cache, flagged stale, and report why.
                if !cached.is_empty() {
                    models.extend(cached.into_iter().map(|mut entry| {
                        entry.is_stale = true;
                        entry
                    }));
                }
                errors.push(ProviderErrorDto {
                    provider_id: descriptor.id.to_string(),
                    message: error.message,
                });
            }
        }
    }

    // A stale flag is recomputed from the timestamp so a catalog that aged out while the
    // app was open is not reported as fresh.
    for model in &mut models {
        model.is_stale = model.is_stale || !providers::catalog_is_fresh(&model.fetched_at, &now);
    }
    models.sort_by(|left, right| {
        left.provider_id
            .cmp(&right.provider_id)
            .then(left.model_id.cmp(&right.model_id))
    });

    Ok(ProviderListModelsResponse {
        models,
        fetched_at: refreshed_at,
        errors,
    })
}

/// Exposed for the UI's "cache is N hours old" copy without another round trip.
pub const fn catalog_ttl_seconds() -> u64 {
    CATALOG_TTL.as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_ttl_is_a_day() {
        assert_eq!(catalog_ttl_seconds(), 86_400);
    }

    #[test]
    fn unknown_provider_ids_are_rejected_before_any_http() {
        let error = providers::descriptor("not-a-provider").unwrap_err();
        assert!(error.message.contains("unknown provider"), "{error}");
    }

    #[test]
    fn the_list_timeout_is_bounded() {
        assert!(LIST_TIMEOUT.as_secs() >= 10 && LIST_TIMEOUT.as_secs() <= 120);
    }
}
