/**
 * The provider registry: the only place the app enumerates adapters.
 *
 * Two invariants it enforces:
 *   * every adapter failure leaves as a `CreativeLabError` (never a raw `TypeError` from a
 *     provider SDK or a JSON parse);
 *   * one broken provider never breaks model listing for the others — `listModels` collects
 *     failures into an `errors` array instead of throwing (PRD §8 swappable providers).
 */
import type { CreativeLabError, Spend } from "@creativelab/core";
import type { ModelCapabilities, ModelDescriptor } from "./capabilities.js";
import type { ProviderAdapter, ProviderContext } from "./adapter.js";
import type {
  GenerationRequest,
  JobStatusResult,
  RemoteOutput,
  SubmitResult,
  ValidationResult,
} from "./requests.js";
import { estimateCostFromCapabilities } from "./cost.js";
import { validateRequest } from "./validate.js";
import { normalizeProviderError } from "./errors.js";
import type { CatalogRefreshResult, ModelCatalog } from "./catalog.js";

export class UnknownProviderError extends Error {
  readonly providerId: string;
  constructor(providerId: string) {
    super(`No provider adapter is registered for "${providerId}".`);
    this.name = "UnknownProviderError";
    this.providerId = providerId;
  }
}

export class UnknownModelError extends Error {
  readonly providerId: string;
  readonly modelId: string;
  constructor(providerId: string, modelId: string) {
    super(`Provider "${providerId}" does not report a model "${modelId}".`);
    this.name = "UnknownModelError";
    this.providerId = providerId;
    this.modelId = modelId;
  }
}

export interface ProviderFailure {
  readonly providerId: string;
  readonly message: string;
  readonly category: string;
  readonly retryable: boolean;
  readonly error: CreativeLabError;
}

export interface ListModelsResult {
  readonly models: ModelDescriptor[];
  /** Providers that failed. Empty on a fully successful call. */
  readonly errors: ProviderFailure[];
}

export interface RegistryOptions {
  readonly adapters?: readonly ProviderAdapter[];
  /** When supplied, `listModels`/`describeCapabilities` consult and update the cache. */
  readonly catalog?: ModelCatalog;
}

/**
 * Per-call context. `fetch` is optional here and filled from `globalThis.fetch` only at
 * this boundary, which is what keeps "no test touches the network" enforceable.
 */
export interface RegistryCallContext {
  readonly credentials: ProviderContext["credentials"];
  readonly fetch?: typeof fetch;
  readonly logger?: ProviderContext["logger"];
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly catalogRef: ModelCatalog | undefined;

  constructor(options: RegistryOptions = {}) {
    this.catalogRef = options.catalog;
    for (const adapter of options.adapters ?? []) this.register(adapter);
  }

