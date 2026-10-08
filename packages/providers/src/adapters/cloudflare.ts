/**
 * Cloudflare Workers AI adapter (PRD §8: "Distinguish Workers AI-hosted from third-party
 * catalog offerings").
 *
 * Endpoints:
 *   * `GET  /accounts/{accountId}/ai/models/search`  -> catalog
 *   * `POST /accounts/{accountId}/ai/run/{model}`    -> image / transcription / tts
 *
 * Auth is a bearer token. Workers AI generation is synchronous, so `submit` returns
 * `completed` with an output URL that carries the transport's expiry; `getJob` resolves a
 * stored run when one exists and otherwise reports `unknown` (which routes to
 * reconciliation rather than a retry).
 */
import { ProviderError, ValidationError } from "@creativelab/core";
import type { ProviderContext } from "../adapter.js";
import type { ModelCapabilities, ModelDescriptor } from "../capabilities.js";
import { capabilitiesFrom, reportedList } from "../capabilities.js";
import type {
  GenerationRequest,
  JobStatusResult,
  RemoteOutput,
  SubmitResult,
} from "../requests.js";
import { extractOutputList, firstString, mapRemoteStatus } from "../remote.js";
import { asArray, asRecord, RestAdapter, type RestAdapterConfig } from "./shared.js";

export const DEFAULT_CLOUDFLARE_BASE_URL = "https://api.cloudflare.com/client/v4";
export const CLOUDFLARE_PROVIDER_ID = "cloudflare";

/** Installable subset of the Workers AI catalog the adapter knows how to drive. */
export interface CloudflareModelSpec {
  readonly modelId: string;
  readonly displayName: string;
  readonly capabilities: ModelCapabilities;
}

export const CLOUDFLARE_FALLBACK_MODELS: readonly CloudflareModelSpec[] = [
  {
    modelId: "@cf/stabilityai/stable-diffusion-xl-base-1.0",
    displayName: "Stable Diffusion XL Base 1.0 (Workers AI)",
    capabilities: capabilitiesFrom({
      modality: "image",
      modes: ["text-to-image"],
      inputMimeTypes: ["text/plain"],
      aspectRatios: ["1:1"],
      resolutions: ["1024x1024"],
      supportsSeed: true,
      supportsNegativePrompt: true,
      referenceFrame: "none",
      maxConcurrency: 2,
      pricing: null,
      quota: null,
      safety: { contentFiltering: true, notes: null },
    }),
  },
  {
    modelId: "@cf/black-forest-labs/flux-1-schnell",
    displayName: "FLUX.1 Schnell (Workers AI)",
    capabilities: capabilitiesFrom({
      modality: "image",
      modes: ["text-to-image"],
      inputMimeTypes: ["text/plain"],
      aspectRatios: ["1:1", "16:9", "9:16"],
      resolutions: ["512x512", "1024x1024"],
      supportsSeed: true,
      supportsNegativePrompt: false,
      referenceFrame: "none",
      maxConcurrency: 2,
      pricing: null,
      quota: null,
      safety: { contentFiltering: true, notes: null },
    }),
  },
  {
    modelId: "@cf/openai/whisper-large-v3-turbo",
    displayName: "Whisper Large v3 Turbo (Workers AI)",
    capabilities: capabilitiesFrom({
      modality: "text",
      modes: ["transcription"],
      inputMimeTypes: ["audio/wav", "audio/mpeg", "audio/mp4", "video/mp4"],
      referenceFrame: "required",
      supportsAudio: true,
      languages: ["en", "es", "de", "fr", "pt", "it", "ja", "zh"],
      maxConcurrency: 2,
      pricing: null,
      quota: null,
      safety: { contentFiltering: false, notes: null },
    }),
  },
  {
    modelId: "@cf/myshell-ai/melotts",
    displayName: "MeloTTS (Workers AI)",
    capabilities: capabilitiesFrom({
      modality: "audio",
      modes: ["tts"],
      inputMimeTypes: ["text/plain"],
      supportsSeed: false,
      supportsNegativePrompt: false,
      referenceFrame: "none",
      supportsAudio: true,
      voices: [
        {
          id: "en-US-1",
          name: "English (US)",
          languages: ["en-US"],
          gender: null,
          previewUrl: null,
        },
        {
          id: "en-GB-1",
          name: "English (UK)",
          languages: ["en-GB"],
          gender: null,
          previewUrl: null,
        },
      ],
      languages: ["en-US", "en-GB"],
      maxConcurrency: 2,
      pricing: null,
      quota: null,
      safety: { contentFiltering: false, notes: null },
    }),
  },
];

