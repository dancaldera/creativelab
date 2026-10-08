import { describe, expect, it } from "vitest";
import type { CreativeLabError } from "@creativelab/core";
import type { ProviderAdapter, ProviderContext } from "../adapter.js";
import { MemoryCredentialVault, containsSecret } from "../credentials.js";
import type { ModelDescriptor } from "../capabilities.js";
import type {
  GenerationRequest,
  JobStatusResult,
  RemoteOutput,
  SubmitResult,
} from "../requests.js";
import {
  ANY_URL,
  createMockFetch,
  type MockFetch,
  type MockRequest,
  type MockResponseSpec,
} from "../test-fetch.test-helper.js";
import { CloudflareAdapter } from "./cloudflare.js";
import { ElevenLabsAdapter } from "./elevenlabs.js";
import { MockAdapter } from "./mock.js";
import { VercelGatewayAdapter } from "./vercel-gateway.js";

/**
 * Table-driven contract suite, run against the mock double and all three real REST
 * adapters (PRD §8 "capability-based adapters", PRD §17 "provider adapters via mocked
 * HTTP"). Every case uses an injected `fetch`: no test here can touch the network.
 */

const KEY = "test-key-do-not-log-9f8e7d6c5b4a";
const PAST = "2020-01-01T00:00:00.000Z";
const OUTPUT_URL = "https://cdn.test/outputs/contract-model.png";
const GATEWAY_MODEL = "openai/sora-2";
const ELEVEN_MODEL = "eleven_multilingual_v2";
const CLOUDFLARE_MODEL = "@cf/stabilityai/stable-diffusion-xl-base-1.0";
const MOCK_MODEL = "mock-video-1";

interface Scenario {
  readonly mock: MockFetch;
  /** The spec most recently scripted, reused by the mock double's failure hooks. */
  response: MockResponseSpec | undefined;
}

interface AdapterCase {
  readonly name: string;
  readonly modelId: string;
  readonly mode: GenerationRequest["mode"];
  /** A realistic 200 body for whichever catalog endpoint this adapter calls. */
  readonly okSpec: MockResponseSpec;
  readonly build: (scenario: Scenario) => ProviderAdapter;
}

function scenarioWith(spec: MockResponseSpec | undefined): Scenario {
  const scenario: Scenario = { mock: createMockFetch(), response: spec };
  if (spec) scenario.mock.addRoute(ANY_URL, [spec]);
  return scenario;
}

function context(scenario: Scenario, overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    credentials: new MemoryCredentialVault({ "provider:test": KEY, "provider:mock": KEY }),
    fetch: scenario.mock.fetch,
    now: () => new Date(),
    ...overrides,
  };
}

function requestFor(
  adapterId: string,
  modelId: string,
  mode: GenerationRequest["mode"],
): GenerationRequest {
  return {
    providerId: adapterId,
    modelId,
    mode,
    prompt: "a slow pan across a rainy street",
    references: [],
  };
}

/**
 * Failure injection for the mock double, mirroring the HTTP scenarios.
 *
 * Deliberately returns plain `Error`s: the adapter is responsible for normalizing whatever
 * a transport hands it, and `interceptStatus` supplies the HTTP status.
 */
function mockIntercept(scenario: Scenario): (call: string) => Error | undefined {
  let attempts = 0;
  return (call) => {
    const spec = scenario.response;
    if (!spec || call !== "listModels") return undefined;
    attempts += 1;
    // 500 and 401 are persistent; the 429 scenario recovers on the retry, exactly like a
    // real provider that answers `Retry-After` and then serves the request.
    if (spec.status === 500) return new Error("Mock provider failed (status 500).");
    if (spec.status === 401) return new Error("Mock provider rejected the credential.");
    if (spec.status === 429)
      return attempts > 1 ? undefined : new Error("Mock provider is rate limiting.");
    return undefined;
  };
}

