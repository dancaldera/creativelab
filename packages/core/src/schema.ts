/**
 * Project schema — runtime validation and static types for every persisted entity.
 *
 * The zod schemas are the contract for `project.json`, for SQLite row hydration and for
 * migration fixtures. Anything that crosses a process or file boundary is parsed.
 */
import { z } from "zod";
import { FRAME_RATE_PRESETS } from "./timebase.js";

/** Current on-disk schema version. Bump with a new migration file, never in place. */
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const IsoTimestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "must be an ISO-8601 timestamp",
});

const NonNegativeInt = z.number().int().min(0);
const PositiveInt = z.number().int().min(1);

/**
 * Zod 4 types `.default(x)` against the schema's *output*, so `{}.default({})` does not
 * compile even when every field inside the object has its own default. This helper
 * supplies the fully-defaulted object lazily, which keeps the nested default groups
 * (`transform`, `crop`, `audio`, …) valid both for parsing `{}` and for TS inference.
 */
function withObjectDefaults<S extends z.ZodObject<z.ZodRawShape>>(schema: S): z.ZodDefault<S> {
  // The `as never`/`as ZodDefault<S>` pair only bridges zod's `NoUndefined<output<S>>`
  // conditional; `schema.parse({})` is already fully typed and runtime-checked.
  return schema.default((() => schema.parse({})) as never) as z.ZodDefault<S>;
}

export const MediaTypeSchema = z.enum(["video", "image", "audio", "subtitle"]);
export type MediaType = z.infer<typeof MediaTypeSchema>;

export const TrackKindSchema = z.enum(["video", "audio", "caption"]);
export type TrackKind = z.infer<typeof TrackKindSchema>;

/** PRD §4: at least 3 video and 4 audio tracks. */
export const TRACK_LIMITS: Record<TrackKind, number> = { video: 8, audio: 12, caption: 4 };

export const AssetOriginSchema = z.enum(["imported", "generated", "derived"]);
export type AssetOrigin = z.infer<typeof AssetOriginSchema>;

/** PRD §9: imports are copied into the project by default; linked originals are advanced. */
export const StorageModeSchema = z.enum(["copied", "linked", "generated"]);
export type StorageMode = z.infer<typeof StorageModeSchema>;

export const AspectRatioSchema = z.enum(["16:9", "9:16", "1:1", "4:3", "4:5", "21:9"]);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

export const ASPECT_PRESETS: ReadonlyArray<{
  id: AspectRatio;
  label: string;
  width: number;
  height: number;
}> = [
  { id: "16:9", label: "Landscape 16:9", width: 1920, height: 1080 },
  { id: "9:16", label: "Vertical 9:16", width: 1080, height: 1920 },
  { id: "1:1", label: "Square 1:1", width: 1080, height: 1080 },
  { id: "4:3", label: "Classic 4:3", width: 1440, height: 1080 },
  { id: "4:5", label: "Portrait 4:5", width: 1080, height: 1350 },
  { id: "21:9", label: "Cinemascope 21:9", width: 2560, height: 1080 },
];

/** Frame rate as a rational; never a float, so 29.97 round-trips exactly. */
export const FrameRateSchema = z.object({
  num: PositiveInt,
  den: PositiveInt,
});

export const FrameRateIdSchema = z
  .string()
  .refine((id) => FRAME_RATE_PRESETS.some((preset) => preset.id === id), {
    message: "unknown frame-rate preset",
  });

// ---------------------------------------------------------------------------
// Clip properties (the non-destructive edit state)
// ---------------------------------------------------------------------------

export const TransformSchema = z.object({
  /** Position offset in project pixels, relative to the composition centre. */
  x: z.number().default(0),
  y: z.number().default(0),
  /** Fractional scale; 1 = fit the composition. */
  scale: z.number().min(0.01).max(20).default(1),
  /** Degrees, clockwise. */
  rotation: z.number().default(0),
  opacity: z.number().min(0).max(1).default(1),
  /** Mirror flags, applied before rotation. */
  flipX: z.boolean().default(false),
  flipY: z.boolean().default(false),
});
export type Transform = z.infer<typeof TransformSchema>;

/** Crop is expressed in source-normalized fractions so it survives proxy swaps. */
export const CropSchema = z.object({
  top: z.number().min(0).max(1).default(0),
  right: z.number().min(0).max(1).default(0),
  bottom: z.number().min(0).max(1).default(0),
  left: z.number().min(0).max(1).default(0),
});
export type Crop = z.infer<typeof CropSchema>;

