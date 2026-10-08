/**
 * Vercel AI Gateway adapter (PRD §8: "Primary aggregator").
 *
 * `GET /v1/models` drives the catalog; generation, speech and transcription calls submit to
 * the gateway and are polled asynchronously when the gateway returns a job id.
 *
 * Two rules from PRD §8 shape every mapping below:
 *   * the gateway is the source of truth for capabilities — when it does not report a
 *     feature, the capability is `false`/`null` here, never guessed to `true`;
 *   * model ids are opaque, so classification never *widens* a known family's capabilities
 *     beyond what that family demonstrably supports, and anything unrecognized is reported
 *     with the conservative default set.
 */
import { ProviderError } from "@creativelab/core";
import type { ProviderContext } from "../adapter.js";
import type { ModelCapabilities, ModelDescriptor, Pricing } from "../capabilities.js";
import { capabilitiesFrom, reportedFlag, reportedList } from "../capabilities.js";
import type {
  GenerationRequest,
  JobStatusResult,
  RemoteOutput,
  SubmitResult,
} from "../requests.js";
import { extractOutputList, firstString, mapRemoteStatus } from "../remote.js";
import { submissionError } from "../errors.js";
import { asArray, asRecord, RestAdapter, type RestAdapterConfig } from "./shared.js";

export const DEFAULT_VERCEL_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
export const VERCEL_GATEWAY_PROVIDER_ID = "vercel-gateway";

export interface VercelGatewayAdapterOptions extends Partial<
  Omit<RestAdapterConfig, "providerId" | "displayName" | "defaultBaseUrl" | "authHeaders">
> {
  readonly baseUrl?: string;
  readonly credentialRef?: string;
  /** Endpoint overrides; the gateway's paths are documented but do evolve. */
  readonly endpoints?: Partial<VercelGatewayEndpoints>;
  readonly fetch?: typeof fetch;
}

export interface VercelGatewayEndpoints {
  readonly models: string;
  readonly images: string;
  readonly video: string;
  readonly speech: string;
  readonly transcriptions: string;
  readonly jobs: string;
}

export const VERCEL_GATEWAY_ENDPOINTS: VercelGatewayEndpoints = {
  models: "/v1/models",
  images: "/v1/images/generations",
  video: "/v1/video/generations",
  speech: "/v1/audio/speech",
  transcriptions: "/v1/audio/transcriptions",
  jobs: "/v1/jobs",
};

export class VercelGatewayAdapter extends RestAdapter {
  readonly id = VERCEL_GATEWAY_PROVIDER_ID;
  readonly displayName = "Vercel AI Gateway";

  private readonly endpoints: VercelGatewayEndpoints;
  private modelCache: ModelDescriptor[] = [];

  constructor(options: VercelGatewayAdapterOptions = {}) {
    super({
      ...options,
      providerId: VERCEL_GATEWAY_PROVIDER_ID,
      displayName: "Vercel AI Gateway",
      defaultBaseUrl: DEFAULT_VERCEL_GATEWAY_BASE_URL,
      authHeaders: (secret) => ({ authorization: `Bearer ${secret}` }),
    });
    this.endpoints = { ...VERCEL_GATEWAY_ENDPOINTS, ...(options.endpoints ?? {}) };
  }

  // -------------------------------------------------------------------------
  // Catalog
  // -------------------------------------------------------------------------

  async listModels(ctx: ProviderContext): Promise<ModelDescriptor[]> {
    const payload = await this.requestJson<unknown>(ctx, this.endpoints.models, {
      method: "GET",
      operation: "listModels",
    });
    const entries = extractModelEntries(payload);
    const descriptors = entries
      .map((entry) => this.describeEntry(entry))
      .filter((item): item is ModelDescriptor => item !== undefined);
    this.modelCache = descriptors;
    return descriptors;
  }

