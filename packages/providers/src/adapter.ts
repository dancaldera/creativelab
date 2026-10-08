/**
 * The PRD §8 / ARCHITECTURE.md adapter contract.
 *
 * The interface is reproduced verbatim from `docs/ARCHITECTURE.md` — adapters and the
 * registry are type-checked against it, so a change here is a change to the documented
 * contract and must be made in the docs first.
 *
 * Two signatures are intentionally `ctx`-free (`describeCapabilities(modelId)` and
 * `validate(request, capabilities)`) because per-call credentials are baked into the
 * adapter at construction; `ctx` carries per-*request* ambient state (deadline, abort,
 * clock) plus the vault for adapters that resolve keys lazily.
 */
import type { CredentialVault } from "./credentials.js";
import type { ModelCapabilities, ModelDescriptor } from "./capabilities.js";
import type {
  GenerationRequest,
  JobStatusResult,
  RemoteOutput,
  SubmitResult,
  ValidationResult,
} from "./requests.js";
import type { Spend } from "@creativelab/core";
import type { CreativeLabError } from "@creativelab/core";

/**
 * Structured logging seam.
 *
 * **Never pass a credential to a logger.** Adapters log provider ids, model ids, request
 * ids, status codes and retry decisions — values that are already public. The
 * `HttpClient` additionally scrubs known secret values out of anything it logs, and the
 * vault never hands a secret to a log call, so a mistake here degrades to `***`.
 */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Ambient state for a single provider call. */
export interface ProviderContext {
  /** Secret source. Keys are addressed by opaque `credentialRef`, never inline (PRD §13). */
  readonly credentials: CredentialVault;
  /** Injectable so no test ever touches the network and the app can wrap/observe calls. */
  readonly fetch: typeof fetch;
  readonly logger?: Logger;
  /** Caller cancellation. Combined with the per-request timeout by `HttpClient`. */
  readonly signal?: AbortSignal;
  /** Injectable clock so backoff, expiry and staleness are testable. */
  readonly now?: () => Date;
}

/** Fill in the defaults a caller may leave out. */
export function resolveContext(
  ctx: Partial<ProviderContext> & Pick<ProviderContext, "credentials">,
): ProviderContext {
  return {
    credentials: ctx.credentials,
    fetch: ctx.fetch ?? globalThis.fetch,
    ...(ctx.logger ? { logger: ctx.logger } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.now ? { now: ctx.now } : {}),
  };
}

/** PRD §8 adapter contract — exactly as documented. */
export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  listModels(ctx: ProviderContext): Promise<ModelDescriptor[]>;
  describeCapabilities(modelId: string): Promise<ModelCapabilities>;
  estimateCost(request: GenerationRequest): Promise<Spend | null>;
  validate(request: GenerationRequest, capabilities: ModelCapabilities): ValidationResult;
  submit(request: GenerationRequest, ctx: ProviderContext): Promise<SubmitResult>;
  getJob(jobId: string, ctx: ProviderContext): Promise<JobStatusResult>;
  cancel(jobId: string, ctx: ProviderContext): Promise<void>;
  fetchOutputs(job: JobStatusResult, ctx: ProviderContext): Promise<RemoteOutput[]>;
  normalizeError(error: unknown): CreativeLabError;
}

/** Constructor shape shared by the REST adapters. */
export interface HttpAdapterOptions {
  /** Injectable `fetch`; defaults to `globalThis.fetch`. No test may hit the network. */
  readonly fetch?: typeof fetch;
  /** Override for gateways, self-hosted relays and tests. */
  readonly baseUrl?: string;
  /** Opaque key into the `CredentialVault`. */
  readonly credentialRef?: string;
  readonly logger?: Logger;
  readonly now?: () => Date;
  /** Per-request timeout, milliseconds. */
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  /** Deterministic jitter for tests. */
  readonly random?: () => number;
  /** Test seam: replaces the real sleep so backoff is instantaneous in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}
