/**
 * Identifier generation and validation.
 *
 * IDs are opaque, URL/filename-safe and stable across machines so that relative
 * project references survive a "Package Project" round trip (PRD §11).
 */
/**
 * Randomness comes from the Web Crypto API (`globalThis.crypto`), not `node:crypto`.
 *
 * This module is re-exported from the browser-safe entry point (`@creativelab/core/browser`)
 * so the React webview can generate ids with the *same* implementation the host uses.
 * Importing `node:crypto` here made the whole core barrel un-bundleable for the webview,
 * which forced the UI to duplicate domain logic; `globalThis.crypto` is available in both
 * Node 22+ and the Tauri webview (a secure context), so one implementation serves both.
 */
function webCrypto(): typeof globalThis.crypto {
  const available = globalThis.crypto;
  if (available === undefined || typeof available.randomUUID !== "function") {
    throw new Error(
      "This runtime has no Web Crypto API. Creative Lab requires Node 22+ or a secure browser context.",
    );
  }
  return available;
}

function randomUuid(): string {
  return webCrypto().randomUUID();
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  webCrypto().getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

const PREFIXES = {
  project: "prj",
  sequence: "seq",
  track: "trk",
  clip: "clp",
  effect: "fx",
  keyframe: "kf",
  asset: "ast",
  job: "job",
  event: "evt",
  promptRevision: "prv",
  exportJob: "exp",
  providerConfig: "pcfg",
  catalogEntry: "cat",
  spend: "spd",
  snapshot: "snp",
} as const;

export type IdKind = keyof typeof PREFIXES;

/** `clp_01H...`-style prefixed id: prefixed ids make logs and SQL dumps readable. */
export function newId(kind: IdKind): string {
  return `${PREFIXES[kind]}_${randomUuid().replace(/-/g, "").slice(0, 24)}`;
}

export function newRunId(): string {
  return randomHex(8);
}

const ID_PATTERN = /^[a-z]{2,5}_[a-z0-9]{6,32}$/;

export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function assertId(value: unknown, label = "id"): string {
  if (!isId(value)) throw new TypeError(`Invalid ${label}: ${String(value)}`);
  return value;
}

/**
 * Stable idempotency key for a paid generation request.
 *
 * PRD §12: "Use idempotency keys where supported and a local submission lock to reduce
 * duplicate paid requests." The key is derived from the *normalized* request so that a
 * double-click on Generate collapses onto one job, while a genuinely different prompt,
 * seed or model produces a different key.
 */
export function idempotencyKey(parts: {
  providerId: string;
  modelId: string;
  mode: string;
  prompt: string;
  seed?: number | null;
  references?: readonly string[];
  extra?: Record<string, unknown>;
}): string {
  const canonical = JSON.stringify({
    p: parts.providerId,
    m: parts.modelId,
    md: parts.mode,
    pr: normalizePrompt(parts.prompt),
    s: parts.seed ?? null,
    r: [...(parts.references ?? [])].sort(),
    x: parts.extra ? sortObject(parts.extra) : null,
  });
  return `idem_${fnv1a(canonical)}`;
}

/** Collapse insignificant whitespace/case so near-identical prompts dedupe. */
export function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").toLowerCase();
}

function sortObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** FNV-1a 64-bit, rendered as hex. Non-cryptographic; used for keys and dedupe only. */
export function fnv1a(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
