/**
 * Typed error taxonomy.
 *
 * PRD §12 requires every job to be reconcilable after a crash, and §13 requires that
 * uncertain paid submissions are never silently retried. That distinction lives here:
 * only errors marked `retryable` may be automatically re-attempted.
 */

export type ErrorCategory =
  | "validation"
  | "configuration"
  | "credential"
  | "network"
  | "timeout"
  | "rate_limit"
  | "provider"
  | "budget"
  | "disk"
  | "media"
  | "io"
  | "canceled"
  | "internal";

export interface CreativeLabErrorOptions {
  category: ErrorCategory;
  retryable?: boolean;
  /** Provider HTTP status, when applicable. */
  status?: number;
  /** Seconds the caller should wait before retrying, from `Retry-After`. */
  retryAfterSeconds?: number;
  /** Marks a submission whose outcome is unknown — must be reconciled, never auto-resubmitted. */
  uncertain?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class CreativeLabError extends Error {
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly uncertain: boolean;
  readonly details: Record<string, unknown>;

  constructor(message: string, options: CreativeLabErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "CreativeLabError";
    this.category = options.category;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.uncertain = options.uncertain ?? false;
    this.details = options.details ?? {};
  }

  /** Serialize for the `error_json` column; never includes credentials or headers. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      category: this.category,
      retryable: this.retryable,
      uncertain: this.uncertain,
      status: this.status,
      retryAfterSeconds: this.retryAfterSeconds,
      details: this.details,
    };
  }
}

export class ValidationError extends CreativeLabError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { category: "validation", retryable: false, details });
    this.name = "ValidationError";
  }
}

export class ConfigurationError extends CreativeLabError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { category: "configuration", retryable: false, details });
    this.name = "ConfigurationError";
  }
}

export class CredentialError extends CreativeLabError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { category: "credential", retryable: false, details });
    this.name = "CredentialError";
  }
}

export class BudgetExceededError extends CreativeLabError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { category: "budget", retryable: false, details });
    this.name = "BudgetExceededError";
  }
}

export class ProviderError extends CreativeLabError {
  constructor(
    message: string,
    options: Omit<CreativeLabErrorOptions, "category"> & { category?: ErrorCategory },
  ) {
    super(message, { ...options, category: options.category ?? "provider" });
    this.name = "ProviderError";
  }
}

export class UnsafePathError extends CreativeLabError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { category: "io", retryable: false, details });
    this.name = "UnsafePathError";
  }
}

/**
 * Classify an unknown thrown value into a CreativeLabError so that the job queue can
 * make a retry decision without special-casing provider SDK quirks.
 */
export function normalizeError(error: unknown): CreativeLabError {
  if (error instanceof CreativeLabError) return error;
  if (error instanceof Error) {
    return new CreativeLabError(error.message, {
      category: "internal",
      retryable: false,
      cause: error,
      details: { stack: error.stack?.split("\n").slice(0, 4).join("\n") },
    });
  }
  return new CreativeLabError(String(error), { category: "internal", retryable: false });
}

/** HTTP status -> retry policy shared by every REST adapter. */
export function classifyHttpStatus(
  status: number,
): Pick<CreativeLabErrorOptions, "retryable" | "uncertain" | "category"> {
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { retryable: true, category: status === 429 ? "rate_limit" : "provider" };
  }
  if (status === 401 || status === 403) return { retryable: false, category: "credential" };
  if (status === 404 || status === 400 || status === 422)
    return { retryable: false, category: "validation" };
  if (status === 402) return { retryable: false, category: "budget" };
  return { retryable: false, category: "provider" };
}