const ADAPTER_CASES: AdapterCase[] = [
  {
    name: "mock",
    modelId: MOCK_MODEL,
    mode: "text-to-video",
    okSpec: { status: 200, json: { data: [] } },
    build: (scenario) =>
      new MockAdapter({
        requireCredentials: true,
        ...(scenario.response?.json &&
        typeof scenario.response.json === "object" &&
        "expiresAt" in (scenario.response.json as Record<string, unknown>)
          ? { expiresAt: String((scenario.response.json as Record<string, unknown>)["expiresAt"]) }
          : {}),
        intercept: mockIntercept(scenario),
        sleep: async () => undefined,
        ...(scenario.response?.status !== undefined
          ? { interceptStatus: scenario.response.status }
          : {}),
      }),
  },
  {
    name: "vercel-gateway",
    modelId: GATEWAY_MODEL,
    mode: "text-to-video",
    okSpec: {
      status: 200,
      json: {
        data: [
          {
            id: GATEWAY_MODEL,
            name: "Sora 2",
            modality: "video",
            modes: ["text-to-video"],
            aspect_ratios: ["16:9"],
            resolutions: ["1080p"],
          },
        ],
        outputs: [{ url: OUTPUT_URL, mime_type: "video/mp4" }],
      },
    },
    build: (scenario) =>
      new VercelGatewayAdapter({
        fetch: scenario.mock.fetch,
        credentialRef: "provider:test",
        baseUrl: "https://gw.test",
        maxRetries: 2,
        sleep: async () => undefined,
      }),
  },
  {
    name: "elevenlabs",
    modelId: ELEVEN_MODEL,
    mode: "tts",
    okSpec: {
      status: 200,
      json: {
        voices: [
          { voice_id: "voice-1", name: "Narrator", labels: { language: "en", gender: "female" } },
        ],
        outputs: [{ url: OUTPUT_URL, mime_type: "audio/mpeg" }],
      },
    },
    build: (scenario) =>
      new ElevenLabsAdapter({
        fetch: scenario.mock.fetch,
        credentialRef: "provider:test",
        baseUrl: "https://el.test",
        maxRetries: 2,
        sleep: async () => undefined,
      }),
  },
  {
    name: "cloudflare",
    modelId: CLOUDFLARE_MODEL,
    mode: "text-to-image",
    okSpec: {
      status: 200,
      json: {
        result: [
          { name: CLOUDFLARE_MODEL, task: "text-to-image", description: "Stable Diffusion XL" },
          {
            name: "@cf/openai/whisper-large-v3-turbo",
            task: "automatic-speech-recognition",
            description: "Whisper",
          },
        ],
        outputs: [{ url: OUTPUT_URL, mime_type: "image/png" }],
      },
    },
    build: (scenario) =>
      new CloudflareAdapter({
        fetch: scenario.mock.fetch,
        accountId: "acct-1",
        credentialRef: "provider:test",
        baseUrl: "https://cf.test",
        maxRetries: 2,
        sleep: async () => undefined,
      }),
  },
];

