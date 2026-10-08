/**
 * Capability gating (PRD §8).
 *
 * > "Unknown features must be hidden/disabled rather than silently ignored."
 *
 * Every check below either reports a field the model cannot honour in `unsupported`
 * (the UI hides/disables it) or reports an incoherent request in `errors`. Nothing is
 * dropped silently — `unsupported` is non-empty whenever anything requested cannot be
 * delivered, which is the property the tests assert.
 */
import type { ModelCapabilities } from "./capabilities.js";
import type { GenerationRequest, Issue, ValidationResult } from "./requests.js";
import { PROMPT_REQUIRED_MODES, REFERENCE_REQUIRED_MODES } from "./requests.js";

type Severity = "errors" | "warnings" | "unsupported";

function issue(field: string, code: string, message: string): Issue {
  return { field, code, message };
}

/** Modes that consume at least one input reference by definition. */
function requiresReferences(mode: string): boolean {
  return REFERENCE_REQUIRED_MODES.includes(mode);
}

const FRAME_ROLES: readonly string[] = ["first-frame", "last-frame"];

/**
 * Validate a request against a model's capabilities.
 *
 * Field names in the returned issues are request paths (`durationSeconds`, `seed`, …) so
 * the generation panel can disable exactly the offending control.
 */
export function validateRequest(
  request: GenerationRequest,
  capabilities: ModelCapabilities,
): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const unsupported: Issue[] = [];
  const add = (severity: Severity, item: Issue): void => {
    if (severity === "errors") errors.push(item);
    else if (severity === "warnings") warnings.push(item);
    else unsupported.push(item);
  };

  // --- mode / modality -----------------------------------------------------
  if (!capabilities.modes.includes(request.mode)) {
    add(
      "unsupported",
      issue(
        "mode",
        "unsupported_mode",
        `${capabilities.modality} model "${request.modelId}" does not support mode "${request.mode}". Supported: ${
          capabilities.modes.join(", ") || "none"
        }.`,
      ),
    );
  }

  // --- prompt --------------------------------------------------------------
  if (PROMPT_REQUIRED_MODES.includes(request.mode) && request.prompt.trim().length === 0) {
    add(
      "errors",
      issue("prompt", "prompt_required", `Mode "${request.mode}" requires a non-empty prompt.`),
    );
  }
  if (request.prompt.length > 8_000) {
    add(
      "warnings",
      issue(
        "prompt",
        "prompt_very_long",
        "Prompts longer than 8000 characters are often truncated by providers.",
      ),
    );
  }

  // --- negative prompt -----------------------------------------------------
  if (request.negativePrompt !== undefined) {
    if (!capabilities.supportsNegativePrompt) {
      add(
        "unsupported",
        issue(
          "negativePrompt",
          "unsupported_negative_prompt",
          `Model "${request.modelId}" does not support negative prompts.`,
        ),
      );
    } else if (request.negativePrompt.trim().length === 0) {
      add(
        "warnings",
        issue("negativePrompt", "negative_prompt_empty", "An empty negative prompt has no effect."),
      );
    }
  }

  // --- seed ----------------------------------------------------------------
  if (request.seed !== undefined && !capabilities.supportsSeed) {
    add(
      "unsupported",
      issue("seed", "unsupported_seed", `Model "${request.modelId}" does not accept a seed.`),
    );
  }

  // --- duration ------------------------------------------------------------
  if (request.durationSeconds !== undefined) {
    const { durationMinSeconds, durationMaxSeconds } = capabilities;
    const below = durationMinSeconds !== null && request.durationSeconds < durationMinSeconds;
    const above = durationMaxSeconds !== null && request.durationSeconds > durationMaxSeconds;
    if (below || above) {
      add(
        "unsupported",
        issue(
          "durationSeconds",
          "duration_out_of_range",
          `Duration ${request.durationSeconds}s is outside the supported range${
            durationMinSeconds !== null || durationMaxSeconds !== null
              ? ` (${durationMinSeconds ?? "any"}s–${durationMaxSeconds ?? "any"}s)`
              : ""
          }.`,
        ),
      );
    }
  } else if (capabilities.durationMinSeconds !== null && capabilities.durationMinSeconds > 0) {
    add(
      "warnings",
      issue(
        "durationSeconds",
        "duration_unspecified",
        `This model's minimum duration is ${capabilities.durationMinSeconds}s; a duration must be chosen.`,
      ),
    );
  }

  // --- aspect ratio / resolution ------------------------------------------
  if (
    request.aspectRatio !== undefined &&
    !capabilities.aspectRatios.includes(request.aspectRatio)
  ) {
    add(
      "unsupported",
      issue(
        "aspectRatio",
        "unsupported_aspect_ratio",
        `Aspect ratio "${request.aspectRatio}" is not supported by "${request.modelId}". Supported: ${
          capabilities.aspectRatios.join(", ") || "none"
        }.`,
      ),
    );
  }
  if (request.resolution !== undefined && !capabilities.resolutions.includes(request.resolution)) {
    add(
      "unsupported",
      issue(
        "resolution",
        "unsupported_resolution",
        `Resolution "${request.resolution}" is not supported by "${request.modelId}". Supported: ${
          capabilities.resolutions.join(", ") || "none"
        }.`,
      ),
    );
  }

  // --- references ----------------------------------------------------------
  const references = request.references ?? [];
  if (capabilities.referenceFrame === "none" && references.length > 0) {
    add(
      "unsupported",
      issue(
        "references",
        "unsupported_references",
        `Model "${request.modelId}" does not accept input references.`,
      ),
    );
  }

  if (capabilities.referenceFrame === "required" && references.length === 0) {
    add(
      "errors",
      issue(
        "references",
        "reference_required",
        `Model "${request.modelId}" requires at least one input reference.`,
      ),
    );
  }

  references.forEach((reference, index) => {
    const field = `references.${index}.role`;
    const usesFrame = FRAME_ROLES.includes(reference.role);
    if (usesFrame && capabilities.referenceFrame === "none") {
      add(
        "unsupported",
        issue(
          field,
          "unsupported_reference_frame",
          `Model "${request.modelId}" does not accept reference frames.`,
        ),
      );
    }
    if (usesFrame && capabilities.modality === "audio") {
      add(
        "errors",
        issue(
          field,
          "reference_role_mismatch",
          `An audio model cannot use role "${reference.role}".`,
        ),
      );
    }
    if (!usesFrame && reference.role === "audio" && !capabilities.supportsAudio) {
      add(
        "unsupported",
        issue(
          field,
          "unsupported_audio_reference",
          `Model "${request.modelId}" does not accept audio references.`,
        ),
      );
    }
    if (!reference.assetId && !reference.path) {
      add(
        "errors",
        issue(
          `references.${index}`,
          "reference_missing_source",
          "A reference must carry either an assetId (project asset) or a path (local file).",
        ),
      );
    }
  });

  if (requiresReferences(request.mode) && references.length === 0) {
    add(
      "errors",
      issue(
        "references",
        "reference_required_by_mode",
        `Mode "${request.mode}" requires at least one input reference.`,
      ),
    );
  }

  if (
    capabilities.referenceFrame === "optional" &&
    references.length > 1 &&
    !references.some((r) => FRAME_ROLES.includes(r.role))
  ) {
    add(
      "warnings",
      issue(
        "references",
        "multiple_references",
        `${references.length} references were supplied; the provider may use only the first.`,
      ),
    );
  }

  // --- voice ---------------------------------------------------------------
  if (request.voiceId !== undefined) {
    if (capabilities.voices.length === 0) {
      add(
        "unsupported",
        issue(
          "voiceId",
          "unsupported_voice",
          `Model "${request.modelId}" has no selectable voices.`,
        ),
      );
    } else if (!capabilities.voices.some((voice) => voice.id === request.voiceId)) {
      add(
        "errors",
        issue(
          "voiceId",
          "unknown_voice",
          `Voice "${request.voiceId}" is not offered by "${request.modelId}".`,
        ),
      );
    }
  } else if (
    capabilities.voices.length > 0 &&
    (request.mode === "tts" || request.mode === "music")
  ) {
    add(
      "warnings",
      issue(
        "voiceId",
        "voice_not_selected",
        "No voice was selected; the provider default will be used.",
      ),
    );
  }

  // --- language ------------------------------------------------------------
  if (
    request.language !== undefined &&
    capabilities.languages.length > 0 &&
    !capabilities.languages.includes(request.language)
  ) {
    add(
      "errors",
      issue(
        "language",
        "unknown_language",
        `Language "${request.language}" is not supported by "${request.modelId}". Supported: ${capabilities.languages.join(", ")}.`,
      ),
    );
  } else if (request.language !== undefined && capabilities.languages.length === 0) {
    add(
      "unsupported",
      issue(
        "language",
        "unsupported_language",
        `Model "${request.modelId}" does not expose a language option.`,
      ),
    );
  }

  // --- capability-level preconditions --------------------------------------
  if (
    capabilities.modality === "audio" &&
    !capabilities.supportsAudio &&
    capabilities.voices.length === 0
  ) {
    add(
      "warnings",
      issue(
        "mode",
        "audio_model_without_audio_flag",
        `Model "${request.modelId}" reports no audio output flag; confirm with the provider.`,
      ),
    );
  }
  if (capabilities.maxConcurrency <= 0) {
    add(
      "errors",
      issue(
        "modelId",
        "invalid_concurrency",
        `Model "${request.modelId}" reports maxConcurrency <= 0 and cannot be scheduled.`,
      ),
    );
  }
  // `pricing === null` is deliberately *not* an issue here: `estimateCost` returns `null`
  // and the budget layer owns the "unknown pricing" warning/confirmation (core
  // `evaluateBudget`), so reporting it twice would double-prompt the user.

  return {
    ok: errors.length === 0 && unsupported.length === 0,
    errors,
    warnings,
    unsupported,
  };
}

/** Convenience: the field names that gating rejected. */
export function unsupportedFields(result: ValidationResult): string[] {
  return result.unsupported.map((item) => item.field);
}
