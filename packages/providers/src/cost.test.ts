import { describe, expect, it } from "vitest";
import { capabilitiesFrom } from "./capabilities.js";
import { billableUnits, costFromPricing, estimateCostFromCapabilities } from "./cost.js";
import { MockAdapter } from "./adapters/mock.js";
import { ProviderRegistry, type RegistryCallContext } from "./registry.js";
import { MemoryCredentialVault } from "./credentials.js";
import type { GenerationRequest } from "./requests.js";

/** `estimateCost` for all four pricing units, and the null-pricing contract (PRD §13). */

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    providerId: "mock",
    modelId: "mock-image-1",
    mode: "text-to-image",
    prompt: "a lighthouse at dusk",
    references: [],
    ...overrides,
  };
}

describe("costFromPricing — unit math", () => {
  it("multiplies per-image by the number of images", () => {
    const spend = costFromPricing(
      { unit: "per-image", amount: 0.04, currency: "USD" },
      billableUnits(request()),
    );
    expect(spend).toEqual({ amount: 0.04, currency: "USD", isEstimate: false });

    const three = costFromPricing(
      { unit: "per-image", amount: 0.04, currency: "USD" },
      billableUnits(request({ extra: { images: 3 } })),
    );
    expect(three?.amount).toBeCloseTo(0.12, 6);
  });

  it("multiplies per-second by the duration", () => {
    const spend = costFromPricing(
      { unit: "per-second", amount: 0.1, currency: "USD" },
      billableUnits(request({ mode: "text-to-video", durationSeconds: 8 })),
    );
    expect(spend?.amount).toBeCloseTo(0.8, 6);
  });

  it("multiplies per-1k-chars by prompt length over 1000", () => {
    const prompt = "x".repeat(2_000);
    const spend = costFromPricing(
      { unit: "per-1k-chars", amount: 0.15, currency: "USD" },
      billableUnits(request({ prompt })),
    );
    expect(spend?.amount).toBeCloseTo(0.3, 6);

    const short = costFromPricing(
      { unit: "per-1k-chars", amount: 0.15, currency: "USD" },
      billableUnits(request({ prompt: "x".repeat(500) })),
    );
    expect(short?.amount).toBeCloseTo(0.075, 6);
  });

  it("charges per-request a flat amount", () => {
    const spend = costFromPricing(
      { unit: "per-request", amount: 0.02, currency: "USD" },
      billableUnits(request({ prompt: "x".repeat(5_000) })),
    );
    expect(spend?.amount).toBeCloseTo(0.02, 6);
  });

  it("reports a per-second price with no known duration as unknown, not as one second", () => {
    const spend = costFromPricing(
      { unit: "per-second", amount: 0.1, currency: "USD" },
      billableUnits(request({ mode: "text-to-video" })),
    );
    expect(spend).toBeNull();
  });

  it("returns null when pricing is null and never a fabricated zero", () => {
    expect(costFromPricing(null, billableUnits(request()))).toBeNull();
    expect(costFromPricing(undefined, billableUnits(request()))).toBeNull();
    expect(
      estimateCostFromCapabilities(
        request(),
        capabilitiesFrom({ modality: "image", modes: ["text-to-image"] }),
      ),
    ).toBeNull();
  });

  it("honours the pricing currency", () => {
    const spend = costFromPricing(
      { unit: "per-request", amount: 1, currency: "EUR" },
      billableUnits(request()),
    );
    expect(spend?.currency).toBe("EUR");
  });
});

describe("estimateCost through capabilities", () => {
  it("reads the pricing block off the capability object", () => {
    const capabilities = capabilitiesFrom({
      modality: "audio",
      modes: ["tts"],
      pricing: { unit: "per-1k-chars", amount: 0.3, currency: "USD" },
    });
    const spend = estimateCostFromCapabilities(
      request({ mode: "tts", prompt: "y".repeat(1_000) }),
      capabilities,
    );
    expect(spend?.amount).toBeCloseTo(0.3, 6);
  });

  it("uses the model's maximum duration when a per-second model has no requested duration", () => {
    const capabilities = capabilitiesFrom({
      modality: "video",
      modes: ["text-to-video"],
      durationMinSeconds: 4,
      durationMaxSeconds: 10,
      pricing: { unit: "per-second", amount: 0.1, currency: "USD" },
    });
    const spend = estimateCostFromCapabilities(request({ mode: "text-to-video" }), capabilities);
    // Conservative: the ceiling, never an under-quote.
    expect(spend?.amount).toBeCloseTo(1, 6);
  });
});

describe("adapter and registry cost estimation", () => {
  const ctx: RegistryCallContext = {
    credentials: new MemoryCredentialVault(),
    fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    now: () => new Date(),
  };

  it("estimates per-image, per-second, per-1k-chars and per-request from the mock catalog", async () => {
    const adapter = new MockAdapter();

    const image = await adapter.estimateCost(request({ modelId: "mock-image-1" }));
    expect(image).toEqual({ amount: 0.04, currency: "USD", isEstimate: false });

    const video = await adapter.estimateCost(
      request({ modelId: "mock-video-1", mode: "text-to-video", durationSeconds: 5 }),
    );
    expect(video?.amount).toBeCloseTo(0.5, 6);

    const speech = await adapter.estimateCost(
      request({ modelId: "mock-speech-1", mode: "tts", prompt: "z".repeat(2_000) }),
    );
    expect(speech?.amount).toBeCloseTo(0.3, 6);

    const sfx = await adapter.estimateCost(request({ modelId: "mock-sfx-1", mode: "sfx" }));
    expect(sfx?.amount).toBeCloseTo(0.02, 6);
  });

  it("returns null rather than zero for a model with no published pricing", async () => {
    const adapter = new MockAdapter();
    const spend = await adapter.estimateCost(
      request({ modelId: "mock-video-frame-1", mode: "image-to-video", durationSeconds: 5 }),
    );
    expect(spend).toBeNull();
  });

  it("falls back to the cached catalog pricing when the adapter has no opinion", async () => {
    const adapter = new MockAdapter();
    const registry = new ProviderRegistry({ adapters: [adapter] });
    // Prime the local model list so the adapter can price the request.
    await registry.listModels(ctx, "mock");

    const spend = await registry.estimateCost(request({ modelId: "mock-image-1" }), ctx);
    expect(spend).toEqual({ amount: 0.04, currency: "USD", isEstimate: false });
  });

  it("never fabricates a zero through the registry for an unpriced model", async () => {
    const registry = new ProviderRegistry({ adapters: [new MockAdapter()] });
    await registry.listModels(ctx, "mock");
    const spend = await registry.estimateCost(
      request({ modelId: "mock-video-frame-1", mode: "image-to-video", durationSeconds: 6 }),
      ctx,
    );
    expect(spend).toBeNull();
  });
});
