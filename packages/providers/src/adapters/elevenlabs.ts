/**
 * ElevenLabs direct adapter (PRD §8: "TTS, sound effects, music, transcription").
 *
 * Endpoints (per the PRD's reference documentation):
 *   * `GET  /v1/voices`                      -> voice catalog
 *   * `POST /v1/text-to-speech/{voice_id}`   -> narration (tts)
 *   * `POST /v1/sound-generation`            -> sfx / music
 *   * `POST /v1/speech-to-text`              -> transcription
 *
 * Auth is the `xi-api-key` header, which is treated as a secret everywhere: it is never
 * logged, never attached to an error, and never echoed in a `details` object.
 */
import { ProviderError } from "@creativelab/core";
import type { ProviderContext } from "../adapter.js";
import type { ModelCapabilities, ModelDescriptor, Voice } from "../capabilities.js";
import { capabilitiesFrom } from "../capabilities.js";
import type {
  GenerationRequest,
  JobStatusResult,
  RemoteOutput,
  SubmitResult,
} from "../requests.js";
import { extractOutputList, firstString, mapRemoteStatus } from "../remote.js";
import { asArray, asRecord, RestAdapter, type RestAdapterConfig } from "./shared.js";

export const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
export const ELEVENLABS_PROVIDER_ID = "elevenlabs";

/** ElevenLabs' own model ids, exposed as TTS variants in the catalog. */
export const ELEVENLABS_TTS_MODELS = [
  "eleven_multilingual_v2",
  "eleven_turbo_v2_5",
  "eleven_flash_v2_5",
] as const;

export interface ElevenLabsAdapterOptions extends Partial<
  Omit<RestAdapterConfig, "providerId" | "displayName" | "defaultBaseUrl" | "authHeaders">
> {
  readonly baseUrl?: string;
  readonly credentialRef?: string;
  readonly fetch?: typeof fetch;
  /** Skip `GET /v1/voices` (useful when the account lacks the voices scope). */
  readonly includeVoices?: boolean;
}

export class ElevenLabsAdapter extends RestAdapter {
  readonly id = ELEVENLABS_PROVIDER_ID;
  readonly displayName = "ElevenLabs";

  private readonly includeVoices: boolean;
  private voiceCache: Voice[] = [];
  private modelCache: ModelDescriptor[] = [];

  constructor(options: ElevenLabsAdapterOptions = {}) {
    super({
      ...options,
      providerId: ELEVENLABS_PROVIDER_ID,
      displayName: "ElevenLabs",
      defaultBaseUrl: DEFAULT_ELEVENLABS_BASE_URL,
      authHeaders: (secret) => ({ "xi-api-key": secret }),
    });
    this.includeVoices = options.includeVoices ?? true;
  }

  // -------------------------------------------------------------------------
  // Catalog
  // -------------------------------------------------------------------------

  async listModels(ctx: ProviderContext): Promise<ModelDescriptor[]> {
    const voices = this.includeVoices ? await this.listVoices(ctx) : this.voiceCache;
    const descriptors = this.buildDescriptors(voices);
    this.modelCache = descriptors;
    return descriptors;
  }

  async describeCapabilities(modelId: string): Promise<ModelCapabilities> {
    const cached = this.modelCache.find((descriptor) => descriptor.modelId === modelId);
    if (cached) return cached.capabilities;
    const descriptors = this.buildDescriptors(this.voiceCache);
    const match = descriptors.find((descriptor) => descriptor.modelId === modelId);
    if (!match) {
      throw new ProviderError(`ElevenLabs does not report a model "${modelId}".`, {
        category: "validation",
        status: 404,
      });
    }
    return match.capabilities;
  }

  protected async safeDescribeCapabilities(
    modelId: string,
  ): Promise<ModelCapabilities | undefined> {
    const cached = this.modelCache.find((descriptor) => descriptor.modelId === modelId);
    if (cached) return cached.capabilities;
    return this.buildDescriptors(this.voiceCache).find(
      (descriptor) => descriptor.modelId === modelId,
    )?.capabilities;
  }

  /** `GET /v1/voices`; every voice carries its languages so the UI can gate language choice. */
  async listVoices(ctx: ProviderContext): Promise<Voice[]> {
    const payload = await this.requestJson<unknown>(ctx, "/v1/voices", {
      method: "GET",
      operation: "listVoices",
    });
    const voices = this.parseVoices(payload);
    this.voiceCache = voices;
    return voices;
  }

  private parseVoices(payload: unknown): Voice[] {
    const record = asRecord(payload);
    const list =
      asArray(record["voices"]).length > 0 ? asArray(record["voices"]) : asArray(payload);
    return list
      .map((item) => asRecord(item))
      .map((item) => {
        const id = firstString(item, ["voice_id", "voiceId", "id"]) ?? "";
        const name = firstString(item, ["name", "voice_name"]) ?? id;
        const languages = extractLanguages(item);
        return {
          id,
          name,
          languages,
          gender: firstString(item, ["gender", "labels.gender"]) ?? genderFromLabels(item),
          previewUrl: firstString(item, ["preview_url", "previewUrl"]) ?? null,
        } satisfies Voice;
      })
      .filter((voice) => voice.id.length > 0);
  }

