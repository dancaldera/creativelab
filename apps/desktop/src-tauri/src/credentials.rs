//! OS-keychain credential vault.
//!
//! PRD §13: "API keys stored in OS keychain/secure credential store; no plaintext .env
//! inside packaged project and no keys in logs or exported projects."
//!
//! ## The three rules this module enforces
//! 1. **A secret never crosses the IPC boundary.** [`CredentialRef`] has no secret field;
//!    every command returns that shape.
//! 2. **A secret is never written to the database.** Only the opaque `credentialRef`
//!    string is stored (in `provider_configs.credential_ref` and `app_settings`).
//! 3. **A secret is never interpolated into an error.** Keyring failures are reported by
//!    service/account and error kind, never by value.
//!
//! Service name and account shape are fixed: service `com.creativelab.studio`,
//! account `provider:<providerId>`.

use keyring::Entry;

use crate::error::{CommandError, CommandResult};
use crate::protocol::CredentialRefDto;

/// The keychain service name. Changing this orphans every stored key.
pub const SERVICE: &str = "com.creativelab.studio";

/// Provider ids this build knows how to talk to.
pub const KNOWN_PROVIDERS: &[&str] = &["vercel-ai-gateway", "elevenlabs", "cloudflare"];

/// `provider:<providerId>`, the keychain account for a provider secret.
pub fn account_for(provider_id: &str) -> String {
    format!("provider:{provider_id}")
}

/// The opaque handle handed to the renderer. Contains no secret material.
pub fn credential_ref(provider_id: &str) -> String {
    format!("keyring:{SERVICE}:{}", account_for(provider_id))
}

/// Validate a provider id before it is used to build a keychain account.
///
/// The account string is a keychain key, not a path, but an unvalidated id could still
/// confuse a user reading their keychain, so restrict it to `[a-z0-9._-]`.
pub fn validate_provider_id(provider_id: &str) -> CommandResult<()> {
    if provider_id.is_empty() {
        return Err(CommandError::validation("providerId must not be empty"));
    }
    if provider_id.len() > 64 {
        return Err(CommandError::validation("providerId is too long"));
    }
    if !provider_id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'))
    {
        return Err(CommandError::validation(
            "providerId must be lowercase alphanumeric with '-', '_' or '.'",
        ));
    }
    Ok(())
}

/// Reject a secret that cannot be a real API key, before it reaches the keychain.
///
/// This is a sanity check, not a strength check: empty and whitespace-only values are the
/// ones that silently break every later request.
pub fn validate_secret(secret: &str) -> CommandResult<()> {
    if secret.trim().is_empty() {
        return Err(CommandError::validation("the API key must not be empty"));
    }
    if secret.len() > 8192 {
        return Err(CommandError::validation("the API key is implausibly long"));
    }
    if secret
        .chars()
        .any(|c| c == '\0' || (c.is_control() && c != '\n' && c != '\r' && c != '\t'))
    {
        return Err(CommandError::validation(
            "the API key contains control characters",
        ));
    }
    Ok(())
}

/// Keyring error text that never echoes the secret.
fn describe(provider_id: &str, error: &keyring::Error) -> CommandError {
    match error {
        keyring::Error::NoEntry => {
            CommandError::credential(format!("no stored credential for provider '{provider_id}'"))
        }
        keyring::Error::Ambiguous(_) => CommandError::credential(format!(
            "the keychain holds more than one credential for provider '{provider_id}'"
        )),
        other => CommandError::credential(format!(
            "the keychain could not be read for provider '{provider_id}': {other}"
        )),
    }
}

/// An OS-keychain-backed vault. Stateless: the OS owns the storage.
#[derive(Debug, Default, Clone, Copy)]
pub struct CredentialVault;

impl CredentialVault {
    pub fn new() -> Self {
        Self
    }

    fn entry(&self, provider_id: &str) -> CommandResult<Entry> {
        validate_provider_id(provider_id)?;
        Entry::new(SERVICE, &account_for(provider_id))
            .map_err(|error| describe(provider_id, &error))
    }

    /// Store (or replace) the secret for a provider. Returns the opaque handle only.
    pub fn set(&self, provider_id: &str, secret: &str) -> CommandResult<CredentialRefDto> {
        validate_secret(secret)?;
        let entry = self.entry(provider_id)?;
        entry
            .set_password(secret)
            .map_err(|error| describe(provider_id, &error))?;
        Ok(CredentialRefDto {
            provider_id: provider_id.to_string(),
            credential_ref: credential_ref(provider_id),
            has_secret: true,
        })
    }

