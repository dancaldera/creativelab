/**
 * The single HTTP path every REST adapter uses.
 *
 * Responsibilities (PRD §12 and §13):
 *   * per-request timeout composed with the caller's `AbortSignal`;
 *   * bounded retries driven by core's `classifyHttpStatus` + `nextBackoffDelay`, with an
 *     injectable `random` and `sleep` so tests are deterministic and instantaneous;
 *   * `Retry-After` honoured in both the delta-seconds and the HTTP-date form;
 *   * `Idempotency-Key` attached when the caller supplies one (duplicate-charge safety);
 *   * a malformed body throws a `ProviderError` — it never returns `undefined`;
 *   * `authorization`, `x-api-key`, `api-key`, `xi-api-key` and `cookie` are stripped from
 *     every error, log line and `details` object produced here.
 *
 * There is no fallback to the network: `fetch` is injected, and adapters default it to
 * `globalThis.fetch` only at the composition root.
 */
import {
  ProviderError,
  classifyHttpStatus,
  nextBackoffDelay,
  normalizeError,
  type ErrorCategory,
} from "@creativelab/core";
import type { Logger } from "./adapter.js";
import { REDACTED, scrubSecrets } from "./credentials.js";

/** Request headers that must never survive into an error, a log line or `details`. */
const SENSITIVE_HEADERS: readonly string[] = [
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "xi-api-key",
  "cookie",
  "set-cookie",
];

export type HeaderRecord = Record<string, string>;

/** Error payload always attached to a `ProviderError` thrown by `HttpClient`. */
export interface HttpErrorPayload {
  readonly url: string;
  readonly method: string;
  readonly status: number;
  readonly statusText: string;
  /** Redacted response headers. */
  readonly headers: HeaderRecord;
  /** Redacted request headers. */
  readonly requestHeaders: HeaderRecord;
  /** Parsed body when it was JSON, otherwise the (truncated, redacted) text. */
  readonly body: unknown;
  readonly retryAfterSeconds?: number;
  readonly attempt: number;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
}

/** Options for one `HttpClient` instance (usually one per adapter). */
export interface HttpClientOptions {
  /** Injected transport. Defaults to `globalThis.fetch`; tests always inject. */
  readonly fetch?: typeof fetch;
  readonly logger?: Logger;
  readonly now?: () => Date;
  /** Per-request timeout. `0`/`null` disables the timeout. */
  readonly timeoutMs?: number;
  /** Retries *after* the first attempt. */
  readonly maxRetries?: number;
  readonly baseBackoffMs?: number;
  readonly capBackoffMs?: number;
  /** Deterministic jitter. Defaults to `Math.random`. */
  readonly random?: () => number;
  /** Test seam: replaces the real timer so retries do not slow the suite down. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Scrubbed out of every error and log line; also fed to the logger wrapper. */
  readonly secrets?: readonly string[];
  /** Headers added to every request (e.g. `xi-api-key`). Values are treated as secrets. */
  readonly defaultHeaders?: HeaderRecord;
  /** Sink for the delays the client computed. Test seam for `Retry-After` assertions. */
  readonly onRetry?: (info: {
    attempt: number;
    delayMs: number;
    status?: number;
    reason: string;
    url: string;
  }) => void;
}

/** One request. */
export interface HttpRequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly headers?: HeaderRecord;
  readonly query?: Record<string, string | number | boolean | undefined>;
  readonly body?: unknown;
  /** Raw body (multipart, binary, stream). Wins over `body`. */
  readonly rawBody?: RawBody;
  /** Attached as `Idempotency-Key` when present (PRD §12). */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

/** The seam tests use to build a fake transport with the same signature as `fetch`. */
export type FetchLike = typeof fetch;

/**
 * Request bodies this client accepts.
 *
 * Declared structurally instead of as the DOM's `BodyInit` because this package compiles
 * against the `ES2023` lib (no DOM types) and `@types/node` does not re-declare `BodyInit`.
 */
