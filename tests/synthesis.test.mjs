// Deterministic synthesis layer (engine/synthesis.ts) — Phase 1 of the research-report redesign.
// Covers: horizon classification, redundancy collapse, cross-category relationships, materiality,
// thin-data behavior, determinism, stable ordering, evidence preservation, and five realistic
// per-token fixtures (BTC/ETH/UNI/SUI/HYPE-shaped). No prose is asserted anywhere in this file —
// only the structured synthesis output (relationships/redundancyGroups/thesisDrivers).

import assert from "node:assert/strict";

import { getLiveTokenProfile } from "../src/lib/data/live-data.ts";
import { buildProfilePayload } from "../src/lib/analysis/profile-payload.ts";
import { CALCULATED_METRICS } from "../src/lib/metrics/engine.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

import { extractFindings } from "../src/lib/analysis/engine/findings.ts";
import {
  synthesize, classifyHorizon, collapseRedundant, materialityOf, findingId,
  MIN_DRIVER_MATERIALITY, MAX_THESIS_DRIVERS,
} from "../src/lib/analysis/engine/synthesis.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const NOW = new Date("2026-09-27T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();

// ---- Fixture builder (mirrors tests/deep-analysis-engine.test.mjs's own helper) ----

function seed(tokenId, chainId, rows, calculated = [], isNative = false) {
  let id = 1000;
  const obs = ([provider, metric, value, hoursAgo = 0.5, extra = {}]) => ({
    id: id++, token_id: tokenId, chain_id: chainId, provider_id: provider, metric_id: metric, value,
    status: value === null ? "unavailable" : "available", observed_at: at(hoursAgo), collected_at: at(hoursAgo), window_days: null, note: null, ...extra,
  });
  return {
    tokens: [{ id: tokenId, name: "Test Token", symbol: "TST", chain_id: chainId, contract_address: isNative ? null : "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", is_native: isNative, category: "DeFi", description: null }],
    chains: [{ id: chainId, name: chainId }],
    token_metric_observations: rows.map(obs),
    metric_definitions: [],
    calculated_metric_observations: calculated.map((row, index) => {
      const definition = CALCULATED_METRICS.find((metric) => metric.id === row.metric);
      return {
        id: 5000 + index, token_id: tokenId, chain_id: chainId, metric_id: row.metric, metric_name: definition.name, unit: definition.unit,
        value: row.value, status: "available", formula: definition.formula, calculated_at: at(0.4),
        period_start_at: row.start ?? null, period_end_at: row.end ?? null, provenance: {},
      };
    }),
    calculated_metric_definitions: CALCULATED_METRICS.map((metric) => ({ id: metric.id, category: metric.category, source_scopes: metric.sourceScopes })),
  };
}

async function payloadFor(tokenId, data) {
  const profile = await getLiveTokenProfile(tokenId, createFakeSupabase({ seed: data }).client);
  return buildProfilePayload(profile);
}

/** Every findingId/evidenceId a synthesis object cites is drawn from the real finding set it was built from. */
function assertEvidencePreserved(findings, result) {
  const knownFindingIds = new Set(findings.map(findingId));
  const knownEvidenceIds = new Set(findings.flatMap((f) => f.evidenceIds));
  const checkIds = (findingIds, evidenceIds, label) => {
    for (const id of findingIds) assert.ok(knownFindingIds.has(id), `${label}: findingId ${id} is not among the real findings`);
    for (const id of evidenceIds) assert.ok(knownEvidenceIds.has(id), `${label}: evidenceId ${id} is not among the real findings' evidence`);
  };
  for (const rel of result.relationships) checkIds(rel.findingIds, rel.evidenceIds, `relationship ${rel.id}`);
  for (const group of result.redundancyGroups) checkIds(group.findingIds, group.evidenceIds, `redundancy group ${group.id}`);
  for (const driver of result.thesisDrivers) checkIds(driver.findingIds, driver.evidenceIds, `thesis driver ${driver.id}`);
}

// =====================================================================================
// A. Horizon classification
// =====================================================================================

test("A1. a valuation ratio / structure / tokenomics-share finding classifies as snapshot", () => {
  assert.equal(classifyHorizon({ category: "valuation", findingType: "ratio_market_cap_to_tvl", severity: "low", evidenceIds: ["calc:market_cap_to_tvl"], observationPeriods: [null], data: {} }), "snapshot");
  assert.equal(classifyHorizon({ category: "valuation", findingType: "fdv_market_cap_gap", severity: "moderate", evidenceIds: ["obs:fdv"], observationPeriods: [null], data: {} }), "snapshot");
  assert.equal(classifyHorizon({ category: "tokenomics", findingType: "low_circulating_share", severity: "moderate", evidenceIds: ["calc:circulating_of_max_supply"], observationPeriods: [null], data: {} }), "snapshot");
  assert.equal(classifyHorizon({ category: "liquidityMarketStructure", findingType: "structure_dex_aggregate_liquidity_usd", severity: "low", evidenceIds: ["calc:dex_aggregate_liquidity_usd"], observationPeriods: [null], data: {} }), "snapshot");
});

test("A2. a multi-horizon finding spanning only 24h/7d classifies as short_term", () => {
  const finding = {
    category: "marketPerformance", findingType: "multi_horizon_consistent_up_steady", severity: "high",
    evidenceIds: ["hist:price_24h", "hist:price_7d"], observationPeriods: ["24H", "7D"], data: {},
    horizons: [{ key: "24h", days: 1, raw: 5, value: "+5.00%", period: "24H", id: "hist:price_24h" }, { key: "7d", days: 7, raw: 8, value: "+8.00%", period: "7D", id: "hist:price_7d" }],
  };
  assert.equal(classifyHorizon(finding), "short_term");
});

