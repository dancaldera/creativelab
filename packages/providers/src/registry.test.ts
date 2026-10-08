import { describe, expect, it } from "vitest";
import type { ProviderAdapter } from "./adapter.js";
import { capabilitiesFrom, type ModelDescriptor } from "./capabilities.js";
import { MemoryCatalogStore, ModelCatalog, toCatalogEntry } from "./catalog.js";
import { MockAdapter } from "./adapters/mock.js";
import { ProviderRegistry, UnknownProviderError, type RegistryCallContext } from "./registry.js";
import { MemoryCredentialVault } from "./credentials.js";
import type { GenerationRequest } from "./requests.js";

/** Catalog staleness + provider isolation (PRD §8 catalog cache, PRD §18 provider churn). */

const TTL_MS = 1_000;

function descriptor(providerId: string, modelId: string, fetchedAt: string): ModelDescriptor {
  const capabilities = capabilitiesFrom({
    modality: "image",
    modes: ["text-to-image"],
    pricing: { unit: "per-image", amount: 0.05, currency: "USD" },
  });
  return {
    providerId,
    modelId,
    displayName: modelId,
    modality: "image",
    capabilities,
    fetchedAt,
    isStale: false,
  };
}

function context(now: () => Date): RegistryCallContext {
  return {
    credentials: new MemoryCredentialVault(),
    fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    now,
  };
}

describe("ModelCatalog staleness", () => {
  it("keeps a fresh entry fresh", async () => {
    const clock = new Date("2026-10-07T12:00:00.000Z");
    const store = new MemoryCatalogStore();
    await store.upsertModelCatalog([toCatalogEntry(descriptor("p1", "m1", clock.toISOString()))]);
    const catalog = new ModelCatalog({ store, ttlMs: TTL_MS, now: () => clock });

    const models = await catalog.load();

    expect(models).toHaveLength(1);
    expect(models[0]?.isStale).toBe(false);
  });

  it("marks an entry stale once the TTL expires", async () => {
    const fetchedAt = "2026-10-07T12:00:00.000Z";
    const store = new MemoryCatalogStore();
    await store.upsertModelCatalog([toCatalogEntry(descriptor("p1", "m1", fetchedAt))]);
    let now = new Date(Date.parse(fetchedAt) + TTL_MS - 1);
    const catalog = new ModelCatalog({ store, ttlMs: TTL_MS, now: () => now });

    expect((await catalog.load())[0]?.isStale).toBe(false);

    now = new Date(Date.parse(fetchedAt) + TTL_MS + 1);
    const later = catalog.list();
    expect(later[0]?.isStale).toBe(true);
    // The original fetch time is preserved: the UI shows the real "last refreshed" stamp.
    expect(later[0]?.fetchedAt).toBe(fetchedAt);
  });

  it("keeps stale entries when a provider refresh fails", async () => {
    const clock = new Date("2026-10-07T12:00:00.000Z");
    const store = new MemoryCatalogStore();
    await store.upsertModelCatalog([toCatalogEntry(descriptor("p1", "m1", clock.toISOString()))]);
    const catalog = new ModelCatalog({ store, ttlMs: 24 * 60 * 60 * 1_000, now: () => clock });
    await catalog.load();

    // A provider whose id matches the cached entries, so the failure is attributable.
    const failing = {
      id: "p1",
      displayName: "Failing provider",
      listModels: async () => {
        throw new Error("provider exploded");
      },
    } as unknown as ProviderAdapter;
    const result = await catalog.refresh([failing], {
      credentials: new MemoryCredentialVault(),
      fetch: (async () => new Response()) as unknown as typeof fetch,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.providerId).toBe("p1");
    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.isStale).toBe(true);
    // Not deleted: the cached entry survives the failure.
    expect(catalog.list()).toHaveLength(1);
    expect(catalog.list()[0]?.isStale).toBe(true);
  });

  it("replaces entries for a provider that refreshes successfully", async () => {
    const clock = new Date("2026-10-07T12:00:00.000Z");
    const store = new MemoryCatalogStore();
    await store.upsertModelCatalog([
      toCatalogEntry(descriptor("mock", "old-model", clock.toISOString())),
    ]);
    const catalog = new ModelCatalog({ store, ttlMs: 24 * 60 * 60 * 1_000, now: () => clock });
    await catalog.load();
    expect(catalog.list().map((model) => model.modelId)).toContain("old-model");

    const adapter = new MockAdapter();
    const result = await catalog.refresh([adapter], {
      credentials: new MemoryCredentialVault(),
      fetch: (async () => new Response()) as unknown as typeof fetch,
    });

    expect(result.errors).toHaveLength(0);
    // The retired model disappears only after a *successful* refresh.
    expect(catalog.list().map((model) => model.modelId)).not.toContain("old-model");
    expect(result.models.length).toBeGreaterThanOrEqual(4);
    expect(result.models.every((model) => model.isStale === false)).toBe(true);
  });

  it("recomputes staleness from the clock rather than trusting the stored flag", async () => {
    const fetchedAt = "2026-01-01T00:00:00.000Z";
    const store = new MemoryCatalogStore();
    await store.upsertModelCatalog([toCatalogEntry(descriptor("p1", "m1", fetchedAt))]);
    const clock = new Date("2026-10-07T12:00:00.000Z");
    const catalog = new ModelCatalog({ store, ttlMs: 24 * 60 * 60 * 1_000, now: () => clock });

    const models = await catalog.load();

    expect(models[0]?.isStale).toBe(true);
  });
});

