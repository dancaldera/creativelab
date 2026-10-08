/**
 * The PRD §8 capability schema.
 *
 * A capability object is the *only* thing the UI is allowed to believe about a model.
 * If a provider does not report a feature, the corresponding field is `false`/`null`
 * and the feature is hidden or disabled — never silently ignored (PRD §8, last line).
 *
 * Everything here is a zod schema so a payload that arrives from a gateway at runtime
 * can be validated before it is cached or persisted into `model_catalog`.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** PRD §8 modes. `text-to-image` etc. are request modes, not output formats. */
export const GENERATION_MODES = [
  "text-to-image",
  "image-to-image",
  "text-to-video",
  "image-to-video",
  "video-to-video",
  "tts",
  "sfx",
  "music",
  "transcription",
] as const;
export const GenerationModeSchema = z.enum(GENERATION_MODES);
export type GenerationMode = z.infer<typeof GenerationModeSchema>;

/** What the model produces, aligned with core's `MediaType` (plus subtitle). */
export const MODEL_MODALITIES = ["image", "video", "audio", "text", "subtitle"] as const;
export const ModelModalitySchema = z.enum(MODEL_MODALITIES);
export type ModelModality = z.infer<typeof ModelModalitySchema>;

export const PRICING_UNITS = ["per-image", "per-second", "per-1k-chars", "per-request"] as const;
export const PricingUnitSchema = z.enum(PRICING_UNITS);
export type PricingUnit = z.infer<typeof PricingUnitSchema>;

export const REFERENCE_FRAME_REQUIREMENTS = ["none", "optional", "required"] as const;
export const ReferenceFrameSchema = z.enum(REFERENCE_FRAME_REQUIREMENTS);
export type ReferenceFrame = z.infer<typeof ReferenceFrameSchema>;

/** Roles an input reference may play in a request. */
export const REFERENCE_ROLES = ["image", "video", "audio", "first-frame", "last-frame"] as const;
export const ReferenceRoleSchema = z.enum(REFERENCE_ROLES);
export type ReferenceRole = z.infer<typeof ReferenceRoleSchema>;

export const REMOTE_OUTPUT_KINDS = ["image", "video", "audio", "text"] as const;
export const RemoteOutputKindSchema = z.enum(REMOTE_OUTPUT_KINDS);
export type RemoteOutputKind = z.infer<typeof RemoteOutputKindSchema>;

// ---------------------------------------------------------------------------
// Pricing / quota / safety
// ---------------------------------------------------------------------------

/**
 * A machine-readable price. `null` on a capability object means "the provider does not
 * publish a price" — a first-class state that must never be coerced into `0` (PRD §13).
 */
export const PricingSchema = z.object({
  unit: PricingUnitSchema,
  amount: z.number().nonnegative(),
  currency: z.string().min(3).max(3).default("USD"),
});
export type Pricing = z.infer<typeof PricingSchema>;

export const QuotaSchema = z.object({
  /** Requests per minute, when the provider publishes a rate limit. */
  requestsPerMinute: z.number().int().positive().nullable().default(null),
  requestsPerDay: z.number().int().positive().nullable().default(null),
  /** Account-level concurrency cap, when published. */
  maxConcurrentRequests: z.number().int().positive().nullable().default(null),
  /** Free-text quota description for the UI. */
  notes: z.string().nullable().default(null),
});
export type Quota = z.infer<typeof QuotaSchema>;

export const SafetyMetadataSchema = z.object({
  contentFiltering: z.boolean().default(false),
  notes: z.string().nullable().default(null),
});
export type SafetyMetadata = z.infer<typeof SafetyMetadataSchema>;

/** PRD §8: "voice/language options". `gender` and `previewUrl` are advisory only. */
export const VoiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  languages: z.array(z.string().min(1)).default([]),
  gender: z.string().min(1).nullable().default(null),
  previewUrl: z.string().min(1).nullable().default(null),
});
export type Voice = z.infer<typeof VoiceSchema>;

// ---------------------------------------------------------------------------
// The capability object
// ---------------------------------------------------------------------------

