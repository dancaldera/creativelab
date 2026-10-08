//! `CommandError` — the single error type every allowlisted command returns.
//!
//! Serializes to exactly `{ category, message, retryable, details? }` so the TypeScript
//! bridge can map it onto `CreativeLabError` (see `packages/core/src/errors.ts`, whose
//! `ErrorCategory` union this mirrors one-to-one).
//!
//! ## Secrets
//! PRD §13: a credential must never reach the renderer, the database, or an error
//! message. Nothing in this type ever formats a secret; `CredentialError` variants emit
//! the provider id only, and [`CommandError::sanitize`] strips anything that looks like a
//! bearer token or API key from a provider-supplied message before it is serialized.

use serde::{Deserialize, Serialize};

use crate::security::PathError;

/// Mirrors `packages/core/src/errors.ts#ErrorCategory`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    Validation,
    Configuration,
    Credential,
    Network,
    Timeout,
    RateLimit,
    Provider,
    Budget,
    Disk,
    Media,
    Io,
    Canceled,
    Internal,
}

impl ErrorCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCategory::Validation => "validation",
            ErrorCategory::Configuration => "configuration",
            ErrorCategory::Credential => "credential",
            ErrorCategory::Network => "network",
            ErrorCategory::Timeout => "timeout",
            ErrorCategory::RateLimit => "rate_limit",
            ErrorCategory::Provider => "provider",
            ErrorCategory::Budget => "budget",
            ErrorCategory::Disk => "disk",
            ErrorCategory::Media => "media",
            ErrorCategory::Io => "io",
            ErrorCategory::Canceled => "canceled",
            ErrorCategory::Internal => "internal",
        }
    }
}

/// The wire shape. `details` is omitted entirely when empty so the TS side can
/// distinguish "no details" from "empty details".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandError {
    pub category: ErrorCategory,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl CommandError {
    pub fn new(category: ErrorCategory, message: impl Into<String>) -> Self {
        Self {
            category,
            message: sanitize(&message.into()),
            retryable: false,
            details: None,
        }
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Validation, message)
    }
    pub fn configuration(message: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Configuration, message)
    }
    pub fn credential(message: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Credential, message)
    }
    pub fn network(message: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Network, message).retryable()
    }
    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Timeout, message).retryable()
    }
    pub fn rate_limit(message: impl Into<String>) -> Self {
        Self::new(ErrorCategory::RateLimit, message).retryable()
    }
    pub fn provider(message: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Provider, message)
    }
    pub fn budget(message: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Budget, message)
    }
    pub fn disk(message: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Disk, message)
    }
    pub fn media(message: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Media, message)
    }
    pub fn io(message: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Io, message)
    }
    pub fn canceled(message: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Canceled, message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Internal, message)
    }

    /// An explicitly unimplemented surface. Never fakes success — the renderer sees a
    /// clear, actionable refusal instead of silently doing nothing.
    pub fn unsupported(what: &str, why: &str) -> Self {
        Self::new(
            ErrorCategory::Configuration,
            format!("{what} is not implemented in this build: {why}"),
        )
    }

    /// Build from an IO error, mapping the interesting `ErrorKind`s onto categories.
    pub fn from_io(context: &str, error: &std::io::Error) -> Self {
        let category = match error.kind() {
            std::io::ErrorKind::NotFound => ErrorCategory::Io,
            std::io::ErrorKind::PermissionDenied => ErrorCategory::Io,
            std::io::ErrorKind::TimedOut => ErrorCategory::Timeout,
            std::io::ErrorKind::Interrupted => ErrorCategory::Canceled,
            _ => ErrorCategory::Io,
        };
        if error.raw_os_error() == Some(28) {
            return Self::disk(format!("{context}: the disk is full"));
        }
        Self::new(category, format!("{context}: {error}"))
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.category.as_str(), self.message)
    }
}

impl std::error::Error for CommandError {}

pub type CommandResult<T> = Result<T, CommandError>;

