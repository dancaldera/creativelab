/**
 * Shared plumbing for the REST adapters.
 *
 * The three concrete adapters (`vercel-gateway`, `elevenlabs`, `cloudflare`) differ only in
 * URLs and payload shapes; credential resolution, retry policy, redaction, error
 * normalization and output-expiry enforcement are identical and live here.
 */
import {
  CredentialError,
  ProviderError,
  type CreativeLabError,
  type Spend,
} from "@creativelab/core";
import type { HttpAdapterOptions, Logger, ProviderAdapter, ProviderContext } from "../adapter.js";
import {
  createRedactingLogger,
  HttpClient,
  type HeaderRecord,
  type HttpRequestOptions,
} from "../http.js";
import { normalizeProviderError } from "../errors.js";
import { assertOutputsFresh, normalizeRemoteOutput, type RawOutputInput } from "../remote.js";
import { estimateCostFromCapabilities } from "../cost.js";
import type { ModelCapabilities, ModelDescriptor } from "../capabilities.js";
import type {
  GenerationRequest,
  JobStatusResult,
  RemoteOutput,
  SubmitResult,
  ValidationResult,
} from "../requests.js";
import { validateRequest } from "../validate.js";

export interface RestAdapterConfig extends HttpAdapterOptions {
  readonly providerId: string;
  readonly displayName: string;
  readonly defaultBaseUrl: string;
  /** Builds the auth header(s) from the resolved secret. */
  readonly authHeaders: (secret: string) => HeaderRecord;
  /** When false, endpoints that do not need a key (e.g. a public catalog) stay usable. */
  readonly requiresCredential?: boolean;
}

/** Base class: credentials + HTTP + the parts of the contract that never vary. */
export abstract class RestAdapter implements ProviderAdapter {
  abstract readonly id: string;
  abstract readonly displayName: string;

  /** Live list used for redaction; grows as credentials are resolved. */
  private readonly resolvedSecrets: string[] = [];
  protected readonly baseUrl: string;
  protected readonly http: HttpClient;
  protected readonly logger: Logger | undefined;
  protected readonly now: () => Date;
  protected readonly credentialRef: string;
  /** Injected transport, exposed so subclasses can build a context for catalog fallbacks. */
  protected readonly fetchImpl: typeof fetch;
  private readonly authHeaders: (secret: string) => HeaderRecord;
  private readonly requiresCredential: boolean;

  constructor(config: RestAdapterConfig) {
    this.baseUrl = trimTrailingSlash(config.baseUrl ?? config.defaultBaseUrl);
    this.now = config.now ?? (() => new Date());
    this.credentialRef = config.credentialRef ?? `provider:${config.providerId}`;
    this.authHeaders = config.authHeaders;
    this.requiresCredential = config.requiresCredential ?? true;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.logger = createRedactingLogger(config.logger, this.resolvedSecrets);
    this.http = new HttpClient({
      fetch: this.fetchImpl,
      logger: this.logger,
      now: this.now,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      random: config.random,
      sleep: config.sleep,
      secrets: this.resolvedSecrets,
    });
  }

  validate(request: GenerationRequest, capabilities: ModelCapabilities): ValidationResult {
    return validateRequest(request, capabilities);
  }

  async estimateCost(request: GenerationRequest): Promise<Spend | null> {
    const capabilities = await this.safeDescribeCapabilities(request.modelId);
    return estimateCostFromCapabilities(request, capabilities ?? null);
  }

  normalizeError(error: unknown): CreativeLabError {
    return normalizeProviderError(error, this.resolvedSecrets);
  }

  /**
   * Download/validate remote outputs.
   *
   * The base implementation enforces expiry for every adapter — a signed URL that already
   * expired is rejected before the caller learns about it any other way (PRD §8).
   */
  async fetchOutputs(job: JobStatusResult, ctx: ProviderContext): Promise<RemoteOutput[]> {
    const outputs = job.outputs ?? [];
    if (outputs.length > 0) await this.resolveCredential(ctx);
    assertOutputsFresh(outputs, this.now());
    return outputs;
  }

  // -------------------------------------------------------------------------
  // Protected helpers
  // -------------------------------------------------------------------------

  /** Capabilities for a model this adapter reports, or `undefined` when unknown. */
  protected abstract safeDescribeCapabilities(
    modelId: string,
  ): Promise<ModelCapabilities | undefined>;

