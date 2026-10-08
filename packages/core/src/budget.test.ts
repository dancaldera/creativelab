import { describe, expect, it } from "vitest";
import {
  addMoney,
  assertBudget,
  DEFAULT_BUDGET_POLICY,
  dayKey,
  evaluateBudget,
  formatMoney,
  normalizeCost,
  roundMoney,
  spendOn,
  type BudgetLedgerEntry,
  type BudgetPolicy,
} from "../src/budget.js";
import { BudgetExceededError } from "../src/errors.js";
import type { Spend } from "../src/schema.js";

const policy: BudgetPolicy = {
  maxCostPerJob: 5,
  dailyCeiling: 25,
  requireApprovalAbove: 1,
  currency: "USD",
  blockUnknownPricing: false,
};

function spend(amount: number, currency = "USD"): Spend {
  return { amount, currency, isEstimate: true };
}

describe("evaluateBudget (PRD §13: caps, ceiling, approval, unknown pricing)", () => {
  it("allows a small job and does not demand approval below the threshold", () => {
    const decision = evaluateBudget(policy, spend(0.25), 0);
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.projectedDailyTotal).toBe(0.25);
  });

  it("requires explicit approval at or above the threshold", () => {
    const atThreshold = evaluateBudget(policy, spend(1), 0);
    expect(atThreshold.allowed).toBe(true);
    expect(atThreshold.requiresApproval).toBe(true);

    const above = evaluateBudget(policy, spend(2.5), 0);
    expect(above.allowed).toBe(true);
    expect(above.requiresApproval).toBe(true);
    expect(above.reason).toMatch(/approval/i);
  });

  it("blocks a job above the per-job cap", () => {
    const decision = evaluateBudget(policy, spend(9.99), 0);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe("per_job_cap");
    expect(decision.reason).toMatch(/\$5\.00/);
  });

  it("blocks a job that would breach the daily ceiling", () => {
    const decision = evaluateBudget(policy, spend(3), 23.5);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe("daily_ceiling");
    expect(decision.projectedDailyTotal).toBe(26.5);
  });

  it("allows a job that lands exactly on the ceiling", () => {
    const decision = evaluateBudget(policy, spend(5), 20);
    expect(decision.allowed).toBe(true);
    expect(decision.projectedDailyTotal).toBe(25);
  });

  it("blocks a currency mismatch instead of comparing unlike amounts", () => {
    const decision = evaluateBudget(policy, spend(1, "EUR"), 0);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe("currency_mismatch");
  });

  it("warns on unknown pricing and only blocks when the user asked it to", () => {
    const warn = evaluateBudget(policy, null, 0);
    expect(warn.allowed).toBe(true);
    expect(warn.requiresApproval).toBe(true);
    expect(warn.reason).toMatch(/pricing is unavailable/i);

    const strict = evaluateBudget({ ...policy, blockUnknownPricing: true }, null, 0);
    expect(strict.allowed).toBe(false);
    expect(strict.allowed === false && strict.code).toBe("unknown_pricing");
  });

  it("treats null caps and thresholds as disabled", () => {
    const loose: BudgetPolicy = {
      maxCostPerJob: null,
      dailyCeiling: null,
      requireApprovalAbove: null,
      currency: "USD",
      blockUnknownPricing: false,
    };
    const decision = evaluateBudget(loose, spend(10_000), 0);
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it("never demands approval for a free job", () => {
    expect(evaluateBudget(policy, spend(0), 0).requiresApproval).toBe(false);
  });

  it("is wired to a sane shipped default", () => {
    expect(DEFAULT_BUDGET_POLICY.currency).toBe("USD");
    expect(DEFAULT_BUDGET_POLICY.maxCostPerJob).toBeGreaterThan(0);
    expect(DEFAULT_BUDGET_POLICY.dailyCeiling).toBeGreaterThan(
      DEFAULT_BUDGET_POLICY.maxCostPerJob!,
    );
    expect(DEFAULT_BUDGET_POLICY.requireApprovalAbove).toBeLessThan(
      DEFAULT_BUDGET_POLICY.maxCostPerJob!,
    );
  });
});

describe("assertBudget", () => {
  it("passes a within-budget job", () => {
    expect(() => assertBudget(policy, spend(0.1), 0)).not.toThrow();
  });

  it("throws for a blocked job and carries the code for the UI", () => {
    expect(() => assertBudget(policy, spend(50), 0)).toThrow(BudgetExceededError);
    try {
      assertBudget(policy, spend(50), 0);
    } catch (error) {
      expect((error as BudgetExceededError).details["code"]).toBe("per_job_cap");
      expect(error).toBeInstanceOf(BudgetExceededError);
    }
  });

  it("requires the approval flag to be passed explicitly for an above-threshold job", () => {
    expect(() => assertBudget(policy, spend(2), 0)).toThrow(/approval/i);
    expect(() => assertBudget(policy, spend(2), 0, true)).not.toThrow();
  });

  it("cannot be bypassed by the approval flag when a hard cap is breached", () => {
    expect(() => assertBudget(policy, spend(500), 0, true)).toThrow(/per-job cap/i);
  });
});

describe("money helpers", () => {
  it("rounds to six decimal places so sub-cent provider quotes survive", () => {
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(0.0000004)).toBe(0);
    expect(roundMoney(0.0000005)).toBe(0.000001);
  });

  it("adds without accumulating float noise", () => {
    expect(addMoney(0.1, 0.2, 0.3)).toBe(0.6);
    expect(addMoney(...Array.from({ length: 10 }, () => 0.1))).toBe(1);
  });

  it("formats money with a symbol and sensible precision", () => {
    expect(formatMoney({ amount: 1.5, currency: "USD" })).toBe("$1.50");
    expect(formatMoney({ amount: 0.0125, currency: "USD" })).toBe("$0.0125");
    expect(formatMoney({ amount: 3, currency: "JPY" })).toBe("3.00 JPY");
  });
});

