/**
 * Model catalog cache (PRD §8: "A live model catalog drives the UI and is cached locally
 * with a refresh timestamp").
 *
 * Persistence is delegated to an injected `CatalogStore` whose two methods are
 * structurally identical to core's `SqliteProjectStore`, so the desktop app passes the
 * real store and tests pass an in-memory one.
 *
 * Failure policy (PRD §18 "Provider APIs/pricing change"): a failed refresh **marks the
 * provider's entries stale instead of deleting them**. The user can still see and use the
 * last known models, labelled with their real last-refresh time.
 */
import type { ModelCatalogEntry } from "@creativelab/core";
import {
  ModelCapabilitiesSchema,
  ModelDescriptorSchema,
  modelKey,
  type ModelDescriptor,
} from "./capabilities.js";
import type { ProviderContext } from "./adapter.js";
import type { ProviderAdapter } from "./adapter.js";
import { normalizeProviderError } from "./errors.js";

/** Default freshness window for a catalog entry. */
export const DEFAULT_CATALOG_TTL_MS = 24 * 60 * 60 * 1_000;

/** The slice of `ProjectStore` the catalog needs — matches core's `SqliteProjectStore`. */
export interface CatalogStore {
  upsertModelCatalog(entries: readonly ModelCatalogEntry[]): Promise<void>;
  listModelCatalog(providerId?: string): Promise<ModelCatalogEntry[]>;
}

/** Simple in-memory `CatalogStore` for tests, the CLI and headless runs. */
export class MemoryCatalogStore implements CatalogStore {
  private readonly entries = new Map<string, ModelCatalogEntry>();

  async upsertModelCatalog(entries: readonly ModelCatalogEntry[]): Promise<void> {
    for (const entry of entries) this.entries.set(entry.id, entry);
  }

  async listModelCatalog(providerId?: string): Promise<ModelCatalogEntry[]> {
    const all = [...this.entries.values()];
    return providerId ? all.filter((entry) => entry.providerId === providerId) : all;
  }

  snapshot(): ModelCatalogEntry[] {
    return [...this.entries.values()];
  }
}

export class CatalogError extends Error {
  readonly providerId: string | undefined;
  constructor(message: string, providerId?: string) {
    super(message);
    this.name = "CatalogError";
    this.providerId = providerId;
  }
}

export interface CatalogRefreshError {
  readonly providerId: string;
  readonly message: string;
  readonly category: string;
  readonly retryable: boolean;
}

export interface CatalogRefreshResult {
  readonly models: ModelDescriptor[];
  readonly errors: CatalogRefreshError[];
  readonly refreshedAt: string;
}

export interface ModelCatalogOptions {
  readonly store?: CatalogStore;
  /** Entries older than this are `isStale`. Defaults to 24h. */
  readonly ttlMs?: number;
  readonly now?: () => Date;
  readonly logger?: ProviderContext["logger"];
}

/** Convert a descriptor into the flat row core persists. */
export function toCatalogEntry(descriptor: ModelDescriptor): ModelCatalogEntry {
  return {
    id: modelKey(descriptor.providerId, descriptor.modelId),
    providerId: descriptor.providerId,
    modelId: descriptor.modelId,
    displayName: descriptor.displayName,
    modality: descriptor.modality,
    capabilities: descriptor.capabilities as unknown as Record<string, unknown>,
    pricing: (descriptor.capabilities.pricing ?? null) as Record<string, unknown> | null,
    fetchedAt: descriptor.fetchedAt,
    isStale: descriptor.isStale,
  };
}

/** Rehydrate a descriptor from a persisted row. Throws `CatalogError` on malformed data. */
export function fromCatalogEntry(entry: ModelCatalogEntry): ModelDescriptor {
  const capabilities = ModelCapabilitiesSchema.safeParse(entry.capabilities);
  if (!capabilities.success) {
    throw new CatalogError(
      `Catalog entry ${entry.id} has malformed capabilities.`,
      entry.providerId,
    );
  }
  const descriptor = ModelDescriptorSchema.safeParse({
    providerId: entry.providerId,
    modelId: entry.modelId,
    displayName: entry.displayName,
    modality: entry.modality,
    capabilities: capabilities.data,
    fetchedAt: entry.fetchedAt,
    isStale: entry.isStale,
  });
  if (!descriptor.success) {
    throw new CatalogError(`Catalog entry ${entry.id} is malformed.`, entry.providerId);
  }
  return descriptor.data;
}

export class ModelCatalog {
  private readonly store: CatalogStore | undefined;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly logger: ModelCatalogOptions["logger"];
  private readonly cache = new Map<string, ModelDescriptor>();
  private loaded = false;

  constructor(options: ModelCatalogOptions = {}) {
    this.store = options.store;
    this.ttlMs = options.ttlMs ?? DEFAULT_CATALOG_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
  }