  /** Register (or replace) an adapter. */
  register(adapter: ProviderAdapter): this {
    if (!adapter?.id) throw new UnknownProviderError(String(adapter?.id));
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  unregister(providerId: string): boolean {
    return this.adapters.delete(providerId);
  }

  has(providerId: string): boolean {
    return this.adapters.has(providerId);
  }

  get(providerId: string): ProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  /** Same as `get` but throws `UnknownProviderError` — used by the forwarding methods. */
  require(providerId: string): ProviderAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new UnknownProviderError(providerId);
    return adapter;
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  get catalog(): ModelCatalog | undefined {
    return this.catalogRef;
  }

  /**
   * List models from every registered provider (or one).
   *
   * A provider that throws contributes to `errors`; the others still return their models.
   */
  async listModels(ctx: RegistryCallContext, providerId?: string): Promise<ListModelsResult> {
    const targets = providerId ? [this.require(providerId)] : this.list();
    const context = toProviderContext(ctx);
    const models: ModelDescriptor[] = [];
    const errors: ProviderFailure[] = [];

    for (const adapter of targets) {
      try {
        const fetched = await adapter.listModels(context);
        const normalized = fetched.map((descriptor) => ({ ...descriptor, providerId: adapter.id }));
        models.push(...normalized);
        this.catalogRef?.merge(normalized);
      } catch (error) {
        const normalized = this.normalize(adapter, error);
        errors.push({
          providerId: adapter.id,
          message: normalized.message,
          category: normalized.category,
          retryable: normalized.retryable,
          error: normalized,
        });
      }
    }

    return { models, errors };
  }

  /** Refresh the catalog through every (or one) adapter, keeping stale entries on failure. */
  async refreshCatalog(
    ctx: RegistryCallContext,
    providerId?: string,
  ): Promise<CatalogRefreshResult> {
    const catalog = this.catalogRef;
    if (!catalog) throw new UnknownProviderError("catalog");
    const adapters = providerId ? [this.require(providerId)] : this.list();
    return catalog.refresh(adapters, toProviderContext(ctx), providerId);
  }

  /**
   * Capabilities for one model: the cache first, the adapter second. Both the cached and
   * freshly-fetched capabilities are recorded so the UI can show `isStale`.
   */
  // `ctx` is part of the uniform registry call shape (every method takes it) even where
  // this particular method can answer from the cache without touching the provider.
  async describeCapabilities(
    providerId: string,
    modelId: string,
    _ctx: RegistryCallContext,
  ): Promise<ModelCapabilities> {
    const adapter = this.require(providerId);
    const cached = this.catalogRef?.get(providerId, modelId);
    if (cached) return cached.capabilities;
    try {
      return await adapter.describeCapabilities(modelId);
    } catch (error) {
      throw this.normalize(adapter, error);
    }
  }

  /** Full descriptor (capabilities + freshness) for one model. */
  async describeModel(
    providerId: string,
    modelId: string,
    ctx: RegistryCallContext,
  ): Promise<ModelDescriptor> {
    // `describeCapabilities` performs the `require()` existence check, so no adapter is
    // bound here.
    const cached = this.catalogRef?.get(providerId, modelId);
    if (cached) return cached;
    const capabilities = await this.describeCapabilities(providerId, modelId, ctx);
    return {
      providerId,
      modelId,
      displayName: modelId,
      modality: capabilities.modality,
      capabilities,
      fetchedAt: (ctx.now?.() ?? new Date()).toISOString(),
      isStale: false,
    };
  }

  /**
   * Price a request. `null` means "the provider publishes no machine-readable price" and
   * must be surfaced as an unknown-cost warning, never as `0` (PRD §13).
   */
  async estimateCost(request: GenerationRequest, _ctx: RegistryCallContext): Promise<Spend | null> {
    const adapter = this.require(request.providerId);
    try {
      const viaAdapter = await adapter.estimateCost(request);
      if (viaAdapter !== null && viaAdapter !== undefined) return viaAdapter;
    } catch (error) {
      throw this.normalize(adapter, error);
    }
    // Adapter has no opinion (or the model is unknown to it): fall back to the catalog's
    // pricing block so a cached price can still be quoted offline.
    const catalog = this.catalogRef;
    if (!catalog) return null;
    const descriptor = catalog.get(request.providerId, request.modelId);
    if (!descriptor) return null;
    return estimateCostFromCapabilities(request, descriptor.capabilities);
  }

  /** Validate a request against the model's capabilities, resolving them from the cache. */
  async validate(request: GenerationRequest, ctx: RegistryCallContext): Promise<ValidationResult> {
    const adapter = this.require(request.providerId);
    const capabilities = await this.describeCapabilities(request.providerId, request.modelId, ctx);
    try {
      return adapter.validate(request, capabilities);
    } catch (error) {
      throw this.normalize(adapter, error);
    }
  }

  /** Validate against capabilities the caller already holds (no cache/network involved). */
  validateWith(request: GenerationRequest, capabilities: ModelCapabilities): ValidationResult {
    const adapter = this.require(request.providerId);
    try {
      return adapter.validate(request, capabilities);
    } catch (error) {
      throw this.normalize(adapter, error);
    }
  }

  /** Pure capability check with the shared rules, for callers that hold no adapter. */
  validateCapabilities(
    request: GenerationRequest,
    capabilities: ModelCapabilities,
  ): ValidationResult {
    return validateRequest(request, capabilities);
  }

  async submit(request: GenerationRequest, ctx: RegistryCallContext): Promise<SubmitResult> {
    const adapter = this.require(request.providerId);
    try {
      return await adapter.submit(request, toProviderContext(ctx));
    } catch (error) {
      throw this.normalize(adapter, error);
    }
  }

  async getJob(
    providerId: string,
    jobId: string,
    ctx: RegistryCallContext,
  ): Promise<JobStatusResult> {
    const adapter = this.require(providerId);
    try {
      return await adapter.getJob(jobId, toProviderContext(ctx));
    } catch (error) {
      throw this.normalize(adapter, error);
    }
  }

  async cancel(providerId: string, jobId: string, ctx: RegistryCallContext): Promise<void> {
    const adapter = this.require(providerId);
    try {
      await adapter.cancel(jobId, toProviderContext(ctx));
    } catch (error) {
      throw this.normalize(adapter, error);
    }
  }

  async fetchOutputs(
    providerId: string,
    job: JobStatusResult,
    ctx: RegistryCallContext,
  ): Promise<RemoteOutput[]> {
    const adapter = this.require(providerId);
    try {
      return await adapter.fetchOutputs(job, toProviderContext(ctx));
    } catch (error) {
      throw this.normalize(adapter, error);
    }
  }

  /** Normalize through the adapter first (it may know provider-specific shapes), then core. */
  normalize(adapter: ProviderAdapter | undefined, error: unknown): CreativeLabError {
    try {
      const viaAdapter = adapter?.normalizeError(error);
      if (viaAdapter) return viaAdapter;
    } catch {
      // Fall through to the generic normalizer rather than masking the original failure.
    }
    return normalizeProviderError(error);
  }
}

/** Fill the context defaults at the registry boundary — the only place `fetch` defaults. */
export function toProviderContext(ctx: RegistryCallContext): ProviderContext {
  return {
    credentials: ctx.credentials,
    fetch: ctx.fetch ?? globalThis.fetch,
    ...(ctx.logger ? { logger: ctx.logger } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.now ? { now: ctx.now } : {}),
  };
}