describe("dayKey and the spend ledger (PRD §13: daily budget ceiling)", () => {
  it("produces a local YYYY-MM-DD key", () => {
    expect(dayKey(new Date("2026-03-04T12:00:00Z"), 0)).toBe("2026-03-04");
    // A positive offset (east of UTC) can roll the local day forward.
    expect(dayKey(new Date("2026-03-04T23:30:00Z"), 120)).toBe("2026-03-05");
    // A negative offset (west of UTC) can roll it back.
    expect(dayKey(new Date("2026-03-04T02:00:00Z"), -480)).toBe("2026-03-03");
  });

  it("sums only the requested day and currency", () => {
    const entries: BudgetLedgerEntry[] = [
      { amount: 1.5, currency: "USD", day: "2026-03-04", kind: "actual" },
      { amount: 2.25, currency: "USD", day: "2026-03-04", kind: "estimate" },
      { amount: 9, currency: "USD", day: "2026-03-03", kind: "actual" },
      { amount: 4, currency: "EUR", day: "2026-03-04", kind: "actual" },
    ];
    expect(spendOn(entries, "2026-03-04")).toBe(3.75);
    expect(spendOn(entries, "2026-03-03")).toBe(9);
    expect(spendOn(entries, "2026-03-02")).toBe(0);
    expect(spendOn(entries, "2026-03-04", "EUR")).toBe(4);
  });
});

describe("normalizeCost", () => {
  it("accepts a bare number, a numeric string and the common object shapes", () => {
    expect(normalizeCost(1.25)).toMatchObject({ amount: 1.25, currency: "USD" });
    expect(normalizeCost({ amount: 0.04 })).toMatchObject({ amount: 0.04 });
    expect(normalizeCost({ total: 2 })).toMatchObject({ amount: 2 });
    expect(normalizeCost({ value: 3 })).toMatchObject({ amount: 3 });
    expect(normalizeCost({ cost: 4 })).toMatchObject({ amount: 4 });
    expect(normalizeCost({ amount: "0.75" })).toMatchObject({ amount: 0.75 });
  });

  it("normalizes the currency code to upper case and honours the fallback", () => {
    expect(normalizeCost({ amount: 1, currency: "eur" })).toMatchObject({ currency: "EUR" });
    expect(normalizeCost({ amount: 1 }, "gbp")).toMatchObject({ currency: "GBP" });
  });

  it("returns null for missing or unusable pricing instead of fabricating a zero", () => {
    // A fabricated 0 would silently defeat every cap in evaluateBudget.
    expect(normalizeCost(null)).toBeNull();
    expect(normalizeCost(undefined)).toBeNull();
    expect(normalizeCost({})).toBeNull();
    expect(normalizeCost({ amount: "free" })).toBeNull();
    expect(normalizeCost(Number.NaN)).toBeNull();
    expect(normalizeCost(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeCost({ amount: Number.POSITIVE_INFINITY })).toBeNull();
    expect(normalizeCost([])).toBeNull();
  });
});