impl From<rusqlite::Error> for CommandError {
    fn from(value: rusqlite::Error) -> Self {
        CommandError::new(ErrorCategory::Io, format!("database error: {value}"))
    }
}

impl From<serde_json::Error> for CommandError {
    fn from(value: serde_json::Error) -> Self {
        CommandError::validation(format!("invalid JSON: {value}"))
    }
}

impl From<std::io::Error> for CommandError {
    fn from(value: std::io::Error) -> Self {
        CommandError::from_io("filesystem error", &value)
    }
}

impl From<PathError> for CommandError {
    fn from(value: PathError) -> Self {
        CommandError::new(ErrorCategory::Io, value.to_string())
    }
}

impl From<time::error::Format> for CommandError {
    fn from(value: time::error::Format) -> Self {
        CommandError::internal(format!("timestamp formatting failed: {value}"))
    }
}

impl From<reqwest::Error> for CommandError {
    fn from(value: reqwest::Error) -> Self {
        if value.is_timeout() {
            return CommandError::timeout(format!("provider request timed out: {value}"));
        }
        if value.is_connect() {
            return CommandError::network(format!("could not reach provider: {value}"));
        }
        CommandError::provider(format!("provider request failed: {value}"))
    }
}

/// Strip anything that could be a live secret out of a message before it is serialized.
///
/// This is defence in depth, not the primary control: no call site ever *intends* to
/// interpolate a secret. But provider error bodies are echoed into `message`, and a
/// misconfigured provider can echo the key back, so common token shapes are redacted.
pub fn sanitize(message: &str) -> String {
    let mut out = String::with_capacity(message.len());
    for token in message.split_inclusive(char::is_whitespace) {
        let core = token.trim_end();
        let tail = &token[core.len()..];
        let lower = core.to_ascii_lowercase();
        let looks_secret = lower.starts_with("sk-")
            || lower.starts_with("sk_")
            || lower.starts_with("bearer")
            || lower.starts_with("api_key=")
            || lower.starts_with("api-key:")
            || lower.starts_with("apikey=")
            || lower.starts_with("authorization:")
            || lower.starts_with("x-api-key:");
        if looks_secret {
            // Keep the scheme name so the message still reads sensibly.
            let label = core.split([':', '=']).next().unwrap_or("token");
            out.push_str(label);
            out.push_str("[redacted]");
        } else {
            out.push_str(core);
        }
        out.push_str(tail);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_the_frozen_wire_shape() {
        let error =
            CommandError::validation("nope").with_details(serde_json::json!({ "field": "title" }));
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["category"], "validation");
        assert_eq!(value["message"], "nope");
        assert_eq!(value["retryable"], false);
        assert_eq!(value["details"]["field"], "title");
        let keys: Vec<&String> = value.as_object().unwrap().keys().collect();
        assert_eq!(keys, vec!["category", "message", "retryable", "details"]);
    }

    #[test]
    fn omits_empty_details() {
        let value = serde_json::to_value(CommandError::io("boom")).unwrap();
        assert!(value.get("details").is_none());
        assert_eq!(value["category"], "io");
    }

    #[test]
    fn redacts_bearer_tokens_and_keys() {
        let text =
            "request failed: Authorization: Bearer sk-live-abc123 rejected (api_key=topsecret)";
        let cleaned = sanitize(text);
        assert!(!cleaned.contains("sk-live-abc123"), "{cleaned}");
        assert!(!cleaned.contains("topsecret"), "{cleaned}");
        assert!(cleaned.contains("Authorization[redacted]"));
        assert!(cleaned.contains("api_key[redacted]") || cleaned.contains("api_key[redacted]"));
    }

    #[test]
    fn unsupported_is_never_a_success() {
        let error = CommandError::unsupported("job_retry", "only listing is implemented");
        assert_eq!(error.category, ErrorCategory::Configuration);
        assert!(error.message.contains("not implemented"));
        assert!(!error.retryable);
    }
}