export type RawBody =
  string | Uint8Array | ArrayBuffer | ArrayBufferView | URLSearchParams | Blob | FormData;

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_EXCERPT = 2_000;

export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly capBackoffMs: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly secrets: string[];
  private readonly defaultHeaders: HeaderRecord;
  private readonly now: () => Date;
  private readonly onRetry: HttpClientOptions["onRetry"];

  constructor(options: HttpClientOptions = {}) {
    const impl = options.fetch ?? globalThis.fetch;
    if (typeof impl !== "function") {
      throw new ProviderError(
        "No fetch implementation is available; inject one via HttpClientOptions.fetch.",
        {
          category: "configuration",
        },
      );
    }
    this.fetchImpl = impl;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.baseBackoffMs = options.baseBackoffMs ?? 500;
    this.capBackoffMs = options.capBackoffMs ?? 30_000;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.secrets = (options.secrets ?? []).filter((secret) => secret.length > 0);
    this.defaultHeaders = { ...(options.defaultHeaders ?? {}) };
    this.now = options.now ?? (() => new Date());
    this.onRetry = options.onRetry;
  }

  /** Register a secret so it can never appear in an error or a log line. */
  addSecret(secret: string | undefined): void {
    if (secret) this.secrets.push(secret);
  }

  /**
   * Perform a request and return the parsed body (or `undefined` for 204/205).
   *
   * Throws `ProviderError` for every non-2xx response and for unparseable bodies.
   */
  async request<T = unknown>(url: string, options: HttpRequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    const headers: HeaderRecord = { ...(options.headers ?? {}) };
    if (options.idempotencyKey && !hasHeader(headers, "idempotency-key")) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }
    const requestHeaders = this.redactHeaders(headers);
    const attemptLimit = options.maxRetries ?? this.maxRetries;
    const target = withQuery(url, options.query);

    let attempt = 0;
    for (;;) {
      const timeoutMs = options.timeoutMs ?? this.timeoutMs;
      // `dispose()` clears the internal timeout handle, so only these are needed here.
      const { signal, timedOut, dispose } = combineSignals(options.signal, timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(target, {
          method,
          headers: this.mergedHeaders(headers),
          body: (options.rawBody ??
            (options.body === undefined
              ? undefined
              : JSON.stringify(options.body))) as RequestInit["body"],
          signal,
          redirect: "follow",
        });
      } catch (error) {
        dispose();
        if (timedOut()) {
          if (attempt < attemptLimit) {
            await this.wait(attempt, undefined, "timeout", target, method);
            attempt += 1;
            continue;
          }
          throw new ProviderError(
            `Request to ${redactUrl(target)} timed out after ${timeoutMs}ms.`,
            {
              category: "timeout",
              retryable: true,
              details: { url: redactUrl(target), method, timeoutMs, attempt },
              cause: error,
            },
          );
        }
        if (options.signal?.aborted) {
          throw new ProviderError(`Request to ${redactUrl(target)} was canceled.`, {
            category: "canceled",
            retryable: false,
            details: { url: redactUrl(target), method },
            cause: error,
          });
        }
        if (attempt < attemptLimit) {
          await this.wait(attempt, undefined, "network", target, method);
          attempt += 1;
          continue;
        }
        throw new ProviderError(`Network request to ${redactUrl(target)} failed.`, {
          category: "network",
          retryable: true,
          details: { url: redactUrl(target), method, attempt, cause: this.scrubMessage(error) },
          cause: error,
        });
      }
      dispose();

      const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"), this.now());
      const text = await readBodyText(response);
      const parsed = parseJsonOrUndefined(text);

      if (response.ok) {
        if (text.trim().length === 0) return undefined as T;
        if (!parsed.ok) {
          // A success status with an unparseable body is a hard failure: returning
          // `undefined` here would surface much later as a confusing "no outputs".
          throw new ProviderError(
            `Provider returned a malformed JSON body for ${method} ${redactUrl(target)} (status ${response.status}).`,
            {
              category: "provider",
              retryable: false,
              status: response.status,
              details: {
                url: redactUrl(target),
                method,
                status: response.status,
                excerpt: truncate(this.scrubMessage(text)),
                parseError: this.scrubMessage(parsed.error),
              },
              cause: parsed.error,
            },
          );
        }
        return parsed.value as T;
      }

      const body = parsed.ok ? parsed.value : truncate(text);
      const classified = classifyHttpStatus(response.status);
      const payload: HttpErrorPayload = {
        url: redactUrl(target),
        method,
        status: response.status,
        statusText: response.statusText,
        headers: this.redactHeaders(response.headers),
        requestHeaders,
        body: scrubSecrets(body, this.secrets),
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        attempt,
        category: classified.category ?? "provider",
        retryable: classified.retryable ?? false,
      };

      if (payload.retryable && attempt < attemptLimit) {
        await this.wait(attempt, retryAfterSeconds, "http", target, method, response.status);
        attempt += 1;
        continue;
      }

      throw httpErrorFromPayload(payload, this.secrets);
    }
  }

  /** `request` with the JSON boilerplate filled in. */
  async requestJson<T = unknown>(url: string, options: HttpRequestOptions = {}): Promise<T> {
    const headers: HeaderRecord = { accept: "application/json", ...(options.headers ?? {}) };
    if (options.body !== undefined && !hasHeader(headers, "content-type"))
      headers["content-type"] = "application/json";
    return this.request<T>(url, { ...options, headers });
  }

  /** Sleep seam for adapters that poll: cancellation-aware and injectable in tests. */
  async waitFor(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new ProviderError("Wait aborted.", { category: "canceled" });
    await this.sleep(ms);
  }

  /** Redact a header map: blocklisted names are masked, values are scrubbed. */
  redactHeaders(headers: HeaderRecord | Headers): HeaderRecord {
    const out: HeaderRecord = {};
    const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
    for (const [key, value] of entries) {
      if (isSensitiveHeader(key)) {
        out[key.toLowerCase()] = REDACTED;
        continue;
      }
      out[key.toLowerCase()] = scrubSecrets(String(value), this.secrets);
    }
    return out;
  }

  private mergedHeaders(headers: HeaderRecord): HeaderRecord {
    return { ...this.defaultHeaders, ...headers };
  }

  private async wait(
    attempt: number,
    retryAfterSeconds: number | undefined,
    reason: string,
    url: string,
    method: string,
    status?: number,
  ): Promise<void> {
    const delayMs = nextBackoffDelay({
      attempt,
      baseMs: this.baseBackoffMs,
      capMs: this.capBackoffMs,
      retryAfterSeconds,
      random: this.random,
    });
    const info = { attempt, delayMs, status, reason, url: redactUrl(url) };
    this.onRetry?.(info);
    this.logger?.warn("provider request retry", {
      ...info,
      retryAfterSeconds: retryAfterSeconds ?? null,
    });
    await this.sleep(delayMs);
  }

  private scrubMessage(value: unknown): string {
    return scrubSecrets(value instanceof Error ? value.message : String(value), this.secrets);
  }
}