/** A fully-specified capability object. Every PRD §8 field is present. */
export const ModelCapabilitiesSchema = z.object({
  modality: ModelModalitySchema,
  /** Modes the model can serve. Order is not meaningful. */
  modes: z.array(GenerationModeSchema).min(1),
  inputMimeTypes: z.array(z.string().min(1)).default([]),
  aspectRatios: z.array(z.string().min(1)).default([]),
  resolutions: z.array(z.string().min(1)).default([]),
  /** `null` when the model is not duration-bounded (images, TTS without a cap). */
  durationMinSeconds: z.number().nonnegative().nullable().default(null),
  durationMaxSeconds: z.number().nonnegative().nullable().default(null),
  supportsSeed: z.boolean().default(false),
  supportsNegativePrompt: z.boolean().default(false),
  referenceFrame: ReferenceFrameSchema.default("none"),
  supportsAudio: z.boolean().default(false),
  voices: z.array(VoiceSchema).default([]),
  languages: z.array(z.string().min(1)).default([]),
  maxConcurrency: z.number().int().positive().default(1),
  pricing: PricingSchema.nullable().default(null),
  quota: QuotaSchema.nullable().default(null),
  safety: SafetyMetadataSchema.nullable().default(null),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

/**
 * Parse a capability object that may be missing fields, filling in the conservative
 * default ("not supported"). Throws a `z.ZodError` only for genuinely invalid input,
 * which adapters turn into a `ProviderError`.
 *
 * Use `ModelCapabilitiesSchema` directly when the input must be complete.
 */
export function parseCapabilities(input: unknown): ModelCapabilities {
  return ModelCapabilitiesSchema.parse(input);
}

/** Every capability field, in PRD §8 order. Used by contract tests and the UI. */
export const CAPABILITY_FIELDS = [
  "modality",
  "modes",
  "inputMimeTypes",
  "aspectRatios",
  "resolutions",
  "durationMinSeconds",
  "durationMaxSeconds",
  "supportsSeed",
  "supportsNegativePrompt",
  "referenceFrame",
  "supportsAudio",
  "voices",
  "languages",
  "maxConcurrency",
  "pricing",
  "quota",
  "safety",
] as const satisfies readonly (keyof ModelCapabilities)[];

/**
 * Neutral, entirely conservative capabilities. Adapters start from this and only set
 * fields the provider actually reported, which is how "unknown => false/null" is kept
 * mechanical rather than a promise.
 */
export const CONSERVATIVE_CAPABILITIES: ModelCapabilities = Object.freeze(
  ModelCapabilitiesSchema.parse({
    modality: "text",
    modes: ["transcription"],
    inputMimeTypes: [],
    aspectRatios: [],
    resolutions: [],
    durationMinSeconds: null,
    durationMaxSeconds: null,
    supportsSeed: false,
    supportsNegativePrompt: false,
    referenceFrame: "none",
    supportsAudio: false,
    voices: [],
    languages: [],
    maxConcurrency: 1,
    pricing: null,
    quota: null,
    safety: null,
  }),
) as ModelCapabilities;

/** Build a capability object from partial provider data without guessing features on. */
export function capabilitiesFrom(
  partial: Partial<ModelCapabilities> & Pick<ModelCapabilities, "modality" | "modes">,
): ModelCapabilities {
  return ModelCapabilitiesSchema.parse({ ...CONSERVATIVE_CAPABILITIES, ...partial });
}

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

/**
 * A model as the catalog stores it.
 *
 * `fetchedAt`/`isStale` are catalog bookkeeping (24h TTL by default): a stale entry is
 * still usable — the user may be offline — but the UI must say so (PRD §18 "in-app
 * last-refreshed price").
 */
export const ModelDescriptorSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  modality: ModelModalitySchema,
  capabilities: ModelCapabilitiesSchema,
  fetchedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "fetchedAt must be an ISO-8601 timestamp",
  }),
  isStale: z.boolean().default(false),
});
export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;

/** Stable key for a descriptor inside the flat catalog table. */
export function modelKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

export function parseModelDescriptor(input: unknown): ModelDescriptor {
  return ModelDescriptorSchema.parse(input);
}

/**
 * Normalize a provider-reported capability flag. Anything that is not a literal boolean
 * `true` becomes `false`: a gateway that prints `"true"` or omits the key must not be
 * interpreted as support (PRD §8 "unknown features must be hidden/disabled").
 */
export function reportedFlag(value: unknown): boolean {
  return value === true;
}

/** Extract a string list, dropping non-strings and empties; order preserved. */
export function reportedList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