    /// Load the secret, treating "no entry" as `None` rather than an error.
    ///
    /// **Never** return this to the renderer — it is used only to build a Rust-side HTTP
    /// request.
    pub fn fetch(&self, provider_id: &str) -> CommandResult<Option<String>> {
        let entry = self.entry(provider_id)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(describe(provider_id, &error)),
        }
    }

    /// The secret for a provider, or an error explaining that it is missing.
    pub fn load(&self, provider_id: &str) -> CommandResult<String> {
        self.fetch(provider_id)?.ok_or_else(|| {
            CommandError::credential(format!(
                "no stored credential for provider '{provider_id}'; add one in Settings"
            ))
        })
    }

    pub fn delete(&self, provider_id: &str) -> CommandResult<()> {
        let entry = self.entry(provider_id)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            // Deleting something that is not there is not an error for the caller.
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(describe(provider_id, &error)),
        }
    }

    pub fn has_secret(&self, provider_id: &str) -> bool {
        matches!(self.fetch(provider_id), Ok(Some(_)))
    }

    /// The handle for a provider, whether or not a secret is stored.
    pub fn reference(&self, provider_id: &str) -> CommandResult<CredentialRefDto> {
        validate_provider_id(provider_id)?;
        Ok(CredentialRefDto {
            provider_id: provider_id.to_string(),
            credential_ref: credential_ref(provider_id),
            has_secret: self.has_secret(provider_id),
        })
    }

    /// Every known provider with its current presence flag.
    pub fn list(&self) -> Vec<CredentialRefDto> {
        KNOWN_PROVIDERS
            .iter()
            .map(|provider_id| CredentialRefDto {
                provider_id: (*provider_id).to_string(),
                credential_ref: credential_ref(provider_id),
                has_secret: self.has_secret(provider_id),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// These tests never touch the real keychain: they exercise the pure validation and
    /// naming rules, which is where the security properties live. The keychain round trip
    /// is covered by `credential_round_trip` below, which is opt-in because it writes to
    /// the developer's login keychain.
    #[test]
    fn service_and_account_names_are_frozen() {
        assert_eq!(SERVICE, "com.creativelab.studio");
        assert_eq!(account_for("elevenlabs"), "provider:elevenlabs");
        assert_eq!(
            credential_ref("elevenlabs"),
            "keyring:com.creativelab.studio:provider:elevenlabs"
        );
    }

    #[test]
    fn credential_ref_contains_no_secret_material() {
        let reference = credential_ref("cloudflare");
        assert!(!reference.contains("sk-"));
        assert!(reference.starts_with("keyring:"));
        // The DTO has exactly three fields and none of them is a secret.
        let dto = CredentialRefDto {
            provider_id: "cloudflare".into(),
            credential_ref: reference,
            has_secret: true,
        };
        let value = serde_json::to_value(&dto).unwrap();
        let mut keys: Vec<&String> = value.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, vec!["credentialRef", "hasSecret", "providerId"]);
    }

    #[test]
    fn provider_ids_are_restricted() {
        for good in [
            "elevenlabs",
            "vercel-ai-gateway",
            "cloudflare",
            "my.provider_2",
        ] {
            validate_provider_id(good).unwrap_or_else(|error| panic!("{good}: {error}"));
        }
        for bad in [
            "",
            "ElevenLabs",
            "provider:elevenlabs",
            "a b",
            "../etc",
            "a/b",
            "ünïcode",
        ] {
            assert!(
                validate_provider_id(bad).is_err(),
                "{bad} should be rejected"
            );
        }
        assert!(validate_provider_id(&"a".repeat(65)).is_err());
    }

    #[test]
    fn empty_or_odd_secrets_are_rejected_before_storage() {
        assert!(validate_secret("").is_err());
        assert!(validate_secret("   ").is_err());
        assert!(validate_secret("\n\t").is_err());
        assert!(validate_secret("has\0nul").is_err());
        assert!(validate_secret("has\x07bell").is_err());
        assert!(validate_secret(&"a".repeat(9000)).is_err());
        validate_secret("sk-abcdefghijklmnop").unwrap();
        validate_secret("line\nbreak-is-fine").unwrap();
    }

    #[test]
    fn error_messages_never_echo_the_secret() {
        let secret = "sk-super-secret-value-1234";
        let error = describe("elevenlabs", &keyring::Error::NoEntry);
        let text = format!("{error}");
        assert!(!text.contains(secret));
        assert!(text.contains("elevenlabs"));
        // And the sanitizer would catch it even if a provider echoed it back.
        let echoed = crate::error::sanitize(&format!("upstream rejected {secret}"));
        assert!(!echoed.contains(secret), "{echoed}");
    }

    #[test]
    fn list_covers_every_known_provider() {
        // Uses a provider list check rather than `CredentialVault::list` so the test never
        // touches the keychain.
        assert!(KNOWN_PROVIDERS.contains(&"vercel-ai-gateway"));
        assert!(KNOWN_PROVIDERS.contains(&"elevenlabs"));
        assert!(KNOWN_PROVIDERS.contains(&"cloudflare"));
        assert_eq!(KNOWN_PROVIDERS.len(), 3);
    }

    /// Opt-in real-keychain round trip:
    /// `CREATIVELAB_KEYCHAIN_TEST=1 cargo test -- --ignored credential_round_trip`
    #[test]
    #[ignore = "writes to the developer's login keychain"]
    fn credential_round_trip() {
        let vault = CredentialVault::new();
        let provider = "creativelab-keychain-selftest";
        let (_account, secret) = ("unused", "sk-test-value-1234567890");
        vault.set(provider, secret).unwrap();
        assert!(vault.has_secret(provider));
        assert_eq!(vault.load(provider).unwrap(), secret);
        let reference = vault.reference(provider).unwrap();
        assert!(reference.has_secret);
        assert!(!reference.credential_ref.contains(secret));
        vault.delete(provider).unwrap();
        assert!(!vault.has_secret(provider));
        // Deleting twice is not an error.
        vault.delete(provider).unwrap();
    }
}
