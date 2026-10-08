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

use regex::Regex;
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
/// misconfigured provider can echo the key back, so three patterns are redacted:
///
///  1. named headers and key/value pairs — `Authorization: Bearer x`,
///     `x-api-key: x`, `api_key=x`, `cookie=…`, `token=…`, `secret=…`, `password=…` —
///     keeping the label so the message still reads;
///  2. bare provider key literals anywhere in free text (`sk-…`, `xi-…`, `rk-…`, `pk-…`);
///  3. a lone `Bearer <token>` with no header name in front of it.
///
/// Redaction is the *safe direction*: a false positive costs readability, a false negative
/// leaks a live key into a renderer-visible error, a log and a crash report.
pub fn sanitize(message: &str) -> String {
    let (named, literals, bearer) = redaction_patterns();
    let named_redacted = named.replace_all(message, "${1}: [redacted]");
    let bearer_redacted = bearer.replace_all(&named_redacted, "Bearer [redacted]");
    literals
        .replace_all(&bearer_redacted, "[redacted]")
        .into_owned()
}

/// The three redaction patterns, compiled once.
fn redaction_patterns() -> &'static (Regex, Regex, Regex) {
    static PATTERNS: std::sync::OnceLock<(Regex, Regex, Regex)> = std::sync::OnceLock::new();
    PATTERNS.get_or_init(|| {
        (
            // 1. `Name: value` / `name=value` for header- and key-shaped names. The value is
            //    a single non-whitespace run, optionally preceded by a `Bearer` scheme word,
            //    so `Authorization: Bearer sk-…` is redacted in one match.
            Regex::new(
                r"(?i)\b(authorization|x-api-key|xi-api-key|api[-_]?key|cookie|token|secret|password|passwd|bearer)\b[ \t]*[:=]?[ \t]*(?:Bearer[ \t]+)?\S+",
            )
            .expect("static redaction regex"),
            // 2. A bare provider key literal anywhere in free text, even with no label.
            Regex::new(r"\b(?:sk|xi|rk|pk)-[A-Za-z0-9_-]{8,}\b")
                .expect("static redaction regex"),
            // 3. A lone `Bearer <token>` with no header name in front of it.
            Regex::new(r"(?i)\bBearer[ \t]+\S+").expect("static redaction regex"),
        )
    })
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
        // `serde_json::Map` is a `BTreeMap`, so the serialized key order is alphabetical;
        // assert on the set of keys, not on declaration order.
        let mut keys: Vec<&String> = value.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, vec!["category", "details", "message", "retryable"]);
        assert_eq!(
            value.as_object().unwrap().len(),
            4,
            "exactly four wire fields"
        );
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
        // The negative assertions are the ones that matter: a redaction test that only looks
        // for `[redacted]` can pass while the secret sits right next to it.
        assert!(!cleaned.contains("sk-live-abc123"), "{cleaned}");
        assert!(!cleaned.contains("topsecret"), "{cleaned}");
        assert!(cleaned.contains("[redacted]"), "{cleaned}");
        // The labels survive so the message is still diagnosable.
        assert!(cleaned.contains("Authorization: [redacted]"), "{cleaned}");
        assert!(cleaned.contains("api_key: [redacted]"), "{cleaned}");
        assert!(!cleaned.contains("Bearer sk-live"), "{cleaned}");
    }

    /// A key echoed as free text, with no header name anywhere near it.
    #[test]
    fn redacts_bare_key_literals_in_free_text() {
        for secret in [
            "sk-live-abc123456",
            "sk-proj_ABCdef1234567890",
            "xi-abcdefgh12345678",
            "rk-0123456789abcdef",
            "pk-live_0123456789",
        ] {
            let cleaned = sanitize(&format!("upstream said: {secret} is invalid"));
            assert!(!cleaned.contains(secret), "{cleaned}");
            assert!(cleaned.contains("[redacted]"), "{cleaned}");
        }
        // A short or unrelated token is left alone: this is a heuristic, not a filter that
        // mangles every message.
        assert_eq!(
            sanitize("clip clp_1 references unknown track"),
            "clip clp_1 references unknown track"
        );
        assert_eq!(sanitize("sk-abc"), "sk-abc", "too short to be a key");
    }

    #[test]
    fn redacts_every_credential_header_and_key_name() {
        for (input, secret) in [
            ("x-api-key: abcdefghijklmnop", "abcdefghijklmnop"),
            ("xi-api-key=abcdefghijklmnop", "abcdefghijklmnop"),
            ("api-key: abcdefghijklmnop", "abcdefghijklmnop"),
            ("apikey=abcdefghijklmnop", "abcdefghijklmnop"),
            ("cookie: session=abcdefghijklmnop", "abcdefghijklmnop"),
            ("token: abcdefghijklmnop", "abcdefghijklmnop"),
            ("secret=abcdefghijklmnop", "abcdefghijklmnop"),
            ("password: hunter2hunter2", "hunter2hunter2"),
            ("passwd=hunter2hunter2", "hunter2hunter2"),
            ("Bearer abcdefghijklmnop", "abcdefghijklmnop"),
            ("AUTHORIZATION: bearer TOKENVALUE12345", "TOKENVALUE12345"),
        ] {
            let cleaned = sanitize(input);
            assert!(!cleaned.contains(secret), "{input} -> {cleaned}");
            assert!(cleaned.contains("[redacted]"), "{input} -> {cleaned}");
        }
    }

    #[test]
    fn redaction_is_idempotent_and_leaves_clean_messages_untouched() {
        let already = sanitize("upstream returned HTTP 500");
        assert_eq!(already, "upstream returned HTTP 500");
        assert_eq!(sanitize(&already), already);
        let once = sanitize("Authorization: Bearer sk-live-abc123456");
        assert_eq!(sanitize(&once), once, "redacting twice must be stable");
    }

    #[test]
    fn unsupported_is_never_a_success() {
        let error = CommandError::unsupported("job_retry", "only listing is implemented");
        assert_eq!(error.category, ErrorCategory::Configuration);
        assert!(error.message.contains("not implemented"));
        assert!(!error.retryable);
    }
}
