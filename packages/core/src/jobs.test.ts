import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  claimSubmission,
  countInFlight,
  decideRetry,
  DEFAULT_RETRY_POLICY,
  isPollable,
  isTerminal,
  JOB_TRANSITIONS,
  JobTransitionError,
  jobsDueForPoll,
  nextBackoffDelay,
  reconcileAfterRestart,
  scheduleNextPoll,
} from "../src/jobs.js";
import {
  GenerationJobSchema,
  JOB_STATUSES,
  type GenerationJob,
  type JobStatus,
} from "../src/schema.js";

const NOW = "2026-01-01T00:00:00.000Z";

function makeJob(overrides: Partial<GenerationJob> = {}): GenerationJob {
  return GenerationJobSchema.parse({
    id: "job_aaaa000000000000000001",
    projectId: "prj_test000000000000000001",
    providerId: "mock",
    modelId: "mock-video",
    mode: "text-to-video",
    modality: "video",
    status: "queued",
    request: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

describe("job state machine (PRD §12)", () => {
  it("declares a transition list for every status", () => {
    for (const status of JOB_STATUSES) {
      expect(JOB_TRANSITIONS[status]).toBeDefined();
      expect(Array.isArray(JOB_TRANSITIONS[status])).toBe(true);
    }
  });

  it("allows the documented happy path", () => {
    expect(canTransition("queued", "validating")).toBe(true);
    expect(canTransition("validating", "submitting")).toBe(true);
    expect(canTransition("submitting", "running")).toBe(true);
    expect(canTransition("running", "downloading")).toBe(true);
    expect(canTransition("downloading", "completed")).toBe(true);
    expect(() => assertTransition("queued", "validating")).not.toThrow();
  });

  it("refuses illegal transitions rather than silently corrupting job state", () => {
    expect(canTransition("completed", "running")).toBe(false);
    expect(canTransition("canceled", "queued")).toBe(false);
    expect(canTransition("queued", "completed")).toBe(false);
    expect(canTransition("downloading", "validating")).toBe(false);
    expect(() => assertTransition("completed", "running")).toThrow(JobTransitionError);
  });

  it("allows a failed job to be retried, and a mid-flight job to become unknown", () => {
    expect(canTransition("failed", "queued")).toBe(true);
    expect(canTransition("submitting", "unknown")).toBe(true);
    expect(canTransition("running", "unknown")).toBe(true);
    expect(canTransition("unknown", "failed")).toBe(true);
  });

  it("identifies terminal and pollable statuses", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("canceled")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("unknown")).toBe(false);
    expect(isPollable("running")).toBe(true);
    expect(isPollable("downloading")).toBe(true);
    expect(isPollable("unknown")).toBe(true);
    expect(isPollable("queued")).toBe(false);
    expect(isPollable("completed")).toBe(false);
  });
});

describe("nextBackoffDelay (PRD §12: exponential backoff with jitter)", () => {
  it("grows exponentially when jitter is disabled", () => {
    const delays = [0, 1, 2, 3, 4].map((attempt) =>
      nextBackoffDelay({ attempt, baseMs: 1_000, capMs: 60_000, jitter: "none" }),
    );
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  it("clamps to the cap and never overflows for large attempt counts", () => {
    expect(nextBackoffDelay({ attempt: 10, baseMs: 1_000, capMs: 60_000, jitter: "none" })).toBe(
      60_000,
    );
    // 2**1000 would be Infinity; the implementation must cap before that matters.
    expect(nextBackoffDelay({ attempt: 1_000, baseMs: 1_000, capMs: 60_000, jitter: "none" })).toBe(
      60_000,
    );
    expect(
      Number.isFinite(nextBackoffDelay({ attempt: 1_000, baseMs: 1_000, capMs: 60_000 })),
    ).toBe(true);
  });

  it("spreads retries with full jitter", () => {
    const low = nextBackoffDelay({
      attempt: 3,
      baseMs: 1_000,
      capMs: 60_000,
      jitter: "full",
      random: () => 0,
    });
    const mid = nextBackoffDelay({
      attempt: 3,
      baseMs: 1_000,
      capMs: 60_000,
      jitter: "full",
      random: () => 0.5,
    });
    const high = nextBackoffDelay({
      attempt: 3,
      baseMs: 1_000,
      capMs: 60_000,
      jitter: "full",
      random: () => 0.999,
    });
    expect(low).toBe(1); // clamped away from 0 so the scheduler cannot hot-loop
    expect(mid).toBe(4_000);
    expect(high).toBeLessThanOrEqual(8_000);
    expect(high).toBeGreaterThan(mid);
  });

  it("never shortens a provider Retry-After, even with unlucky jitter", () => {
    const delay = nextBackoffDelay({
      attempt: 0,
      baseMs: 1_000,
      capMs: 60_000,
      jitter: "full",
      random: () => 0,
      retryAfterSeconds: 30,
    });
    expect(delay).toBe(30_000);
  });

  it("always returns a positive integer", () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const delay = nextBackoffDelay({ attempt, random: () => 0 });
      expect(Number.isInteger(delay)).toBe(true);
      expect(delay).toBeGreaterThan(0);
    }
  });
});

describe("decideRetry (PRD §12: bounded retries, no uncertain resubmission)", () => {
  it("retries a retryable failure while budget remains", () => {
    const decision = decideRetry({
      job: { retryCount: 0, status: "running" },
      error: { retryable: true },
      policy: { maxRetries: 3, baseMs: 1_000, capMs: 60_000 },
      random: () => 0.5,
    });
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBeGreaterThan(0);
  });

  it("stops once the retry budget is exhausted", () => {
    const decision = decideRetry({
      job: { retryCount: DEFAULT_RETRY_POLICY.maxRetries, status: "running" },
      error: { retryable: true },
    });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toMatch(/budget exhausted/i);
  });

  it("never auto-retries a non-retryable error", () => {
    expect(
      decideRetry({ job: { retryCount: 0, status: "running" }, error: { retryable: false } }).retry,
    ).toBe(false);
  });

  it("refuses to retry when the submission outcome is uncertain", () => {
    const decision = decideRetry({
      job: { retryCount: 0, status: "submitting" },
      error: { retryable: true, uncertain: true },
    });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toMatch(/unknown/i);
    expect(decision.reason).toMatch(/reconcil/i);
  });

  it("refuses to retry a canceled job", () => {
    expect(
      decideRetry({ job: { retryCount: 0, status: "canceled" }, error: { retryable: true } }).retry,
    ).toBe(false);
  });

  it("honours Retry-After through the delay calculation", () => {
    const decision = decideRetry({
      job: { retryCount: 1, status: "running" },
      error: { retryable: true, retryAfterSeconds: 12 },
      policy: { maxRetries: 3, baseMs: 100, capMs: 1_000 },
      random: () => 0,
    });
    expect(decision.delayMs).toBe(12_000);
  });
});

describe("claimSubmission (PRD §12: local submission lock)", () => {
  it("grants the lock to an unclaimed job", () => {
    const claim = claimSubmission(makeJob(), new Date(NOW));
    expect(claim).toBeDefined();
    expect(claim!.jobId).toBe("job_aaaa000000000000000001");
    expect(claim!.lockId).toContain(NOW);
  });

  it("refuses a second concurrent claim, which is how a double-click avoids a double charge", () => {
    const now = new Date(NOW);
    const first = claimSubmission(makeJob(), now)!;
    const job = makeJob({ status: "submitting", submissionLock: first.lockId });
    expect(claimSubmission(job, new Date(now.getTime() + 1_000))).toBeUndefined();
  });

  it("reclaims a lock that has outlived its TTL", () => {
    const now = new Date(NOW);
    const first = claimSubmission(makeJob(), now)!;
    const job = makeJob({ status: "submitting", submissionLock: first.lockId });
    const later = new Date(now.getTime() + 10 * 60_000);
    expect(claimSubmission(job, later, 5 * 60_000)).toBeDefined();
  });

  it("treats an unparseable lock as live rather than risking a duplicate charge", () => {
    const job = makeJob({ status: "submitting", submissionLock: "not-a-timestamp" });
    expect(claimSubmission(job, new Date(NOW))).toBeUndefined();
  });

  it("keeps the timestamp readable by using a delimiter that cannot appear in ISO-8601", () => {
    const claim = claimSubmission(makeJob(), new Date(NOW))!;
    expect(claim.lockId.split("|")[0]).toBe(NOW);
    expect(Number.isFinite(Date.parse(claim.lockId.split("|")[0]!))).toBe(true);
  });

  it("refuses to claim a job that already has provider-side state or is finished", () => {
    for (const status of ["running", "downloading", "completed"] as const) {
      expect(claimSubmission(makeJob({ status }), new Date(NOW))).toBeUndefined();
    }
  });
});

describe("reconcileAfterRestart (PRD §12: uncertain submissions must not auto-resubmit)", () => {
  it("parks a mid-submission job in unknown and flags it for a human", () => {
    const actions = reconcileAfterRestart([
      makeJob({ status: "submitting", idempotencyKey: "idem_1" }),
    ]);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ from: "submitting", to: "unknown", requiresHuman: true });
    expect(actions[0]!.reason).toMatch(/must not be auto-resubmitted/i);
  });

  it("resumes polling for running and downloading jobs", () => {
    const actions = reconcileAfterRestart([
      makeJob({ id: "job_bbbb000000000000000001", status: "running", providerJobId: "p-1" }),
      makeJob({ id: "job_bbbb000000000000000002", status: "downloading", providerJobId: "p-2" }),
    ]);
    expect(actions.every((action) => action.to === action.from)).toBe(true);
    expect(actions.every((action) => action.requiresHuman === false)).toBe(true);
    expect(actions.every((action) => /poll/i.test(action.reason))).toBe(true);
  });

  it("re-queues a job that never finished validating, because nothing was submitted", () => {
    const actions = reconcileAfterRestart([makeJob({ status: "validating" })]);
    expect(actions[0]).toMatchObject({ from: "validating", to: "queued", requiresHuman: false });
  });

  it("polls an unknown job that has a provider id, and escalates one that does not", () => {
    const withId = reconcileAfterRestart([
      makeJob({ id: "job_cccc000000000000000001", status: "unknown", providerJobId: "p-9" }),
    ]);
    expect(withId[0]).toMatchObject({ requiresHuman: false });

    const withoutId = reconcileAfterRestart([
      makeJob({ id: "job_cccc000000000000000002", status: "unknown" }),
    ]);
    expect(withoutId[0]).toMatchObject({ requiresHuman: true });
    expect(withoutId[0]!.reason).toMatch(/manual reconciliation/i);
  });

  it("ignores terminal jobs and queued jobs that have not started", () => {
    const actions = reconcileAfterRestart([
      makeJob({ id: "job_dddd000000000000000001", status: "completed" }),
      makeJob({ id: "job_dddd000000000000000002", status: "canceled" }),
      makeJob({ id: "job_dddd000000000000000003", status: "failed" }),
      makeJob({ id: "job_dddd000000000000000004", status: "queued" }),
    ]);
    expect(actions).toHaveLength(0);
  });

  it("never proposes moving a submitting job directly back to queued", () => {
    for (const status of ["submitting"] as const) {
      const actions = reconcileAfterRestart([makeJob({ status })]);
      expect(actions.every((action) => action.to !== "queued")).toBe(true);
    }
  });
});

