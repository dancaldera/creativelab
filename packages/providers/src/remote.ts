/**
 * Shared helpers for the REST adapters: output URL expiry, payload normalization and
 * status mapping.
 *
 * PRD §8 requires "output URLs with expiry" to be a first-class concept, so every adapter
 * funnels downloaded outputs through `assertOutputsFresh` — a URL whose `expiresAt` has
 * passed is a failure, not a stale-but-usable artifact.
 */
import { ProviderError } from "@creativelab/core";
import type { RemoteOutputKind } from "./capabilities.js";
import { RemoteOutputSchema, type RemoteJobStatus, type RemoteOutput } from "./requests.js";

/** Tolerated clock skew when comparing against `expiresAt`. */
export const EXPIRY_SKEW_MS = 1_000;

/** Output with an optional absolute deadline attached. */
export interface OutputWithExpiry {
  readonly expiresAt?: string;
}

/**
 * Throw when an output URL has expired.
 *
 * Called by every `fetchOutputs` implementation *before* any download, so an expired
 * signed URL never turns into a confusing 403 later in the pipeline.
 */
export function assertOutputFresh(output: OutputWithExpiry, now: Date = new Date()): void {
  if (!output.expiresAt) return;
  const expiry = Date.parse(output.expiresAt);
  if (Number.isNaN(expiry)) {
    throw new ProviderError(`Output URL has an unparseable expiry ("${output.expiresAt}").`, {
      category: "validation",
      details: { expiresAt: output.expiresAt, url: classifyUrl(output) },
    });
  }
  if (expiry + EXPIRY_SKEW_MS <= now.getTime()) {
    throw new ProviderError(`Output URL expired at ${output.expiresAt}.`, {
      category: "provider",
      retryable: false,
      details: { expiresAt: output.expiresAt, now: now.toISOString() },
    });
  }
}

/** Validate a whole output list against the clock. */
export function assertOutputsFresh(
  outputs: readonly OutputWithExpiry[],
  now: Date = new Date(),
): void {
  for (const output of outputs) assertOutputFresh(output, now);
}

/**
 * Derive an expiry from the URL itself when a provider encodes one (Cloudflare and S3
 * signed URLs carry `expires`/`X-Amz-Expires`). Returns an ISO timestamp or `undefined`.
 */
export function expiryFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const seconds = parsed.searchParams.get("expires") ?? parsed.searchParams.get("Expires");
    if (seconds && /^\d+$/.test(seconds)) {
      const value = Number.parseInt(seconds, 10);
      // `expires` is either an absolute epoch second (S3/Cloudflare) or a TTL; the
      // absolute form is far more common on signed media URLs.
      const ms = value > 1_000_000_000 ? value * 1000 : Date.now() + value * 1000;
      return new Date(ms).toISOString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export interface RawOutputInput {
  readonly url?: unknown;
  readonly mimeType?: unknown;
  readonly contentType?: unknown;
  readonly bytes?: unknown;
  readonly size?: unknown;
  readonly sha256?: unknown;
  readonly expiresAt?: unknown;
  readonly kind?: unknown;
  readonly type?: unknown;
}

/** Best-effort kind inference from a MIME type; unknown stays `text` (safe default). */
export function inferOutputKind(mimeType: string | undefined, hint?: string): RemoteOutputKind {
  const explicit = hint?.toLowerCase();
  if (explicit === "image" || explicit === "video" || explicit === "audio" || explicit === "text")
    return explicit;
  const mime = (mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "text";
}

/**
 * Normalize one provider output object into a `RemoteOutput`.
 *
 * Missing MIME types are *not* guessed with an optimistic default: an unknown payload is
 * `application/octet-stream`, which the media layer probes before it is trusted.
 */
export function normalizeRemoteOutput(
  raw: RawOutputInput,
  options: { now?: Date; url?: string; mimeType?: string } = {},
): RemoteOutput {
  const url = typeof raw.url === "string" ? raw.url : options.url;
  if (!url) {
    throw new ProviderError("Provider returned an output without a URL.", {
      category: "provider",
      details: { output: safeShape(raw) },
    });
  }
  const mimeType =
    (typeof raw.mimeType === "string" && raw.mimeType) ||
    (typeof raw.contentType === "string" && raw.contentType) ||
    options.mimeType ||
    "application/octet-stream";
  const kind = inferOutputKind(
    mimeType,
    typeof raw.kind === "string" ? raw.kind : typeof raw.type === "string" ? raw.type : undefined,
  );
  const bytes = firstFiniteNumber([raw.bytes, raw.size]);
  const expiresAt =
    (typeof raw.expiresAt === "string" && raw.expiresAt) ||
    (typeof raw.expiresAt === "number"
      ? new Date(raw.expiresAt * 1000).toISOString()
      : undefined) ||
    expiryFromUrl(url);

  const candidate: Record<string, unknown> = { url, mimeType, kind };
  if (bytes !== undefined) candidate["bytes"] = bytes;
  if (typeof raw.sha256 === "string") candidate["sha256"] = raw.sha256;
  if (expiresAt) candidate["expiresAt"] = expiresAt;
  return RemoteOutputSchema.parse(candidate);
}

/** Map a provider status string onto the provider-side job vocabulary. */
export function mapRemoteStatus(raw: unknown): RemoteJobStatus {
  const value = typeof raw === "string" ? raw.toLowerCase() : "";
  switch (value) {
    case "queued":
    case "pending":
    case "starting":
    case "in_queue":
    case "in-progress":
    case "processing":
    case "running":
    case "in_progress":
      return "running";
    case "succeeded":
    case "success":
    case "completed":
    case "complete":
    case "done":
      return "completed";
    case "failed":
    case "error":
    case "canceled":
    case "cancelled":
    case "cancel":
      return value.startsWith("cancel") ? "canceled" : "failed";
    default:
      // An unrecognized status is *not* a failure: the job may still be running, and
      // treating it as `unknown` routes it to reconciliation rather than a retry.
      return "unknown";
  }
}

/** Pull the first URL out of the many shapes gateways use for an output list. */
export function extractOutputList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["outputs", "output", "artifacts", "data", "images", "result"]) {
      const candidate = record[key];
      if (Array.isArray(candidate)) return candidate;
      if (
        candidate &&
        typeof candidate === "object" &&
        typeof (candidate as Record<string, unknown>)["url"] === "string"
      ) {
        return [candidate];
      }
      if (typeof candidate === "string" && /^https?:/.test(candidate)) return [{ url: candidate }];
    }
  }
  return [];
}

/** Read the first string found under any of `keys` on a payload. */
export function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Parse `Retry-After` from a generic headers-like object. */
export function retryAfterFromHeaders(
  headers: { get(name: string): string | null } | undefined,
): number | undefined {
  if (!headers) return undefined;
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, (date - Date.now()) / 1000);
}

function firstFiniteNumber(values: readonly unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return undefined;
}

function safeShape(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  return Object.keys(raw as Record<string, unknown>);
}

function classifyUrl(output: OutputWithExpiry): string {
  const url = (output as { url?: unknown }).url;
  return typeof url === "string" ? (url.split("?")[0] ?? "") : "";
}