export interface CloudflareAdapterOptions extends Partial<
  Omit<RestAdapterConfig, "providerId" | "displayName" | "defaultBaseUrl" | "authHeaders">
> {
  /** Cloudflare account id; required for every endpoint in this adapter. */
  readonly accountId?: string;
  readonly baseUrl?: string;
  readonly credentialRef?: string;
  readonly fetch?: typeof fetch;
  /** Extra models passed by the caller (e.g. from a cached catalog). */
  readonly extraModels?: readonly CloudflareModelSpec[];
}

export class CloudflareAdapter extends RestAdapter {
  readonly id = CLOUDFLARE_PROVIDER_ID;
  readonly displayName = "Cloudflare Workers AI";

  private readonly accountId: string | undefined;
  private readonly knownModels: CloudflareModelSpec[];
  private modelCache: ModelDescriptor[] = [];

  constructor(options: CloudflareAdapterOptions = {}) {
    super({
      ...options,
      providerId: CLOUDFLARE_PROVIDER_ID,
      displayName: "Cloudflare Workers AI",
      defaultBaseUrl: DEFAULT_CLOUDFLARE_BASE_URL,
      authHeaders: (secret) => ({ authorization: `Bearer ${secret}` }),
    });
    this.accountId = options.accountId;
    this.knownModels = [...CLOUDFLARE_FALLBACK_MODELS, ...(options.extraModels ?? [])];
  }

  // -------------------------------------------------------------------------
  // Catalog
  // -------------------------------------------------------------------------

  async listModels(ctx: ProviderContext): Promise<ModelDescriptor[]> {
    const path = `/accounts/${encodeURIComponent(this.requireAccountId())}/ai/models/search`;
    const payload = await this.requestJson<unknown>(ctx, path, {
      method: "GET",
      operation: "listModels",
    });
    const entries = extractModelEntries(payload);
    const descriptors = entries
      .map((entry) => this.describeEntry(entry))
      .filter((item): item is ModelDescriptor => item !== undefined);
    if (descriptors.length === 0) {
      // The remote answer contained nothing usable. Falling back to the static list here
      // would hide a provider regression, so this is a hard failure like the other adapters.
      throw new ProviderError(
        "Cloudflare Workers AI returned no recognizable models in its catalog response.",
        {
          category: "provider",
          details: { providerId: this.id, path },
        },
      );
    }
    this.modelCache = descriptors;
    return descriptors;
  }

  async describeCapabilities(modelId: string): Promise<ModelCapabilities> {
    const cached =
      this.modelCache.find((descriptor) => descriptor.modelId === modelId) ??
      this.fallbackDescriptors().find((d) => d.modelId === modelId);
    if (cached) return cached.capabilities;
    throw new ProviderError(`Cloudflare Workers AI does not report a model "${modelId}".`, {
      category: "validation",
      status: 404,
    });
  }