describe("poll scheduling (PRD §12)", () => {
  it("returns only pollable jobs whose poll time has arrived, oldest first", () => {
    const jobs = [
      makeJob({
        id: "job_eeee000000000000000001",
        status: "running",
        nextPollAt: "2026-01-01T00:00:05.000Z",
      }),
      makeJob({
        id: "job_eeee000000000000000002",
        status: "running",
        nextPollAt: "2026-01-01T00:00:01.000Z",
      }),
      makeJob({ id: "job_eeee000000000000000003", status: "queued" }),
      makeJob({ id: "job_eeee000000000000000004", status: "completed" }),
      makeJob({ id: "job_eeee000000000000000005", status: "running", nextPollAt: null }),
    ];
    const due = jobsDueForPoll(jobs, new Date("2026-01-01T00:00:02.000Z"));
    expect(due.map((job) => job.id)).toEqual([
      "job_eeee000000000000000005", // null nextPollAt sorts first (due immediately)
      "job_eeee000000000000000002",
    ]);
  });

  it("computes the next poll time in the future", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const schedule = scheduleNextPoll({
      attempt: 2,
      now,
      baseMs: 1_000,
      capMs: 60_000,
      random: () => 0,
    });
    expect(schedule.delayMs).toBeGreaterThan(0);
    expect(Date.parse(schedule.nextPollAt)).toBe(now.getTime() + schedule.delayMs);
  });

  it("counts in-flight jobs per provider and model for the concurrency cap", () => {
    const jobs = [
      makeJob({
        id: "job_ffff000000000000000001",
        status: "running",
        providerId: "a",
        modelId: "m1",
      }),
      makeJob({
        id: "job_ffff000000000000000002",
        status: "downloading",
        providerId: "a",
        modelId: "m1",
      }),
      makeJob({
        id: "job_ffff000000000000000003",
        status: "submitting",
        providerId: "a",
        modelId: "m2",
      }),
      makeJob({
        id: "job_ffff000000000000000004",
        status: "running",
        providerId: "b",
        modelId: "m1",
      }),
      makeJob({
        id: "job_ffff000000000000000005",
        status: "completed",
        providerId: "a",
        modelId: "m1",
      }),
    ];
    expect(countInFlight(jobs, "a")).toBe(3);
    expect(countInFlight(jobs, "a", "m1")).toBe(2);
    expect(countInFlight(jobs, "b")).toBe(1);
    expect(countInFlight(jobs, "c")).toBe(0);
  });
});

describe("status coverage", () => {
  it("covers exactly the nine statuses the PRD enumerates", () => {
    const expected: JobStatus[] = [
      "queued",
      "validating",
      "submitting",
      "running",
      "downloading",
      "completed",
      "failed",
      "canceled",
      "unknown",
    ];
    expect([...JOB_STATUSES]).toEqual(expected);
  });
});
