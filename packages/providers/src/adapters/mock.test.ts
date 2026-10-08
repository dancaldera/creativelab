import { describe, expect, it } from "vitest";
import { decideRetry, DEFAULT_RETRY_POLICY, hashBytes } from "@creativelab/core";
import { MemoryCredentialVault } from "../credentials.js";
import { ProviderError } from "@creativelab/core";
import { isUncertainSubmission, isRateLimited } from "../errors.js";
import { adler32, crc32, encodePng, encodeWav, encodeVideoBlob, isPng, isWav } from "./bytes.js";
import { MockAdapter, mockModels } from "./mock.js";
import type { ProviderContext } from "../adapter.js";
import type { GenerationRequest } from "../requests.js";

/**
 * The mock double is load-bearing: the headless e2e driver commits the bytes it produces as
 * project assets, so "valid PNG/WAV" is a tested property rather than a comment.
 */

const context: ProviderContext = {
  credentials: new MemoryCredentialVault({ "provider:mock": "mock-key" }),
  fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
  now: () => new Date("2026-10-07T12:00:00.000Z"),
};

function imageRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    providerId: "mock",
    modelId: "mock-image-1",
    mode: "text-to-image",
    prompt: "a lighthouse at dusk",
    references: [],
    ...overrides,
  };
}

async function outputBytes(adapter: MockAdapter, request: GenerationRequest): Promise<Uint8Array> {
  adapter.reset();
  const submitted = await adapter.submit(request, context);
  const job = await adapter.getJob(submitted.providerJobId ?? "", context);
  const outputs = await adapter.fetchOutputs(job, context);
  expect(outputs.length).toBeGreaterThan(0);
  return adapter.bytesFor(outputs[0]!);
}