export const AudioPropertiesSchema = z.object({
  /** Linear gain in decibels; the render graph converts to a linear multiplier. */
  gainDb: z.number().min(-96).max(24).default(0),
  fadeInFrames: NonNegativeInt.default(0),
  fadeOutFrames: NonNegativeInt.default(0),
  /** False removes the clip's audio from the mix without unlinking the video. */
  enabled: z.boolean().default(true),
  pan: z.number().min(-1).max(1).default(0),
});
export type AudioProperties = z.infer<typeof AudioPropertiesSchema>;

export const SpeedSchema = z.object({
  num: PositiveInt.default(1),
  den: PositiveInt.default(1),
});

export const TransitionKindSchema = z.enum([
  "none",
  "crossfade",
  "dip-to-black",
  "dip-to-white",
  "slide-left",
  "slide-right",
  "wipe-left",
  "wipe-right",
  "zoom-in",
  "zoom-out",
]);
export type TransitionKind = z.infer<typeof TransitionKindSchema>;

export const TransitionSchema = z.object({
  kind: TransitionKindSchema.default("none"),
  durationFrames: NonNegativeInt.default(0),
});
export type Transition = z.infer<typeof TransitionSchema>;

export const ClipPropertiesSchema = z.object({
  transform: withObjectDefaults(TransformSchema),
  crop: withObjectDefaults(CropSchema),
  audio: withObjectDefaults(AudioPropertiesSchema),
  speed: withObjectDefaults(SpeedSchema),
  transitionIn: withObjectDefaults(TransitionSchema),
  transitionOut: withObjectDefaults(TransitionSchema),
  /** Free-form user label shown on the clip header (e.g. shot number). */
  notes: z.string().default(""),
});
export type ClipProperties = z.infer<typeof ClipPropertiesSchema>;

export const DEFAULT_CLIP_PROPERTIES: ClipProperties = ClipPropertiesSchema.parse({});

// ---------------------------------------------------------------------------
// Entities (PRD §10 data model)
// ---------------------------------------------------------------------------