/** Build a `ProviderError` from a response description. Exported for adapter reuse. */
export function httpErrorFromPayload(
  payload: HttpErrorPayload,
  secrets: readonly string[] = [],
): ProviderError {
  const detail =
    typeof payload.body === "string"
      ? ` ${truncate(scrubSecrets(payload.body, secrets))}`
      : payload.body !== undefined && payload.body !== null
        ? ` ${truncate(scrubSecrets(safeStringify(payload.body), secrets))}`
        : "";
  const { category, retryable, retryAfterSeconds, ...rest } = payload;
  return new ProviderError(
    `Provider request failed: ${payload.method} ${payload.url} -> ${payload.status} ${payload.statusText}${detail}`.trim(),
    {
      category,
      retryable,
      status: payload.status,
      retryAfterSeconds,
      // Flattened: `error.details.url`, `error.details.headers`, ... — one level, so a
      // `JSON.stringify(error)` dump is readable and the redaction surface is obvious.
      details: { ...rest, body: scrubSecrets(payload.body, secrets) },
    },
  );
}

/**
 * Parse `Retry-After` in both legal forms: delta-seconds (`120`) and HTTP-date
 * (`Wed, 21 Oct 2026 07:28:00 GMT`). Negative/absent values yield `undefined`.
 */
export function parseRetryAfter(value: string | null, now: Date = new Date()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number.parseFloat(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, (date - now.getTime()) / 1000);
}