describe("byte encoders", () => {
  it("produces a structurally valid PNG with correct chunk CRCs", () => {
    const png = encodePng({ width: 8, height: 4 });
    expect(isPng(png)).toBe(true);

    // Walk the chunk list and verify each CRC over (type || data).
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    let offset = 8;
    const types: string[] = [];
    while (offset < png.length) {
      const length = view.getUint32(offset);
      const type = new TextDecoder().decode(png.slice(offset + 4, offset + 8));
      types.push(type);
      const crcInput = png.slice(offset + 4, offset + 8 + length);
      const expected = view.getUint32(offset + 8 + length);
      expect(crc32(crcInput)).toBe(expected);
      offset += 12 + length;
    }
    expect(types).toEqual(["IHDR", "IDAT", "IEND"]);

    // IHDR width/height survive the round trip.
    expect(view.getUint32(16)).toBe(8);
    expect(view.getUint32(20)).toBe(4);
  });

  it("produces a canonical 44-byte-header WAV with PCM silence", () => {
    const wav = encodeWav({
      durationSeconds: 1,
      sampleRate: 8_000,
      channels: 1,
      bitsPerSample: 16,
    });
    expect(isWav(wav.bytes)).toBe(true);
    expect(wav.headerBytes).toBe(44);
    expect(wav.dataBytes).toBe(8_000 * 1 * 2);
    expect(wav.bytes.length).toBe(44 + wav.dataBytes);

    const view = new DataView(wav.bytes.buffer, wav.bytes.byteOffset, wav.bytes.byteLength);
    expect(view.getUint32(4, true)).toBe(36 + wav.dataBytes);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(8_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(wav.dataBytes);
    // Silence: every sample byte is zero.
    expect(wav.bytes.slice(44).every((byte) => byte === 0)).toBe(true);
  });

  it("satisfies the zlib checksum helper it exports", () => {
    // zlib's Adler-32 for the bytes [0, 1, 2, 3] (verified against `node:zlib`).
    expect(adler32(new Uint8Array([0, 1, 2, 3]))).toBe(0x000e0007);
  });

  it("produces an ISO-BMFF ftyp for video", () => {
    const video = encodeVideoBlob(3, 64);
    expect(new TextDecoder().decode(video.slice(4, 8))).toBe("ftyp");
    expect(video.length).toBe(64);
  });
});

describe("MockAdapter output bytes", () => {
  it("returns real PNG bytes for images", async () => {
    const adapter = new MockAdapter({ now: context.now });
    const bytes = await outputBytes(adapter, imageRequest());
    expect(isPng(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(60);
    expect(hashBytes(bytes)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns real WAV bytes for audio", async () => {
    const adapter = new MockAdapter({ now: context.now });
    const bytes = await outputBytes(
      adapter,
      imageRequest({
        modelId: "mock-speech-1",
        mode: "tts",
        prompt: "hello there",
        voiceId: "mock-voice-aria",
        language: "en-US",
      }),
    );
    expect(isWav(bytes)).toBe(true);
  });

  it("returns a hashed byte blob for video and reports video/mp4", async () => {
    const adapter = new MockAdapter({ now: context.now });
    const request = imageRequest({
      modelId: "mock-video-1",
      mode: "text-to-video",
      durationSeconds: 4,
    });
    const submitted = await adapter.submit(request, context);
    const job = await adapter.getJob(submitted.providerJobId ?? "", context);
    const outputs = await adapter.fetchOutputs(job, context);
    expect(outputs[0]?.mimeType).toBe("video/mp4");
    expect(outputs[0]?.kind).toBe("video");
    expect(adapter.bytesFor(outputs[0]!).length).toBe(4_096);
  });

  it("is deterministic: the same request yields byte-identical outputs", async () => {
    const first = new MockAdapter({ now: context.now });
    const second = new MockAdapter({ now: context.now });
    const a = await outputBytes(first, imageRequest({ seed: 7 }));
    const b = await outputBytes(second, imageRequest({ seed: 7 }));
    expect(hashBytes(a)).toBe(hashBytes(b));

    const c = await outputBytes(
      new MockAdapter({ now: context.now, seedOutputs: 99 }),
      imageRequest({ seed: 7 }),
    );
    expect(hashBytes(c)).not.toBe(hashBytes(a));
  });

  it("rejects an output list whose expiry has passed", async () => {
    const adapter = new MockAdapter({
      now: () => new Date("2026-10-07T12:00:00.000Z"),
      expiresAt: "2026-10-07T11:00:00.000Z",
    });
    const submitted = await adapter.submit(imageRequest(), context);
    const job = await adapter.getJob(submitted.providerJobId ?? "", context);
    await expect(adapter.fetchOutputs(job, context)).rejects.toThrow(/expired/i);
  });
});

describe("MockAdapter job lifecycle", () => {
  it("progresses across polls and completes with outputs and cost", async () => {
    const adapter = new MockAdapter({ pollsBeforeCompletion: 2, now: context.now });
    const submitted = await adapter.submit(imageRequest(), context);
    expect(submitted.status).toBe("running");
    expect(submitted.providerJobId).toBeTruthy();

    const first = await adapter.getJob(submitted.providerJobId!, context);
    expect(first.status).toBe("running");
    expect(first.progress).toBeGreaterThan(0);

    const second = await adapter.getJob(submitted.providerJobId!, context);
    expect(second.status).toBe("completed");
    expect(second.outputs?.length).toBeGreaterThan(0);
    expect(second.cost).toEqual({ amount: 0.04, currency: "USD", isEstimate: false });
  });

  it("is idempotent for an identical in-flight request", async () => {
    const adapter = new MockAdapter({ pollsBeforeCompletion: 3, now: context.now });
    const request = imageRequest({ seed: 11 });
    const first = await adapter.submit(request, context);
    const second = await adapter.submit(request, context);
    expect(second.providerJobId).toBe(first.providerJobId);
    expect(adapter.submissionAttempts()).toBe(2);
  });

  it("fails the first N submissions with a retryable error, then succeeds", async () => {
    const adapter = new MockAdapter({ failFirstN: 1, failWith: { status: 500 }, now: context.now });
    const first = await adapter.submit(imageRequest(), context).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(Error);
    expect((first as { retryable: boolean }).retryable).toBe(true);
    expect((first as { uncertain: boolean }).uncertain).toBe(true);
    expect(isUncertainSubmission(first)).toBe(true);

    const second = await adapter.submit(imageRequest(), context);
    expect(second.providerJobId).toBeTruthy();
  });

  it("cancels a job", async () => {
    const adapter = new MockAdapter({ pollsBeforeCompletion: 3, now: context.now });
    const submitted = await adapter.submit(imageRequest(), context);
    await adapter.cancel(submitted.providerJobId!, context);
    const status = await adapter.getJob(submitted.providerJobId!, context);
    expect(status.status).toBe("canceled");
  });

  it("reports unknown jobs as a validation error", async () => {
    const adapter = new MockAdapter({ now: context.now });
    await expect(adapter.getJob("nope", context)).rejects.toThrow(/no job/);
  });
});

describe("MockAdapter catalog", () => {
  it("reports between four and six fully-populated models", async () => {
    const models = mockModels(() => new Date("2026-10-07T12:00:00.000Z"));
    expect(models.length).toBeGreaterThanOrEqual(4);
    expect(models.length).toBeLessThanOrEqual(6);
    for (const model of models) {
      expect(model.capabilities.modes.length).toBeGreaterThan(0);
      expect(model.capabilities.maxConcurrency).toBeGreaterThan(0);
    }
  });

  it("covers the modalities the e2e driver needs", async () => {
    const adapter = new MockAdapter({ now: context.now });
    const models = await adapter.listModels(context);
    const modes = new Set(models.flatMap((model) => model.capabilities.modes));
    for (const mode of [
      "text-to-image",
      "text-to-video",
      "image-to-video",
      "tts",
      "sfx",
      "transcription",
    ]) {
      expect([...modes]).toContain(mode);
    }
  });
});

describe("uncertain submissions never auto-resubmit", () => {
  it("flags network and timeout failures as uncertain", () => {
    expect(isUncertainSubmission(new Error("socket hang up"))).toBe(true);
    expect(
      isUncertainSubmission(
        new ProviderError("timed out", { category: "timeout", retryable: true }),
      ),
    ).toBe(true);
    expect(
      isUncertainSubmission(
        new ProviderError("bad prompt", { category: "validation", status: 422 }),
      ),
    ).toBe(false);
    expect(
      isUncertainSubmission(
        new ProviderError("missing key", { category: "credential", status: 401 }),
      ),
    ).toBe(false);
  });

  it("drives core's decideRetry refusal for an uncertain submission", () => {
    const error = { retryable: true, uncertain: true, retryAfterSeconds: 5 };
    expect(isUncertainSubmission(error)).toBe(true);
    const decision = decideRetry({
      job: { retryCount: 0, status: "submitting" },
      error,
      policy: DEFAULT_RETRY_POLICY,
    });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toMatch(/unknown/i);
    expect(decision.delayMs).toBe(0);
  });

  it("allows a retry for a definite retryable failure", () => {
    const decision = decideRetry({
      job: { retryCount: 0, status: "running" },
      error: { retryable: true, retryAfterSeconds: 3 },
      policy: DEFAULT_RETRY_POLICY,
      random: () => 0,
    });
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBeGreaterThanOrEqual(3_000);
  });

  it("treats a 429 as rate limiting", () => {
    expect(
      isRateLimited(new ProviderError("slow down", { category: "rate_limit", status: 429 })),
    ).toBe(true);
    expect(
      isRateLimited(new ProviderError("bad request", { category: "validation", status: 400 })),
    ).toBe(false);
  });
});