test("A3. a marketFundamentalRelationships divergence/comparison finding always classifies as short_term, regardless of magnitude", () => {
  const finding = { category: "marketFundamentalRelationships", findingType: "divergence_price_up_tvl_down", severity: "moderate", evidenceIds: ["calc:divergence_price_up_tvl_down"], observationPeriods: [null], data: {} };
  assert.equal(classifyHorizon(finding), "short_term", "the metrics engine's 'aligned interval' is not guaranteed to be long — could be minutes — so this must never be promoted");
});

test("A4. TVL/fees/revenue growth and the fundamentals synthesis findings classify as medium_term", () => {
  for (const findingType of ["tvl_growth_increase", "fees_growth_decrease", "revenue_growth_increase", "fundamentals_improving", "fundamentals_deteriorating", "fundamentals_mixed"]) {
    assert.equal(classifyHorizon({ category: "fundamentalPerformance", findingType, severity: "moderate", evidenceIds: ["calc:x"], observationPeriods: [null], data: {} }), "medium_term", findingType);
  }
});

test("A5. a multi-horizon finding whose longest horizon is 30d classifies as medium_term", () => {
  const finding = {
    category: "marketPerformance", findingType: "multi_horizon_consistent_up_steady", severity: "high",
    evidenceIds: ["hist:price_7d", "hist:price_30d"], observationPeriods: ["7D", "30D"], data: {},
    horizons: [{ key: "7d", days: 7, raw: 8, value: "+8.00%", period: "7D", id: "hist:price_7d" }, { key: "30d", days: 30, raw: 12, value: "+12.00%", period: "30D", id: "hist:price_30d" }],
  };
  assert.equal(classifyHorizon(finding), "medium_term");
});

test("A6. a multi-horizon finding whose longest horizon is 90d classifies as structural", () => {
  const finding = {
    category: "marketPerformance", findingType: "multi_horizon_consistent_up_accelerating", severity: "high",
    evidenceIds: ["hist:price_7d", "hist:price_30d", "hist:price_90d"], observationPeriods: ["7D", "30D", "90D"], data: {},
    horizons: [
      { key: "7d", days: 7, raw: 8, value: "+8.00%", period: "7D", id: "hist:price_7d" },
      { key: "30d", days: 30, raw: 12, value: "+12.00%", period: "30D", id: "hist:price_30d" },
      { key: "90d", days: 90, raw: 20, value: "+20.00%", period: "90D", id: "hist:price_90d" },
    ],
  };
  assert.equal(classifyHorizon(finding), "structural");
});

test("A7. risk history findings (elevated_volatility/sharp_drawdown) read their window directly from the hist:risk_{period} evidence ID", () => {
  const at = (evidenceId) => ({ category: "risk", findingType: "elevated_volatility", severity: "high", evidenceIds: [evidenceId], observationPeriods: [null], data: {} });
  assert.equal(classifyHorizon(at("hist:risk_7d")), "short_term");
  assert.equal(classifyHorizon(at("hist:risk_30d")), "medium_term");
  assert.equal(classifyHorizon(at("hist:risk_90d")), "structural");
});

test("A8. a persistent multi-horizon pattern (consistent_up/down) is classified by its longest horizon, never demoted for being 'just a pattern'", () => {
  const finding = {
    category: "marketPerformance", findingType: "multi_horizon_consistent_down_decelerating", severity: "high",
    evidenceIds: ["hist:price_30d", "hist:price_90d"], observationPeriods: ["30D", "90D"], data: {},
    horizons: [{ key: "30d", days: 30, raw: -12, value: "-12.00%", period: "30D", id: "hist:price_30d" }, { key: "90d", days: 90, raw: -30, value: "-30.00%", period: "90D", id: "hist:price_90d" }],
  };
  assert.equal(classifyHorizon(finding), "structural");
});

// =====================================================================================
// B. Redundancy collapse
// =====================================================================================

test("B1. elevated_volatility flagged across 7D/30D/90D collapses into a single redundancy group, preserving every Finding ID and evidence ID", () => {
  const findings = [
    { category: "risk", findingType: "elevated_volatility", severity: "high", evidenceIds: ["hist:risk_7d"], observationPeriods: ["7D"], data: {} },
    { category: "risk", findingType: "elevated_volatility", severity: "high", evidenceIds: ["hist:risk_30d"], observationPeriods: ["30D"], data: {} },
    { category: "risk", findingType: "elevated_volatility", severity: "high", evidenceIds: ["hist:risk_90d"], observationPeriods: ["90D"], data: {} },
  ];
  const { survivors, groups } = collapseRedundant(findings);
  assert.equal(groups.length, 1, "one synthesized signal, not three independent drivers");
  const [group] = groups;
  assert.equal(group.category, "risk");
  assert.equal(group.findingType, "elevated_volatility");
  assert.equal(group.memberCount, 3);
  assert.deepEqual(group.findingIds.sort(), findings.map(findingId).sort(), "every member Finding ID is preserved");
  assert.deepEqual(group.evidenceIds.sort(), ["hist:risk_30d", "hist:risk_7d", "hist:risk_90d"].sort(), "every member evidence ID is preserved");
  assert.equal(group.horizon, "structural", "the strongest (90d) member is the representative");
  assert.equal(survivors.length, 1, "the group collapses to a single survivor for downstream relationship-building");
  assert.equal(survivors[0].evidenceIds[0], "hist:risk_90d");
});

test("B2. findings that share a category but differ in findingType are never merged (exact-match key only)", () => {
  const findings = [
    { category: "risk", findingType: "elevated_volatility", severity: "high", evidenceIds: ["hist:risk_30d"], observationPeriods: ["30D"], data: {} },
    { category: "risk", findingType: "sharp_drawdown", severity: "high", evidenceIds: ["hist:risk_90d"], observationPeriods: ["90D"], data: {} },
  ];
  const { survivors, groups } = collapseRedundant(findings);
  assert.equal(groups.length, 0);
  assert.equal(survivors.length, 2);
});