describe("ProviderRegistry isolation", () => {
  it("still lists models for other providers when one throws", async () => {
    const healthy = new MockAdapter();
    const broken: typeof healthy = Object.assign(
      Object.create(Object.getPrototypeOf(healthy)) as MockAdapter,
      {
        id: "broken",
        displayName: "Broken",
        listModels: async () => {
          throw new Error("network down");
        },
        describeCapabilities: async () => {
          throw new Error("network down");
        },
      },
    );
    const registry = new ProviderRegistry({ adapters: [healthy, broken] });

    const result = await registry.listModels(context(() => new Date()));

    expect(result.models.length).toBeGreaterThanOrEqual(4);
    expect(result.models.every((model) => model.providerId === "mock")).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.providerId).toBe("broken");
    expect(result.errors[0]?.message).toContain("network down");
    expect(result.errors[0]?.category).toBe("internal");
  });

  it("normalizes a non-CreativeLabError thrown by an adapter", async () => {
    const adapter = new MockAdapter({
      intercept: (call) => (call === "submit" ? new TypeError("bad fetch") : undefined),
    });
    const registry = new ProviderRegistry({ adapters: [adapter] });
    const request: GenerationRequest = {
      providerId: "mock",
      modelId: "mock-image-1",
      mode: "text-to-image",
      prompt: "hello",
      references: [],
    };

    const error = await registry
      .submit(
        request,
        context(() => new Date()),
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as { name: string }).name).toBe("ProviderError");
    expect((error as Error).message).toContain("bad fetch");
  });

  it("throws UnknownProviderError for an unregistered provider", async () => {
    const registry = new ProviderRegistry();
    await expect(
      registry.listModels(
        context(() => new Date()),
        "nope",
      ),
    ).rejects.toBeInstanceOf(UnknownProviderError);
    expect(() => registry.require("nope")).toThrow(UnknownProviderError);
  });

  it("delegates listModels, validate and estimateCost for a registered adapter", async () => {
    const adapter = new MockAdapter();
    const registry = new ProviderRegistry({ adapters: [adapter] });
    const ctx = context(() => new Date());

    const models = await registry.listModels(ctx, "mock");
    expect(models.errors).toHaveLength(0);
    expect(models.models).toHaveLength(6);

    const request: GenerationRequest = {
      providerId: "mock",
      modelId: "mock-image-1",
      mode: "text-to-image",
      prompt: "a lighthouse",
      references: [],
    };
    const validation = await registry.validate(request, ctx);
    expect(validation.ok).toBe(true);

    const spend = await registry.estimateCost(request, ctx);
    expect(spend).toEqual({ amount: 0.04, currency: "USD", isEstimate: false });
  });
});

describe("registry model listing", () => {
  it("records models into the catalog when one is installed", async () => {
    const catalog = new ModelCatalog({ ttlMs: TTL_MS, now: () => new Date() });
    const registry = new ProviderRegistry({ adapters: [new MockAdapter()], catalog });

    await registry.listModels(context(() => new Date()));

    const cached = catalog.list("mock");
    expect(cached.length).toBe(6);
    const capabilities = await registry.describeCapabilities(
      "mock",
      "mock-image-1",
      context(() => new Date()),
    );
    expect(capabilities.modes).toContain("text-to-image");
  });
});