/** Compose the caller's signal with a timeout signal, cleaning up the listener. */
export function combineSignals(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  timedOut: () => boolean;
  dispose: () => void;
} {
  if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    return { signal: caller, timer: undefined, timedOut: () => false, dispose: () => undefined };
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("timeout"));
  }, timeoutMs);
  const onAbort = (): void => controller.abort(caller?.reason);
  if (caller) {
    if (caller.aborted) controller.abort(caller.reason);
    else caller.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timer,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onAbort);
    },
  };
}

/** Drop query parameters that are absent. */
export function withQuery(
  url: string,
  query: Record<string, string | number | boolean | undefined> | undefined,
): string {
  if (!query) return url;
  const pairs = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  if (pairs.length === 0) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${pairs.join("&")}`;
}

/** Remove obvious credential material from a URL before it is logged or thrown. */
export function redactUrl(url: string): string {
  let out = url;
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/key|token|secret|signature|sig|password|auth/i.test(key))
        parsed.searchParams.set(key, REDACTED);
    }
    out = parsed.toString();
  } catch {
    out = url;
  }
  return out.replace(/\/\/([^/@\s]+)@/, "//***@");
}

export function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    SENSITIVE_HEADERS.includes(lower) ||
    /(^|[-_])(key|token|secret|auth|signature|password)($|[-_])/.test(lower)
  );
}

function hasHeader(headers: HeaderRecord, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw new ProviderError("Failed to read the provider response body.", {
      category: "network",
      retryable: true,
      details: { message: error instanceof Error ? error.message : String(error) },
      cause: error,
    });
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

/** JSON parse that returns the raw text instead of throwing. */
function parseJsonOrUndefined(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: unknown } {
  if (text.trim().length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

function truncate(value: string, max = MAX_RESPONSE_EXCERPT): string {
  return value.length <= max
    ? value
    : `${value.slice(0, max)}…[${value.length - max} chars truncated]`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Normalize an arbitrary thrown value, redacting a known secret list on the way. */
export function normalizeHttpError(error: unknown, secrets: readonly string[] = []): ProviderError {
  const normalized = normalizeError(error);
  return new ProviderError(scrubSecrets(normalized.message, secrets), {
    category: normalized.category,
    retryable: normalized.retryable,
    status: normalized.status,
    retryAfterSeconds: normalized.retryAfterSeconds,
    uncertain: normalized.uncertain,
    details: scrubSecrets(normalized.details, secrets),
    cause: normalized,
  });
}

/**
 * Wrap a `Logger` so every field is scrubbed before it reaches the sink. Adapters use
 * this instead of trusting themselves to remember.
 */
export function createRedactingLogger(
  logger: Logger | undefined,
  secrets: readonly string[] = [],
): Logger | undefined {
  if (!logger) return undefined;
  const emit =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: string, fields?: Record<string, unknown>): void => {
      const scrubbed = fields
        ? (scrubSecrets(fields, secrets) as Record<string, unknown>)
        : undefined;
      logger[level](scrubSecrets(message, secrets), scrubbed);
    };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

/** Header blocklist exported so tests can assert nothing sensitive escapes. */
export const REDACTED_HEADER_NAMES: readonly string[] = SENSITIVE_HEADERS;