test("B3. redundancy grouping does not depend on input array order", () => {
  const findings = [
    { category: "risk", findingType: "elevated_volatility", severity: "high", evidenceIds: ["hist:risk_90d"], observationPeriods: ["90D"], data: {} },
    { category: "risk", findingType: "elevated_volatility", severity: "high", evidenceIds: ["hist:risk_7d"], observationPeriods: ["7D"], data: {} },
    { category: "risk", findingType: "elevated_volatility", severity: "high", evidenceIds: ["hist:risk_30d"], observationPeriods: ["30D"], data: {} },
  ];
  const forward = collapseRedundant(findings);
  const reversed = collapseRedundant([...findings].reverse());
  assert.deepEqual(forward.groups, reversed.groups);
  assert.deepEqual(forward.survivors, reversed.survivors);
});

// =====================================================================================
// C. Cross-category relationships (all six explicit rules)
// =====================================================================================

test("C1. A. price + TVL divergence produces a price_fundamental_divergence relationship", () => {
  const findings = [{ category: "marketFundamentalRelationships", findingType: "divergence_price_up_tvl_down", severity: "moderate", evidenceIds: ["calc:divergence_price_up_tvl_down"], observationPeriods: [null], data: {} }];
  const result = synthesize(findings);
  assert.ok(result.relationships.some((r) => r.type === "price_fundamental_divergence"));
});

test("C2. B. market cap + TVL + MC/TVL outpacing produces a valuation_activity_relationship spanning three categories", () => {
  const findings = [
    { category: "fundamentalPerformance", findingType: "tvl_growth_increase", severity: "moderate", evidenceIds: ["calc:tvl_growth_pct"], observationPeriods: [null], data: {} },
    { category: "valuation", findingType: "ratio_market_cap_to_tvl", severity: "low", evidenceIds: ["calc:market_cap_to_tvl"], observationPeriods: [null], data: {} },
    { category: "marketFundamentalRelationships", findingType: "divergence_market_cap_up_faster_tvl", severity: "moderate", evidenceIds: ["calc:divergence_market_cap_up_faster_tvl"], observationPeriods: [null], data: {} },
  ];
  const result = synthesize(findings);
  const rel = result.relationships.find((r) => r.type === "valuation_activity_relationship");
  assert.ok(rel);
  assert.equal(rel.categories.length, 3);
  assert.equal(rel.materiality.corroboration, 4, "three distinct categories corroborate this relationship");
});

test("C3. C. price momentum + a valuation multiple produces a market_momentum_valuation relationship", () => {
  const findings = [
    {
      category: "marketPerformance", findingType: "multi_horizon_consistent_up_steady", severity: "high",
      evidenceIds: ["hist:price_24h", "hist:price_7d"], observationPeriods: ["24H", "7D"], data: {},
      horizons: [{ key: "24h", days: 1, raw: 5, value: "+5.00%", period: "24H", id: "hist:price_24h" }, { key: "7d", days: 7, raw: 8, value: "+8.00%", period: "7D", id: "hist:price_7d" }],
    },
    { category: "valuation", findingType: "ratio_fdv_to_tvl", severity: "low", evidenceIds: ["calc:fdv_to_tvl"], observationPeriods: [null], data: {} },
  ];
  const result = synthesize(findings);
  assert.ok(result.relationships.some((r) => r.type === "market_momentum_valuation"));
});

test("C4. D. tokenomics circulating share + FDV/MC gap produces a supply_valuation_exposure relationship", () => {
  const findings = [
    { category: "tokenomics", findingType: "low_circulating_share", severity: "moderate", evidenceIds: ["calc:circulating_of_max_supply"], observationPeriods: [null], data: {} },
    { category: "valuation", findingType: "fdv_market_cap_gap", severity: "moderate", evidenceIds: ["obs:fdv", "obs:market_cap"], observationPeriods: [null, null], data: {} },
  ];
  const result = synthesize(findings);
  assert.ok(result.relationships.some((r) => r.type === "supply_valuation_exposure"));
});

test("C5. E. DEX volume/liquidity/transactions/buy-sell produces a trading_liquidity_conditions relationship", () => {
  const findings = [
    { category: "liquidityMarketStructure", findingType: "structure_dex_aggregate_liquidity_usd", severity: "low", evidenceIds: ["calc:dex_aggregate_liquidity_usd"], observationPeriods: [null], data: {} },
    { category: "liquidityMarketStructure", findingType: "structure_dex_aggregate_volume_24h_usd", severity: "low", evidenceIds: ["calc:dex_aggregate_volume_24h_usd"], observationPeriods: [null], data: {} },
    { category: "liquidityMarketStructure", findingType: "structure_dex_buy_sell_ratio", severity: "low", evidenceIds: ["calc:dex_buy_sell_ratio"], observationPeriods: [null], data: {} },
  ];
  const result = synthesize(findings);
  assert.ok(result.relationships.some((r) => r.type === "trading_liquidity_conditions"));
});

test("C6. F. TVL + fees + revenue changes together produce a fundamental_activity_trajectory relationship", () => {
  const findings = [
    { category: "fundamentalPerformance", findingType: "tvl_growth_increase", severity: "moderate", evidenceIds: ["calc:tvl_growth_pct"], observationPeriods: [null], data: {} },
    { category: "fundamentalPerformance", findingType: "fees_growth_increase", severity: "moderate", evidenceIds: ["calc:fees_growth_pct"], observationPeriods: [null], data: {} },
  ];
  const result = synthesize(findings);
  assert.ok(result.relationships.some((r) => r.type === "fundamental_activity_trajectory"));
});

test("C7. a relationship is never fabricated merely because two metrics coexist: a lone valuation ratio with nothing else produces zero relationships", () => {
  const findings = [{ category: "valuation", findingType: "ratio_market_cap_to_tvl", severity: "low", evidenceIds: ["calc:market_cap_to_tvl"], observationPeriods: [null], data: {} }];
  const result = synthesize(findings);
  assert.deepEqual(result.relationships, []);
});