  private buildDescriptors(voices: readonly Voice[]): ModelDescriptor[] {
    const languages = [...new Set(voices.flatMap((voice) => voice.languages))].sort();
    return [
      this.descriptor(
        "eleven_multilingual_v2",
        "ElevenLabs Multilingual v2",
        capabilitiesFrom({
          modality: "audio",
          modes: ["tts"],
          inputMimeTypes: ["text/plain"],
          durationMinSeconds: 1,
          durationMaxSeconds: 3_600,
          supportsSeed: true,
          supportsNegativePrompt: false,
          referenceFrame: "none",
          supportsAudio: true,
          voices: voices.map((voice) => ({ ...voice })),
          languages,
          maxConcurrency: 4,
          pricing: null,
          quota: null,
          safety: {
            contentFiltering: true,
            notes: "Voice cloning requires documented consent (PRD §13).",
          },
        }),
      ),
      this.descriptor(
        "eleven_turbo_v2_5",
        "ElevenLabs Turbo v2.5",
        capabilitiesFrom({
          modality: "audio",
          modes: ["tts"],
          inputMimeTypes: ["text/plain"],
          durationMinSeconds: 1,
          durationMaxSeconds: 1_800,
          supportsSeed: false,
          supportsNegativePrompt: false,
          referenceFrame: "none",
          supportsAudio: true,
          voices: voices.map((voice) => ({ ...voice })),
          languages,
          maxConcurrency: 6,
          pricing: null,
          quota: null,
          safety: { contentFiltering: true, notes: null },
        }),
      ),
      this.descriptor(
        "eleven_sound_effects_v1",
        "ElevenLabs Sound Effects",
        capabilitiesFrom({
          modality: "audio",
          modes: ["sfx", "music"],
          inputMimeTypes: ["text/plain"],
          durationMinSeconds: 0.5,
          durationMaxSeconds: 22,
          supportsSeed: true,
          supportsNegativePrompt: true,
          referenceFrame: "optional",
          supportsAudio: true,
          voices: [],
          languages: [],
          maxConcurrency: 2,
          pricing: null,
          quota: null,
          safety: { contentFiltering: true, notes: null },
        }),
      ),
      this.descriptor(
        "eleven_scribe_v1",
        "ElevenLabs Scribe (speech-to-text)",
        capabilitiesFrom({
          modality: "text",
          modes: ["transcription"],
          inputMimeTypes: ["audio/mpeg", "audio/wav", "audio/mp4", "video/mp4"],
          referenceFrame: "required",
          supportsAudio: true,
          languages: languages.length > 0 ? languages : [],
          maxConcurrency: 2,
          pricing: null,
          quota: null,
          safety: { contentFiltering: false, notes: null },
        }),
      ),
    ];
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  async submit(request: GenerationRequest, ctx: ProviderContext): Promise<SubmitResult> {
    switch (request.mode) {
      case "tts":
        return this.submitTts(request, ctx);
      case "sfx":
      case "music":
        return this.submitSfx(request, ctx);
      case "transcription":
        return this.submitTranscription(request, ctx);
      default:
        throw new ProviderError(`ElevenLabs does not support mode "${request.mode}".`, {
          category: "validation",
          status: 422,
          details: { mode: request.mode },
        });
    }
  }

  private async submitTts(request: GenerationRequest, ctx: ProviderContext): Promise<SubmitResult> {
    const voices = this.voiceCache.length > 0 ? this.voiceCache : [];
    const voiceId = request.voiceId ?? voices[0]?.id;
    if (!voiceId) {
      // An id is required in the path; without one the request cannot be formed.
      const listed = await this.listVoices(ctx).catch(() => [] as Voice[]);
      const fallback = request.voiceId ?? listed[0]?.id;
      if (!fallback) {
        throw new ProviderError(
          "ElevenLabs text-to-speech requires a voiceId (no voices are available on this account).",
          {
            category: "validation",
            status: 422,
            details: { field: "voiceId" },
          },
        );
      }
      return this.postTts(request, ctx, fallback);
    }
    return this.postTts(request, ctx, voiceId);
  }

  private async postTts(
    request: GenerationRequest,
    ctx: ProviderContext,
    voiceId: string,
  ): Promise<SubmitResult> {
    const modelId = ELEVENLABS_TTS_MODELS.includes(
      request.modelId as (typeof ELEVENLABS_TTS_MODELS)[number],
    )
      ? request.modelId
      : ELEVENLABS_TTS_MODELS[0];
    const payload = await this.request<unknown>(
      ctx,
      `/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: "POST",
        operation: "submit.tts",
        headers: { accept: "audio/mpeg" },
        body: {
          text: request.prompt,
          model_id: modelId,
          ...(request.seed !== undefined ? { seed: request.seed } : {}),
          ...(request.language !== undefined ? { language_code: request.language } : {}),
          ...(request.extra ? request.extra : {}),
        },
      },
    );
    const outputs = this.binaryOutput(payload, "audio/mpeg", "audio");
    return { status: "completed", outputs, submittedAt: this.isoTimestamp() };
  }

  private async submitSfx(request: GenerationRequest, ctx: ProviderContext): Promise<SubmitResult> {
    const payload = await this.request<unknown>(ctx, "/v1/sound-generation", {
      method: "POST",
      operation: "submit.sfx",
      headers: { accept: "audio/mpeg" },
      body: {
        text: request.prompt,
        ...(request.durationSeconds !== undefined
          ? { duration_seconds: request.durationSeconds }
          : {}),
        ...(request.negativePrompt !== undefined
          ? { negative_prompt: request.negativePrompt }
          : {}),
        ...(request.seed !== undefined ? { seed: request.seed } : {}),
        ...(request.extra ? request.extra : {}),
      },
    });
    const outputs = this.binaryOutput(payload, "audio/mpeg", "audio");
    return { status: "completed", outputs, submittedAt: this.isoTimestamp() };
  }

  private async submitTranscription(
    request: GenerationRequest,
    ctx: ProviderContext,
  ): Promise<SubmitResult> {
    const reference = request.references[0];
    if (!reference) {
      throw new ProviderError("Transcription requires an audio or video input reference.", {
        category: "validation",
        status: 422,
        details: { field: "references" },
      });
    }
    const body: Record<string, unknown> = {
      model_id: request.modelId.startsWith("eleven_") ? request.modelId : "scribe_v1",
      ...(request.language !== undefined ? { language_code: request.language } : {}),
    };
    if (reference.assetId && !reference.path) body["cloud_storage_url"] = reference.assetId;
    if (reference.path) body["file"] = reference.path;
    const payload = await this.requestJson<unknown>(ctx, "/v1/speech-to-text", {
      method: "POST",
      operation: "submit.transcription",
      body,
    });
    const record = asRecord(payload);
    const text = firstString(record, ["text", "transcript"]);
    const outputs: RemoteOutput[] =
      text === undefined
        ? this.outputs(extractOutputList(payload) as never[], "text/plain")
        : [
            {
              // The transcript is small and already in hand; a data URL keeps the contract
              // (every output has a URL) without an extra round trip.
              url: `data:text/plain;charset=utf-8;base64,${Buffer.from(text, "utf8").toString("base64")}`,
              mimeType: "text/plain",
              kind: "text",
              bytes: Buffer.byteLength(text, "utf8"),
            },
          ];
    return { status: "completed", outputs, submittedAt: this.isoTimestamp() };
  }

  async getJob(jobId: string, ctx: ProviderContext): Promise<JobStatusResult> {
    // ElevenLabs' generation endpoints are synchronous, so the only pollable thing this
    // adapter exposes is a transcription/history lookup.
    const payload = await this.requestJson<unknown>(
      ctx,
      `/v1/history/${encodeURIComponent(jobId)}`,
      {
        method: "GET",
        operation: "getJob",
      },
    );
    const record = asRecord(payload);
    const status = mapRemoteStatus(firstString(record, ["status", "state"]) ?? "completed");
    const outputs = this.outputs(extractOutputList(payload) as never[], "audio/mpeg");
    return {
      status,
      ...(outputs.length > 0 ? { outputs } : {}),
      ...(typeof record["error"] === "string" ? { error: record["error"] } : {}),
    };
  }

  async cancel(jobId: string, ctx: ProviderContext): Promise<void> {
    // Synchronous generation has nothing to cancel; history entries are immutable. The
    // method exists to satisfy the contract and is a no-op rather than a false success.
    void jobId;
    void ctx;
  }

  override async fetchOutputs(job: JobStatusResult, ctx: ProviderContext): Promise<RemoteOutput[]> {
    return super.fetchOutputs(job, ctx);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** A synchronous audio endpoint may answer with raw bytes or with a JSON URL. */
  private binaryOutput(
    payload: unknown,
    mimeType: string,
    kind: "audio" | "video" | "image",
  ): RemoteOutput[] {
    if (payload instanceof ArrayBuffer || payload instanceof Uint8Array) {
      const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
      return [
        {
          url: `data:${mimeType};base64,${base64(bytes)}`,
          mimeType,
          kind,
          bytes: bytes.length,
        },
      ];
    }
    return this.outputs(extractOutputList(payload) as never[], mimeType);
  }
}

function extractLanguages(item: Record<string, unknown>): string[] {
  const labels = asRecord(item["labels"]);
  const candidates: unknown[] = [
    item["languages"],
    item["language"],
    labels["language"],
    labels["languages"],
  ];
  const out: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) out.push(candidate);
    else if (Array.isArray(candidate)) {
      for (const value of candidate)
        if (typeof value === "string" && value.length > 0) out.push(value);
    }
  }
  return [...new Set(out)];
}

function genderFromLabels(item: Record<string, unknown>): string | null {
  const labels = asRecord(item["labels"]);
  const gender = labels["gender"];
  return typeof gender === "string" && gender.length > 0 ? gender : null;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
