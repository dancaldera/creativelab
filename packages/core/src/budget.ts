/**
 * Cost controls.
 *
 * PRD §13: "Cost caps per job, daily budget ceiling, cost estimate/unknown pricing
 * warning, and explicit approval above threshold."
 *
 * The studio is BYOK (PRD §19), so a runaway loop spends the user's own money. These
 * checks run *before* a paid submission and are the last gate in the pipeline.
 */
import type { Spend } from "./schema.js";
import { BudgetExceededError } from "./errors.js";

export interface BudgetPolicy {
  /** Hard cap for any single generation job, in `currency`. `null` disables the cap. */
  readonly maxCostPerJob: number | null;
  /** Rolling per-day ceiling across all providers. `null` disables the ceiling. */
  readonly dailyCeiling: number | null;
  /** Amount above which the UI must ask for explicit confirmation. */
  readonly requireApprovalAbove: number | null;
  readonly currency: string;
  /** When true, a job whose price the provider cannot quote is refused outright. */
  readonly blockUnknownPricing: boolean;
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
  maxCostPerJob: 5,
  dailyCeiling: 25,
  requireApprovalAbove: 1,
  currency: "USD",
  blockUnknownPricing: false,
};

export interface BudgetLedgerEntry {
  readonly amount: number;
  readonly currency: string;
  readonly day: string;
  readonly kind: "estimate" | "actual";
}

export type BudgetDecision =
  | {
      readonly allowed: true;
      readonly requiresApproval: boolean;
      readonly projectedDailyTotal: number;
      readonly reason: string;
    }
  | {
      readonly allowed: false;
      readonly requiresApproval: false;
      readonly projectedDailyTotal: number;
      readonly reason: string;
      readonly code: "unknown_pricing" | "per_job_cap" | "daily_ceiling" | "currency_mismatch";
    };

/** Money is compared at 6 decimal places; providers quote fractions of a cent. */
export function roundMoney(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function addMoney(...values: readonly number[]): number {
  return roundMoney(values.reduce((total, value) => total + value, 0));
}

/** Local calendar day key, `YYYY-MM-DD`, for the spend ledger. */
export function dayKey(
  date: Date = new Date(),
  timezoneOffsetMinutes = -date.getTimezoneOffset(),
): string {
  const shifted = new Date(date.getTime() + timezoneOffsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

export function spendOn(
  entries: readonly BudgetLedgerEntry[],
  day: string,
  currency = "USD",
): number {
  return addMoney(
    ...entries
      .filter((entry) => entry.day === day && entry.currency === currency)
      .map((entry) => entry.amount),
  );
}

/**
 * Decide whether a job may be submitted.
 *
 * `estimate` is `null` when the provider publishes no machine-readable price. That is a
 * first-class case, not an error: we warn, and only block if the user asked us to.
 */
export function evaluateBudget(
  policy: BudgetPolicy,
  estimate: Spend | null,
  todaySpend: number,
  today = dayKey(),
): BudgetDecision {
  void today;

  if (estimate === null) {
    if (policy.blockUnknownPricing) {
      return {
        allowed: false,
        requiresApproval: false,
        projectedDailyTotal: todaySpend,
        code: "unknown_pricing",
        reason:
          "This model does not publish machine-readable pricing and unknown-pricing jobs are blocked.",
      };
    }
    return {
      allowed: true,
      requiresApproval: true,
      projectedDailyTotal: todaySpend,
      reason:
        "Pricing is unavailable for this model; confirm the cost with your provider before submitting.",
    };
  }

  if (estimate.currency !== policy.currency) {
    return {
      allowed: false,
      requiresApproval: false,
      projectedDailyTotal: todaySpend,
      code: "currency_mismatch",
      reason: `Estimate is in ${estimate.currency} but the budget is set in ${policy.currency}.`,
    };
  }

  const amount = roundMoney(estimate.amount);
  const projectedDailyTotal = addMoney(todaySpend, amount);

  if (policy.maxCostPerJob !== null && amount > policy.maxCostPerJob) {
    return {
      allowed: false,
      requiresApproval: false,
      projectedDailyTotal,
      code: "per_job_cap",
      reason: `Estimated ${formatMoney({ amount, currency: estimate.currency })} exceeds the per-job cap of ${formatMoney(
        { amount: policy.maxCostPerJob, currency: policy.currency },
      )}.`,
    };
  }

  if (policy.dailyCeiling !== null && projectedDailyTotal > policy.dailyCeiling) {
    return {
      allowed: false,
      requiresApproval: false,
      projectedDailyTotal,
      code: "daily_ceiling",
      reason: `This job would bring today's spend to ${formatMoney({
        amount: projectedDailyTotal,
        currency: policy.currency,
      })}, above the daily ceiling of ${formatMoney({
        amount: policy.dailyCeiling,
        currency: policy.currency,
      })}.`,
    };
  }

  const requiresApproval =
    policy.requireApprovalAbove !== null && amount >= policy.requireApprovalAbove && amount > 0;

  return {
    allowed: true,
    requiresApproval,
    projectedDailyTotal,
    reason: requiresApproval
      ? `Estimated ${formatMoney({ amount, currency: estimate.currency })} requires explicit approval.`
      : "Within budget.",
  };
}

/** Throwing variant for code paths that must not proceed on a blocked budget. */
export function assertBudget(
  policy: BudgetPolicy,
  estimate: Spend | null,
  todaySpend: number,
  approved = false,
): BudgetDecision {
  const decision = evaluateBudget(policy, estimate, todaySpend);
  if (!decision.allowed) {
    throw new BudgetExceededError(decision.reason, { code: decision.code, estimate, todaySpend });
  }
  if (decision.requiresApproval && !approved) {
    throw new BudgetExceededError(decision.reason, {
      code: "approval_required",
      estimate,
      todaySpend,
    });
  }
  return decision;
}

export function formatMoney(spend: { amount: number; currency: string }): string {
  const amount = roundMoney(spend.amount);
  const symbols: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };
  const symbol = symbols[spend.currency] ?? "";
  const formatted = amount < 1 ? amount.toFixed(4) : amount.toFixed(2);
  return symbol ? `${symbol}${formatted}` : `${formatted} ${spend.currency}`;
}

/**
 * Normalize the many shapes providers use for cost into a single `Spend`.
 * Returns `null` when nothing usable is present — never a fabricated zero, because a
 * fabricated zero would silently defeat every cap above.
 */
export function normalizeCost(raw: unknown, currency = "USD"): Spend | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? { amount: roundMoney(raw), currency, isEstimate: false } : null;
  }
  if (typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const amount = record["amount"] ?? record["total"] ?? record["value"] ?? record["cost"];
    const cur = typeof record["currency"] === "string" ? record["currency"] : currency;
    if (typeof amount === "number" && Number.isFinite(amount)) {
      return { amount: roundMoney(amount), currency: cur.toUpperCase(), isEstimate: false };
    }
    if (typeof amount === "string") {
      const parsed = Number.parseFloat(amount);
      if (Number.isFinite(parsed)) {
        return { amount: roundMoney(parsed), currency: cur.toUpperCase(), isEstimate: false };
      }
    }
  }
  return null;
}