// =====================================================================================
// D. Materiality
// =====================================================================================

test("D1. a persistent, structural relationship outranks a single-horizon snapshot, even at lower severity than the snapshot", () => {
  const snapshotHighSeverity = materialityOf({ severity: "high", horizon: "snapshot", persistence: "single", categories: ["valuation"], supportingFindingCount: 1, completeness: "complete" });
  const structuralModerateSeverity = materialityOf({ severity: "moderate", horizon: "structural", persistence: "persistent", categories: ["marketPerformance"], supportingFindingCount: 1, completeness: "complete" });
  assert.ok(structuralModerateSeverity.total > snapshotHighSeverity.total, "severity alone must not determine materiality");
});

test("D2. cross-category corroboration strictly increases materiality", () => {
  const single = materialityOf({ severity: "moderate", horizon: "snapshot", persistence: "single", categories: ["valuation"], supportingFindingCount: 1, completeness: "complete" });
  const corroborated = materialityOf({ severity: "moderate", horizon: "snapshot", persistence: "single", categories: ["valuation", "fundamentalPerformance"], supportingFindingCount: 1, completeness: "complete" });
  assert.equal(corroborated.total - single.total, 2);
  assert.equal(corroborated.corroboration, 2);
});

test("D3. a nearby relevant data gap discounts materiality but never below what a single gap penalty removes, and never turns a positive signal negative by itself", () => {
  const base = { severity: "moderate", horizon: "medium_term", persistence: "single", categories: ["fundamentalPerformance"], supportingFindingCount: 1 };
  const complete = materialityOf({ ...base, completeness: "complete" });
  const partial = materialityOf({ ...base, completeness: "partial" });
  const limited = materialityOf({ ...base, completeness: "limited" });
  assert.equal(complete.total - partial.total, 2);
  assert.equal(complete.total - limited.total, 4);
  assert.ok(partial.total > limited.total);
});

test("D4. persistence rewards agreement and penalizes conflict, but never more than corroboration/horizon dominate", () => {
  const persistent = materialityOf({ severity: "moderate", horizon: "structural", persistence: "persistent", categories: ["marketPerformance"], supportingFindingCount: 1, completeness: "complete" });
  const conflicting = materialityOf({ severity: "moderate", horizon: "structural", persistence: "conflicting", categories: ["marketPerformance"], supportingFindingCount: 1, completeness: "complete" });
  const single = materialityOf({ severity: "moderate", horizon: "structural", persistence: "single", categories: ["marketPerformance"], supportingFindingCount: 1, completeness: "complete" });
  assert.ok(persistent.total > single.total);
  assert.ok(single.total > conflicting.total);
});

test("D5. materiality is a distinct score from severity: two findings of the same severity can have very different materiality", () => {
  const a = materialityOf({ severity: "moderate", horizon: "snapshot", persistence: "single", categories: ["valuation"], supportingFindingCount: 1, completeness: "limited" });
  const b = materialityOf({ severity: "moderate", horizon: "structural", persistence: "persistent", categories: ["marketPerformance", "fundamentalPerformance"], supportingFindingCount: 3, completeness: "complete" });
  assert.notEqual(a.total, b.total);
  assert.equal(a.magnitude, b.magnitude, "same severity magnitude");
});

// =====================================================================================
// E. Thin data
// =====================================================================================

test("E1. missing fundamentals (unmapped DeFiLlama) never becomes 'negative fundamentals': no fabricated fundamental relationship, and the gap only discounts, never inverts, materiality", () => {
  const findings = [
    { category: "marketPerformance", findingType: "multi_horizon_consistent_up_steady", severity: "high", evidenceIds: ["hist:price_24h", "hist:price_7d"], observationPeriods: ["24H", "7D"], data: {}, horizons: [{ key: "24h", days: 1, raw: 5, value: "+5.00%", period: "24H", id: "hist:price_24h" }, { key: "7d", days: 7, raw: 8, value: "+8.00%", period: "7D", id: "hist:price_7d" }] },
    { category: "dataQuality", findingType: "unmapped_defillama", severity: "low", evidenceIds: ["scope:defillama"], observationPeriods: [null], data: {} },
  ];
  const result = synthesize(findings);
  assert.ok(!result.relationships.some((r) => r.type === "fundamental_activity_trajectory" || r.type === "valuation_activity_relationship" || r.type === "price_fundamental_divergence"), "no fundamental-side relationship is fabricated when fundamentals are simply unavailable");
  const momentumDriver = result.thesisDrivers.find((d) => d.findingType?.startsWith("multi_horizon_"));
  assert.ok(momentumDriver, "the market-only signal still survives as a thesis driver");
  assert.equal(momentumDriver.completeness, "complete", "a DeFiLlama gap is irrelevant to a marketPerformance finding's own completeness");
});

test("E2. missing DEX data never fabricates a trading_liquidity_conditions relationship (fewer than two structure findings)", () => {
  const findings = [{ category: "liquidityMarketStructure", findingType: "structure_dex_aggregate_liquidity_usd", severity: "low", evidenceIds: ["calc:dex_aggregate_liquidity_usd"], observationPeriods: [null], data: {} }];
  const result = synthesize(findings);
  assert.ok(!result.relationships.some((r) => r.type === "trading_liquidity_conditions"));
});

