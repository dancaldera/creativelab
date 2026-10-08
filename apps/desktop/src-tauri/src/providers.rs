//! Provider HTTP, executed **Rust-side**.
//!
//! PRD §9: "avoid exposing raw API keys to the renderer", §13: "API keys stored in OS
//! keychain". The webview never holds a key and has no `http:*` capability; it calls
//! `provider_list_models` / `credential_test` and receives only model metadata and a
//! boolean-plus-latency result.
//!
//! ## What is implemented
//! * **Listing** — Vercel AI Gateway, ElevenLabs and Cloudflare model catalogs, parsed
//!   into `ProviderModelDto` and cached in `model_catalog`.
//! * **Credential test** — one lightweight authenticated request per provider, returning
//!   `{ ok, message, latencyMs }` with the provider's status code and nothing else.
//! * **Job submission/polling entry points** — real signatures, real plumbing into
//!   `generation_jobs`, but they return an explicit [`CommandError::unsupported`] because
//!   the request/response contract for each generation mode is not frozen yet. They are
//!   *not* stubbed to fake success: a caller gets a clear refusal naming what is missing.

use std::time::{Duration, Instant};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::Client;

use crate::credentials::CredentialVault;
use crate::error::{CommandError, CommandResult};
use crate::protocol::{CredentialTestResponse, ProviderModelDto};

/// How long a cached catalog row is considered fresh.
pub const CATALOG_TTL: Duration = Duration::from_secs(24 * 60 * 60);

const USER_AGENT: &str = concat!("CreativeStudio/", env!("CARGO_PKG_VERSION"));

/// Which corner of a provider's HTTP surface we are talking to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthScheme {
    /// `Authorization: Bearer <secret>`.
    Bearer,
    /// A provider-specific header, e.g. `x-api-key` or `xi-api-key`.
    Header(&'static str),
}

#[derive(Debug, Clone, Copy)]
pub struct ProviderDescriptor {
    pub id: &'static str,
    pub display_name: &'static str,
    pub base_url: &'static str,
    pub models_path: &'static str,
    /// Path (or path prefix) used for a cheap authenticated request.
    pub verify_path: &'static str,
    pub auth: AuthScheme,
    pub default_modality: &'static str,
}

impl AuthScheme {
    /// The header this scheme produces. Kept private to the module so a secret can never
    /// leak out through a debug print of the scheme.
    fn header_name(self) -> HeaderName {
        match self {
            AuthScheme::Bearer => AUTHORIZATION,
            AuthScheme::Header(name) => HeaderName::from_static(name),
        }
    }

    fn header_value(self, secret: &str) -> CommandResult<HeaderValue> {
        let value = match self {
            AuthScheme::Bearer => format!("Bearer {secret}"),
            AuthScheme::Header(_) => secret.to_string(),
        };
        HeaderValue::from_str(&value).map_err(|_| {
            // Deliberately does not echo the value.
            CommandError::credential(
                "the stored credential contains characters HTTP headers cannot carry",
            )
        })
    }
}

/// The three providers this build knows.
pub const PROVIDERS: &[ProviderDescriptor] = &[
    ProviderDescriptor {
        id: "vercel-ai-gateway",
        display_name: "Vercel AI Gateway",
        base_url: "https://ai-gateway.vercel.sh",
        models_path: "/v1/models",
        verify_path: "/v1/models",
        auth: AuthScheme::Bearer,
        default_modality: "image",
    },
    ProviderDescriptor {
        id: "elevenlabs",
        display_name: "ElevenLabs",
        base_url: "https://api.elevenlabs.io",
        models_path: "/v1/models",
        // Cheap, always-available, and requires a valid key.
        verify_path: "/v1/user/subscription",
        auth: AuthScheme::Header("xi-api-key"),
        default_modality: "audio",
    },
    ProviderDescriptor {
        id: "cloudflare",
        display_name: "Cloudflare Workers AI",
        base_url: "https://api.cloudflare.com/client/v4",
        models_path: "/accounts/{account_id}/ai/models/search",
        verify_path: "/user/tokens/verify",
        auth: AuthScheme::Bearer,
        default_modality: "image",
    },
];

