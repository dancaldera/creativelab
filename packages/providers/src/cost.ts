/**
 * Cost estimation from a published `pricing` block (PRD §8 "pricing units", PRD §13
 * "cost estimate / unknown pricing warning").
 *
 * The governing rule from core's `normalizeCost` is repeated here: **never fabricate a
 * zero**. When `pricing` is `null` the estimate is `null` and the budget layer turns that
 * into a confirmation prompt rather than a silent free job. The same applies to a
 * per-second price on a request whose duration is unknown: the total is genuinely unknown,
 * so it is reported as unknown.
 */
import { normalizeCost, roundMoney, type Spend } from "@creativelab/core";
import type { ModelCapabilities, Pricing } from "./capabilities.js";
import type { GenerationRequest } from "./requests.js";

/** Alias of the capability schema's unit enum; re-exported by `capabilities.ts`. */
type PricingUnit = Pricing["unit"];

/** How many billable units a request represents, per pricing unit. `null` = unknown. */
export interface BillableUnits {
  readonly images: number;
  readonly seconds: number | null;
  readonly characters: number;
  readonly requests: number;
}

/**
 * Derive billable unit counts from a request.
 *
 * `capabilities` is optional; when supplied, a per-second model with no requested duration
 * is priced at the model's maximum duration, which is the conservative reading (never
 * *under*-quote a paid job).
 */
export function billableUnits(
  request: GenerationRequest,
  capabilities?: ModelCapabilities | null,
): BillableUnits {
  const extra = (request.extra ?? {}) as Record<string, unknown>;
  const images = positiveInt(extra["images"]) ?? 1;
  const requests = positiveInt(extra["requests"]) ?? 1;
  const seconds =
    positiveNumber(extra["seconds"]) ??
    positiveNumber(request.durationSeconds) ??
    positiveNumber(extra["durationSeconds"]) ??
    (capabilities ? positiveNumber(capabilities.durationMaxSeconds ?? undefined) : undefined);
  const characters = positiveNumber(extra["characters"]) ?? request.prompt.length;
  return { images, seconds: seconds ?? null, characters, requests };
}

/** Pure unit math: `Pricing` + units -> `Spend`, or `null` when the total is unknown. */
export function costFromPricing(
  pricing: Pricing | null | undefined,
  units: BillableUnits,
): Spend | null {
  if (!pricing) return null;
  if (!Number.isFinite(pricing.amount) || pricing.amount < 0) return null;
  const multiplier = multiplierFor(pricing.unit, units);
  if (multiplier === null || !Number.isFinite(multiplier)) return null;
  const amount = roundMoney(pricing.amount * multiplier);
  return normalizeCost({ amount, currency: pricing.currency, isEstimate: true }) ?? null;
}

/**
 * Cost for a request, or `null` when the model publishes no machine-readable price (the
 * caller must then warn or block per the budget policy).
 */
export function estimateCostFromCapabilities(
  request: GenerationRequest,
  capabilities: ModelCapabilities | null | undefined,
): Spend | null {
  return costFromPricing(
    capabilities?.pricing ?? null,
    billableUnits(request, capabilities ?? null),
  );
}

function multiplierFor(unit: PricingUnit, units: BillableUnits): number | null {
  switch (unit) {
    case "per-image":
      return units.images;
    case "per-second":
      return units.seconds === null ? null : units.seconds;
    case "per-1k-chars":
      return units.characters / 1000;
    case "per-request":
      return units.requests;
    default:
      return null;
  }
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function positiveInt(value: unknown): number | undefined {
  const parsed = positiveNumber(value);
  return parsed === undefined ? undefined : Math.max(1, Math.trunc(parsed));
}
