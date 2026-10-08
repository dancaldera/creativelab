/**
 * Request/response vocabulary shared by every adapter.
 *
 * These types are transport-agnostic on purpose: an adapter may be REST, a gateway or a
 * test double (PRD §8 "implement capability-based adapters, not one hard-coded SDK
 * abstraction").
 */
import { z } from "zod";
import {
  GenerationModeSchema,
  ReferenceRoleSchema,
  RemoteOutputKindSchema,
} from "./capabilities.js";

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const ReferenceInputSchema = z.object({
  /** Project asset id, when the caller already has one. */
  assetId: z.string().min(1).optional(),
  /** Local absolute path. Never sent to a provider without an explicit upload step. */
  path: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  role: ReferenceRoleSchema,
});
export type ReferenceInput = z.infer<typeof ReferenceInputSchema>;

export const GenerationRequestSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  mode: GenerationModeSchema,
  prompt: z.string(),
  negativePrompt: z.string().optional(),
  seed: z.number().int().optional(),
  references: z.array(ReferenceInputSchema).default([]),
  aspectRatio: z.string().min(1).optional(),
  resolution: z.string().min(1).optional(),
  durationSeconds: z.number().positive().optional(),
  voiceId: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  quality: z.string().min(1).optional(),
  /** Provider-specific escape hatch. Must never contain credentials. */
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type GenerationRequest = z.infer<typeof GenerationRequestSchema>;
export type GenerationRequestInput = z.input<typeof GenerationRequestSchema>;

/** Modes that are meaningless without a prompt. */
export const PROMPT_REQUIRED_MODES: readonly string[] = [
  "text-to-image",
  "image-to-image",
  "text-to-video",
  "image-to-video",
  "video-to-video",
  "tts",
  "sfx",
  "music",
];

/** Modes whose requests are meaningless without at least one input reference. */
export const REFERENCE_REQUIRED_MODES: readonly string[] = [
  "image-to-image",
  "image-to-video",
  "video-to-video",
  "transcription",
];

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export const RemoteOutputSchema = z.object({
  /** Absolute URL the bytes can be downloaded from. */
  url: z.string().min(1),
  mimeType: z.string().min(1),
  bytes: z.number().int().nonnegative().optional(),
  sha256: z.string().optional(),
  /** ISO-8601 expiry. A URL past this instant must not be fetched (PRD §8). */
  expiresAt: z.string().optional(),
  kind: RemoteOutputKindSchema,
});
export type RemoteOutput = z.infer<typeof RemoteOutputSchema>;

// ---------------------------------------------------------------------------
// Submission / polling
// ---------------------------------------------------------------------------

export const SUBMIT_STATUSES = ["running", "completed", "failed", "unknown"] as const;
export type SubmitStatus = (typeof SUBMIT_STATUSES)[number];

export const SubmitResultSchema = z.object({
  /** Absent for synchronous providers whose `submit` already produced outputs. */
  providerJobId: z.string().min(1).optional(),
  status: z.enum(SUBMIT_STATUSES),
  outputs: z.array(RemoteOutputSchema).optional(),
  /** Set when the submission was accepted but the outcome cannot be confirmed. */
  uncertain: z.boolean().optional(),
  submittedAt: z.string().optional(),
});
export type SubmitResult = z.infer<typeof SubmitResultSchema>;

/** The statuses a provider can report for one of *its own* jobs. */
export const REMOTE_JOB_STATUSES = [
  "running",
  "completed",
  "failed",
  "canceled",
  "unknown",
] as const;
export type RemoteJobStatus = (typeof REMOTE_JOB_STATUSES)[number];

export const JobStatusResultSchema = z.object({
  status: z.enum(REMOTE_JOB_STATUSES),
  progress: z.number().min(0).max(1).nullable().optional(),
  outputs: z.array(RemoteOutputSchema).optional(),
  cost: z.unknown().nullable().optional(),
  /** Provider-reported failure text, already redacted by the adapter. */
  error: z.string().optional(),
  retryAfterSeconds: z.number().nonnegative().optional(),
});
export type JobStatusResult = z.infer<typeof JobStatusResultSchema>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const IssueSchema = z.object({
  /** Dotted request path, e.g. `durationSeconds` or `references.0.role`. */
  field: z.string().min(1),
  /** Stable machine code, e.g. `unsupported_aspect_ratio`, `duration_out_of_range`. */
  code: z.string().min(1),
  message: z.string().min(1),
});
export type Issue = z.infer<typeof IssueSchema>;

/**
 * PRD §8: anything requested that the model cannot honour lands in `unsupported` and the
 * UI hides/disables it. `errors` are requests that make no sense at all; `warnings` are
 * advisory. A request is submittable only when `unsupported` *and* `errors` are empty.
 */
export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly Issue[];
  readonly warnings: readonly Issue[];
  readonly unsupported: readonly Issue[];
}

export function emptyValidationResult(): ValidationResult {
  return { ok: true, errors: [], warnings: [], unsupported: [] };
}