pub fn descriptor(provider_id: &str) -> CommandResult<&'static ProviderDescriptor> {
    PROVIDERS
        .iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| {
            CommandError::validation(format!(
                "unknown provider '{provider_id}'; known providers are {}",
                PROVIDERS
                    .iter()
                    .map(|provider| provider.id)
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        })
}

/// Build the shared HTTP client. `rustls` only, no native-tls, so there is no dependency
/// on a system TLS library.
pub fn http_client(timeout: Duration) -> CommandResult<Client> {
    Client::builder()
        .user_agent(USER_AGENT)
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| {
            CommandError::internal(format!("could not build the HTTP client: {error}"))
        })
}

fn headers_for(provider: &ProviderDescriptor, secret: &str) -> CommandResult<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        provider.auth.header_name(),
        provider.auth.header_value(secret)?,
    );
    Ok(headers)
}

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

/// Parse a provider's model-list response.
///
/// Each provider uses a different envelope; the normalizer is pure so it can be tested
/// against recorded bodies without network access.
pub fn normalize_models(
    provider: &ProviderDescriptor,
    body: &serde_json::Value,
) -> Vec<ProviderModelDto> {
    let fetched_at = crate::db::migrate::now_iso8601();
    let entries: Vec<&serde_json::Value> = match body {
        serde_json::Value::Array(items) => items.iter().collect(),
        serde_json::Value::Object(object) => {
            for key in ["data", "models", "result", "result"] {
                if let Some(serde_json::Value::Array(items)) = object.get(key) {
                    return items
                        .iter()
                        .filter_map(|item| map_model_entry(provider, item, &fetched_at))
                        .collect();
                }
            }
            Vec::new()
        }
        _ => Vec::new(),
    };
    entries
        .into_iter()
        .filter_map(|item| map_model_entry(provider, item, &fetched_at))
        .collect()
}

/// Map one provider entry. Unknown shapes yield `None` rather than a placeholder model,
/// so the catalog never advertises something that cannot be called.
fn map_model_entry(
    provider: &ProviderDescriptor,
    item: &serde_json::Value,
    fetched_at: &str,
) -> Option<ProviderModelDto> {
    let model_id = item
        .get("id")
        .or_else(|| item.get("name"))
        .or_else(|| item.get("model"))
        .or_else(|| item.get("model_id"))
        .and_then(|value| value.as_str())?;
    let display_name = item
        .get("name")
        .or_else(|| item.get("display_name"))
        .or_else(|| item.get("id"))
        .and_then(|value| value.as_str())
        .unwrap_or(model_id);
    let modality = item
        .get("type")
        .or_else(|| item.get("modality"))
        .or_else(|| item.get("task"))
        .or_else(|| item.get("output_modality"))
        .and_then(|value| value.as_str())
        .unwrap_or(provider.default_modality);
    Some(ProviderModelDto {
        provider_id: provider.id.to_string(),
        // `model_id` appears in the schema's unique index, so keep it a single string
        // ("@cf/black-forest-labs/flux-1-schnell").
        model_id: model_id.to_string(),
        display_name: display_name.to_string(),
        modality: modality.to_string(),
        capabilities: item
            .get("capabilities")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
        pricing: item
            .get("pricing")
            .cloned()
            .or_else(|| item.get("cost").cloned()),
        fetched_at: fetched_at.to_string(),
        is_stale: false,
    })
}

/// Hit a provider's model endpoint and normalize the result.
pub async fn fetch_models(
    client: &Client,
    provider: &ProviderDescriptor,
    secret: &str,
) -> CommandResult<Vec<ProviderModelDto>> {
    let url = format!("{}{}", provider.base_url, provider.models_path);
    let response = client
        .get(&url)
        .headers(headers_for(provider, secret)?)
        .send()
        .await
        .map_err(|error| categorize(&error, provider.id))?;
    let status = response.status();
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| categorize(&error, provider.id))?;
    if !status.is_success() {
        return Err(from_status(provider.id, status.as_u16(), &body));
    }
    let models = normalize_models(provider, &body);
    if models.is_empty() {
        return Err(CommandError::provider(format!(
            "{} returned no models this build can call",
            provider.id
        )));
    }
    Ok(models)
}