describe.each(ADAPTER_CASES)("adapter contract: $name", (adapterCase) => {
  const build = (scenario: Scenario): ProviderAdapter => adapterCase.build(scenario);
  const request = (): GenerationRequest =>
    requestFor(adapterCase.name, adapterCase.modelId, adapterCase.mode);
  /** A healthy catalog response for this adapter's endpoint shape. */
  const ok = (): MockResponseSpec => adapterCase.okSpec;

  it("listModels normalizes into complete ModelDescriptor objects", async () => {
    const scenario = scenarioWith(ok());
    const adapter = build(scenario);

    const models: ModelDescriptor[] = await adapter.listModels(context(scenario));

    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.providerId.length).toBeGreaterThan(0);
      expect(model.modelId.length).toBeGreaterThan(0);
      expect(model.displayName.length).toBeGreaterThan(0);
      expect(["image", "video", "audio", "text", "subtitle"]).toContain(model.modality);
      expect(Number.isNaN(Date.parse(model.fetchedAt))).toBe(false);
      expect(typeof model.isStale).toBe("boolean");
      // Every PRD §8 field is present on every descriptor.
      expect(Object.keys(model.capabilities).sort()).toEqual(
        [
          "aspectRatios",
          "durationMaxSeconds",
          "durationMinSeconds",
          "inputMimeTypes",
          "languages",
          "maxConcurrency",
          "modality",
          "modes",
          "pricing",
          "quota",
          "referenceFrame",
          "resolutions",
          "safety",
          "supportsAudio",
          "supportsNegativePrompt",
          "supportsSeed",
          "voices",
        ].sort(),
      );
    }
  });

  it("retries a 429 carrying Retry-After and eventually succeeds", async () => {
    const scenario = scenarioWith(undefined);
    scenario.response = {
      status: 429,
      statusText: "Too Many Requests",
      headers: { "retry-after": "1" },
      json: { error: "slow down" },
    };
    scenario.mock.addRoute(ANY_URL, [scenario.response, ok()]);
    const adapter = build(scenario);

    const models = await adapter.listModels(context(scenario));
    expect(models.length).toBeGreaterThan(0);

    // The mock double performs no HTTP, so only the REST adapters are counted here.
    if (adapterCase.name !== "mock") {
      expect(scenario.mock.requests.length).toBeGreaterThanOrEqual(2);
      expect(scenario.mock.requests[0]?.url).toBeTruthy();
    }
  });

  it("throws a retryable ProviderError for a 500", async () => {
    const scenario = scenarioWith({
      status: 500,
      statusText: "Server Error",
      json: { error: "boom" },
    });
    const adapter = build(scenario);

    const error = (await adapter
      .listModels(context(scenario))
      .catch((caught: unknown) => caught)) as CreativeLabError;
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ProviderError");
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(500);
  });

  it("throws a ProviderError for a malformed body", async () => {
    const scenario = scenarioWith({
      status: 200,
      headers: { "content-type": "application/json" },
      text: "<!doctype html><html>nope</html>",
    });
    const adapter =
      adapterCase.name === "mock"
        ? new MockAdapter({ malformedResponses: true, requireCredentials: true })
        : build(scenario);

    const error = (await adapter
      .listModels(context(scenario))
      .catch((caught: unknown) => caught)) as CreativeLabError;
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ProviderError");
    expect(error.category).not.toBe("credential");
  });

  it("throws a credential error on 401 and never leaks the key", async () => {
    const scenario = scenarioWith({
      status: 401,
      statusText: "Unauthorized",
      json: { error: "invalid api key", key: KEY },
    });
    const adapter = build(scenario);

    let caught: unknown;
    try {
      await adapter.listModels(context(scenario));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as CreativeLabError;
    expect(error.category).toBe("credential");
    expect(error.status).toBe(401);
    expect(error.message).not.toContain(KEY);
    expect(JSON.stringify(error.details)).not.toContain(KEY);
    expect(containsSecret(error, KEY)).toBe(false);
  });

  it("rejects an output URL whose expiresAt is in the past", async () => {
    const scenario = scenarioWith({
      status: 200,
      json: {
        status: "completed",
        outputs: [{ url: OUTPUT_URL, mimeType: "image/png", kind: "image", expiresAt: PAST }],
      },
    });
    const adapter = build(scenario);
    const expired: RemoteOutput[] = [
      { url: OUTPUT_URL, mimeType: "image/png", kind: "image", expiresAt: PAST },
    ];
    const job: JobStatusResult = { status: "completed", outputs: expired };

    const error = (await adapter
      .fetchOutputs(job, context(scenario))
      .catch((caught: unknown) => caught)) as CreativeLabError;
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ProviderError");
    expect(error.message).toMatch(/expired/i);
  });

  it("validates a well-formed request and submits it end to end", async () => {
    const scenario = scenarioWith(ok());
    const adapter = build(scenario);

    const capabilities = await adapter.describeCapabilities(adapterCase.modelId);
    const validation = adapter.validate(request(), capabilities);
    expect(validation.errors).toEqual([]);
    expect(validation.unsupported).toEqual([]);

    const result: SubmitResult = await adapter.submit(request(), context(scenario));
    expect(["running", "completed"]).toContain(result.status);

    const outputs = await adapter.fetchOutputs(
      {
        status: "completed",
        outputs: result.outputs ?? [{ url: OUTPUT_URL, mimeType: "video/mp4", kind: "video" }],
      },
      context(scenario),
    );
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs[0]?.url).toBeTruthy();
    expect(outputs[0]?.kind).toBeTruthy();
  });

  it("normalizes an unknown thrown value through normalizeError", async () => {
    const adapter = build(scenarioWith(ok()));
    const normalized = adapter.normalizeError(new TypeError("fetch failed"));
    expect(normalized.name).toBe("ProviderError");
    expect(normalized.message).toContain("fetch failed");
    expect(normalized.category).toBe("internal");
    expect(normalized.retryable).toBe(false);
  });

  it("sends the provider's documented auth header", async () => {
    const scenario = scenarioWith(ok());
    const adapter = build(scenario);
    await adapter.listModels(context(scenario));
    if (adapterCase.name === "mock") {
      // The double has no transport; credential presence is what its contract guarantees.
      expect(await context(scenario).credentials.get("provider:test")).toBe(KEY);
      return;
    }
    const sent: MockRequest | undefined = scenario.mock.requests[0];
    expect(sent).toBeDefined();
    if (adapterCase.name === "elevenlabs") expect(sent?.header("xi-api-key")).toBe(KEY);
    else expect(sent?.header("authorization")).toBe(`Bearer ${KEY}`);
  });
});

describe("adapter contract summary", () => {
  it("covers the mock double and all three real adapters", () => {
    expect(ADAPTER_CASES.map((entry) => entry.name).sort()).toEqual([
      "cloudflare",
      "elevenlabs",
      "mock",
      "vercel-gateway",
    ]);
  });
});