export const ProjectSchema = z.object({
  id: z.string().min(1),
  schemaVersion: PositiveInt,
  title: z.string().min(1).max(200),
  fps: FrameRateSchema,
  width: PositiveInt,
  height: PositiveInt,
  colorProfile: z.enum(["bt709", "bt2020", "srgb", "p3-d65"]).default("bt709"),
  sampleRate: PositiveInt.default(48_000),
  channels: z.union([z.literal(1), z.literal(2)]).default(2),
  /** Project-relative folder inside the workspace; `.` means the workspace root. */
  workspaceRelPath: z.string().default("."),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type Project = z.infer<typeof ProjectSchema>;

export const SequenceSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1).max(120),
  width: PositiveInt,
  height: PositiveInt,
  fps: FrameRateSchema,
  durationFrames: NonNegativeInt.default(0),
  isActive: z.boolean().default(false),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type Sequence = z.infer<typeof SequenceSchema>;

export const TrackSchema = z.object({
  id: z.string().min(1),
  sequenceId: z.string().min(1),
  kind: TrackKindSchema,
  name: z.string().min(1).max(80),
  sortOrder: NonNegativeInt,
  muted: z.boolean().default(false),
  locked: z.boolean().default(false),
  hidden: z.boolean().default(false),
  solo: z.boolean().default(false),
  volumeDb: z.number().min(-96).max(24).default(0),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type Track = z.infer<typeof TrackSchema>;

export const ClipSchema = z
  .object({
    id: z.string().min(1),
    trackId: z.string().min(1),
    sequenceId: z.string().min(1),
    assetId: z.string().nullable().default(null),
    label: z.string().default(""),
    /** Timeline position. Canonical, integer frames (PRD §10). */
    startFrame: NonNegativeInt,
    /** Offset into the immutable source asset. */
    sourceInFrame: NonNegativeInt.default(0),
    durationFrames: PositiveInt,
    properties: withObjectDefaults(ClipPropertiesSchema),
    version: PositiveInt.default(1),
    createdAt: IsoTimestamp,
    updatedAt: IsoTimestamp,
  })
  .refine((clip) => clip.startFrame + clip.durationFrames <= Number.MAX_SAFE_INTEGER, {
    message: "clip end frame overflows",
  });
export type Clip = z.infer<typeof ClipSchema>;

export const EffectSchema = z.object({
  id: z.string().min(1),
  clipId: z.string().min(1),
  kind: z.enum([
    "brightness",
    "contrast",
    "saturation",
    "blur",
    "sharpen",
    "grayscale",
    "sepia",
    "vignette",
    "volume",
    "eq",
    "denoise",
  ]),
  sortOrder: NonNegativeInt.default(0),
  enabled: z.boolean().default(true),
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type Effect = z.infer<typeof EffectSchema>;

export const EasingSchema = z.enum([
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "hold",
  "bezier",
]);
export type Easing = z.infer<typeof EasingSchema>;

export const KeyframeSchema = z.object({
  id: z.string().min(1),
  effectId: z.string().min(1),
  /** Dotted path into the effect/c lip property bag, e.g. `transform.opacity`. */
  property: z.string().min(1),
  frame: NonNegativeInt,
  value: z.union([z.number(), z.string(), z.boolean()]),
  easing: EasingSchema.default("linear"),
  createdAt: IsoTimestamp,
});
export type Keyframe = z.infer<typeof KeyframeSchema>;

export const AssetSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  mediaType: MediaTypeSchema,
  storageMode: StorageModeSchema.default("copied"),
  /** Absolute path on disk, or a provider URL for remote originals. */
  uri: z.string().min(1),
  /** Project-relative path; the portable reference used by `project.json`. */
  relativePath: z.string().nullable().default(null),
  sha256: z.string().nullable().default(null),
  bytes: NonNegativeInt.nullable().default(null),
  durationFrames: NonNegativeInt.nullable().default(null),
  width: PositiveInt.nullable().default(null),
  height: PositiveInt.nullable().default(null),
  sampleRate: PositiveInt.nullable().default(null),
  channels: PositiveInt.nullable().default(null),
  fps: FrameRateSchema.nullable().default(null),
  codec: z.string().nullable().default(null),
  container: z.string().nullable().default(null),
  origin: AssetOriginSchema.default("imported"),
  parentAssetId: z.string().nullable().default(null),
  generationJobId: z.string().nullable().default(null),
  promptRevisionId: z.string().nullable().default(null),
  probe: z.record(z.string(), z.unknown()).nullable().default(null),
  /** Set when the file was last found missing; drives the relink UI (FR-02). */
  missingAt: IsoTimestamp.nullable().default(null),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type Asset = z.infer<typeof AssetSchema>;

/** PRD §12 — the durable job state machine. */
export const JOB_STATUSES = [
  "queued",
  "validating",
  "submitting",
  "running",
  "downloading",
  "completed",
  "failed",
  "canceled",
  "unknown",
] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const SpendSchema = z.object({
  amount: z.number(),
  currency: z.string().length(3).default("USD"),
  /** True when the provider does not publish machine-readable pricing. */
  isEstimate: z.boolean().default(true),
});
export type Spend = z.infer<typeof SpendSchema>;

export const GenerationJobSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  /** e.g. `text-to-video`, `image-to-video`, `tts`, `sfx`, `transcription`. */
  mode: z.string().min(1),
  modality: MediaTypeSchema,
  status: JobStatusSchema,
  idempotencyKey: z.string().nullable().default(null),
  /** Set while a submission is in flight; cleared on a definite outcome. */
  submissionLock: z.string().nullable().default(null),
  request: z.record(z.string(), z.unknown()),
  providerJobId: z.string().nullable().default(null),
  retryCount: NonNegativeInt.default(0),
  nextPollAt: IsoTimestamp.nullable().default(null),
  progress: z.number().min(0).max(1).nullable().default(null),
  costEstimate: SpendSchema.nullable().default(null),
  actualCost: SpendSchema.nullable().default(null),
  outputAssetIds: z.array(z.string()).default([]),
  error: z.record(z.string(), z.unknown()).nullable().default(null),
  submittedAt: IsoTimestamp.nullable().default(null),
  completedAt: IsoTimestamp.nullable().default(null),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type GenerationJob = z.infer<typeof GenerationJobSchema>;

export const PromptRevisionSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().nullable().default(null),
  assetId: z.string().nullable().default(null),
  prompt: z.string(),
  negativePrompt: z.string().nullable().default(null),
  references: z.array(z.string()).default([]),
  seed: z.number().int().nullable().default(null),
  parameters: z.record(z.string(), z.unknown()).default({}),
  createdAt: IsoTimestamp,
});
export type PromptRevision = z.infer<typeof PromptRevisionSchema>;

export const ExportPresetSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  container: z.literal("mp4").default("mp4"),
  videoCodec: z.literal("h264").default("h264"),
  audioCodec: z.literal("aac").default("aac"),
  width: PositiveInt,
  height: PositiveInt,
  /**
   * Export frame rate. `null` — the default, and what every shipped preset uses — means
   * "render at the project's frame rate", which is what PRD §12 requires: "export always
   * renders at project settings". An explicit rate is still allowed for deliberate
   * delivery conversions (for example handing a 25 fps edit to a 30 fps channel).
   */
  fps: FrameRateSchema.nullable().default(null),
  /** Average video bitrate in kbit/s. */
  videoBitrateKbps: PositiveInt.default(12_000),
  audioBitrateKbps: PositiveInt.default(192),
  /** Global quality override; when set, FFmpeg CRF is used instead of a fixed bitrate. */
  crf: z.number().int().min(0).max(51).nullable().default(null),
  pixelFormat: z.enum(["yuv420p", "yuv422p", "yuv444p"]).default("yuv420p"),
  burnInCaptions: z.boolean().default(false),
});
export type ExportPreset = z.infer<typeof ExportPresetSchema>;

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  ExportPresetSchema.parse({
    id: "1080p",
    label: "1080p H.264",
    width: 1920,
    height: 1080,
    videoBitrateKbps: 12_000,
  }),
  ExportPresetSchema.parse({
    id: "720p",
    label: "720p H.264",
    width: 1280,
    height: 720,
    videoBitrateKbps: 6_000,
  }),
  ExportPresetSchema.parse({
    id: "1080p-vertical",
    label: "1080p vertical H.264",
    width: 1080,
    height: 1920,
    videoBitrateKbps: 10_000,
  }),
  ExportPresetSchema.parse({
    id: "master-crf",
    label: "Master (CRF 16)",
    width: 1920,
    height: 1080,
    crf: 16,
    videoBitrateKbps: 20_000,
  }),
];

