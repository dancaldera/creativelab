/**
 * Job queue state (PRD §12, FR-10).
 *
 * The store holds the *last known* queue plus the reconciliation queue that needs a human
 * decision. TanStack Query owns the polling cadence (`hooks/queries.ts`) and pushes each
 * result in through `syncJobs`, so the store never owns a timer and React never polls in a
 * `useEffect` of its own.
 */
import { create } from "zustand";
import type { JobDto } from "../bridge/protocol";

export interface UnknownJobNotice {
  jobId: string;
  reason: string;
}

export interface CostLedgerEntry {
  jobId: string;
  amount: number;
  currency: string;
  day: string;
  kind: "estimate" | "actual";
}

export interface JobsState {
  jobs: JobDto[];
  /** Jobs parked in `unknown` that a human must resolve (never auto-resubmitted). */
  needsAttention: UnknownJobNotice[];
  /** Jobs whose polling was safely resumed after a restart. */
  resumed: string[];
  loading: boolean;
  syncing: boolean;
  lastSyncedAt: string | null;
  error: string | null;
  statusFilter: string[];
  /** Rolling ledger of what this session has been told jobs cost. */
  ledger: CostLedgerEntry[];

  syncJobs: (jobs: JobDto[]) => void;
  syncReconcile: (needsAttention: UnknownJobNotice[], resumed: string[]) => void;
  setLoading: (loading: boolean) => void;
  setSyncing: (syncing: boolean) => void;
  setError: (message: string | null) => void;
  setStatusFilter: (statuses: string[]) => void;
  upsertJob: (job: JobDto) => void;
  removeJob: (jobId: string) => void;
  resolveAttention: (jobId: string) => void;
  recordCost: (entry: CostLedgerEntry) => void;
  /** Today's spend in the policy currency, in the sense of core's `spendOn`. */
  spendToday: (currency?: string, day?: string) => number;
  clear: () => void;
}

function todayKey(date = new Date()): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function roundMoney(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function sameJobs(a: readonly JobDto[], b: readonly JobDto[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.id !== right.id ||
      left.status !== right.status ||
      left.progress !== right.progress ||
      left.updatedAt !== right.updatedAt ||
      left.retryCount !== right.retryCount ||
      left.outputAssetIds.length !== right.outputAssetIds.length
    ) {
      return false;
    }
  }
  return true;
}

const EMPTY_JOBS: JobDto[] = [];

export function createJobsStore() {
  return create<JobsState>((set, get) => ({
    jobs: EMPTY_JOBS,
    needsAttention: [],
    resumed: [],
    loading: false,
    syncing: false,
    lastSyncedAt: null,
    error: null,
    statusFilter: [],
    ledger: [],

    syncJobs: (incoming) => {
      // Identity-stable updates keep React from re-rendering on every poll tick.
      if (sameJobs(get().jobs, incoming)) {
        set({ lastSyncedAt: new Date().toISOString(), syncing: false });
        return;
      }
      set({ jobs: incoming, lastSyncedAt: new Date().toISOString(), syncing: false, error: null });
    },

    syncReconcile: (needsAttention, resumed) => set({ needsAttention, resumed }),

    setLoading: (loading) => set({ loading }),
    setSyncing: (syncing) => set({ syncing }),
    setError: (error) => set({ error, syncing: false }),
    setStatusFilter: (statusFilter) => set({ statusFilter }),

    upsertJob: (job) => {
      const jobs = get().jobs.filter((candidate) => candidate.id !== job.id);
      set({ jobs: [job, ...jobs] });
    },

    removeJob: (jobId) => set({ jobs: get().jobs.filter((job) => job.id !== jobId) }),

    resolveAttention: (jobId) =>
      set({ needsAttention: get().needsAttention.filter((entry) => entry.jobId !== jobId) }),

    recordCost: (entry) => {
      const ledger = [
        ...get().ledger.filter(
          (existing) => existing.jobId !== entry.jobId || existing.kind !== entry.kind,
        ),
        entry,
      ];
      set({ ledger });
    },

    spendToday: (currency = "USD", day = todayKey()) =>
      roundMoney(
        get()
          .ledger.filter((entry) => entry.day === day && entry.currency === currency)
          .reduce((total, entry) => total + entry.amount, 0),
      ),

    clear: () =>
      set({ jobs: EMPTY_JOBS, needsAttention: [], resumed: [], ledger: [], error: null }),
  }));
}

export const useJobsStore = createJobsStore();

/** Convenience selectors so components do not re-implement status buckets. */
export function selectActiveJobs(state: JobsState): JobDto[] {
  return state.jobs.filter((job) => !["completed", "canceled"].includes(job.status));
}

export function selectUnknownJobs(state: JobsState): JobDto[] {
  return state.jobs.filter((job) => job.status === "unknown");
}

export function selectRetryableJobs(state: JobsState): JobDto[] {
  return state.jobs.filter((job) => job.status === "failed" && job.retryCount < 4);
}

export { todayKey };
