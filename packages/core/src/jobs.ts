/**
 * Durable generation-job state machine, retry policy and restart reconciliation.
 *
 * PRD §12:
 *   * persistent queue with states queued/validating/submitting/running/downloading/
 *     completed/failed/canceled/unknown;
 *   * exponential backoff with jitter, provider `Retry-After`, bounded retries;
 *   * idempotency keys and a local submission lock to reduce duplicate paid requests;
 *   * "uncertain submissions must not auto-resubmit".
 *
 * The last rule is the important one and lives in `reconcileAfterRestart`: a job that
 * was mid-`submitting` when the process died is moved to `unknown` and parked for a
 * human, because re-submitting could bill the user twice.
 */
import type { GenerationJob, JobStatus } from "./schema.js";
import { newId } from "./ids.js";

/** Allowed transitions. Anything absent here is a bug, not a runtime condition. */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["validating", "canceled"],
  validating: ["submitting", "failed", "canceled"],
  submitting: ["running", "completed", "failed", "canceled", "unknown"],
  running: ["downloading", "completed", "failed", "canceled", "unknown"],
  downloading: ["completed", "failed", "canceled", "unknown"],
  completed: [],
  failed: ["queued", "canceled"],
  canceled: [],
  unknown: ["running", "downloading", "completed", "failed", "canceled"],
};