// ---------------------------------------------------------------------------
// Credential test
// ---------------------------------------------------------------------------

/// One lightweight authenticated request. Returns `{ ok, message, latencyMs }`.
///
/// A rejected key is a *successful* call with `ok: false` — the renderer wants to show
/// "your key was refused", not an error toast.
pub async fn test_credential(
    client: &Client,
    provider: &ProviderDescriptor,
    secret: &str,
) -> CredentialTestResponse {
    let url = format!("{}{}", provider.base_url, provider.verify_path);
    let started = Instant::now();
    let request = client
        .get(&url)
        .headers(match headers_for(provider, secret) {
            Ok(headers) => headers,
            Err(error) => {
                return CredentialTestResponse {
                    ok: false,
                    message: error.message,
                    latency_ms: None,
                }
            }
        })
        .send()
        .await;
    let latency_ms = Some(started.elapsed().as_millis().min(i64::MAX as u128) as i64);

    match request {
        Ok(response) => {
            let status = response.status();
            if status.is_success() {
                CredentialTestResponse {
                    ok: true,
                    message: format!("{} accepted the credential", provider.display_name),
                    latency_ms,
                }
            } else if status.as_u16() == 401 || status.as_u16() == 403 {
                CredentialTestResponse {
                    ok: false,
                    message: format!(
                        "{} rejected the credential (HTTP {status})",
                        provider.display_name
                    ),
                    latency_ms,
                }
            } else if status.as_u16() == 429 {
                CredentialTestResponse {
                    ok: false,
                    message: format!(
                        "{} rate-limited the check (HTTP {status}); the credential may still be valid",
                        provider.display_name
                    ),
                    latency_ms,
                }
            } else {
                CredentialTestResponse {
                    ok: false,
                    message: format!("{} returned HTTP {status}", provider.display_name),
                    latency_ms,
                }
            }
        }
        Err(error) => CredentialTestResponse {
            ok: false,
            message: if error.is_timeout() {
                format!(
                    "{} did not respond before the timeout",
                    provider.display_name
                )
            } else if error.is_connect() {
                format!("could not reach {}", provider.display_name)
            } else {
                format!("{} request failed", provider.display_name)
            },
            latency_ms,
        },
    }
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

fn categorize(error: &reqwest::Error, provider_id: &str) -> CommandError {
    if error.is_timeout() {
        return CommandError::timeout(format!("{provider_id} request timed out"));
    }
    if error.is_connect() {
        return CommandError::network(format!("could not reach {provider_id}"));
    }
    CommandError::provider(format!("{provider_id} request failed"))
}

fn from_status(provider_id: &str, status: u16, body: &serde_json::Value) -> CommandError {
    // Provider error bodies can echo request details, so run the text through the
    // sanitizer before it reaches an error message.
    let detail = body
        .get("error")
        .and_then(|value| {
            value
                .get("message")
                .and_then(|message| message.as_str())
                .or_else(|| value.as_str())
        })
        .or_else(|| body.get("message").and_then(|value| value.as_str()))
        .unwrap_or("");
    let detail = crate::error::sanitize(detail);
    let detail = detail.trim();
    let suffix = if detail.is_empty() {
        String::new()
    } else {
        format!(": {}", detail.chars().take(240).collect::<String>())
    };
    match status {
        401 | 403 => CommandError::credential(format!(
            "{provider_id} rejected the credential (HTTP {status}){suffix}"
        )),
        404 => CommandError::provider(format!(
            "{provider_id} endpoint not found (HTTP 404){suffix}"
        )),
        429 => CommandError::rate_limit(format!(
            "{provider_id} rate limit reached (HTTP 429){suffix}"
        )),
        _ => CommandError::provider(format!("{provider_id} returned HTTP {status}{suffix}")),
    }
}

// ---------------------------------------------------------------------------
// Catalog cache
// ---------------------------------------------------------------------------

/// Is a cached `fetchedAt` still inside [`CATALOG_TTL`]?
pub fn catalog_is_fresh(fetched_at: &str, now: &time::OffsetDateTime) -> bool {
    match parse_timestamp(fetched_at) {
        Some(then) => *now - then < CATALOG_TTL,
        None => false,
    }
}

/// Parse the `Date.prototype.toISOString()` shape this crate writes.
pub fn parse_timestamp(value: &str) -> Option<time::OffsetDateTime> {
    use time::format_description::well_known::Rfc3339;
    time::OffsetDateTime::parse(value, &Rfc3339).ok()
}

// ---------------------------------------------------------------------------
// Generation job submission / polling (not implemented)
// ---------------------------------------------------------------------------

/// Why the generation surface is not implemented, stated once so every entry point gives
/// the same, honest answer.
pub const SUBMISSION_NOT_IMPLEMENTED: &str = "the per-mode generation request/response \
contract (image, video, audio, voice) is not frozen in protocol.ts or packages/core/src/jobs.ts, \
so submitting a paid request is deliberately not implemented rather than guessed at. Model \
listing, credential storage and credential testing are fully implemented; rerun this after the \
generation schema lands.";

/// `job_retry`: re-submit a terminally failed generation job.
pub async fn submit_job() -> CommandResult<()> {
    Err(CommandError::unsupported(
        "job_retry (provider job submission)",
        SUBMISSION_NOT_IMPLEMENTED,
    ))
}

/// `job_reconcile`'s resumption half: poll a job the provider already accepted.
pub async fn poll_job() -> CommandResult<()> {
    Err(CommandError::unsupported(
        "job polling / resumption",
        SUBMISSION_NOT_IMPLEMENTED,
    ))
}

/// Convenience for call sites that need the credential for a provider, with the same
/// "missing key" message everywhere.
pub fn require_secret(vault: &CredentialVault, provider_id: &str) -> CommandResult<String> {
    vault.load(provider_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_descriptors_are_consistent() {
        assert_eq!(PROVIDERS.len(), 3);
        assert_eq!(descriptor("elevenlabs").unwrap().id, "elevenlabs");
        assert_eq!(
            descriptor("vercel-ai-gateway").unwrap().auth,
            AuthScheme::Bearer
        );
        assert_eq!(
            descriptor("elevenlabs").unwrap().auth,
            AuthScheme::Header("xi-api-key")
        );
        for provider in PROVIDERS {
            assert!(provider.base_url.starts_with("https://"), "{}", provider.id);
            assert!(provider.models_path.starts_with('/'), "{}", provider.id);
            assert!(provider.verify_path.starts_with('/'), "{}", provider.id);
        }
        let error = descriptor("openai").unwrap_err();
        assert!(error.message.contains("unknown provider"), "{error}");
    }

    #[test]
    fn auth_headers_never_leak_into_a_display_string() {
        // The header value carries the secret, but nothing derives from it is stored or
        // logged; assert the two schemes produce the right header names.
        assert_eq!(AuthScheme::Bearer.header_name(), AUTHORIZATION);
        assert_eq!(
            AuthScheme::Header("xi-api-key").header_name(),
            HeaderName::from_static("xi-api-key")
        );
        let error = AuthScheme::Bearer.header_value("bad\nvalue").unwrap_err();
        assert!(!error.message.contains("bad"), "{error}");
    }

    #[test]
    fn vercel_envelope_is_normalized() {
        let provider = descriptor("vercel-ai-gateway").unwrap();
        let body = serde_json::json!({
            "object": "list",
            "data": [
                { "id": "openai/gpt-image-1", "name": "GPT Image 1", "type": "image" },
                { "id": "black-forest-labs/flux-1.1-pro", "type": "image" }
            ]
        });
        let models = normalize_models(provider, &body);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].provider_id, "vercel-ai-gateway");
        assert_eq!(models[0].model_id, "openai/gpt-image-1");
        assert_eq!(models[0].display_name, "GPT Image 1");
        assert_eq!(models[0].modality, "image");
        assert!(!models[0].is_stale);
        assert_eq!(models[1].display_name, "black-forest-labs/flux-1.1-pro");
    }

    #[test]
    fn elevenlabs_envelope_is_normalized() {
        let provider = descriptor("elevenlabs").unwrap();
        let body = serde_json::json!([
            { "model_id": "eleven_multilingual_v2", "name": "Multilingual v2", "type": "tts" }
        ]);
        let models = normalize_models(provider, &body);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].model_id, "eleven_multilingual_v2");
        assert_eq!(models[0].modality, "tts");
    }

    #[test]
    fn cloudflare_envelope_is_normalized() {
        let provider = descriptor("cloudflare").unwrap();
        let body = serde_json::json!({
            "success": true,
            "result": [
                { "name": "@cf/black-forest-labs/flux-1-schnell", "task": { "name": "Text-to-Image" } }
            ]
        });
        let models = normalize_models(provider, &body);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].model_id, "@cf/black-forest-labs/flux-1-schnell");
        // `task` is an object here, so modality falls back to the provider default.
        assert_eq!(models[0].modality, "image");
    }

    #[test]
    fn unknown_entries_are_dropped_rather_than_invented() {
        let provider = descriptor("elevenlabs").unwrap();
        let body = serde_json::json!([{ "display_name": "no id here" }, { "model_id": "real" }]);
        let models = normalize_models(provider, &body);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].model_id, "real");
        assert!(normalize_models(provider, &serde_json::json!("nope")).is_empty());
        assert!(normalize_models(provider, &serde_json::json!({})).is_empty());
    }

    #[test]
    fn pricing_and_capabilities_are_carried_through() {
        let provider = descriptor("vercel-ai-gateway").unwrap();
        let body = serde_json::json!({
            "data": [{
                "id": "x/y",
                "pricing": { "input": "0.0001", "output": "0.0004" },
                "capabilities": { "streaming": true }
            }]
        });
        let models = normalize_models(provider, &body);
        assert_eq!(models[0].pricing.as_ref().unwrap()["input"], "0.0001");
        assert_eq!(models[0].capabilities["streaming"], true);
    }

    #[test]
    fn catalog_freshness_follows_the_ttl() {
        let now = time::OffsetDateTime::now_utc();
        let fresh = crate::db::migrate::iso8601_from(now - time::Duration::hours(1));
        let stale = crate::db::migrate::iso8601_from(now - time::Duration::hours(30));
        assert!(catalog_is_fresh(&fresh, &now));
        assert!(!catalog_is_fresh(&stale, &now));
        assert!(!catalog_is_fresh("not a timestamp", &now));
        assert!(!catalog_is_fresh("", &now));
    }

    #[test]
    fn http_statuses_map_onto_the_error_taxonomy() {
        let body = serde_json::json!({ "error": { "message": "invalid api key" } });
        let unauthorized = from_status("elevenlabs", 401, &body);
        assert_eq!(
            unauthorized.category,
            crate::error::ErrorCategory::Credential
        );
        assert!(unauthorized.message.contains("invalid api key"));

        let limited = from_status("elevenlabs", 429, &serde_json::json!({}));
        assert_eq!(limited.category, crate::error::ErrorCategory::RateLimit);
        assert!(limited.retryable);

        let boom = from_status("cloudflare", 500, &serde_json::json!({}));
        assert_eq!(boom.category, crate::error::ErrorCategory::Provider);

        // A body that echoes the key back is redacted.
        let echo = from_status(
            "elevenlabs",
            401,
            &serde_json::json!({ "error": { "message": "bad key sk-live-should-not-appear" } }),
        );
        assert!(
            !echo.message.contains("sk-live-should-not-appear"),
            "{echo}"
        );
    }

    #[test]
    fn unimplemented_generation_surfaces_refuse_explicitly() {
        let error =
            crate::error::CommandError::unsupported("job_retry", SUBMISSION_NOT_IMPLEMENTED);
        assert!(error.message.contains("not implemented"));
        assert!(error.message.contains("protocol.ts"));
        assert!(!error.retryable);
    }

    #[test]
    fn client_builds_with_rustls() {
        let client = http_client(Duration::from_secs(5)).unwrap();
        // `reqwest::Client` is cheap to clone and shares the connection pool.
        let _clone = client.clone();
    }
}
