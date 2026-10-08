/**
 * Budget evaluation for the renderer.
 *
 * These are **re-exports of `@creativelab/core`**, not copies. They were previously mirrored
 * here because core values could not be imported into the webview bundle (see
 * `state/coreOps.ts` for the full history); that root cause is fixed, so the renderer now
 * evaluates budgets with the exact function the host uses.
 *
 * This matters more here than anywhere else: it is the last gate before money is spent
 * (PRD §13), and a subtly different copy could allow a job the host would refuse.
 */
export {
  DEFAULT_BUDGET_POLICY,
  assertBudget,
  evaluateBudget,
  formatMoney,
  normalizeCost,
} from "@creativelab/core";

export type { BudgetDecision, BudgetPolicy } from "@creativelab/core";