export const TERMINAL_STATUSES: readonly JobStatus[] = ["completed", "canceled"];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Statuses where a provider-side job id exists and polling is meaningful. */
export function isPollable(status: JobStatus): boolean {
  return status === "running" || status === "downloading" || status === "unknown";
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export class JobTransitionError extends Error {
  readonly from: JobStatus;
  readonly to: JobStatus;
  constructor(from: JobStatus, to: JobStatus) {
    super(`Illegal job transition ${from} -> ${to}`);
    this.name = "JobTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new JobTransitionError(from, to);
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

export interface BackoffOptions {
  readonly attempt: number;
  readonly baseMs?: number;
  readonly capMs?: number;
  /** Provider `Retry-After` in seconds; always wins when larger than the computed delay. */
  readonly retryAfterSeconds?: number;
  /** Injectable in [0, 1) so tests are deterministic. Defaults to `Math.random`. */
  readonly random?: () => number;
  /** `full` (default) draws uniformly from [0, delay]; `equal` uses delay/2 + jitter/2. */
  readonly jitter?: "full" | "equal" | "none";
}

export const DEFAULT_BASE_BACKOFF_MS = 1_000;
export const DEFAULT_MAX_BACKOFF_MS = 60_000;

/**
 * Exponential backoff with jitter. The `retryAfterSeconds` floor is applied *after*
 * jitter so a provider-specified wait is never shortened by a lucky random draw.
 */
export function nextBackoffDelay(options: BackoffOptions): number {
  const base = options.baseMs ?? DEFAULT_BASE_BACKOFF_MS;
  const cap = options.capMs ?? DEFAULT_MAX_BACKOFF_MS;
  const attempt = Math.max(0, Math.floor(options.attempt));
  const random = options.random ?? Math.random;

  // Cap the exponent before it overflows, then clamp to the ceiling.
  const raw = base * 2 ** Math.min(attempt, 30);
  const capped = Math.min(cap, raw);
  const jitterMode = options.jitter ?? "full";
  let delay: number;
  switch (jitterMode) {
    case "none":
      delay = capped;
      break;
    case "equal":
      delay = capped / 2 + random() * (capped / 2);
      break;
    case "full":
    default:
      delay = random() * capped;
      break;
  }
  const retryAfterMs = Math.max(0, (options.retryAfterSeconds ?? 0) * 1000);
  // Never return 0: a zero delay would hot-loop the scheduler.
  return Math.max(1, Math.round(Math.max(delay, retryAfterMs)));
}

export interface RetryPolicy {
  readonly maxRetries: number;
  readonly baseMs?: number;
  readonly capMs?: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 4,
  baseMs: DEFAULT_BASE_BACKOFF_MS,
  capMs: DEFAULT_MAX_BACKOFF_MS,
};

export interface RetryDecision {
  readonly retry: boolean;
  readonly reason: string;
  readonly delayMs: number;
}

/** Decide whether a failed attempt may be retried, and how long to wait. */
export function decideRetry(input: {
  job: Pick<GenerationJob, "retryCount" | "status">;
  error: { retryable?: boolean; uncertain?: boolean; retryAfterSeconds?: number };
  policy?: RetryPolicy;
  random?: () => number;
}): RetryDecision {
  const policy = input.policy ?? DEFAULT_RETRY_POLICY;
  if (input.error.uncertain) {
    return {
      retry: false,
      reason: "submission outcome unknown; manual reconciliation required",
      delayMs: 0,
    };
  }
  if (input.job.status === "canceled")
    return { retry: false, reason: "job was canceled", delayMs: 0 };
  if (!input.error.retryable) return { retry: false, reason: "error is not retryable", delayMs: 0 };
  if (input.job.retryCount >= policy.maxRetries) {
    return { retry: false, reason: `retry budget exhausted (${policy.maxRetries})`, delayMs: 0 };
  }
  return {
    retry: true,
    reason: `retryable failure, attempt ${input.job.retryCount + 1} of ${policy.maxRetries}`,
    delayMs: nextBackoffDelay({
      attempt: input.job.retryCount,
      baseMs: policy.baseMs,
      capMs: policy.capMs,
      retryAfterSeconds: input.error.retryAfterSeconds,
      random: input.random,
    }),
  };
}

// ---------------------------------------------------------------------------
// Submission lock
// ---------------------------------------------------------------------------

export interface SubmissionClaim {
  readonly jobId: string;
  readonly lockId: string;
  readonly claimedAt: string;
}

/**
 * Claim the exclusive right to submit a paid request. Returns `undefined` when another
 * claim is live, which is how a double-clicked Generate button collapses to one charge.
 *
 * The lock id is `<ISO-8601 timestamp>|<opaque id>`. The `|` delimiter is deliberate:
 * an ISO timestamp contains `:` characters, so splitting on `:` would silently produce
 * an unparseable timestamp and disable the lock entirely.
 */
export function claimSubmission(
  job: GenerationJob,
  now = new Date(),
  lockTtlMs = 5 * 60_000,
): SubmissionClaim | undefined {
  if (job.submissionLock) {
    const [stamp] = job.submissionLock.split("|");
    const claimedAt = stamp ? Date.parse(stamp) : Number.NaN;
    const expired = Number.isFinite(claimedAt) && now.getTime() - claimedAt >= lockTtlMs;
    // An unreadable lock is treated as *live*: refusing a duplicate paid submission is
    // safer than risking a double charge, and reconciliation can clear it deliberately.
    if (!expired) return undefined;
  }
  if (job.status === "running" || job.status === "downloading" || job.status === "completed")
    return undefined;
  return {
    jobId: job.id,
    lockId: `${now.toISOString()}|${newId("event")}`,
    claimedAt: now.toISOString(),
  };
}

export interface ReconciliationAction {
  readonly jobId: string;
  readonly from: JobStatus;
  readonly to: JobStatus;
  readonly reason: string;
  readonly requiresHuman: boolean;
}

/**
 * Decide what to do with every non-terminal job after a restart.
 *
 * The `submitting` case deliberately parks the job in `unknown` instead of retrying:
 * we cannot know whether the provider accepted (and billed) the request.
 */
export function reconcileAfterRestart(
  jobs: readonly GenerationJob[],
  options: { now?: Date } = {},
): ReconciliationAction[] {
  const now = options.now ?? new Date();
  const actions: ReconciliationAction[] = [];
  for (const job of jobs) {
    switch (job.status) {
      case "submitting":
        actions.push({
          jobId: job.id,
          from: "submitting",
          to: "unknown",
          reason:
            "process exited mid-submission; provider acceptance is unverified, so this must not be auto-resubmitted",
          requiresHuman: true,
        });
        break;
      case "running":
      case "downloading":
        actions.push({
          jobId: job.id,
          from: job.status,
          to: job.status,
          reason: "resume polling with the stored provider job id",
          requiresHuman: false,
        });
        break;
      case "validating":
        actions.push({
          jobId: job.id,
          from: "validating",
          to: "queued",
          reason: "validation never completed; safe to re-validate because nothing was submitted",
          requiresHuman: false,
        });
        break;
      case "queued":
        break;
      case "unknown":
        if (job.providerJobId) {
          actions.push({
            jobId: job.id,
            from: "unknown",
            to: "unknown",
            reason: "provider job id present; poll to resolve the unknown outcome",
            requiresHuman: false,
          });
        } else {
          actions.push({
            jobId: job.id,
            from: "unknown",
            to: "unknown",
            reason:
              "no provider job id recorded; needs manual reconciliation before any re-submission",
            requiresHuman: true,
          });
        }
        break;
      default:
        break;
    }
  }
  // `now` participates so callers can assert time-dependent decisions in tests.
  void now;
  return actions;
}

/** Jobs whose next poll is due, oldest first. */
export function jobsDueForPoll(jobs: readonly GenerationJob[], now = new Date()): GenerationJob[] {
  const nowMs = now.getTime();
  return jobs
    .filter((job) => isPollable(job.status))
    .filter((job) => job.nextPollAt === null || Date.parse(job.nextPollAt) <= nowMs)
    .sort((a, b) => {
      const aDue = a.nextPollAt ? Date.parse(a.nextPollAt) : 0;
      const bDue = b.nextPollAt ? Date.parse(b.nextPollAt) : 0;
      return aDue - bDue || a.createdAt.localeCompare(b.createdAt);
    });
}

/** How many jobs of a provider/model may be in flight at once (capability `maxConcurrency`). */
export function countInFlight(
  jobs: readonly GenerationJob[],
  providerId: string,
  modelId?: string,
): number {
  return jobs.filter(
    (job) =>
      job.providerId === providerId &&
      (modelId === undefined || job.modelId === modelId) &&
      (job.status === "submitting" || job.status === "running" || job.status === "downloading"),
  ).length;
}

export interface PollSchedule {
  readonly nextPollAt: string;
  readonly delayMs: number;
}

/** Schedule the next poll for a still-running provider job. */
export function scheduleNextPoll(input: {
  attempt: number;
  now?: Date;
  baseMs?: number;
  capMs?: number;
  retryAfterSeconds?: number;
  random?: () => number;
}): PollSchedule {
  const now = input.now ?? new Date();
  const delayMs = nextBackoffDelay({
    attempt: input.attempt,
    baseMs: input.baseMs ?? 2_000,
    capMs: input.capMs ?? 60_000,
    retryAfterSeconds: input.retryAfterSeconds,
    random: input.random,
    jitter: "equal",
  });
  return { nextPollAt: new Date(now.getTime() + delayMs).toISOString(), delayMs };
}