test("E3. a market-only token (no fundamentals, no DEX mapping at all) still produces at least one valid thesis driver", () => {
  const findings = [
    { category: "marketPerformance", findingType: "multi_horizon_consistent_down_steady", severity: "high", evidenceIds: ["hist:price_7d", "hist:price_30d", "hist:price_90d"], observationPeriods: ["7D", "30D", "90D"], data: {}, horizons: [{ key: "7d", days: 7, raw: -10, value: "-10.00%", period: "7D", id: "hist:price_7d" }, { key: "30d", days: 30, raw: -22, value: "-22.00%", period: "30D", id: "hist:price_30d" }, { key: "90d", days: 90, raw: -40, value: "-40.00%", period: "90D", id: "hist:price_90d" }] },
    { category: "dataQuality", findingType: "unmapped_defillama", severity: "low", evidenceIds: ["scope:defillama"], observationPeriods: [null], data: {} },
    { category: "dataQuality", findingType: "unmapped_dexpaprika", severity: "low", evidenceIds: ["scope:dexpaprika"], observationPeriods: [null], data: {} },
  ];
  const result = synthesize(findings);
  assert.ok(result.thesisDrivers.length > 0, "thin data must never leave the report with zero analytical drivers when a real market signal exists");
  assert.ok(result.thesisDrivers.every((d) => d.materiality.total >= MIN_DRIVER_MATERIALITY));
});

test("E4. a data gap never silently deletes the underlying finding: it still appears in redundancy/relationship inputs available for the narrative layer", () => {
  // dataQuality findings themselves are never turned into relationships or drivers (they are not
  // analytical claims), but they must never be thrown away — they remain part of the same call's
  // input for completeness scoring, which is a form of "preserved," not "deleted."
  const gap = { category: "dataQuality", findingType: "unmapped_defillama", severity: "low", evidenceIds: ["scope:defillama"], observationPeriods: [null], data: {} };
  const findings = [gap, { category: "valuation", findingType: "ratio_market_cap_to_tvl", severity: "low", evidenceIds: ["calc:market_cap_to_tvl"], observationPeriods: [null], data: {} }];
  const result = synthesize(findings);
  assert.ok(!result.thesisDrivers.some((d) => d.findingIds.includes(findingId(gap))), "a data gap is never itself promoted into a thesis driver");
  // But it is not deleted from findings.ts's own output — extractFindings still emits it, and this
  // module never mutates or filters the caller's `findings` array (verified structurally: `findings`
  // passed in is not reassigned/spliced anywhere in synthesis.ts).
});

// =====================================================================================
// F. Determinism
// =====================================================================================

