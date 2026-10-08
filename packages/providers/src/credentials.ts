/**
 * Credential handling (PRD §13).
 *
 * Rules this module exists to enforce:
 *   * keys live in an OS keychain behind an opaque `credentialRef` — never in a project
 *     file, never in a log line, never on an error object;
 *   * every place a secret could escape has a single choke point (`redactSecret`,
 *     `scrubSecrets`, `assertNoSecretLeak`) so tests can prove the rule holds.
 *
 * `MemoryCredentialVault` is the test/headless implementation. The desktop app supplies
 * a Tauri-backed vault with the same interface.
 */
import { CredentialError } from "@creativelab/core";

/** ARCHITECTURE.md credential access surface. */
export interface CredentialVault {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, secret: string): Promise<void>;
  delete(ref: string): Promise<void>;
  list(): Promise<string[]>;
}

/** The one supported way to build a `credentialRef` from a provider id. */
export function credentialRefFor(providerId: string): string {
  return `provider:${providerId}`;
}

/**
 * In-memory vault for tests, the CLI and headless e2e runs.
 *
 * `export()` is deliberately explicit and lossy-free so a test can assert that the
 * *serialized project* never contains it — see `assertNoSecretLeak`.
 */
export class MemoryCredentialVault implements CredentialVault {
  private readonly secrets = new Map<string, string>();

  constructor(initial?: Record<string, string>) {
    if (initial) {
      for (const [ref, secret] of Object.entries(initial)) this.secrets.set(ref, secret);
    }
  }

  async get(ref: string): Promise<string | undefined> {
    return this.secrets.get(ref);
  }

  async set(ref: string, secret: string): Promise<void> {
    if (typeof secret !== "string" || secret.length === 0) {
      throw new CredentialError("Refusing to store an empty credential.", { ref });
    }
    this.secrets.set(ref, secret);
  }

  async delete(ref: string): Promise<void> {
    this.secrets.delete(ref);
  }

  async list(): Promise<string[]> {
    return [...this.secrets.keys()].sort();
  }

  /** Test-only: the raw map. Never call this from application code. */
  export(): Record<string, string> {
    return Object.fromEntries(this.secrets);
  }

  /** Test-only: bulk load. */
  import(values: Record<string, string>): void {
    for (const [ref, secret] of Object.entries(values)) this.secrets.set(ref, secret);
  }

  clear(): void {
    this.secrets.clear();
  }
}

export const REDACTED = "***";

/**
 * Replace a secret with a `***`-style marker. Keeps at most the last two characters so a
 * user can tell two keys apart without either being usable.
 */
export function redactSecret(value: string, options: { keepLast?: number } = {}): string {
  if (typeof value !== "string" || value.length === 0) return REDACTED;
  const keepLast = options.keepLast ?? 0;
  if (keepLast <= 0 || value.length <= keepLast + 2) return REDACTED;
  return `${REDACTED}${value.slice(-keepLast)}`;
}

/** Patterns that are secrets whatever they are called. Used by `scrubSecrets`. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
  /\b(xi-api-key|api[-_]?key|apikey|access[-_]?token|auth[-_]?token|client[-_]?secret|password|authorization)\b\s*[:=]\s*"?[^"',\s}]{4,}/gi,
];

/**
 * Replace every known secret, and every string that *looks* like a secret, inside an
 * arbitrary value. Used on log fields, error messages and error `details`.
 */
export function scrubSecrets<T>(value: T, secrets: readonly string[] = []): T {
  return scrub(value, secrets.length > 0 ? secrets : undefined, 0) as T;
}

function scrub(value: unknown, secrets: readonly string[] | undefined, depth: number): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return scrubString(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: scrubString(value.message, secrets) };
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = scrub(item, secrets, depth + 1);
  }
  return out;
}

function scrubString(input: string, secrets: readonly string[] | undefined): string {
  let out = input;
  if (secrets) {
    for (const secret of secrets) {
      if (!secret || secret.length < 4) continue;
      while (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/** True when `value` contains `secret` anywhere in its serialized form. */
export function containsSecret(value: unknown, secret: string): boolean {
  if (!secret) return false;
  return serialize(value).includes(secret);
}

/**
 * Assert that a payload (a project manifest, an error, a log line) contains no trace of a
 * secret. Throws `CredentialError` — never returns the offending payload.
 */
export function assertNoSecretLeak(payload: unknown, secret: string): void {
  if (!secret) return;
  if (!containsSecret(payload, secret)) return;
  throw new CredentialError(
    "A credential value was found in a payload that must never contain one.",
    {
      where: describeLeakSite(payload),
    },
  );
}

function describeLeakSite(payload: unknown): string {
  if (payload === null || payload === undefined) return "unknown";
  if (typeof payload === "string") return "string";
  if (payload instanceof Error) return payload.name;
  return typeof payload === "object" ? "object" : typeof payload;
}

function serialize(value: unknown): string {
  try {
    return (
      JSON.stringify(value, (_key, item: unknown) =>
        item instanceof Error ? { name: item.name, message: item.message } : item,
      ) ?? String(value)
    );
  } catch {
    // Circular payloads: fall back to a shallow stringification, which is enough to catch
    // a secret sitting on a top-level field.
    return Object.values(value as Record<string, unknown>)
      .map((item) => (typeof item === "string" ? item : ""))
      .join("\n");
  }
}

/**
 * Resolve a credential for a provider, or fail with a `CredentialError` the UI can turn
 * into "Open Settings → Providers".
 */
export async function requireCredential(
  vault: CredentialVault,
  ref: string,
  options: { providerId?: string; label?: string } = {},
): Promise<string> {
  let secret: string | undefined;
  try {
    secret = await vault.get(ref);
  } catch (error) {
    throw new CredentialError(
      `Could not read the ${options.label ?? "provider"} credential from the credential store.`,
      {
        ref,
        providerId: options.providerId,
        cause: scrubSecrets(error instanceof Error ? error.message : String(error)),
      },
    );
  }
  if (!secret) {
    throw new CredentialError(
      `No credential is configured for ${options.label ?? options.providerId ?? ref}. Add an API key in Settings → Providers.`,
      { ref, providerId: options.providerId },
    );
  }
  return secret;
}

/** Resolve a credential, returning `undefined` instead of throwing when it is absent. */
export async function optionalCredential(
  vault: CredentialVault,
  ref: string,
): Promise<string | undefined> {
  try {
    return await vault.get(ref);
  } catch {
    return undefined;
  }
}
