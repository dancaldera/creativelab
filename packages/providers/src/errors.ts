/**
 * Provider error helpers.
 *
 * Two jobs:
 *   1. turn an HTTP response into the right `CreativeLabError` subclass using core's
 *      `classifyHttpStatus`, so the job queue's retry decision needs no provider-specific
 *      knowledge;
 *   2. be the single place that decides a failure is an *uncertain submission* — the state
 *      where the provider may have accepted (and billed) a request whose id we never
 *      received. Core's `decideRetry` refuses to retry those, and PRD §12 says the job must
 *      be parked for a human instead.
 */
import {
  CredentialError,
  ProviderError,
  classifyHttpStatus,
  normalizeError,
  type CreativeLabError,
} from "@creativelab/core";
import { scrubSecrets } from "./credentials.js";
import type { HttpErrorPayload } from "./http.js";
import { httpErrorFromPayload } from "./http.js";

export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  readonly headers?: { get(name: string): string | null } | Headers;
}

export interface ProviderErrorOptions {
  readonly url?: string;
  readonly method?: string;
  /** Redacted response headers. */
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly retryAfterSeconds?: number;
  /** Force the "we do not know whether this was accepted" flag. */
  readonly uncertain?: boolean;
  /** Secrets to scrub out of the message and `details`. */
  readonly secrets?: readonly string[];
}

/**
 * Build a `ProviderError` for a non-2xx response.
 *
 * Category/retryability come from `classifyHttpStatus`; `401`/`403` therefore surface as
 * `credential` so the UI can send the user to key settings.
 */
export function providerErrorFromResponse(
  response: HttpResponseLike,
  options: ProviderErrorOptions = {},
): ProviderError {
  const body = options.body ?? null;
  const secrets = options.secrets ?? [];
  const payload: HttpErrorPayload = {
    url: options.url ?? "",
    method: options.method ?? "GET",
    status: response.status,
    statusText: response.statusText ?? "",
    headers: options.headers ?? {},
    requestHeaders: {},
    body: scrubSecrets(body, secrets),
    ...(options.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: options.retryAfterSeconds }
      : {}),
    attempt: 0,
    category: classifyHttpStatus(response.status).category ?? "provider",
    retryable: classifyHttpStatus(response.status).retryable ?? false,
  };
  return httpErrorFromPayload(payload, secrets);
}

/** Build a `CredentialError` for a rejected key, without ever echoing the key. */
export function credentialErrorFromResponse(
  response: HttpResponseLike,
  options: ProviderErrorOptions = {},
): CredentialError {
  const secrets = options.secrets ?? [];
  return new CredentialError(
    `The provider rejected the stored credential (${response.status} ${response.statusText ?? ""}). Re-enter the API key in Settings → Providers.`.trim(),
    {
      url: options.url,
      status: response.status,
      body: scrubSecrets(options.body ?? null, secrets),
    },
  );
}

/** Wrap an unknown thrown value as a `ProviderError`, scrubbing known secrets. */
export function normalizeProviderError(
  error: unknown,
  secrets: readonly string[] = [],
): CreativeLabError {
  if (error instanceof ProviderError || error instanceof CredentialError)
    return scrubError(error, secrets);
  const normalized = normalizeError(error);
  if (normalized instanceof CredentialError || normalized instanceof ProviderError)
    return scrubError(normalized, secrets);
  return new ProviderError(scrubSecrets(normalized.message, secrets), {
    category: normalized.category,
    retryable: normalized.retryable,
    details: scrubSecrets(normalized.details, secrets),
    cause: normalized,
  });
}

function scrubError(error: CreativeLabError, secrets: readonly string[]): CreativeLabError {
  if (secrets.length === 0) return error;
  const message = scrubSecrets(error.message, secrets);
  if (error instanceof CredentialError) {
    return new CredentialError(message, scrubSecrets(error.details, secrets));
  }
  return new ProviderError(message, {
    category: error.category,
    retryable: error.retryable,
    status: error.status,
    retryAfterSeconds: error.retryAfterSeconds,
    uncertain: error.uncertain,
    details: scrubSecrets(error.details, secrets),
    cause: error,
  });
}

/**
 * PRD §12: "uncertain submissions must not auto-resubmit".
 *
 * A failure is uncertain when the request may have reached the provider but no job id came
 * back: connection reset mid-flight, request timeout, `5xx` from the *submission* call, or
 * a body that says the task was created but does not carry an id. A `4xx` is *not*
 * uncertain — the provider rejected the request outright and no charge happened, so the
 * caller may safely fix and resubmit.
 */
export function isUncertainSubmission(error: unknown): boolean {
  if (error instanceof ProviderError && error.uncertain) return true;
  const normalized = normalizeError(error);
  if (normalized.uncertain) return true;
  if (normalized.status === 404 || normalized.status === 410) return false;
  switch (normalized.category) {
    case "validation":
    case "configuration":
    case "credential":
    case "canceled":
    case "budget":
      return false;
    case "network":
    case "timeout":
    case "provider":
    case "rate_limit":
      return true;
    default:
      // An unclassified throw from a submission path is assumed to be a transport failure:
      // parking the job for reconciliation costs a click, double-charging costs money.
      return !(error instanceof ProviderError || error instanceof CredentialError);
  }
}

/** True when the provider says "wait, then try again" (PRD §12). */
export function isRateLimited(error: unknown): boolean {
  const normalized = normalizeError(error);
  return normalized.status === 429 || normalized.category === "rate_limit";
}

/**
 * Turn a submission-path failure into an error the job queue can act on: retryable per the
 * status, and flagged `uncertain` when re-submitting could double-charge.
 */
export function submissionError(
  response: HttpResponseLike,
  options: ProviderErrorOptions = {},
): ProviderError {
  const error = providerErrorFromResponse(response, options);
  const uncertain =
    options.uncertain ??
    (response.status >= 500 || response.status === 408 || response.status === 425);
  return new ProviderError(error.message, {
    category: error.category,
    retryable: error.retryable,
    status: error.status,
    retryAfterSeconds: error.retryAfterSeconds,
    uncertain,
    details: error.details,
    cause: error,
  });
}

/** Errors that mean "the provider has no such job" — reconcile rather than retry. */
export function isMissingJob(error: unknown): boolean {
  const normalized = normalizeError(error);
  return normalized.status === 404 || normalized.status === 410;
}