  /** Load persisted entries once. Safe to call repeatedly. */
  async load(providerId?: string): Promise<ModelDescriptor[]> {
    if (!this.store) {
      this.loaded = true;
      return this.list(providerId);
    }
    const entries = await this.store.listModelCatalog(providerId);
    for (const entry of entries) {
      try {
        const descriptor = fromCatalogEntry(entry);
        // Recompute staleness against the current clock rather than trusting a persisted
        // boolean, so an entry written weeks ago is not reported fresh after a restart.
        this.cache.set(modelKey(descriptor.providerId, descriptor.modelId), {
          ...descriptor,
          isStale: descriptor.isStale || this.isExpired(descriptor.fetchedAt),
        });
      } catch (error) {
        this.logger?.warn("skipping malformed model catalog entry", {
          entryId: entry.id,
          message: normalizeProviderError(error).message,
        });
      }
    }
    this.loaded = true;
    return this.list(providerId);
  }

  /** In-memory entries, optionally for one provider. Never touches the store. */
  list(providerId?: string): ModelDescriptor[] {
    const all = [...this.cache.values()].map((descriptor) => ({
      ...descriptor,
      isStale: descriptor.isStale || this.isExpired(descriptor.fetchedAt),
    }));
    return providerId ? all.filter((descriptor) => descriptor.providerId === providerId) : all;
  }

  /** The cached descriptors for one model, or `undefined`. */
  get(providerId: string, modelId: string): ModelDescriptor | undefined {
    return this.list().find(
      (descriptor) => descriptor.providerId === providerId && descriptor.modelId === modelId,
    );
  }

  /**
   * Fetch fresh descriptors from every (or one) registered adapter.
   *
   * Fresh results replace cached entries for that provider. A failing provider keeps its
   * cached entries, flagged stale, and contributes to `errors` — the catalog is never
   * emptied by a network failure.
   */
  async refresh(
    adapters: readonly ProviderAdapter[],
    ctx: ProviderContext,
    providerId?: string,
  ): Promise<CatalogRefreshResult> {
    const now = this.now();
    const refreshedAt = now.toISOString();
    const targets = providerId ? adapters.filter((adapter) => adapter.id === providerId) : adapters;
    const models: ModelDescriptor[] = [];
    const errors: CatalogRefreshError[] = [];
    const changed: ModelDescriptor[] = [];

    for (const adapter of targets) {
      try {
        const fetched = await adapter.listModels(ctx);
        const normalized = fetched.map((descriptor) => ({
          ...descriptor,
          providerId: adapter.id,
          isStale: false,
        }));
        this.mergeProvider(adapter.id, normalized);
        models.push(...normalized);
        changed.push(...normalized);
      } catch (error) {
        const normalized = normalizeProviderError(error, []);
        errors.push({
          providerId: adapter.id,
          message: normalized.message,
          category: normalized.category,
          retryable: normalized.retryable,
        });
        this.markProviderStale(adapter.id);
        models.push(...this.list(adapter.id));
        this.logger?.warn("model catalog refresh failed; keeping stale entries", {
          providerId: adapter.id,
          category: normalized.category,
          retryable: normalized.retryable,
        });
      }
    }

    if (this.store && changed.length > 0) {
      await this.store.upsertModelCatalog(changed.map(toCatalogEntry));
    }

    return { models, errors, refreshedAt };
  }

  /** Insert/refresh descriptor list for a provider without touching other providers. */
  merge(descriptors: readonly ModelDescriptor[]): ModelDescriptor[] {
    const byProvider = new Map<string, ModelDescriptor[]>();
    for (const descriptor of descriptors) {
      const list = byProvider.get(descriptor.providerId) ?? [];
      list.push(descriptor);
      byProvider.set(descriptor.providerId, list);
    }
    for (const [providerId, list] of byProvider) this.mergeProvider(providerId, list);
    return [...descriptors];
  }

  /** Mark every cached entry of a provider stale without removing it. */
  markProviderStale(providerId: string): void {
    for (const [key, descriptor] of this.cache) {
      if (descriptor.providerId !== providerId || descriptor.isStale) continue;
      // Keep the original `fetchedAt`: it is what the UI shows as "last refreshed".
      this.cache.set(key, { ...descriptor, isStale: true });
    }
  }

  private mergeProvider(providerId: string, descriptors: readonly ModelDescriptor[]): void {
    const seen = new Set<string>();
    for (const descriptor of descriptors) {
      const key = modelKey(providerId, descriptor.modelId);
      seen.add(key);
      this.cache.set(key, { ...descriptor, providerId, isStale: false });
    }
    // Models the provider no longer reports are dropped *only* on a successful refresh for
    // that provider; a failed refresh goes through `markProviderStale` instead.
    for (const [key, descriptor] of [...this.cache]) {
      if (descriptor.providerId === providerId && !seen.has(key)) this.cache.delete(key);
    }
  }

  private isExpired(fetchedAt: string): boolean {
    const parsed = Date.parse(fetchedAt);
    if (Number.isNaN(parsed)) return true;
    return this.now().getTime() - parsed > this.ttlMs;
  }

  isLoaded(): boolean {
    return this.loaded;
  }
}

/** Convenience factory so callers do not need `new ModelCatalog` in tests. */
export function createCatalog(options: ModelCatalogOptions = {}): ModelCatalog {
  return new ModelCatalog(options);
}