  protected async safeDescribeCapabilities(
    modelId: string,
  ): Promise<ModelCapabilities | undefined> {
    return (
      this.modelCache.find((descriptor) => descriptor.modelId === modelId)?.capabilities ??
      this.fallbackDescriptors().find((descriptor) => descriptor.modelId === modelId)?.capabilities
    );
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  async submit(request: GenerationRequest, ctx: ProviderContext): Promise<SubmitResult> {
    const path = `/accounts/${encodeURIComponent(this.requireAccountId())}/ai/run/${encodeURIComponent(request.modelId)}`;
    const body = this.buildBody(request);
    const payload = await this.request<unknown>(ctx, path, {
      method: "POST",
      operation: "submit",
      body,
    });
    const outputs = this.extractOutputs(payload, request);
    if (outputs.length === 0) {
      throw new ProviderError(
        `Cloudflare Workers AI returned no output for "${request.modelId}".`,
        {
          category: "provider",
          details: { providerId: this.id, modelId: request.modelId, mode: request.mode },
        },
      );
    }
    return { status: "completed", outputs, submittedAt: this.isoTimestamp() };
  }

  async getJob(jobId: string, ctx: ProviderContext): Promise<JobStatusResult> {
    const payload = await this.requestJson<unknown>(
      ctx,
      `/accounts/${encodeURIComponent(this.requireAccountId())}/ai/runs/${encodeURIComponent(jobId)}`,
      { method: "GET", operation: "getJob" },
    ).catch(() => undefined);
    if (payload === undefined) {
      // Workers AI has no run registry; anything we did not complete locally is unknown,
      // which is the state that requires manual reconciliation (PRD §12).
      return { status: "unknown" };
    }
    const record = asRecord(payload);
    const expiresAt = firstString(record, ["expires_at", "expiresAt"]);
    const outputs: RemoteOutput[] = [];
    for (const item of extractOutputList(payload)) {
      const withExpiry = { ...asRecord(item), ...(expiresAt ? { expiresAt } : {}) };
      const normalized = this.outputs([withExpiry] as never[]);
      for (const output of normalized) outputs.push(output);
    }
    return {
      status: mapRemoteStatus(firstString(record, ["status", "state"]) ?? "completed"),
      ...(outputs.length > 0 ? { outputs } : {}),
    };
  }

  async cancel(jobId: string, ctx: ProviderContext): Promise<void> {
    // Workers AI runs are synchronous and non-cancelable once started.
    void jobId;
    void ctx;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireAccountId(): string {
    if (!this.accountId) {
      throw new ValidationError("Cloudflare Workers AI requires an accountId.", {
        providerId: this.id,
        field: "accountId",
      });
    }
    return this.accountId;
  }

  private buildBody(request: GenerationRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (request.mode === "transcription") {
      const reference = request.references[0];
      if (!reference) {
        throw new ValidationError("Cloudflare transcription requires an audio input reference.", {
          field: "references",
        });
      }
      const audio = base64FromReference(reference.path ?? reference.assetId);
      body["audio"] = audio;
      if (request.language !== undefined) body["language"] = request.language;
    } else if (request.mode === "tts") {
      body["prompt"] = request.prompt;
      if (request.language !== undefined) body["lang"] = request.language;
      if (request.voiceId !== undefined) body["voice"] = request.voiceId;
    } else {
      body["prompt"] = request.prompt;
      if (request.negativePrompt !== undefined) body["negative_prompt"] = request.negativePrompt;
      if (request.seed !== undefined) body["seed"] = request.seed;
      if (request.aspectRatio !== undefined) body["aspect_ratio"] = request.aspectRatio;
      if (request.resolution !== undefined) {
        const [width, height] = request.resolution.split("x");
        if (width && height) {
          body["width"] = Number.parseInt(width, 10);
          body["height"] = Number.parseInt(height, 10);
        }
      }
    }
    if (request.extra) Object.assign(body, request.extra);
    return body;
  }

  /**
   * Workers AI answers with JSON (`{ result: { image: "<base64>" } }`) or with a raw binary
   * body. Both are normalized into a URL-bearing `RemoteOutput`.
   */
  private extractOutputs(payload: unknown, request: GenerationRequest): RemoteOutput[] {
    const fromJson = this.outputs(
      extractOutputList(payload) as never[],
      defaultMimeForMode(request.mode),
    );
    if (fromJson.length > 0) return fromJson;

    const record = asRecord(payload);
    const result = asRecord(record["result"] ?? payload);
    const base64 = firstString(result, ["image", "audio", "audio_base64", "base64", "data"]);
    if (base64 && looksBase64(base64)) {
      const mimeType =
        firstString(result, ["mime_type", "mimeType"]) ?? defaultMimeForMode(request.mode);
      return [
        {
          url: `data:${mimeType};base64,${base64}`,
          mimeType,
          kind: kindForMode(request.mode),
          bytes: Math.floor((base64.length * 3) / 4),
        },
      ];
    }
    const text = firstString(result, ["text", "response", "transcription"]);
    if (text !== undefined) {
      const bytes = Buffer.from(text, "utf8");
      return [
        {
          url: `data:text/plain;charset=utf-8;base64,${bytes.toString("base64")}`,
          mimeType: "text/plain",
          kind: "text",
          bytes: bytes.length,
        },
      ];
    }
    return [];
  }

  private describeEntry(entry: Record<string, unknown>): ModelDescriptor | undefined {
    const modelId = firstString(entry, ["name", "id", "model"]);
    if (!modelId) return undefined;
    const known = this.knownModels.find((spec) => spec.modelId === modelId);
    if (known) return this.descriptor(known.modelId, known.displayName, known.capabilities);
    const displayName = firstString(entry, ["display_name", "displayName", "name"]) ?? modelId;
    const task = firstString(entry, ["task", "task_name", "type"]) ?? "";
    return this.descriptor(modelId, displayName, capabilitiesForWorkerTask(modelId, task, entry));
  }

  private fallbackDescriptors(): ModelDescriptor[] {
    return this.knownModels.map((spec) =>
      this.descriptor(spec.modelId, spec.displayName, spec.capabilities),
    );
  }
}

/** Map a Workers AI `task` string onto the capability schema, conservatively. */
export function capabilitiesForWorkerTask(
  modelId: string,
  task: string,
  entry: Record<string, unknown>,
): ModelCapabilities {
  const lowerTask = task.toLowerCase();
  const descriptions = reportedList(entry["description"]);
  if (
    lowerTask.includes("text-to-image") ||
    /text-to-image|stable-diffusion|flux/.test(`${lowerTask} ${modelId}`)
  ) {
    return capabilitiesFrom({
      modality: "image",
      modes: ["text-to-image"],
      inputMimeTypes: ["text/plain"],
      aspectRatios: ["1:1"],
      resolutions: ["1024x1024"],
      supportsSeed: true,
      referenceFrame: "none",
      maxConcurrency: 1,
      safety: { contentFiltering: true, notes: descriptions.length > 0 ? descriptions[0]! : null },
    });
  }
  if (lowerTask.includes("speech-recognition") || lowerTask.includes("automatic-speech")) {
    return capabilitiesFrom({
      modality: "text",
      modes: ["transcription"],
      inputMimeTypes: ["audio/wav", "audio/mpeg"],
      referenceFrame: "required",
      supportsAudio: true,
      languages: ["en"],
      maxConcurrency: 1,
    });
  }
  if (lowerTask.includes("text-to-speech")) {
    return capabilitiesFrom({
      modality: "audio",
      modes: ["tts"],
      inputMimeTypes: ["text/plain"],
      supportsAudio: true,
      voices: [],
      languages: ["en"],
      maxConcurrency: 1,
    });
  }
  // Unknown task: report the model without claiming any generation capability.
  return capabilitiesFrom({
    modality: "text",
    modes: ["transcription"],
    referenceFrame: "none",
    maxConcurrency: 1,
  });
}

function extractModelEntries(payload: unknown): Record<string, unknown>[] {
  const record = asRecord(payload);
  for (const candidate of [record["result"], record["models"], record["data"], payload]) {
    const list = asArray(candidate);
    if (list.length > 0) return list.map((item) => asRecord(item));
  }
  return [];
}

function base64FromReference(pathOrAssetId: string | undefined): string {
  if (!pathOrAssetId) {
    throw new ValidationError("Cloudflare transcription requires a resolved audio payload.", {
      field: "references.0",
    });
  }
  const dataUrlMatch = /^data:([^;,]+)?;base64,(.*)$/.exec(pathOrAssetId);
  if (dataUrlMatch && dataUrlMatch[2]) return dataUrlMatch[2];
  throw new ValidationError(
    "Cloudflare Workers AI requires the caller to inline reference bytes as a data URL (the adapter cannot read local files).",
    { field: "references.0.path" },
  );
}

function defaultMimeForMode(mode: string): string {
  if (mode.includes("image")) return "image/png";
  if (mode.includes("video")) return "video/mp4";
  if (mode === "tts" || mode === "sfx" || mode === "music") return "audio/mpeg";
  return "text/plain";
}

function kindForMode(mode: string): RemoteOutput["kind"] {
  if (mode.includes("image")) return "image";
  if (mode.includes("video")) return "video";
  if (mode === "tts" || mode === "sfx" || mode === "music") return "audio";
  return "text";
}

function looksBase64(value: string): boolean {
  return value.length > 16 && /^[A-Za-z0-9+/=\s]+$/.test(value);
}