  async describeCapabilities(modelId: string): Promise<ModelCapabilities> {
    const cached = this.modelCache.find((descriptor) => descriptor.modelId === modelId);
    if (cached) return cached.capabilities;
    const capabilities = await this.safeDescribeCapabilities(modelId);
    if (!capabilities) {
      throw new ProviderError(
        `Vercel AI Gateway did not report a model "${modelId}". Refresh the catalog first.`,
        {
          category: "validation",
          status: 404,
        },
      );
    }
    return capabilities;
  }

  protected async safeDescribeCapabilities(
    modelId: string,
  ): Promise<ModelCapabilities | undefined> {
    const cached = this.modelCache.find((descriptor) => descriptor.modelId === modelId);
    if (cached) return cached.capabilities;
    // No cached catalog yet: classify from the id. Deliberately *not* a network call —
    // capability lookup must not turn a synchronous UI query into a billed round trip.
    return capabilitiesForGatewayModel(modelId, undefined).capabilities;
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  async submit(request: GenerationRequest, ctx: ProviderContext): Promise<SubmitResult> {
    const path = this.endpointFor(request);
    const body = this.buildBody(request);
    let payload: unknown;
    try {
      payload = await this.requestJson<unknown>(ctx, path, {
        method: "POST",
        body,
        operation: "submit",
      });
    } catch (error) {
      throw this.asSubmissionError(error);
    }
    const record = asRecord(payload);
    const providerJobId = firstString(record, [
      "id",
      "job_id",
      "jobId",
      "request_id",
      "requestId",
      "task_id",
    ]);
    const outputs = this.extractOutputs(payload, request);
    if (outputs.length > 0 && !providerJobId) {
      return { status: "completed", outputs, submittedAt: this.isoTimestamp() };
    }
    if (!providerJobId) {
      // The gateway accepted something we cannot identify. PRD §12: never auto-resubmit.
      throw new ProviderError(
        "Vercel AI Gateway accepted the request without returning a job id.",
        {
          category: "provider",
          retryable: false,
          uncertain: true,
          details: { providerId: this.id, mode: request.mode },
        },
      );
    }
    return {
      providerJobId,
      status: outputs.length > 0 ? "completed" : "running",
      ...(outputs.length > 0 ? { outputs } : {}),
      submittedAt: this.isoTimestamp(),
    };
  }

  async getJob(jobId: string, ctx: ProviderContext): Promise<JobStatusResult> {
    const payload = await this.requestJson<unknown>(
      ctx,
      `${this.endpoints.jobs}/${encodeURIComponent(jobId)}`,
      {
        method: "GET",
        operation: "getJob",
      },
    );
    const record = asRecord(payload);
    const status = mapRemoteStatus(firstString(record, ["status", "state"]) ?? "unknown");
    const progress = numberOrNull(record["progress"]);
    const outputs = this.extractOutputs(payload);
    return {
      status,
      ...(progress !== null ? { progress } : {}),
      ...(outputs.length > 0 ? { outputs } : {}),
      ...(record["cost"] !== undefined ? { cost: record["cost"] } : {}),
      ...(typeof record["error"] === "string" ? { error: record["error"] } : {}),
    };
  }

  async cancel(jobId: string, ctx: ProviderContext): Promise<void> {
    await this.request(ctx, `${this.endpoints.jobs}/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      operation: "cancel",
    });
  }

  override async fetchOutputs(job: JobStatusResult, ctx: ProviderContext): Promise<RemoteOutput[]> {
    const outputs = await super.fetchOutputs(job, ctx);
    return outputs.map((output) =>
      output.kind === "image" || output.kind === "video" || output.kind === "audio"
        ? output
        : { ...output, kind: "text" as const },
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private endpointFor(request: GenerationRequest): string {
    if (request.mode === "transcription") return this.endpoints.transcriptions;
    if (request.mode === "tts" || request.mode === "sfx" || request.mode === "music")
      return this.endpoints.speech;
    if (
      request.mode === "text-to-video" ||
      request.mode === "image-to-video" ||
      request.mode === "video-to-video"
    ) {
      return this.endpoints.video;
    }
    return this.endpoints.images;
  }

  private buildBody(request: GenerationRequest): Record<string, unknown> {
    const body: Record<string, unknown> = { model: request.modelId, prompt: request.prompt };
    if (request.mode === "transcription") {
      // Transcription takes an input reference rather than a prompt.
      const reference = request.references[0];
      if (reference?.path) body["file"] = reference.path;
      if (reference?.assetId) body["asset_id"] = reference.assetId;
      delete body["prompt"];
    }
    if (request.negativePrompt !== undefined) body["negative_prompt"] = request.negativePrompt;
    if (request.seed !== undefined) body["seed"] = request.seed;
    if (request.aspectRatio !== undefined) body["aspect_ratio"] = request.aspectRatio;
    if (request.resolution !== undefined) body["resolution"] = request.resolution;
    if (request.durationSeconds !== undefined) body["duration"] = request.durationSeconds;
    if (request.voiceId !== undefined) body["voice"] = request.voiceId;
    if (request.language !== undefined) body["language"] = request.language;
    if (request.quality !== undefined) body["quality"] = request.quality;
    if (request.references.length > 0) {
      body["references"] = request.references.map((reference) => ({
        ...(reference.assetId ? { asset_id: reference.assetId } : {}),
        ...(reference.path ? { path: reference.path } : {}),
        ...(reference.mimeType ? { mime_type: reference.mimeType } : {}),
        role: reference.role,
      }));
    }
    if (request.extra) Object.assign(body, request.extra);
    return body;
  }

  private extractOutputs(payload: unknown, request?: GenerationRequest): RemoteOutput[] {
    const raw = extractOutputList(payload);
    const defaultMime = request ? defaultMimeForMode(request.mode) : undefined;
    try {
      return this.outputs(raw as never[], defaultMime);
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private asSubmissionError(error: unknown): Error {
    const normalized = this.normalizeError(error);
    if (
      normalized.category === "canceled" ||
      normalized.category === "credential" ||
      normalized.category === "validation"
    ) {
      return normalized;
    }
    const status = normalized.status ?? 0;
    if (status > 0) {
      return submissionError(
        { ok: false, status, statusText: "" },
        {
          url: "vercel-gateway",
          method: "POST",
          body: { message: normalized.message },
          secrets: [],
        },
      );
    }
    return new ProviderError(normalized.message, {
      category: normalized.category,
      retryable: normalized.retryable,
      uncertain: true,
      details: { ...normalized.details, operation: "submit" },
      cause: normalized,
    });
  }

  private describeEntry(entry: Record<string, unknown>): ModelDescriptor | undefined {
    const modelId = firstString(entry, ["id", "model", "name", "slug"]);
    if (!modelId) return undefined;
    const displayName =
      firstString(entry, ["name", "display_name", "displayName", "id"]) ?? modelId;
    const { capabilities } = capabilitiesForGatewayModel(modelId, entry);
    return this.descriptor(modelId, displayName, capabilities);
  }
}

/**
 * Classify a gateway model.
 *
 * Provider-reported fields win outright. Only when a field is absent is a conservative,
 * family-level default applied, and anything unrecognized gets the neutral capability set.
 */
export function capabilitiesForGatewayModel(
  modelId: string,
  entry: Record<string, unknown> | undefined,
): { capabilities: ModelCapabilities; recognized: boolean } {
  const declaredModality =
    typeof entry?.["modality"] === "string" ? (entry["modality"] as string) : undefined;
  const declaredModes = reportedList(entry?.["modes"]);
  const inferred = classifyByModelId(modelId);
  const modality = normalizeModality(declaredModality) ?? inferred.modality;
  const modes =
    declaredModes.length > 0 ? (declaredModes as ModelCapabilities["modes"]) : inferred.modes;

  const aspectRatios = reportedList(entry?.["aspect_ratios"] ?? entry?.["aspectRatios"]);
  const resolutions = reportedList(entry?.["resolutions"] ?? entry?.["supported_resolutions"]);
  const inputMimeTypes = reportedList(entry?.["input_mime_types"] ?? entry?.["inputMimeTypes"]);

  const capabilities = capabilitiesFrom({
    modality,
    modes,
    inputMimeTypes: inputMimeTypes.length > 0 ? inputMimeTypes : inferred.inputMimeTypes,
    aspectRatios: aspectRatios.length > 0 ? aspectRatios : inferred.aspectRatios,
    resolutions: resolutions.length > 0 ? resolutions : inferred.resolutions,
    durationMinSeconds:
      numberOrNull(entry?.["duration_min_seconds"] ?? entry?.["durationMinSeconds"]) ??
      inferred.durationMinSeconds ??
      null,
    durationMaxSeconds:
      numberOrNull(entry?.["duration_max_seconds"] ?? entry?.["durationMaxSeconds"]) ??
      inferred.durationMaxSeconds ??
      null,
    supportsSeed:
      entry?.["supports_seed"] !== undefined
        ? reportedFlag(entry["supports_seed"])
        : inferred.supportsSeed,
    supportsNegativePrompt:
      entry?.["supports_negative_prompt"] !== undefined
        ? reportedFlag(entry["supports_negative_prompt"])
        : inferred.supportsNegativePrompt,
    referenceFrame: normalizeReferenceFrame(entry?.["reference_frame"]) ?? inferred.referenceFrame,
    supportsAudio:
      entry?.["supports_audio"] !== undefined
        ? reportedFlag(entry["supports_audio"])
        : inferred.supportsAudio,
    voices: normalizeVoices(entry?.["voices"]),
    languages: reportedList(entry?.["languages"]),
    maxConcurrency: positiveInt(entry?.["max_concurrency"]) ?? inferred.maxConcurrency,
    pricing: normalizePricing(entry?.["pricing"]),
    quota: normalizeQuota(entry?.["quota"]),
    safety: normalizeSafety(entry?.["safety"]),
  });
  return { capabilities, recognized: inferred.recognized };
}

interface InferredCapabilities extends Partial<ModelCapabilities> {
  readonly modality: ModelCapabilities["modality"];
  readonly modes: ModelCapabilities["modes"];
  readonly recognized: boolean;
}

/** Family-level defaults. Conservative: never claims a capability we cannot justify. */
export function classifyByModelId(modelId: string): InferredCapabilities {
  const id = modelId.toLowerCase();
  if (/video|veo|kling|wan|runway|luma|minimax|hailuo|sora|pika/.test(id)) {
    return {
      recognized: true,
      modality: "video",
      modes: ["text-to-video", "image-to-video"],
      inputMimeTypes: ["image/png", "image/jpeg"],
      aspectRatios: ["16:9", "9:16", "1:1"],
      resolutions: ["720p", "1080p"],
      durationMinSeconds: 2,
      durationMaxSeconds: 10,
      supportsSeed: true,
      referenceFrame: "optional",
      maxConcurrency: 1,
    };
  }
  if (/image|flux|dalle|dall-e|sd-|stable-diffusion|imagen|ideogram|recraft/.test(id)) {
    return {
      recognized: true,
      modality: "image",
      modes: ["text-to-image", "image-to-image"],
      inputMimeTypes: ["image/png", "image/jpeg", "image/webp"],
      aspectRatios: ["1:1", "16:9", "9:16"],
      resolutions: ["512x512", "1024x1024"],
      supportsSeed: true,
      referenceFrame: "optional",
      maxConcurrency: 2,
    };
  }
  if (/whisper|transcri|speech-to-text|asr/.test(id)) {
    return {
      recognized: true,
      modality: "text",
      modes: ["transcription"],
      inputMimeTypes: ["audio/wav", "audio/mpeg", "video/mp4"],
      referenceFrame: "required",
      supportsAudio: true,
      maxConcurrency: 1,
    };
  }
  if (/tts|speech|voice|eleven|sonic|audio/.test(id)) {
    return {
      recognized: true,
      modality: "audio",
      modes: ["tts", "sfx"],
      inputMimeTypes: ["text/plain"],
      supportsAudio: true,
      maxConcurrency: 2,
    };
  }
  // Unrecognized: the neutral capability set. The adapter still lists the model (so its
  // price and id are visible) but claims nothing about what it can do.
  return { recognized: false, modality: "text", modes: ["transcription"], maxConcurrency: 1 };
}

function extractModelEntries(payload: unknown): Record<string, unknown>[] {
  const record = asRecord(payload);
  const candidates = [record["data"], record["models"], record["result"], payload];
  for (const candidate of candidates) {
    const list = asArray(candidate);
    if (list.length > 0) return list.map((item) => asRecord(item));
  }
  return [];
}

function normalizeModality(value: string | undefined): ModelCapabilities["modality"] | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (lower.includes("image")) return "image";
  if (lower.includes("video")) return "video";
  if (lower.includes("audio") || lower.includes("speech") || lower.includes("music"))
    return "audio";
  if (lower.includes("transcri") || lower.includes("text")) return "text";
  if (lower.includes("subtitle") || lower.includes("caption")) return "subtitle";
  return undefined;
}

function normalizeReferenceFrame(value: unknown): ModelCapabilities["referenceFrame"] | undefined {
  return value === "none" || value === "optional" || value === "required" ? value : undefined;
}

function normalizeVoices(value: unknown): ModelCapabilities["voices"] {
  return asArray(value)
    .map((item) => asRecord(item))
    .map((item) => ({
      id: firstString(item, ["id", "voice_id", "voiceId"]) ?? "",
      name:
        firstString(item, ["name", "display_name"]) ?? firstString(item, ["id", "voice_id"]) ?? "",
      languages: reportedList(item["languages"]),
      gender: firstString(item, ["gender"]) ?? null,
      previewUrl: firstString(item, ["preview_url", "previewUrl"]) ?? null,
    }))
    .filter((voice) => voice.id.length > 0 && voice.name.length > 0);
}

function normalizePricing(value: unknown): Pricing | null {
  if (!value) return null;
  if (typeof value === "number") return { unit: "per-request", amount: value, currency: "USD" };
  const record = asRecord(value);
  const amount = numberOrNull(record["amount"] ?? record["value"] ?? record["price"]);
  const unit = record["unit"];
  if (amount === null || typeof unit !== "string") return null;
  if (!["per-image", "per-second", "per-1k-chars", "per-request"].includes(unit)) return null;
  const currency =
    typeof record["currency"] === "string" ? record["currency"].toUpperCase() : "USD";
  return { unit: unit as Pricing["unit"], amount, currency };
}

function normalizeQuota(value: unknown): ModelCapabilities["quota"] {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return null;
  return {
    requestsPerMinute:
      positiveInt(record["requests_per_minute"] ?? record["requestsPerMinute"]) ?? null,
    requestsPerDay: positiveInt(record["requests_per_day"] ?? record["requestsPerDay"]) ?? null,
    maxConcurrentRequests:
      positiveInt(record["max_concurrent_requests"] ?? record["maxConcurrentRequests"]) ?? null,
    notes: firstString(record, ["notes"]) ?? null,
  };
}

function normalizeSafety(value: unknown): ModelCapabilities["safety"] {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return null;
  return {
    contentFiltering: reportedFlag(record["content_filtering"] ?? record["contentFiltering"]),
    notes: firstString(record, ["notes"]) ?? null,
  };
}

function defaultMimeForMode(mode: string): string | undefined {
  if (mode.includes("image")) return "image/png";
  if (mode.includes("video")) return "video/mp4";
  if (mode === "tts" || mode === "sfx" || mode === "music") return "audio/mpeg";
  if (mode === "transcription") return "text/plain";
  return undefined;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function positiveInt(value: unknown): number | undefined {
  const parsed = numberOrNull(value);
  return parsed === null || parsed <= 0 ? undefined : Math.trunc(parsed);
}