export const ExportJobSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  sequenceId: z.string().min(1),
  preset: ExportPresetSchema,
  outputPath: z.string().min(1),
  status: z.enum([
    "queued",
    "preparing",
    "rendering",
    "finalizing",
    "completed",
    "failed",
    "canceled",
  ]),
  progress: z.number().min(0).max(1).default(0),
  renderedFrames: NonNegativeInt.default(0),
  totalFrames: NonNegativeInt.default(0),
  errors: z.array(z.string()).default([]),
  logPath: z.string().nullable().default(null),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type ExportJob = z.infer<typeof ExportJobSchema>;

/**
 * Provider *metadata*. Deliberately has no secret field: the API key lives in the OS
 * keychain and is referenced by `credentialRef` (PRD §13).
 */
export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().nullable().default(null),
  providerId: z.string().min(1),
  enabled: z.boolean().default(true),
  baseUrl: z.string().url().nullable().default(null),
  credentialRef: z.string().nullable().default(null),
  authScheme: z.enum(["bearer", "x-api-key", "query", "none"]).default("bearer"),
  extraHeaders: z.record(z.string(), z.string()).default({}),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

// ---------------------------------------------------------------------------
// The editable document (undo/redo unit)
// ---------------------------------------------------------------------------

export const EditorDocumentSchema = z.object({
  project: ProjectSchema,
  sequences: z.array(SequenceSchema),
  tracks: z.array(TrackSchema),
  clips: z.array(ClipSchema),
  effects: z.array(EffectSchema),
  keyframes: z.array(KeyframeSchema),
  assets: z.array(AssetSchema),
});
export type EditorDocument = z.infer<typeof EditorDocumentSchema>;

/** The portable `project.json` manifest (PRD §11). Assets are referenced relatively. */
export const ProjectManifestSchema = z.object({
  manifestVersion: PositiveInt,
  schemaVersion: PositiveInt,
  generator: z.string(),
  project: ProjectSchema,
  sequences: z.array(SequenceSchema),
  tracks: z.array(TrackSchema),
  clips: z.array(ClipSchema),
  effects: z.array(EffectSchema),
  keyframes: z.array(KeyframeSchema),
  assets: z.array(AssetSchema),
  /** Recorded so a manifest can be checked against the DB it came from. */
  exportedAt: IsoTimestamp,
});
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

export const MANIFEST_VERSION = 1;
