/**
 * Plausibility bounds for DexPaprika figures. A value outside them is treated as unavailable (never clamped, never
 * zeroed), so one bad provider number (for example a $43 trillion liquidity figure seen for one token) cannot reach
 * the profile, the metrics engine or the AI analysis. The bounds are deliberately wide: they only catch values that
 * are impossible, not merely large.
 */
/** More than all DeFi value locked, several times over: no single token's on-chain liquidity or daily volume reaches it. */
export const MAX_PLAUSIBLE_USD = 1e12;
const MAX_PLAUSIBLE_COUNT = 1e9;
const MAX_PLAUSIBLE_POOL_COUNT = 1e7;
const MAX_PLAUSIBLE_PRICE = 1e9;
/** A price cannot fall below -100%; very large gains are possible on thin pools, but not beyond this. */
const MAX_PLAUSIBLE_CHANGE_PCT = 1e5;

export type DexValueKind = "usd" | "count" | "pool_count" | "price" | "change_pct";

export function dexValueKind(metricId: string): DexValueKind {
  if (metricId === "dex_pool_count") return "pool_count";
  if (metricId.endsWith("_count")) return "count";
  if (metricId.includes("price_change")) return "change_pct";
  if (metricId.includes("price_high") || metricId.includes("price_low")) return "price";
  return "usd";
}

export function isPlausibleDexValue(kind: DexValueKind, value: number | null | undefined): boolean {
  if (value === null || value === undefined || !Number.isFinite(value)) return false;
  switch (kind) {
    case "usd": return value >= 0 && value <= MAX_PLAUSIBLE_USD;
    case "count": return value >= 0 && value <= MAX_PLAUSIBLE_COUNT;
    case "pool_count": return value >= 0 && value <= MAX_PLAUSIBLE_POOL_COUNT;
    case "price": return value > 0 && value <= MAX_PLAUSIBLE_PRICE;
    case "change_pct": return value >= -100 && value <= MAX_PLAUSIBLE_CHANGE_PCT;
  }
}

/** The value when plausible, otherwise null. */
export function plausibleDexValue(kind: DexValueKind, value: number | null | undefined): number | null {
  return isPlausibleDexValue(kind, value) ? (value as number) : null;
}
