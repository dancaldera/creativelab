import { describe, expect, it } from "vitest";
import { capabilitiesFrom, type ModelCapabilities } from "./capabilities.js";
import type { GenerationRequest } from "./requests.js";
import { validateRequest } from "./validate.js";

/**
 * Every gating rule from PRD §8 ("Unknown features must be hidden/disabled rather than
 * silently ignored"), positive and negative, asserting the offending *field* name appears
 * in `unsupported`.
 */

const imageCapabilities: ModelCapabilities = capabilitiesFrom({
  modality: "image",
  modes: ["text-to-image", "image-to-image"],
  inputMimeTypes: ["image/png"],
  aspectRatios: ["1:1", "16:9"],
  resolutions: ["1024x1024"],
  durationMinSeconds: null,
  durationMaxSeconds: null,
  supportsSeed: true,
  supportsNegativePrompt: true,
  referenceFrame: "optional",
  maxConcurrency: 2,
  pricing: { unit: "per-image", amount: 0.04, currency: "USD" },
});

const videoCapabilities: ModelCapabilities = capabilitiesFrom({
  modality: "video",
  modes: ["text-to-video", "image-to-video"],
  inputMimeTypes: ["image/png"],
  aspectRatios: ["16:9"],
  resolutions: ["1080p"],
  durationMinSeconds: 4,
  durationMaxSeconds: 8,
  supportsSeed: false,
  supportsNegativePrompt: false,
  referenceFrame: "none",
  maxConcurrency: 1,
});

const speechCapabilities: ModelCapabilities = capabilitiesFrom({
  modality: "audio",
  modes: ["tts"],
  inputMimeTypes: ["text/plain"],
  supportsSeed: false,
  supportsNegativePrompt: false,
  referenceFrame: "none",
  supportsAudio: true,
  voices: [
    { id: "voice-a", name: "Voice A", languages: ["en-US"], gender: null, previewUrl: null },
    { id: "voice-b", name: "Voice B", languages: ["es-ES"], gender: null, previewUrl: null },
  ],
  languages: ["en-US", "es-ES"],
  maxConcurrency: 2,
  pricing: { unit: "per-1k-chars", amount: 0.1, currency: "USD" },
});

const frameCapabilities: ModelCapabilities = capabilitiesFrom({
  modality: "video",
  modes: ["image-to-video"],
  inputMimeTypes: ["image/png"],
  referenceFrame: "required",
  maxConcurrency: 1,
});

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    providerId: "test",
    modelId: "model",
    mode: "text-to-image",
    prompt: "a lighthouse at dusk",
    references: [],
    ...overrides,
  };
}

