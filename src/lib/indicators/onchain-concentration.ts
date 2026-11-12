import type { IndicatorReading, TechnicalIndicator } from "../../types/technical-indicators.ts";

/**
 * DEX Screener on-chain concentration indicators: Herfindahl-Hirschman Index
 * across a token's pools and across the DEXes those pools trade on. These are
 * cross-sectional (computed from the latest DEX Screener pool snapshot), not the
 * daily-series pipeline in build.ts/catalog.ts/series.ts — DEX Screener pool data has
 * exactly one collected snapshot today, not an accumulated history, so no
 * trend/momentum/moving-average indicator can be computed from it yet. Both
 * indicators below return `null` (and are simply omitted, like every other
 * indicator with insufficient input) when there is no eligible liquidity.
 */

export type ConcentrationPool = { pairAddress: string; dexId: string | null; liquidityUsd: number | null };

/** Standard HHI concentration bands (0–1 scale; the widely used 0–10,000 scale divided by 10,000). */
const DIVERSIFIED_MAX = 0.15;
const MODERATE_MAX = 0.25;

function concentrationState(hhi: number): string {
  if (hhi < DIVERSIFIED_MAX) return "Diversified";
  if (hhi < MODERATE_MAX) return "Moderately concentrated";
  return "Highly concentrated";
}

function herfindahl(values: number[], total: number): number {
  return values.reduce((sum, value) => sum + (value / total) ** 2, 0);
}

function readings(hhi: number): IndicatorReading[] {
  return [
    { label: "HHI", value: hhi, unit: "ratio" },
    { label: "Concentration", value: hhi * 100, unit: "percent" },
  ];
}

type Provenance = { collectedAt: string | null; calculatedAt: string };

function buildIndicator(
  id: string,
  name: string,
  summary: string,
  description: string,
  formula: string,
  groupNoun: string,
  liquidities: number[],
  provenance: Provenance,
): TechnicalIndicator | null {
  if (liquidities.length === 0) return null;
  const total = liquidities.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return null;
  const hhi = herfindahl(liquidities, total);
  if (!Number.isFinite(hhi)) return null;
  const snapshotAt = provenance.collectedAt ?? provenance.calculatedAt;
  return {
    id,
    name,
    category: "on_chain",
    available: true,
    parameters: {},
    periodLabel: `${liquidities.length} ${groupNoun}${liquidities.length === 1 ? "" : "s"} with valid liquidity`,
    summary,
    description,
    formula,
    readings: readings(hhi),
    state: concentrationState(hhi),
    provenance: {
      providers: ["dexscreener"],
      // Not a daily-series input (see IndicatorInput); this reads pool-level DEX Screener data instead.
      inputs: [],
      // Not token_metric_observations rows; this is a single pool-level snapshot (see observationStart/End).
      sourceObservationIds: [],
      observationCount: liquidities.length,
      observationStart: snapshotAt,
      observationEnd: snapshotAt,
      calculatedAt: provenance.calculatedAt,
    },
  };
}

/** Distinct pools with valid, strictly positive liquidity only; a duplicate pool address keeps one value (no double-counting). */
function eligiblePools(pools: ConcentrationPool[]): { pairAddress: string; dexId: string | null; liquidityUsd: number }[] {
  const byAddress = new Map<string, { pairAddress: string; dexId: string | null; liquidityUsd: number }>();
  for (const pool of pools) {
    if (pool.liquidityUsd === null || !Number.isFinite(pool.liquidityUsd) || pool.liquidityUsd <= 0) continue;
    const key = pool.pairAddress.trim().toLowerCase();
    if (!key) continue;
    byAddress.set(key, { pairAddress: key, dexId: pool.dexId, liquidityUsd: pool.liquidityUsd });
  }
  return [...byAddress.values()];
}

/**
 * Pool Concentration (HHI): Σ(pool_liquidity_i / total_liquidity)² over pools
 * with valid positive liquidity.
 *
 * DEX Concentration (HHI): the same formula over each DEX's aggregate
 * liquidity (every eligible pool's liquidity summed by `dexId` first). A pool
 * with no reported `dexId` cannot be attributed to an exchange and is
 * excluded from this second calculation's total (it still counts for pool
 * concentration).
 */
export function buildConcentrationIndicators(pools: ConcentrationPool[], provenance: Provenance): TechnicalIndicator[] {
  const eligible = eligiblePools(pools);
  const poolLiquidities = eligible.map((pool) => pool.liquidityUsd);

  const byDex = new Map<string, number>();
  for (const pool of eligible) {
    const dexKey = pool.dexId?.trim().toLowerCase();
    if (!dexKey) continue;
    byDex.set(dexKey, (byDex.get(dexKey) ?? 0) + pool.liquidityUsd);
  }
  const dexLiquidities = [...byDex.values()];

  const indicators = [
    buildIndicator(
      "pool_concentration_hhi",
      "Pool Concentration (HHI)",
      "Share of on-chain liquidity concentrated in the most dominant pool(s).",
      "Herfindahl-Hirschman Index of this token's on-chain liquidity across its individual DEX Screener-indexed pools. Higher values mean liquidity sits in fewer pools; lower values mean it is spread across many.",
      "HHI = Σ(pool_liquidity_i / total_liquidity)², over pools with valid positive liquidity in the latest DEX Screener pool snapshot.",
      "pool",
      poolLiquidities,
      provenance,
    ),
    buildIndicator(
      "dex_concentration_hhi",
      "DEX Concentration (HHI)",
      "Share of on-chain liquidity concentrated on the most dominant exchange(s).",
      "Herfindahl-Hirschman Index of this token's on-chain liquidity across the decentralized exchanges hosting its DEX Screener-indexed pools, after summing every valid pool's liquidity by exchange. Higher values mean liquidity depends on fewer exchanges.",
      "HHI = Σ(dex_liquidity_i / total_liquidity)², where dex_liquidity_i sums valid pool liquidity for exchange i in the latest DEX Screener pool snapshot.",
      "exchange",
      dexLiquidities,
      provenance,
    ),
  ];
  return indicators.filter((indicator): indicator is TechnicalIndicator => indicator !== null);
}