test("F1. synthesize() run twice on identical input produces byte-identical output", async () => {
  const payload = await payloadFor("determinism-tk", seed("determinism-tk", "ethereum", [
    ["coingecko", "price_usd", 8.5], ["coingecko", "price_usd", 8.0, 24 * 6.9], ["coingecko", "price_usd", 7.0, 24 * 29], ["coingecko", "price_usd", 5.0, 24 * 88],
    ["coingecko", "market_cap_usd", 5_000_000_000], ["coingecko", "volume_24h_usd", 900_000_000],
    ["coingecko", "price_change_7d_pct", 6.25, 0.5, { window_days: 7 }],
    ["coingecko", "circulating_supply", 600_000_000], ["coingecko", "total_supply", 1_000_000_000], ["coingecko", "maximum_supply", 1_000_000_000],
    ["defillama", "tvl_usd", 4_000_000_000, 2], ["defillama", "fees_24h_usd", 1_500_000, 2], ["defillama", "revenue_24h_usd", 300_000, 2],
  ], [
    { metric: "tvl_growth_pct", value: 8.2 }, { metric: "fees_growth_pct", value: 5.5 }, { metric: "revenue_growth_pct", value: 4.0 },
    { metric: "market_cap_to_tvl", value: 1.25 }, { metric: "divergence_market_cap_up_faster_tvl", value: 1 },
  ]));
  const findings = extractFindings(payload);
  const first = synthesize(findings);
  const second = synthesize(findings);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("F2. synthesize() output does not depend on the order findings arrive in", () => {
  const findings = [
    { category: "risk", findingType: "elevated_volatility", severity: "high", evidenceIds: ["hist:risk_7d"], observationPeriods: ["7D"], data: {} },
    { category: "risk", findingType: "elevated_volatility", severity: "high", evidenceIds: ["hist:risk_30d"], observationPeriods: ["30D"], data: {} },
    { category: "fundamentalPerformance", findingType: "tvl_growth_increase", severity: "moderate", evidenceIds: ["calc:tvl_growth_pct"], observationPeriods: [null], data: {} },
    { category: "fundamentalPerformance", findingType: "fees_growth_increase", severity: "moderate", evidenceIds: ["calc:fees_growth_pct"], observationPeriods: [null], data: {} },
    { category: "valuation", findingType: "ratio_market_cap_to_tvl", severity: "low", evidenceIds: ["calc:market_cap_to_tvl"], observationPeriods: [null], data: {} },
  ];
  const forward = synthesize(findings);
  const shuffled = synthesize([findings[3], findings[0], findings[4], findings[1], findings[2]]);
  assert.deepEqual(forward, shuffled);
});

// =====================================================================================
// G. Stable ordering / explicit tie-breaking
// =====================================================================================

test("G1. two standalone findings tied on materiality and horizon are ordered deterministically by their stable ID", () => {
  const a = { category: "valuation", findingType: "ratio_fdv_to_tvl", severity: "high", evidenceIds: ["calc:fdv_to_tvl"], observationPeriods: [null], data: {} };
  const b = { category: "valuation", findingType: "ratio_market_cap_to_tvl", severity: "high", evidenceIds: ["calc:market_cap_to_tvl"], observationPeriods: [null], data: {} };
  const idA = findingId(a);
  const idB = findingId(b);
  const materialityA = materialityOf({ severity: "high", horizon: "snapshot", persistence: "single", categories: ["valuation"], supportingFindingCount: 1, completeness: "complete" });
  assert.equal(materialityA.total, MIN_DRIVER_MATERIALITY, "both findings sit exactly at the driver floor, guaranteeing a real tie");

  const result = synthesize([a, b]);
  assert.equal(result.thesisDrivers.length, 2);
  const [first, second] = result.thesisDrivers;
  assert.equal(first.materiality.total, second.materiality.total, "the tie is genuine");
  const expectedOrder = [idA, idB].sort();
  assert.deepEqual([first.id, second.id], expectedOrder);

  // And it holds regardless of input order.
  const reversedResult = synthesize([b, a]);
  assert.deepEqual(reversedResult.thesisDrivers.map((d) => d.id), expectedOrder);
});

test("G2. thesis drivers are capped at MAX_THESIS_DRIVERS and never padded to fill it", () => {
  const lone = [{ category: "valuation", findingType: "ratio_market_cap_to_tvl", severity: "moderate", evidenceIds: ["calc:market_cap_to_tvl"], observationPeriods: [null], data: {} }];
  const result = synthesize(lone);
  assert.ok(result.thesisDrivers.length <= MAX_THESIS_DRIVERS);
  assert.equal(result.thesisDrivers.length, 0, "a single low-materiality snapshot finding never qualifies alone");
});

// =====================================================================================
// H. Evidence preservation (across realistic fixtures built below, and the tie-break fixture above)
// =====================================================================================

test("H1. every relationship/redundancy group/thesis driver only ever cites real Finding IDs and evidence IDs", () => {
  const findings = [
    { category: "marketFundamentalRelationships", findingType: "divergence_price_up_tvl_down", severity: "moderate", evidenceIds: ["calc:divergence_price_up_tvl_down"], observationPeriods: [null], data: {} },
    { category: "fundamentalPerformance", findingType: "tvl_growth_increase", severity: "moderate", evidenceIds: ["calc:tvl_growth_pct"], observationPeriods: [null], data: {} },
    { category: "fundamentalPerformance", findingType: "fees_growth_increase", severity: "moderate", evidenceIds: ["calc:fees_growth_pct"], observationPeriods: [null], data: {} },
    { category: "valuation", findingType: "ratio_market_cap_to_tvl", severity: "low", evidenceIds: ["calc:market_cap_to_tvl"], observationPeriods: [null], data: {} },
    { category: "risk", findingType: "elevated_volatility", severity: "high", evidenceIds: ["hist:risk_7d"], observationPeriods: ["7D"], data: {} },
    { category: "risk", findingType: "elevated_volatility", severity: "high", evidenceIds: ["hist:risk_30d"], observationPeriods: ["30D"], data: {} },
  ];
  assertEvidencePreserved(findings, synthesize(findings));
});

// =====================================================================================
// Realistic per-token fixtures (§14): BTC / ETH / UNI / SUI / HYPE-shaped
// =====================================================================================

// ---- BTC-shaped: capped, circulating==total==maximum, a structural market trend, no DeFiLlama mapping ----

const BTC_LIKE = await payloadFor("btc-shaped", seed("btc-shaped", "bitcoin", [
  ["coingecko", "price_usd", 90000],
  ["coingecko", "price_usd", 85000, 24 * 6.9], ["coingecko", "price_usd", 80000, 24 * 29], ["coingecko", "price_usd", 60000, 24 * 88],
  ["coingecko", "market_cap_usd", 1_780_000_000_000], ["coingecko", "volume_24h_usd", 30_000_000_000],
  ["coingecko", "price_change_7d_pct", 5.9, 0.5, { window_days: 7 }],
  ["coingecko", "circulating_supply", 21_000_000], ["coingecko", "total_supply", 21_000_000], ["coingecko", "maximum_supply", 21_000_000],
], [], true));

test("BTC-shaped: a structural market trend and supply structure are captured, with no fabricated protocol-fundamental relationship when no mapping exists", () => {
  const findings = extractFindings(BTC_LIKE);
  assert.ok(findings.some((f) => f.findingType === "unmapped_defillama"), "no DeFiLlama mapping for BTC");
  assert.ok(findings.some((f) => f.findingType === "circulating_equals_total"), "supply structure is captured");
  const result = synthesize(findings);
  assertEvidencePreserved(findings, result);
  assert.equal(result.relationships.filter((r) => r.type === "price_fundamental_divergence" || r.type === "valuation_activity_relationship" || r.type === "fundamental_activity_trajectory").length, 0, "no fundamental-side relationship is invented when fundamentals data is simply absent");
  const momentumDriver = result.thesisDrivers.find((d) => d.findingType?.startsWith("multi_horizon_"));
  assert.ok(momentumDriver, "the structural price trend survives as a thesis driver");
  assert.equal(momentumDriver.horizon, "structural");
});

// ---- ETH-shaped: uncapped supply, a structural market trend, no DeFiLlama mapping ----

const ETH_LIKE = await payloadFor("eth-shaped", seed("eth-shaped", "ethereum", [
  ["coingecko", "price_usd", 3200],
  ["coingecko", "price_usd", 2900, 24 * 6.9], ["coingecko", "price_usd", 2600, 24 * 29], ["coingecko", "price_usd", 1900, 24 * 88],
  ["coingecko", "market_cap_usd", 385_000_000_000], ["coingecko", "volume_24h_usd", 15_000_000_000],
  ["coingecko", "price_change_7d_pct", 10.3, 0.5, { window_days: 7 }],
  ["coingecko", "circulating_supply", 120_000_000], ["coingecko", "total_supply", 120_000_000],
], [], true));

test("ETH-shaped: a structural market trend and the uncapped-supply limitation are both captured correctly", () => {
  const findings = extractFindings(ETH_LIKE);
  assert.ok(findings.some((f) => f.findingType === "unmapped_defillama"));
  assert.ok(findings.some((f) => f.findingType === "supply_uncapped"));
  const result = synthesize(findings);
  assertEvidencePreserved(findings, result);
  assert.equal(result.relationships.filter((r) => r.type === "fundamental_activity_trajectory" || r.type === "valuation_activity_relationship").length, 0, "no mapping means no fundamental relationship — not treated as evidence of weak fundamentals");
  const momentumDriver = result.thesisDrivers.find((d) => d.findingType?.startsWith("multi_horizon_"));
  assert.ok(momentumDriver);
});

// ---- UNI-shaped: mapped DeFiLlama fundamentals + growth, valuation multiples, DEX activity, and an outpacing divergence flag ----

const UNI_LIKE = await payloadFor("uniswap-uni", seed("uniswap-uni", "ethereum", [
  ["coingecko", "price_usd", 8.5],
  ["coingecko", "price_usd", 8.0, 24 * 6.9], ["coingecko", "price_usd", 7.0, 24 * 29], ["coingecko", "price_usd", 5.0, 24 * 88],
  ["coingecko", "market_cap_usd", 5_000_000_000], ["coingecko", "volume_24h_usd", 900_000_000],
  ["coingecko", "price_change_7d_pct", 6.25, 0.5, { window_days: 7 }],
  ["coingecko", "circulating_supply", 600_000_000], ["coingecko", "total_supply", 1_000_000_000], ["coingecko", "maximum_supply", 1_000_000_000],
  ["defillama", "tvl_usd", 4_000_000_000, 2], ["defillama", "fees_24h_usd", 1_500_000, 2], ["defillama", "revenue_24h_usd", 300_000, 2],
  ["dexpaprika", "liquidity_usd", 168_830, 0.5], ["dexpaprika", "fdv_usd", 8_500_000_000, 0.5],
  ["dexpaprika", "transactions_24h_count", 12_400, 0.5], ["dexpaprika", "buys_24h_count", 6_500, 0.5], ["dexpaprika", "sells_24h_count", 5_900, 0.5],
], [
  { metric: "tvl_growth_pct", value: 8.2 }, { metric: "fees_growth_pct", value: 5.5 }, { metric: "revenue_growth_pct", value: 4.0 },
  { metric: "market_cap_to_tvl", value: 1.25 }, { metric: "fdv_to_tvl", value: 2.13 },
  { metric: "divergence_market_cap_up_faster_tvl", value: 1 }, { metric: "divergence_tvl_up_faster_market_cap", value: 0 },
  { metric: "dex_aggregate_liquidity_usd", value: 5_800_000 }, { metric: "dex_aggregate_volume_24h_usd", value: 21_000_000 },
  { metric: "dex_buy_sell_ratio", value: 6500 / 5900 }, { metric: "dex_volume_to_liquidity", value: 3.6 },
]));

test("UNI-shaped: price, TVL, fees, revenue, valuation, and DEX activity produce multiple, distinct cross-category relationships", () => {
  const findings = extractFindings(UNI_LIKE);
  const result = synthesize(findings);
  assertEvidencePreserved(findings, result);
  const types = new Set(result.relationships.map((r) => r.type));
  assert.ok(types.has("valuation_activity_relationship"), "market cap + TVL + MC/TVL relationship");
  assert.ok(types.has("market_momentum_valuation"), "price momentum + valuation multiple relationship");
  assert.ok(types.has("fundamental_activity_trajectory"), "TVL + fees + revenue trajectory relationship");
  assert.ok(types.has("trading_liquidity_conditions"), "DEX activity/liquidity relationship");
  assert.ok(types.has("fdv_market_cap_gap") === false); // sanity: not a relationship type
  assert.equal(result.relationships.some((r) => r.type === "price_fundamental_divergence"), false, "no direct price/TVL divergence flag was set true for this fixture");
  assert.ok(result.thesisDrivers.length > 0 && result.thesisDrivers.length <= MAX_THESIS_DRIVERS);
});

// ---- SUI-shaped: native asset, strong momentum, elevated turnover, low circulating share, a large FDV/MC gap, no DeFiLlama mapping ----

const SUI_LIKE = await payloadFor("sui-sui", seed("sui-sui", "sui", [
  ["coingecko", "price_usd", 3.42],
  ["coingecko", "price_usd", 3.10, 24 * 6.9], ["coingecko", "price_usd", 2.60, 24 * 29], ["coingecko", "price_usd", 1.85, 24 * 88],
  ["coingecko", "market_cap_usd", 11_950_000_000], ["coingecko", "volume_24h_usd", 2_150_000_000],
  ["coingecko", "price_change_24h_pct", 1.8, 0.5, { window_days: 1 }], ["coingecko", "price_change_7d_pct", 10.3, 0.5, { window_days: 7 }],
  ["coingecko", "circulating_supply", 3_495_000_000], ["coingecko", "total_supply", 10_000_000_000], ["coingecko", "maximum_supply", 10_000_000_000],
  ["dexpaprika", "liquidity_usd", 4_200_000, 0.5], ["dexpaprika", "fdv_usd", 34_200_000_000, 0.5],
  ["dexpaprika", "transactions_24h_count", 18422, 0.5], ["dexpaprika", "buys_24h_count", 9800, 0.5], ["dexpaprika", "sells_24h_count", 8622, 0.5],
], [
  { metric: "dex_aggregate_liquidity_usd", value: 6_100_000 }, { metric: "dex_aggregate_volume_24h_usd", value: 22_000_000 },
  { metric: "dex_liquidity_to_market_cap_pct", value: 0.035 }, { metric: "dex_aggregate_liquidity_to_market_cap_pct", value: 0.051 },
  { metric: "dex_volume_to_liquidity", value: 3.6 }, { metric: "dex_buy_sell_ratio", value: 9800 / 8622 },
  { metric: "volume_to_market_cap", value: 0.18 },
], true));

// The fake data source has no channel for CoinGecko's own reported FDV figure (only the real
// live-data path derives token.fdvUsd from CoinGecko market records) — so, exactly like the
// existing "J. FDV materially above market cap" fixture in deep-analysis-engine.test.mjs, the
// obs:fdv field is patched onto the built payload directly rather than left unreachable.
function withFdvField(payload, raw) {
  const idx = payload.fields.findIndex((f) => f.id === "obs:fdv");
  const fdvField = { id: "obs:fdv", section: "Tokenomics", label: "Fully diluted valuation", value: `$${raw.toLocaleString("en-US")}`, raw, status: "shown", scope: "token", period: null, periodRequired: false, note: null, asOf: null };
  const fields = idx === -1 ? [...payload.fields, fdvField] : payload.fields.map((f, i) => i === idx ? fdvField : f);
  return { ...payload, fields };
}

const SUI_LIKE_WITH_FDV = withFdvField(SUI_LIKE, 34_200_000_000);

test("SUI-shaped: strong price momentum, high volume/market-cap turnover, low circulating share, and a large FDV/MC gap combine into a supply_valuation_exposure relationship, with the mapping limitation handled correctly", () => {
  const findings = extractFindings(SUI_LIKE_WITH_FDV);
  assert.ok(findings.some((f) => f.findingType === "unmapped_defillama"));
  assert.ok(findings.some((f) => f.category === "tokenomics" && f.findingType === "low_circulating_share"));
  assert.ok(findings.some((f) => f.category === "valuation" && f.findingType === "fdv_market_cap_gap"));
  assert.ok(findings.some((f) => f.category === "liquidityMarketStructure" && f.findingType === "elevated_turnover"));
  const result = synthesize(findings);
  assertEvidencePreserved(findings, result);
  assert.ok(result.relationships.some((r) => r.type === "supply_valuation_exposure"));
  assert.equal(result.relationships.some((r) => r.type === "fundamental_activity_trajectory" || r.type === "valuation_activity_relationship"), false, "no mapping means no fabricated fundamental relationship");
  const momentumDriver = result.thesisDrivers.find((d) => d.findingType?.startsWith("multi_horizon_"));
  assert.ok(momentumDriver, "the price momentum survives as a thesis driver even amid the supply/valuation story");
});

// ---- HYPE-shaped: mapped fundamentals + growth, valuation, token supply, DEX trading conditions, and a genuine short-term divergence alongside a longer structural trend ----

const HYPE_LIKE = await payloadFor("hyperliquid-hype", seed("hyperliquid-hype", "hyperliquid", [
  ["coingecko", "price_usd", 38.5],
  ["coingecko", "price_usd", 33.0, 24 * 6.9], ["coingecko", "price_usd", 24.0, 24 * 29], ["coingecko", "price_usd", 14.0, 24 * 88],
  ["coingecko", "market_cap_usd", 12_900_000_000], ["coingecko", "volume_24h_usd", 450_000_000],
  ["coingecko", "price_change_7d_pct", 16.7, 0.5, { window_days: 7 }],
  ["coingecko", "circulating_supply", 334_000_000], ["coingecko", "total_supply", 1_000_000_000], ["coingecko", "maximum_supply", 1_000_000_000],
  ["defillama", "tvl_usd", 1_700_000_000, 2], ["defillama", "fees_24h_usd", 2_800_000, 2], ["defillama", "revenue_24h_usd", 2_800_000, 2],
  ["dexpaprika", "liquidity_usd", 5_400_000, 0.5], ["dexpaprika", "fdv_usd", 38_500_000_000, 0.5],
  ["dexpaprika", "transactions_24h_count", 9_800, 0.5], ["dexpaprika", "buys_24h_count", 5_600, 0.5], ["dexpaprika", "sells_24h_count", 4_200, 0.5],
], [
  { metric: "tvl_growth_pct", value: 11.4 }, { metric: "fees_growth_pct", value: 9.1 }, { metric: "revenue_growth_pct", value: 9.1 },
  { metric: "market_cap_to_tvl", value: 7.6 }, { metric: "fdv_to_tvl", value: 22.6 },
  { metric: "divergence_price_up_tvl_down", value: 1 },
  { metric: "dex_aggregate_liquidity_usd", value: 7_000_000 }, { metric: "dex_aggregate_volume_24h_usd", value: 18_000_000 },
  { metric: "dex_buy_sell_ratio", value: 5600 / 4200 }, { metric: "dex_volume_to_liquidity", value: 2.6 },
], true));

test("HYPE-shaped: a genuine short-term price/TVL divergence never outranks the token's persistent structural price trend and fundamentals trajectory", () => {
  const findings = extractFindings(HYPE_LIKE);
  const result = synthesize(findings);
  assertEvidencePreserved(findings, result);

  const divergenceRel = result.relationships.find((r) => r.type === "price_fundamental_divergence");
  assert.ok(divergenceRel, "the short-term divergence is captured");
  assert.equal(divergenceRel.horizon, "short_term");

  // The structural multi-horizon momentum finding is itself absorbed into the
  // market_momentum_valuation relationship (paired with the FDV/TVL multiple) rather than surfacing
  // twice — that relationship, not a redundant standalone momentum driver, is what must outrank the
  // short-lived divergence.
  const structuralDriver = result.thesisDrivers.find((d) => d.horizon === "structural");
  assert.ok(structuralDriver, "the token's persistent structural relationship is present among the drivers");

  const divergenceDriver = result.thesisDrivers.find((d) => d.id === divergenceRel.id);
  assert.ok(!divergenceDriver || structuralDriver.materiality.total >= divergenceDriver.materiality.total, "a short-lived divergence must never outrank the persistent structural relationship");

  const types = new Set(result.relationships.map((r) => r.type));
  assert.ok(types.has("fundamental_activity_trajectory"));
  assert.ok(types.has("valuation_activity_relationship"));
  assert.ok(types.has("trading_liquidity_conditions"));
  assert.ok(result.thesisDrivers.length > 0 && result.thesisDrivers.length <= MAX_THESIS_DRIVERS);
});

// =====================================================================================

let failures = 0;
for (const { name, run } of cases) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : "unknown error"}`);
  }
}
console.log(`${cases.length - failures}/${cases.length} synthesis checks passed.`);
if (failures > 0) process.exitCode = 1;