describe("validateRequest — mode / modality gating", () => {
  it("accepts a supported mode", () => {
    const result = validateRequest(request(), imageCapabilities);
    expect(result.ok).toBe(true);
    expect(result.unsupported).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("names `mode` in unsupported when the model does not serve it", () => {
    const result = validateRequest(request({ mode: "tts" }), imageCapabilities);
    expect(result.ok).toBe(false);
    expect(result.unsupported.map((issue) => issue.field)).toContain("mode");
    expect(result.unsupported.find((issue) => issue.field === "mode")?.code).toBe(
      "unsupported_mode",
    );
  });

  it("keeps unsupported and errors separate", () => {
    const result = validateRequest(request({ mode: "tts", prompt: "   " }), imageCapabilities);
    expect(result.unsupported.map((issue) => issue.field)).toContain("mode");
    expect(result.errors.map((issue) => issue.field)).toContain("prompt");
  });
});

describe("validateRequest — prompt", () => {
  it("requires a prompt for prompt-driven modes", () => {
    const result = validateRequest(request({ prompt: "   " }), imageCapabilities);
    expect(result.errors.map((issue) => issue.field)).toContain("prompt");
    expect(result.ok).toBe(false);
  });

  it("does not require a prompt for transcription", () => {
    const capabilities = capabilitiesFrom({
      modality: "text",
      modes: ["transcription"],
      referenceFrame: "required",
      supportsAudio: true,
    });
    const result = validateRequest(
      request({
        mode: "transcription",
        prompt: "",
        references: [{ role: "audio", assetId: "asset-1" }],
      }),
      capabilities,
    );
    expect(result.errors.map((issue) => issue.field)).not.toContain("prompt");
    expect(result.ok).toBe(true);
  });
});

describe("validateRequest — duration", () => {
  it("accepts a duration inside the range", () => {
    const result = validateRequest(
      request({ mode: "text-to-video", durationSeconds: 6 }),
      videoCapabilities,
    );
    expect(result.unsupported).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it("rejects a duration above the maximum, naming durationSeconds", () => {
    const result = validateRequest(
      request({ mode: "text-to-video", durationSeconds: 30 }),
      videoCapabilities,
    );
    expect(result.unsupported.map((issue) => issue.field)).toContain("durationSeconds");
    expect(result.unsupported.find((issue) => issue.field === "durationSeconds")?.code).toBe(
      "duration_out_of_range",
    );
  });

  it("rejects a duration below the minimum", () => {
    const result = validateRequest(
      request({ mode: "text-to-video", durationSeconds: 1 }),
      videoCapabilities,
    );
    expect(result.unsupported.map((issue) => issue.field)).toContain("durationSeconds");
  });

  it("does not gate a duration when the model has no bounds", () => {
    const result = validateRequest(request({ durationSeconds: 999 }), imageCapabilities);
    expect(result.unsupported.map((issue) => issue.field)).not.toContain("durationSeconds");
  });
});

describe("validateRequest — aspect ratio and resolution", () => {
  it("accepts listed values", () => {
    const result = validateRequest(
      request({ aspectRatio: "16:9", resolution: "1024x1024" }),
      imageCapabilities,
    );
    expect(result.unsupported).toHaveLength(0);
  });

  it("rejects an unsupported aspect ratio, naming aspectRatio", () => {
    const result = validateRequest(request({ aspectRatio: "21:9" }), imageCapabilities);
    expect(result.unsupported.map((issue) => issue.field)).toContain("aspectRatio");
    expect(result.unsupported.find((issue) => issue.field === "aspectRatio")?.code).toBe(
      "unsupported_aspect_ratio",
    );
  });

  it("rejects an unsupported resolution, naming resolution", () => {
    const result = validateRequest(request({ resolution: "4k" }), imageCapabilities);
    expect(result.unsupported.map((issue) => issue.field)).toContain("resolution");
    expect(result.unsupported.find((issue) => issue.field === "resolution")?.code).toBe(
      "unsupported_resolution",
    );
  });
});

describe("validateRequest — seed and negative prompt", () => {
  it("accepts a seed when supported", () => {
    const result = validateRequest(request({ seed: 42 }), imageCapabilities);
    expect(result.unsupported).toHaveLength(0);
  });

  it("rejects a seed when supportsSeed is false, naming seed", () => {
    const result = validateRequest(request({ mode: "text-to-video", seed: 42 }), videoCapabilities);
    expect(result.unsupported.map((issue) => issue.field)).toContain("seed");
    expect(result.unsupported.find((issue) => issue.field === "seed")?.code).toBe(
      "unsupported_seed",
    );
  });

  it("accepts a negative prompt when supported", () => {
    const result = validateRequest(request({ negativePrompt: "blurry" }), imageCapabilities);
    expect(result.unsupported).toHaveLength(0);
  });

  it("rejects a negative prompt when unsupported, naming negativePrompt", () => {
    const result = validateRequest(
      request({ mode: "text-to-video", negativePrompt: "blurry" }),
      videoCapabilities,
    );
    expect(result.unsupported.map((issue) => issue.field)).toContain("negativePrompt");
    expect(result.unsupported.find((issue) => issue.field === "negativePrompt")?.code).toBe(
      "unsupported_negative_prompt",
    );
  });
});

describe("validateRequest — references", () => {
  it("rejects any reference when referenceFrame is none, naming references", () => {
    const result = validateRequest(
      request({ mode: "image-to-video", references: [{ role: "image", assetId: "asset-1" }] }),
      videoCapabilities,
    );
    expect(result.unsupported.map((issue) => issue.field)).toContain("references");
    expect(result.unsupported.find((issue) => issue.field === "references")?.code).toBe(
      "unsupported_references",
    );
  });

  it("allows a reference when referenceFrame is optional", () => {
    const result = validateRequest(
      request({ references: [{ role: "image", assetId: "asset-1" }] }),
      imageCapabilities,
    );
    expect(result.unsupported).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it("requires a reference when referenceFrame is required", () => {
    const result = validateRequest(
      request({ mode: "image-to-video", references: [] }),
      frameCapabilities,
    );
    expect(result.errors.map((issue) => issue.field)).toContain("references");
    expect(result.errors.find((issue) => issue.field === "references")?.code).toBe(
      "reference_required",
    );
  });

  it("names the role field for an unsupported reference frame", () => {
    const result = validateRequest(
      request({ references: [{ role: "first-frame", assetId: "asset-1" }] }),
      capabilitiesFrom({ modality: "image", modes: ["image-to-image"], referenceFrame: "none" }),
    );
    expect(result.unsupported.map((issue) => issue.field)).toContain("references.0.role");
  });

  it("reports a reference with no source as an error", () => {
    const result = validateRequest(request({ references: [{ role: "image" }] }), imageCapabilities);
    expect(result.errors.map((issue) => issue.field)).toContain("references.0");
    expect(result.errors.find((issue) => issue.field === "references.0")?.code).toBe(
      "reference_missing_source",
    );
  });

  it("requires a reference for reference-driven modes", () => {
    const capabilities = capabilitiesFrom({
      modality: "image",
      modes: ["image-to-image"],
      referenceFrame: "optional",
    });
    const result = validateRequest(
      request({ mode: "image-to-image", references: [] }),
      capabilities,
    );
    expect(result.errors.map((issue) => issue.field)).toContain("references");
    expect(result.errors.find((issue) => issue.field === "references")?.code).toBe(
      "reference_required_by_mode",
    );
  });
});

describe("validateRequest — voice and language", () => {
  it("accepts a known voice", () => {
    const result = validateRequest(
      request({ mode: "tts", voiceId: "voice-a", language: "en-US" }),
      speechCapabilities,
    );
    expect(result.errors).toHaveLength(0);
    expect(result.unsupported).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown voice, naming voiceId", () => {
    const result = validateRequest(
      request({ mode: "tts", voiceId: "nope", language: "en-US" }),
      speechCapabilities,
    );
    expect(result.errors.map((issue) => issue.field)).toContain("voiceId");
    expect(result.errors.find((issue) => issue.field === "voiceId")?.code).toBe("unknown_voice");
  });

  it("rejects a voice on a model with no voices as unsupported", () => {
    const result = validateRequest(request({ mode: "tts", voiceId: "voice-a" }), videoCapabilities);
    expect(result.unsupported.map((issue) => issue.field)).toContain("voiceId");
  });

  it("rejects an unknown language, naming language", () => {
    const result = validateRequest(
      request({ mode: "tts", voiceId: "voice-a", language: "ja-JP" }),
      speechCapabilities,
    );
    expect(result.errors.map((issue) => issue.field)).toContain("language");
    expect(result.errors.find((issue) => issue.field === "language")?.code).toBe(
      "unknown_language",
    );
  });

  it("reports a language on a model without language support as unsupported", () => {
    const result = validateRequest(request({ language: "en-US" }), imageCapabilities);
    expect(result.unsupported.map((issue) => issue.field)).toContain("language");
  });
});

describe("validateRequest — invariants", () => {
  const cases: Array<[string, GenerationRequest, ModelCapabilities, string]> = [
    ["mode", request({ mode: "sfx" }), imageCapabilities, "mode"],
    [
      "duration",
      request({ mode: "text-to-video", durationSeconds: 99 }),
      videoCapabilities,
      "durationSeconds",
    ],
    ["aspect ratio", request({ aspectRatio: "21:9" }), imageCapabilities, "aspectRatio"],
    ["resolution", request({ resolution: "8k" }), imageCapabilities, "resolution"],
    ["seed", request({ mode: "text-to-video", seed: 1 }), videoCapabilities, "seed"],
    [
      "negative prompt",
      request({ mode: "text-to-video", negativePrompt: "x" }),
      videoCapabilities,
      "negativePrompt",
    ],
    [
      "references",
      request({ mode: "image-to-video", references: [{ role: "image", assetId: "a" }] }),
      videoCapabilities,
      "references",
    ],
    ["language", request({ language: "en-US" }), imageCapabilities, "language"],
  ];

  it.each(cases)(
    "puts %s in unsupported even when errors are also present",
    (_label, req, capabilities, field) => {
      // An otherwise-invalid prompt forces `errors` to be non-empty too.
      const result = validateRequest({ ...req, prompt: "" }, capabilities);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.unsupported.map((issue) => issue.field)).toContain(field);
      expect(result.ok).toBe(false);
    },
  );

  it("reports ok=false whenever unsupported is non-empty", () => {
    const result = validateRequest(request({ aspectRatio: "21:9" }), imageCapabilities);
    expect(result.unsupported.length).toBeGreaterThan(0);
    expect(result.ok).toBe(false);
  });
});