  /** Resolve the API key, failing with `CredentialError` when it is missing. */
  protected async resolveCredential(ctx: ProviderContext): Promise<string> {
    const secret = await ctx.credentials.get(this.credentialRef);
    if (!secret) {
      if (!this.requiresCredential) return "";
      throw new CredentialError(
        `No API key is configured for ${this.displayName}. Add one in Settings → Providers.`,
        {
          providerId: this.id,
          ref: this.credentialRef,
        },
      );
    }
    this.remember(secret);
    return secret;
  }

  /** Credential or `undefined`, for endpoints that work without authentication. */
  protected async optionalCredential(ctx: ProviderContext): Promise<string | undefined> {
    const secret = await ctx.credentials.get(this.credentialRef).catch(() => undefined);
    if (secret) this.remember(secret);
    return secret ?? undefined;
  }

  /** Authenticated JSON request. */
  protected async requestJson<T>(
    ctx: ProviderContext,
    path: string,
    options: HttpRequestOptions & { operation: string },
  ): Promise<T> {
    const secret = await this.resolveCredential(ctx);
    try {
      return await this.http.requestJson<T>(this.url(path), {
        ...options,
        headers: { ...this.authHeaders(secret), ...(options.headers ?? {}) },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (error) {
      throw this.wrap(error, options.operation);
    }
  }

  /** Authenticated request with a raw body (multipart uploads, binary responses). */
  protected async request<T>(
    ctx: ProviderContext,
    path: string,
    options: HttpRequestOptions & { operation: string; auth?: boolean },
  ): Promise<T> {
    const useAuth = options.auth ?? true;
    const secret = useAuth ? await this.resolveCredential(ctx) : await this.optionalCredential(ctx);
    try {
      return await this.http.request<T>(this.url(path), {
        ...options,
        headers: { ...(secret ? this.authHeaders(secret) : {}), ...(options.headers ?? {}) },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (error) {
      throw this.wrap(error, options.operation);
    }
  }

  /** Turn any thrown value into a `ProviderError` tagged with the operation that failed. */
  protected wrap(error: unknown, operation: string): CreativeLabError {
    const normalized = this.normalizeError(error);
    if (normalized.category === "canceled") return normalized;
    return new ProviderError(normalized.message, {
      category: normalized.category,
      retryable: normalized.retryable,
      status: normalized.status,
      retryAfterSeconds: normalized.retryAfterSeconds,
      uncertain: normalized.uncertain,
      details: { ...normalized.details, operation, providerId: this.id },
      cause: normalized,
    });
  }

  protected url(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  protected isoTimestamp(): string {
    return this.now().toISOString();
  }

  /** Build a descriptor from provider data without guessing features on. */
  protected descriptor(
    modelId: string,
    displayName: string,
    capabilities: ModelCapabilities,
  ): ModelDescriptor {
    return {
      providerId: this.id,
      modelId,
      displayName,
      modality: capabilities.modality,
      capabilities,
      fetchedAt: this.isoTimestamp(),
      isStale: false,
    };
  }

  /** Normalize a provider output list, attaching a default MIME type when one is needed. */
  protected outputs(raw: readonly RawOutputInput[], defaultMimeType?: string): RemoteOutput[] {
    return raw.map((item) =>
      normalizeRemoteOutput(item, defaultMimeType ? { mimeType: defaultMimeType } : {}),
    );
  }

  private remember(secret: string): void {
    if (!secret || this.resolvedSecrets.includes(secret)) return;
    this.resolvedSecrets.push(secret);
    this.http.addSecret(secret);
  }

  abstract listModels(ctx: ProviderContext): Promise<ModelDescriptor[]>;
  abstract describeCapabilities(modelId: string): Promise<ModelCapabilities>;
  abstract submit(request: GenerationRequest, ctx: ProviderContext): Promise<SubmitResult>;
  abstract getJob(jobId: string, ctx: ProviderContext): Promise<JobStatusResult>;
  abstract cancel(jobId: string, ctx: ProviderContext): Promise<void>;
}

/** Strip a trailing slash so `url()` composition stays predictable. */
export function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/** Narrow an unknown JSON value to a record. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Narrow an unknown JSON value to an array. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export { ProviderError };
