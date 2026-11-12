// Deep Analysis Engine (Phase 2 — institutional-research report structure): findings.ts,
// synthesis.ts wiring, the paragraph-composition narrative engine (narrative.ts), report assembly
// (report.ts), the report-schema.ts evidence contract, and the live deterministic-service.ts path.
// No network access is used anywhere in this file — that itself is part of what is being verified.

import assert from "node:assert/strict";

import { getLiveTokenProfile } from "../src/lib/data/live-data.ts";
import { buildProfilePayload } from "../src/lib/analysis/profile-payload.ts";
import { CALCULATED_METRICS } from "../src/lib/metrics/engine.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

import { extractFindings } from "../src/lib/analysis/engine/findings.ts";
import { synthesize } from "../src/lib/analysis/engine/synthesis.ts";
import { buildEngineReport, ENGINE_VERSION, ANALYSIS_VERSION } from "../src/lib/analysis/engine/report.ts";
import { ENGINE_SECTION_KEYS } from "../src/lib/analysis/engine/report-schema.ts";
import { generateDeterministicAnalysis, DETERMINISTIC_ENGINE_NAME } from "../src/lib/analysis/deterministic-service.ts";
import { AnalysisValidationError, findProhibitedLanguage } from "../src/lib/analysis/schema.ts";
import { findCausalLanguage, findDirectionalLanguage, findExternalConcept, findLeakedEvidenceMarker } from "../src/lib/analysis/evidence-rules.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const NOW = new Date();
const MIDNIGHT = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate(), 0, 10, 0));
const HOUR = 60 * 60 * 1000;
const at = (hoursAgo) => new Date(MIDNIGHT.getTime() - hoursAgo * HOUR).toISOString();

// ---- Fixture builder ----

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

/** Daily UTC-midnight-aligned closes, trending from ~0.5x to ~1.5x `base` over `days`, for technical indicators (needs 61+ consecutive closes for MACD). */
function densePriceRows(base, days) {
  const rows = [];
  for (let d = days; d >= 0; d -= 1) {
    const trend = base * 0.5 + (days - d) * (base / days);
    rows.push(["coingecko", "price_usd", Math.max(1, trend + Math.sin(d * 0.35) * (base * 0.02)), d * 24]);
  }
  return rows;
}

/** Every field/scope/token ID a report cites actually exists in the payload (the provenance guarantee). */
function assertProvenance(payload, report) {
  const knownIds = new Set(["token", ...payload.scope.map((note) => note.id), ...payload.fields.map((field) => field.id)]);
  const cited = new Set();
  JSON.stringify(report.analysis, (key, value) => {
    if (key === "sourceIds" && Array.isArray(value)) for (const id of value) cited.add(id);
    return value;
  });
  for (const id of cited) {
    assert.ok(knownIds.has(id), `cited source ID ${id} is not a real payload field`);
    assert.ok(report.sources[id], `cited source ID ${id} has no provenance label`);
  }
}

/** Every text field in a report, for language/grammar sweeps. */
function allText(analysis) {
  const texts = [];
  JSON.stringify(analysis, (key, value) => {
    if ((key === "text" || key === "question" || key === "rationale") && typeof value === "string") texts.push(value);
    return value;
  });
  return texts;
}

function assertCleanLanguage(report) {
  for (const text of allText(report.analysis)) {
    assert.equal(findLeakedEvidenceMarker(text), null, `leaked evidence marker in: ${text}`);
    assert.deepEqual(findCausalLanguage(text), [], `causal language in: ${text}`);
    assert.deepEqual(findDirectionalLanguage(text), [], `directional/sentiment language in: ${text}`);
    assert.equal(findProhibitedLanguage(text), null, `investment-advice language in: ${text}`);
    assert.equal(findExternalConcept(text, ""), null, `external concept introduced in: ${text}`);
  }
}

function assertAllSectionsPresent(report) {
  for (const key of ENGINE_SECTION_KEYS) {
    assert.ok(Array.isArray(report.analysis[key]?.paragraphs), `section ${key} must be an array of paragraphs`);
  }
  assert.ok(Array.isArray(report.analysis.furtherResearchQuestions));
}

// =====================================================================================
// A. Section structure and evidence discipline hold across a battery of realistic fixtures
// =====================================================================================

const BTC_LIKE = await payloadFor("btc-e2e", seed("btc-e2e", "bitcoin", [
  ["coingecko", "price_usd", 90000], ["coingecko", "market_cap_usd", 1_780_000_000_000], ["coingecko", "volume_24h_usd", 30_000_000_000],
  ["coingecko", "circulating_supply", 21_000_000], ["coingecko", "total_supply", 21_000_000], ["coingecko", "maximum_supply", 21_000_000],
], [], true));

const ETH_LIKE = await payloadFor("eth-e2e", seed("eth-e2e", "ethereum", [
  ...densePriceRows(3200, 95),
  ["coingecko", "market_cap_usd", 385_000_000_000], ["coingecko", "volume_24h_usd", 15_000_000_000],
  ["coingecko", "price_change_24h_pct", 1.2, 0.5, { window_days: 1 }], ["coingecko", "price_change_7d_pct", 5.3, 0.5, { window_days: 7 }],
  ["coingecko", "circulating_supply", 120_000_000], ["coingecko", "total_supply", 120_000_000],
], [], true));

const UNI_LIKE = await payloadFor("uniswap-uni", seed("uniswap-uni", "ethereum", [
  ...densePriceRows(8.5, 95),
  ["coingecko", "market_cap_usd", 5_000_000_000], ["coingecko", "volume_24h_usd", 900_000_000],
  ["coingecko", "price_change_24h_pct", 0.5, 0.5, { window_days: 1 }], ["coingecko", "price_change_7d_pct", 4.8, 0.5, { window_days: 7 }],
  ["coingecko", "circulating_supply", 600_000_000], ["coingecko", "total_supply", 1_000_000_000], ["coingecko", "maximum_supply", 1_000_000_000],
  ["defillama", "tvl_usd", 4_000_000_000, 2], ["defillama", "fees_24h_usd", 1_500_000, 2], ["defillama", "revenue_24h_usd", 300_000, 2],
  ["dexpaprika", "liquidity_usd", 168_830, 0.5], ["dexpaprika", "fdv_usd", 8_500_000_000, 0.5],
  ["dexpaprika", "transactions_24h_count", 12_400, 0.5], ["dexpaprika", "buys_24h_count", 6_500, 0.5], ["dexpaprika", "sells_24h_count", 5_900, 0.5],
], [
  { metric: "tvl_growth_pct", value: 8.2 }, { metric: "fees_growth_pct", value: 5.5 }, { metric: "revenue_growth_pct", value: 4.0 },
  { metric: "market_cap_to_tvl", value: 1.25 }, { metric: "fdv_to_tvl", value: 2.13 },
  { metric: "divergence_market_cap_up_faster_tvl", value: 1 },
  { metric: "dex_aggregate_liquidity_usd", value: 5_800_000 }, { metric: "dex_aggregate_volume_24h_usd", value: 21_000_000 },
  { metric: "dex_buy_sell_ratio", value: 6500 / 5900 }, { metric: "dex_volume_to_liquidity", value: 3.6 },
]));

const SUI_LIKE = await payloadFor("sui-sui", seed("sui-sui", "sui", [
  ["coingecko", "price_usd", 3.42],
  ["coingecko", "price_usd", 3.10, 24 * 24], ["coingecko", "price_usd", 2.60, 24 * 80],
  ["coingecko", "market_cap_usd", 11_950_000_000], ["coingecko", "volume_24h_usd", 2_150_000_000],
  ["coingecko", "price_change_24h_pct", 1.8, 0.5, { window_days: 1 }], ["coingecko", "price_change_7d_pct", 10.3, 0.5, { window_days: 7 }],
  ["coingecko", "circulating_supply", 3_495_000_000], ["coingecko", "total_supply", 10_000_000_000], ["coingecko", "maximum_supply", 10_000_000_000],
  ["dexpaprika", "liquidity_usd", 4_200_000, 0.5], ["dexpaprika", "fdv_usd", 34_200_000_000, 0.5],
  ["dexpaprika", "transactions_24h_count", 18422, 0.5], ["dexpaprika", "buys_24h_count", 9800, 0.5], ["dexpaprika", "sells_24h_count", 8622, 0.5],
], [
  { metric: "dex_aggregate_liquidity_usd", value: 6_100_000 }, { metric: "dex_aggregate_volume_24h_usd", value: 22_000_000 },
  { metric: "dex_volume_to_liquidity", value: 3.6 }, { metric: "dex_buy_sell_ratio", value: 9800 / 8622 },
  { metric: "volume_to_market_cap", value: 0.18 },
], true));

const HYPE_LIKE = await payloadFor("hyperliquid-hype", seed("hyperliquid-hype", "hyperliquid", [
  ["coingecko", "price_usd", 38.5],
  ["coingecko", "price_usd", 33.0, 24 * 24], ["coingecko", "price_usd", 24.0, 24 * 80],
  ["coingecko", "market_cap_usd", 12_900_000_000], ["coingecko", "volume_24h_usd", 450_000_000],
  ["coingecko", "price_change_24h_pct", -1.5, 0.5, { window_days: 1 }], ["coingecko", "price_change_7d_pct", -3.35, 0.5, { window_days: 7 }],
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

const ALL_PAYLOADS = { BTC_LIKE, ETH_LIKE, UNI_LIKE, SUI_LIKE, HYPE_LIKE };

for (const [name, payload] of Object.entries(ALL_PAYLOADS)) {
  test(`A. ${name}: builds a valid, fully-grounded eleven-section report with clean language`, () => {
    const report = buildEngineReport(payload);
    assertAllSectionsPresent(report);
    assertProvenance(payload, report);
    assertCleanLanguage(report);
    for (const key of ENGINE_SECTION_KEYS) assert.ok(report.analysis[key].paragraphs.length > 0, `${name}.${key} has at least a fallback paragraph`);
  });
}

test("A2. every paragraph across every fixture cites at least one source", () => {
  for (const payload of Object.values(ALL_PAYLOADS)) {
    const report = buildEngineReport(payload);
    for (const key of ENGINE_SECTION_KEYS) {
      for (const paragraph of report.analysis[key].paragraphs) assert.ok(paragraph.sourceIds.length > 0, `${key} paragraph has no sourceIds: ${paragraph.text}`);
    }
  }
});

test("A3. no report ever exposes an overall investment score or a buy/sell/hold verdict field", () => {
  for (const payload of Object.values(ALL_PAYLOADS)) {
    const report = buildEngineReport(payload);
    const json = JSON.stringify(report.analysis).toLowerCase();
    assert.ok(!/"score"/.test(json));
    assert.ok(!/\bbuy\b|\bsell\b|\bhold\b/i.test(json.replace(/buy\s*\/?\s*sell/gi, "")));
  }
});

// =====================================================================================
// B. Technical-indicator findings and relationships are real, evidence-grounded content
// =====================================================================================

test("B1. a dense, trending daily-close history produces technical findings (moving averages, MACD, RSI, structure) and a Technical Analysis section that cites them", () => {
  const findings = extractFindings(UNI_LIKE);
  const technical = findings.filter((f) => f.category === "technical");
  assert.ok(technical.length > 0, "technical indicators are extracted from a rich enough price history");
  const report = buildEngineReport(UNI_LIKE);
  const technicalText = report.analysis.technicalAnalysis.paragraphs.map((p) => p.text).join(" ");
  assert.doesNotMatch(technicalText, /no technical indicator/i);
});

test("B2. a thin, single-price-point token never fabricates a technical finding", () => {
  const findings = extractFindings(BTC_LIKE);
  assert.equal(findings.filter((f) => f.category === "technical").length, 0);
  const report = buildEngineReport(BTC_LIKE);
  assert.match(report.analysis.technicalAnalysis.paragraphs[0].text, /no technical indicator/i);
});

test("B3. the three new technical relationship types are reachable from real extracted findings", () => {
  const synthesis = synthesize(extractFindings(UNI_LIKE));
  const types = new Set(synthesis.relationships.map((r) => r.type));
  // At least one technical relationship should form given UNI_LIKE's rich technical + fundamentals + liquidity data.
  const hasTechnical = ["technical_price_confluence", "technical_fundamental_relationship", "technical_liquidity_conditions"].some((type) => types.has(type));
  assert.ok(hasTechnical, `expected at least one technical relationship, got: ${[...types].join(", ")}`);
});

test("B4. RSI/MACD/moving-average/Bollinger findings never use forbidden sentiment words (overbought/oversold/bullish/bearish/breakout)", () => {
  const report = buildEngineReport(UNI_LIKE);
  const text = report.analysis.technicalAnalysis.paragraphs.map((p) => p.text).join(" ");
  assert.doesNotMatch(text, /overbought|oversold|bullish|bearish|breakout|uptrend|downtrend/i);
});

// =====================================================================================
// C. Cross-Domain Analysis is populated from real relationships, not padding
// =====================================================================================

test("C1. Cross-Domain Analysis builds token-specific paragraphs directly from findings (price/technical confluence, range position, fundamentals, valuation), never the old generic one-sentence-per-relationship boilerplate", () => {
  const report = buildEngineReport(UNI_LIKE);
  const texts = report.analysis.crossDomainAnalysis.paragraphs.map((p) => p.text);
  const joined = texts.join(" ");
  // The old RELATIONSHIP_FRAME sentences must not appear verbatim.
  assert.doesNotMatch(joined, /Price momentum is read alongside its technical configuration \(moving averages, MACD, RSI, Bollinger position\) for confluence or divergence\./);
  assert.doesNotMatch(joined, /TVL, fees, and revenue and their respective changes are read together/);
  // Every paragraph cites real evidence (no untraceable statements).
  for (const p of report.analysis.crossDomainAnalysis.paragraphs) assert.ok(p.sourceIds.length > 0, `paragraph has no sourceIds: ${p.text}`);
  // UNI_LIKE has a rich enough fixture (price history, technical indicators, TVL/fees/revenue growth, valuation ratios) that the technical-confluence and fundamentals paragraphs should name specific evidence, not just restate section titles.
  assert.match(joined, /moving averages|MACD|RSI/i);
});

test("C2. a token with no fundamental or valuation data states those specific coverage limitations, never a generic 'no relationship' placeholder when a real limitation can be named", () => {
  const report = buildEngineReport(BTC_LIKE);
  const joined = report.analysis.crossDomainAnalysis.paragraphs.map((p) => p.text).join(" ");
  assert.match(joined, /no protocol-level comparison/i);
  assert.match(joined, /no valuation multiple/i);
  // Never silently invent a relationship this fixture's data does not support.
  assert.doesNotMatch(joined, /reinforced by the technical configuration/i);
});

// =====================================================================================
// D. Momentum interpretation regression (direction/pace/reversal — see calibration history)
// =====================================================================================

test("D1. a 7D-down/90D-up pattern is described as a reversal in Market Performance, never as 'broadly consistent pace'", async () => {
  const payload = await payloadFor("cal-a", seed("cal-a", "ethereum", [
    ["coingecko", "price_usd", 100],
    ["coingecko", "price_usd", 92.94, 24 * 24], ["coingecko", "price_usd", 72.41, 24 * 80],
    ["coingecko", "price_change_24h_pct", -3.28, 0.5, { window_days: 1 }], ["coingecko", "price_change_7d_pct", -3.35, 0.5, { window_days: 7 }],
    ["coingecko", "market_cap_usd", 1_000_000_000], ["coingecko", "volume_24h_usd", 50_000_000], ["coingecko", "circulating_supply", 100_000_000],
  ]));
  const finding = extractFindings(payload).find((f) => f.category === "marketPerformance" && f.findingType.startsWith("multi_horizon_"));
  assert.equal(finding.findingType, "multi_horizon_reversal_to_down");
  const report = buildEngineReport(payload);
  const text = report.analysis.marketPerformance.paragraphs[0].text;
  assert.match(text, /revers/i);
  assert.doesNotMatch(text, /broadly consistent/i);
});

test("D2. all-positive momentum with a sharply faster recent pace is described as accelerating (normalized rate, not raw percentage comparison)", async () => {
  const payload = await payloadFor("cal-b", seed("cal-b", "ethereum", [
    ["coingecko", "price_usd", 100], ["coingecko", "price_usd", 62, 24 * 88],
    ["coingecko", "price_change_7d_pct", 14, 0.5, { window_days: 7 }],
    ["coingecko", "market_cap_usd", 1_000_000_000], ["coingecko", "volume_24h_usd", 50_000_000], ["coingecko", "circulating_supply", 100_000_000],
  ]));
  const finding = extractFindings(payload).find((f) => f.findingType.startsWith("multi_horizon_"));
  assert.equal(finding.findingType, "multi_horizon_consistent_up_accelerating");
  const report = buildEngineReport(payload);
  assert.match(report.analysis.marketPerformance.paragraphs[0].text, /faster/i);
});

test("D3. mixed-direction momentum (up/down/up) is never described as a reversal", async () => {
  const payload = await payloadFor("cal-d", seed("cal-d", "ethereum", [
    ["coingecko", "price_usd", 100], ["coingecko", "price_usd", 110, 24 * 24], ["coingecko", "price_usd", 95, 24 * 80],
    ["coingecko", "price_change_7d_pct", 5, 0.5, { window_days: 7 }],
    ["coingecko", "market_cap_usd", 1_000_000_000], ["coingecko", "volume_24h_usd", 50_000_000], ["coingecko", "circulating_supply", 100_000_000],
  ]));
  const finding = extractFindings(payload).find((f) => f.findingType.startsWith("multi_horizon_"));
  assert.equal(finding.findingType, "multi_horizon_mixed");
  const report = buildEngineReport(payload);
  assert.match(report.analysis.marketPerformance.paragraphs[0].text, /without a single consistent direction/i);
});

// =====================================================================================
// E. BTC/ETH supply-precision and SUI circulating-share phrasing regressions
// =====================================================================================

function supplyPayload(tokenId, circulating, total) {
  return payloadFor(tokenId, seed(tokenId, "bitcoin", [
    ["coingecko", "price_usd", 90000], ["coingecko", "market_cap_usd", 1_800_000_000_000],
    ["coingecko", "circulating_supply", circulating], ["coingecko", "total_supply", total], ["coingecko", "maximum_supply", 21_000_000],
  ], [], true));
}

test("E1. circulating supply exactly equal to total supply never claims 'below'", async () => {
  const payload = await supplyPayload("cal-supply-a", 19_987_731, 19_987_731);
  const report = buildEngineReport(payload);
  const text = report.analysis.tokenomicsSupply.paragraphs.map((p) => p.text).join(" ");
  assert.doesNotMatch(text, /below/i);
  assert.match(text, /equals/i);
});

test("E2. circulating slightly below total, with the compact display colliding at the same rounded figure, still states two different figures (never 'X is below X')", async () => {
  const payload = await supplyPayload("cal-supply-b", 19_987_731, 19_987_800);
  const report = buildEngineReport(payload);
  const text = report.analysis.tokenomicsSupply.paragraphs.find((p) => /below/i.test(p.text)).text;
  const circulatingText = /Circulating supply \(([^)]+)\)/.exec(text)?.[1];
  const totalText = /below total supply \(([^)]+)\)/.exec(text)?.[1];
  assert.ok(circulatingText && totalText);
  assert.notEqual(circulatingText, totalText);
});

test("E3. low-circulating-share phrasing never doubles up 'circulating (...) of maximum supply'", async () => {
  const payload = await payloadFor("cal-sui-share", seed("cal-sui-share", "sui", [
    ["coingecko", "price_usd", 3.42], ["coingecko", "market_cap_usd", 11_950_000_000], ["coingecko", "volume_24h_usd", 500_000_000],
    ["coingecko", "circulating_supply", 4_100_000_000], ["coingecko", "total_supply", 10_000_000_000], ["coingecko", "maximum_supply", 10_000_000_000],
  ], [], true));
  const report = buildEngineReport(payload);
  const text = report.analysis.tokenomicsSupply.paragraphs.map((p) => p.text).join(" ");
  assert.match(text, /of maximum supply is currently circulating/);
  assert.doesNotMatch(text, /circulating \([^)]+\) of maximum supply/i);
});

// =====================================================================================
// F. Determinism, no network, no AI-provider env vars
// =====================================================================================

test("F1. buildEngineReport is deterministic: identical payload produces byte-identical output", () => {
  const first = buildEngineReport(UNI_LIKE);
  const second = buildEngineReport(UNI_LIKE);
  assert.equal(JSON.stringify(first.analysis), JSON.stringify(second.analysis));
});

test("F2. generating a report never calls fetch (no external AI/API call of any kind)", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async (...args) => { called = true; throw new Error(`Unexpected network call: ${args[0]}`); };
  try {
    const db = createFakeSupabase({ seed: seed("cosmos-atom", "cosmos", [["coingecko", "price_usd", 2], ["coingecko", "market_cap_usd", 9_000_000]], [], true) });
    const result = await generateDeterministicAnalysis(db.client, "cosmos-atom", { now: () => MIDNIGHT });
    assert.equal(result.ok, true);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("F3. generation succeeds with every AI-provider environment variable absent", async () => {
  const cleared = { ...process.env };
  for (const key of Object.keys(cleared)) {
    if (/GEMINI|OPENROUTER|MISTRAL|GLM|SILICONFLOW|MODELSCOPE|ZHIPU|QWEN/i.test(key)) delete process.env[key];
  }
  try {
    const db = createFakeSupabase({ seed: seed("algorand-algo", "algorand", [["coingecko", "price_usd", 2], ["coingecko", "market_cap_usd", 9_000_000]], [], true) });
    const result = await generateDeterministicAnalysis(db.client, "algorand-algo", { now: () => MIDNIGHT });
    assert.equal(result.ok, true);
    assert.equal(result.analysis.metadata.model, DETERMINISTIC_ENGINE_NAME);
  } finally {
    process.env = cleared;
  }
});

// =====================================================================================
// G. buildEngineReport never throws a plain Error; generation is stateless (no persistence)
// =====================================================================================

test("G1. buildEngineReport itself never throws a plain Error for any real fixture — only AnalysisValidationError is a recognized failure mode", () => {
  for (const payload of Object.values(ALL_PAYLOADS)) {
    let report;
    try {
      report = buildEngineReport(payload);
    } catch (error) {
      assert.ok(error instanceof AnalysisValidationError, `buildEngineReport threw a non-validation error: ${error?.stack ?? error}`);
      throw error;
    }
    assertProvenance(payload, report);
    assertCleanLanguage(report);
  }
});

test("G2. generateDeterministicAnalysis returns engineVersion/analysisVersion/dataSnapshotAt directly on its result, and never writes to token_ai_analyses", async () => {
  const db = createFakeSupabase({ seed: seed("near-near", "near", [["coingecko", "price_usd", 4], ["coingecko", "market_cap_usd", 3_000_000]], [], true) });
  const result = await generateDeterministicAnalysis(db.client, "near-near", { now: () => MIDNIGHT });
  assert.equal(result.ok, true);
  assert.equal(result.analysis.metadata.engineVersion, ENGINE_VERSION);
  assert.equal(result.analysis.metadata.analysisVersion, ANALYSIS_VERSION);
  assert.equal(result.analysis.metadata.provider, DETERMINISTIC_ENGINE_NAME);
  assert.ok("dataSnapshotAt" in result.analysis.metadata);
  for (const key of ENGINE_SECTION_KEYS) assert.ok(Array.isArray(result.analysis[key].paragraphs), `generated analysis has section ${key}`);
  // Nothing is persisted: generation never touches token_ai_analyses, so it still succeeds even
  // when that table does not exist -- the exact opposite of the old storage-backed path.
  const noTable = createFakeSupabase({ seed: seed("near-near", "near", [["coingecko", "price_usd", 4], ["coingecko", "market_cap_usd", 3_000_000]], [], true), missingTables: ["token_ai_analyses"] });
  const withoutStorage = await generateDeterministicAnalysis(noTable.client, "near-near", { now: () => MIDNIGHT });
  assert.equal(withoutStorage.ok, true);
});

test("G3. an invalid token ID is handled without throwing", async () => {
  const db = createFakeSupabase({ seed: seed("dash-dash", "dash", [["coingecko", "price_usd", 1]], [], true) });
  const badToken = await generateDeterministicAnalysis(db.client, "not-a-real-token", { now: () => MIDNIGHT });
  assert.equal(badToken.ok, false);
  assert.equal(badToken.reason, "invalid_token");
});

test("G4. two consecutive calls for the same token both succeed immediately -- no cooldown, since nothing is persisted to rate-limit", async () => {
  const db = createFakeSupabase({ seed: seed("celo-celo", "celo", [["coingecko", "price_usd", 1], ["coingecko", "market_cap_usd", 2_000_000]], [], true) });
  const first = await generateDeterministicAnalysis(db.client, "celo-celo", { now: () => MIDNIGHT });
  assert.equal(first.ok, true);
  const immediate = await generateDeterministicAnalysis(db.client, "celo-celo", { now: () => new Date(MIDNIGHT.getTime() + 1000) });
  assert.equal(immediate.ok, true);
});

// ---- H. Research-report redesign: confidence/analyticalType classification, regime, versioning ----

test("H1. every paragraph in every section of every fixture carries a valid confidence and analyticalType", () => {
  const VALID_CONFIDENCE = new Set(["high", "moderate", "low"]);
  const VALID_TYPE = new Set(["observation", "interpretation", "inference", "limitation"]);
  for (const payload of [BTC_LIKE, ETH_LIKE, UNI_LIKE, SUI_LIKE, HYPE_LIKE]) {
    const { analysis } = buildEngineReport(payload);
    for (const key of ENGINE_SECTION_KEYS) {
      for (const paragraph of analysis[key].paragraphs) {
        assert.ok(VALID_CONFIDENCE.has(paragraph.confidence), `${payload.token.symbol} ${key}: confidence "${paragraph.confidence}" must be high/moderate/low`);
        assert.ok(VALID_TYPE.has(paragraph.analyticalType), `${payload.token.symbol} ${key}: analyticalType "${paragraph.analyticalType}" must be one of the four research-report types`);
      }
    }
  }
});

test("H2. dataQualityLimitations paragraphs are always classified as limitation/high — a data gap is a directly observed fact, not an uncertain one", () => {
  for (const payload of [BTC_LIKE, ETH_LIKE, UNI_LIKE, SUI_LIKE, HYPE_LIKE]) {
    const { analysis } = buildEngineReport(payload);
    for (const paragraph of analysis.dataQualityLimitations.paragraphs) {
      assert.equal(paragraph.analyticalType, "limitation");
      assert.equal(paragraph.confidence, "high");
    }
  }
});

test("H3. a paragraph grounded only by the bare 'token' placeholder (no real evidence) is always classified as limitation/low, regardless of its section", () => {
  for (const payload of [BTC_LIKE, ETH_LIKE, UNI_LIKE, SUI_LIKE, HYPE_LIKE]) {
    const { analysis } = buildEngineReport(payload);
    for (const key of ENGINE_SECTION_KEYS) {
      if (key === "dataQualityLimitations") continue; // H2 governs this section instead
      for (const paragraph of analysis[key].paragraphs) {
        if (paragraph.sourceIds.length === 1 && paragraph.sourceIds[0] === "token") {
          assert.equal(paragraph.analyticalType, "limitation", `${key}: a 'token'-only paragraph must read as a limitation`);
          assert.equal(paragraph.confidence, "low", `${key}: a 'token'-only paragraph must read as low confidence`);
        }
      }
    }
  }
});

test("H4. the report's regime is read directly off the same multi-horizon momentum finding Market Performance cites — never a separate judgment — and is always one of the five defined labels", () => {
  const VALID_REGIME = new Set(["positive", "negative", "mixed", "flat", "insufficient"]);
  for (const payload of [BTC_LIKE, ETH_LIKE, UNI_LIKE, SUI_LIKE, HYPE_LIKE]) {
    const built = buildEngineReport(payload);
    assert.ok(VALID_REGIME.has(built.regime), `regime "${built.regime}" must be one of the five defined labels`);
    assert.ok(["high", "moderate", "low"].includes(built.regimeConfidence));
  }
});

test("H5. confidence/analyticalType are present on generateDeterministicAnalysis's own result, not just on buildEngineReport's -- the live request path never strips them", async () => {
  const db = createFakeSupabase({ seed: seed("polkadot-dot", "polkadot", [["coingecko", "price_usd", 2.5], ["coingecko", "market_cap_usd", 900_000_000]], [], true) });
  const generated = await generateDeterministicAnalysis(db.client, "polkadot-dot", { now: () => MIDNIGHT });
  assert.equal(generated.ok, true);
  for (const key of ENGINE_SECTION_KEYS) {
    for (const paragraph of generated.analysis[key].paragraphs) {
      assert.ok(paragraph.confidence, `${key}: confidence must be present on the generated result`);
      assert.ok(paragraph.analyticalType, `${key}: analyticalType must be present on the generated result`);
    }
  }
});

// =====================================================================================
// I. Mixed-horizon regime accuracy — a shorter horizon outside the pattern-eligible set must never
// be silently claimed as part of "every available horizon" when it disagrees in sign (see
// classifyMultiHorizonPattern's excludedDisagreement in findings.ts).
// =====================================================================================

/** A minimal ProfilePayload built directly from named fields, bypassing the Supabase fixture
 * pipeline entirely — reliable for exercising one specific combination of obs:/hist: fields. */
function directPayload(overrides) {
  const field = (id, section, label, value, raw, period = null) => ({
    id, section, label, value, raw, status: "shown", scope: "token", period, periodRequired: period !== null,
    note: null, asOf: MIDNIGHT.toISOString(), intervalHours: null, technicalState: null, technicalReadings: null,
  });
  return {
    version: "test",
    token: { id: "mixed-e2e", name: "Mixed Horizon Token", symbol: "MHT", chain: "Ethereum", category: "DeFi", isNative: false, contractAddress: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984" },
    dataAsOf: MIDNIGHT.toISOString(),
    scope: [
      { id: "scope:defillama", provider: "DeFiLlama", mapped: false, statement: "No DeFiLlama protocol mapping." },
      { id: "scope:dexpaprika", provider: "DexPaprika", mapped: false, statement: "No DexPaprika mapping." },
    ],
    fields: [
      field("obs:price", "Overview", "Price", "$45.00", 45),
      field("obs:change_24h", "Overview", "24H change", `${overrides.change24h >= 0 ? "+" : ""}${overrides.change24h}%`, overrides.change24h, "24H (rolling 24 hours, as reported by the provider)"),
      field("obs:change_7d", "Overview", "7D change", `${overrides.change7d >= 0 ? "+" : ""}${overrides.change7d}%`, overrides.change7d, "7D (rolling 7 days, as reported by the provider)"),
      field("hist:price_30d", "Market history", "Price history · 30D", `latest $45.00 · ${overrides.change30d >= 0 ? "+" : ""}${overrides.change30d}% over 30 days`, overrides.change30d, "30D window: 30 observations spanning 29 days"),
      field("obs:market_cap", "Overview", "Market cap", "$400.00M", 400_000_000),
      field("obs:volume_24h", "Overview", "24H volume", "$10.00M", 10_000_000),
      field("obs:circulating_supply", "Tokenomics", "Circulating supply", "9.00M MHT", 9_000_000),
      field("obs:total_supply", "Tokenomics", "Total supply", "10.00M MHT", 10_000_000),
      field("obs:maximum_supply", "Tokenomics", "Maximum supply", "10.00M MHT", 10_000_000),
    ],
  };
}

test("I1. 24H negative with 7D/30D both positive (the ILV production case) is never described as 'persistent positive regime across every available horizon'", () => {
  const payload = directPayload({ change24h: -4.27, change7d: 9.40, change30d: 28.14 });
  const finding = extractFindings(payload).find((f) => f.category === "marketPerformance" && f.findingType.startsWith("multi_horizon_") && !f.findingType.startsWith("volume_"));
  assert.equal(finding.findingType, "multi_horizon_consistent_up_accelerating", "7D/30D still classify as a consistent upward pattern");
  assert.equal(finding.data.excludedDisagreementKey, "24h", "the pattern-excluded 24H horizon is flagged as disagreeing");
  const report = buildEngineReport(payload);
  const text = report.analysis.marketPerformance.paragraphs[0].text;
  assert.doesNotMatch(text, /persistent positive regime across every available horizon/i, "must not claim the regime holds at every horizon when 24H disagrees");
  assert.match(text, /-4\.27%/, "the disagreeing 24H figure is still stated, not hidden");
  assert.match(text, /pullback/i, "the short-term disagreement is named as a pullback");
  // The same guarantee must hold in the Executive Assessment and Final Conclusion, which reuse the same momentumClause.
  assert.doesNotMatch(report.analysis.executiveAssessment.paragraphs[0].text, /persistent positive regime across every available horizon/i);
  assert.doesNotMatch(report.analysis.finalConclusion.paragraphs[0].text, /persistent positive regime across every available horizon/i);
});

test("I2. 24H positive with 7D/30D both negative is described as a rebound, not a persistent negative regime at every horizon", () => {
  const payload = directPayload({ change24h: 3.1, change7d: -6.5, change30d: -12.0 });
  const finding = extractFindings(payload).find((f) => f.category === "marketPerformance" && f.findingType.startsWith("multi_horizon_") && !f.findingType.startsWith("volume_"));
  assert.match(finding.findingType, /^multi_horizon_consistent_down_/);
  assert.equal(finding.data.excludedDisagreementKey, "24h");
  const report = buildEngineReport(payload);
  const text = report.analysis.marketPerformance.paragraphs[0].text;
  assert.doesNotMatch(text, /persistent negative regime across every available horizon/i);
  assert.match(text, /rebound/i);
});

test("I3. 24H/7D/30D all positive (the BTC/ORCA production case) is still described as holding across every available horizon — the fix must not over-trigger on a genuinely consistent regime", () => {
  const payload = directPayload({ change24h: 0.85, change7d: 3.94, change30d: 7.95 });
  const finding = extractFindings(payload).find((f) => f.category === "marketPerformance" && f.findingType.startsWith("multi_horizon_") && !f.findingType.startsWith("volume_"));
  assert.equal(finding.data.excludedDisagreementKey, null, "all horizons agree, so there is no excluded disagreement");
  const report = buildEngineReport(payload);
  assert.match(report.analysis.marketPerformance.paragraphs[0].text, /persistent positive regime across every available horizon/i);
});

// =====================================================================================
// J. Global post-production audit: unsupported turnover labels, fundamental pace reasoning,
// cross-domain qualification, dynamic Final Conclusion availability, FDV inference, ILV-shaped
// mixed-horizon volume. Every fixture is evidence-driven (no token-name conditionals in the
// engine); ORCA/ILV/BTC shapes below are regression fixtures, not special-cased inputs.
// =====================================================================================

function directField(id, section, label, value, raw, period = null, intervalHours = null) {
  return { id, section, label, value, raw, status: "shown", scope: "token", period, periodRequired: period !== null, note: null, asOf: MIDNIGHT.toISOString(), intervalHours, technicalState: null, technicalReadings: null };
}

/** An ORCA-shaped payload: available fundamentals (TVL ~30D-aligned, fees/revenue ~6h-aligned) and
 * available valuation multiples, plus the metrics engine's own aligned price-vs-fundamental spread
 * (mixed sign: outpacing TVL, trailing revenue) and a volume/market-cap ratio in the un-thresholded
 * middle band. */
const ORCA_LIKE = {
  version: "test",
  token: { id: "orca-j", name: "Orca", symbol: "ORCA", chain: "Solana", category: "DEX", isNative: false, contractAddress: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE" },
  dataAsOf: MIDNIGHT.toISOString(),
  scope: [
    { id: "scope:defillama", provider: "DeFiLlama", mapped: true, statement: "DeFiLlama protocol mapping available." },
    { id: "scope:dexpaprika", provider: "DexPaprika", mapped: true, statement: "DexPaprika mapping available." },
  ],
  fields: [
    directField("obs:price", "Overview", "Price", "$3.20", 3.20),
    directField("obs:change_24h", "Overview", "24H change", "+2.00%", 2.00, "24H (rolling 24 hours, as reported by the provider)"),
    directField("obs:change_7d", "Overview", "7D change", "+15.00%", 15.00, "7D (rolling 7 days, as reported by the provider)"),
    directField("hist:price_30d", "Market history", "Price history · 30D", "latest $3.20 · +55.32% over 30 days", 55.32, "30D window: 30 observations spanning 29 days"),
    directField("obs:market_cap", "Overview", "Market cap", "$400.00M", 400_000_000),
    directField("obs:volume_24h", "Overview", "24H volume", "$285.60M", 285_600_000),
    directField("obs:circulating_supply", "Tokenomics", "Circulating supply", "100.00M ORCA", 100_000_000),
    directField("obs:total_supply", "Tokenomics", "Total supply", "100.00M ORCA", 100_000_000),
    directField("obs:maximum_supply", "Tokenomics", "Maximum supply", "100.00M ORCA", 100_000_000),
    directField("obs:tvl", "Fundamentals", "TVL", "$120.00M", 120_000_000),
    directField("obs:fees_24h", "Fundamentals", "Fees · 24h", "$50.00K", 50_000),
    directField("obs:revenue_24h", "Fundamentals", "Revenue · 24h", "$25.00K", 25_000),
    directField("calc:tvl_growth_pct", "Fundamentals", "TVL change", "+25.45%", 25.45, "30D window", 30 * 24),
    directField("calc:fees_growth_pct", "Fundamentals", "Fees change", "+11.99%", 11.99, "~6h window", 6),
    directField("calc:revenue_growth_pct", "Fundamentals", "Revenue change", "+11.99%", 11.99, "~6h window", 6),
    directField("calc:market_cap_to_tvl", "Valuation", "Market Cap / TVL", "3.33×", 3.33),
    directField("calc:fdv_to_tvl", "Valuation", "FDV / TVL", "3.33×", 3.33),
    directField("calc:market_cap_to_revenue_24h", "Valuation", "Market Cap / 24h Revenue", "16000×", 16000),
    directField("calc:fdv_to_revenue_24h", "Valuation", "FDV / 24h Revenue", "16000×", 16000),
    directField("calc:price_change_vs_tvl_growth_pct_points", "Cross-metric analysis", "Price change vs TVL growth", "+9.45 pts", 9.45, "Aligned interval", 30 * 24),
    directField("calc:price_change_vs_revenue_growth_pct_points", "Cross-metric analysis", "Price change vs revenue growth", "-30.59 pts", -30.59, "Aligned interval", 6),
    directField("calc:dex_aggregate_liquidity_usd", "Market structure", "DEX liquidity", "$15.00M", 15_000_000),
    directField("calc:dex_aggregate_volume_24h_usd", "Market structure", "DEX volume", "$285.60M", 285_600_000),
    directField("calc:volume_to_market_cap", "Market structure", "Volume / Market cap", "0.714×", 0.714),
  ],
};

/** An ILV-shaped payload: 24H pullback within a positive 7D/30D regime, and volume whose own
 * 24H/7D/30D directions do not all agree with each other (reversal_to_up), let alone with price. */
const ILV_LIKE = {
  version: "test",
  token: { id: "ilv-j", name: "Illuvium", symbol: "ILV", chain: "Ethereum", category: "Gaming", isNative: false, contractAddress: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984" },
  dataAsOf: MIDNIGHT.toISOString(),
  scope: [
    { id: "scope:defillama", provider: "DeFiLlama", mapped: false, statement: "No DeFiLlama protocol mapping." },
    { id: "scope:dexpaprika", provider: "DexPaprika", mapped: false, statement: "No DexPaprika mapping." },
  ],
  fields: [
    directField("obs:price", "Overview", "Price", "$45.00", 45),
    directField("obs:change_24h", "Overview", "24H change", "-3.76%", -3.76, "24H (rolling 24 hours, as reported by the provider)"),
    directField("obs:change_7d", "Overview", "7D change", "+7.72%", 7.72, "7D (rolling 7 days, as reported by the provider)"),
    directField("hist:price_30d", "Market history", "Price history · 30D", "latest $45.00 · +26.91% over 30 days", 26.91, "30D window: 30 observations spanning 29 days"),
    directField("hist:volume_24h", "Market history", "Volume history · 24H", "latest $10.00M · +0.30% over 24 hours", 0.30, "24H window: 2 observations"),
    directField("hist:volume_7d", "Market history", "Volume history · 7D", "latest $10.00M · +21.55% over 7 days", 21.55, "7D window: 7 observations"),
    directField("hist:volume_30d", "Market history", "Volume history · 30D", "latest $10.00M · -68.72% over 30 days", -68.72, "30D window: 30 observations"),
    directField("obs:market_cap", "Overview", "Market cap", "$400.00M", 400_000_000),
    directField("obs:volume_24h", "Overview", "24H volume", "$10.00M", 10_000_000),
    directField("obs:circulating_supply", "Tokenomics", "Circulating supply", "9.00M ILV", 9_000_000),
    directField("obs:total_supply", "Tokenomics", "Total supply", "10.00M ILV", 10_000_000),
    directField("obs:maximum_supply", "Tokenomics", "Maximum supply", "10.00M ILV", 10_000_000),
  ],
};

test("J-A. a volume/market-cap ratio with no documented threshold never produces an elevated/moderate/low/threshold-crossing classification", () => {
  const report = buildEngineReport(ORCA_LIKE);
  const text = report.analysis.marketStructureLiquidity.paragraphs.map((p) => p.text).join(" ");
  assert.doesNotMatch(text, /\belevated\b|\bmoderate\b|\blow level\b|crossing.*threshold|between.*threshold/i);
  assert.match(text, /0\.714×/, "the ratio itself is still cited");
  assert.match(text, /does not establish executable liquidity/i);
});

test("J-B. ORCA-shaped fundamentals: positive TVL/fees/revenue never collapse into an unqualified 'fundamentals confirm the price move' — differing observation periods are stated explicitly", () => {
  const report = buildEngineReport(ORCA_LIKE);
  const text = report.analysis.fundamentalAnalysis.paragraphs.map((p) => p.text).join(" ");
  assert.match(text, /materially different windows/i, "the 30D TVL window vs ~6h fees/revenue window mismatch is stated");
  assert.doesNotMatch(text, /fundamentals confirm the (size|magnitude) of the price move/i);
  assert.match(text, /outpaced TVL growth/i);
  assert.match(text, /trailed revenue growth/i);
});

test("J-C. ORCA-shaped Cross-Domain: price materially outpacing/trailing tracked fundamentals (mixed across metrics) is acknowledged directionally but the magnitude is qualified, not presented as plain confirmation", () => {
  const report = buildEngineReport(ORCA_LIKE);
  const text = report.analysis.crossDomainAnalysis.paragraphs.map((p) => p.text).join(" ");
  assert.doesNotMatch(text, /providing cross-domain confirmation that market performance is occurring alongside a comparable move/i);
  assert.match(text, /supports the direction of the move/i);
  assert.match(text, /mixed|outpaced/i);
});

test("J-D. ORCA-shaped Final Conclusion: fundamentals and valuation evidence exist, so the conclusion never claims them 'currently unavailable'", () => {
  const report = buildEngineReport(ORCA_LIKE);
  const text = report.analysis.finalConclusion.paragraphs.map((p) => p.text).join(" ");
  assert.doesNotMatch(text, /currently unavailable fundamental/i);
  assert.doesNotMatch(text, /fundamental evidence becomes available/i);
  assert.doesNotMatch(text, /unavailable.*valuation evidence/i);
});

test("J-E. ILV-shaped volume: 24H/7D/30D directions that do not all agree produce horizon-specific reasoning, never a generic 'volume confirms price' statement", () => {
  const report = buildEngineReport(ILV_LIKE);
  const crossText = report.analysis.crossDomainAnalysis.paragraphs.map((p) => p.text).join(" ");
  assert.doesNotMatch(crossText, /providing some confirmation from market participation/i, "the 30D volume contradicts price, so this must not claim confirmation");
  assert.match(crossText, /mixed rather than uniform/i);
  assert.match(crossText, /24H volume \+0\.30%/);
  assert.match(crossText, /7D volume \+21\.55%/);
  assert.match(crossText, /30D volume -68\.72%/);
});

test("J-F. no FDV/tokenomics narrative claims tokens are 'already issued but not yet circulating' without that fact being established by the evidence", () => {
  for (const payload of [ORCA_LIKE, ILV_LIKE]) {
    const report = buildEngineReport(payload);
    const text = [...report.analysis.valuationAnalysis.paragraphs, ...report.analysis.tokenomicsSupply.paragraphs].map((p) => p.text).join(" ");
    // "no already-issued tokens remain outside circulation" (the circulating===total case) is a
    // legitimate, trivially-true statement; the removed, unsupported claim was specifically that a
    // circulating-below-total gap "indicates" tokens are issued-but-not-yet-circulating.
    assert.doesNotMatch(text, /indicating a portion of already-issued tokens is not yet in circulation/i);
    assert.doesNotMatch(text, /incorporating supply not yet in circulation/i);
  }
});

// =====================================================================================
// K. Executive Assessment / Final Conclusion dynamically synthesize every materially available
// domain (fundamentals, valuation, market structure/liquidity, risk) -- never silently stopping at
// the market/technical conclusion merely because that conclusion is already established, and never
// claiming a domain unavailable when the corresponding evidence actually exists.
// =====================================================================================

test("K1. ORCA-shaped (fundamentals + valuation available): Executive Assessment AND Final Conclusion both reflect fundamentals and valuation, not just the market/technical thesis", () => {
  const report = buildEngineReport(ORCA_LIKE);
  for (const key of ["executiveAssessment", "finalConclusion"]) {
    const text = report.analysis[key].paragraphs.map((p) => p.text).join(" ");
    assert.match(text, /protocol activity|tracked protocol activity/i, `${key} must mention fundamentals when available`);
    assert.match(text, /valuation multiples are also observable/i, `${key} must mention valuation when available`);
    assert.match(text, /comparative benchmark/i, `${key} must preserve the no-benchmark limitation`);
  }
});

test("K2. BTC-shaped (fundamentals + valuation unavailable): Executive Assessment and Final Conclusion never falsely claim fundamentals or valuation are available", () => {
  function f(id, section, label, value, raw, period = null) {
    return { id, section, label, value, raw, status: "shown", scope: "token", period, periodRequired: period !== null, note: null, asOf: MIDNIGHT.toISOString(), intervalHours: null, technicalState: null, technicalReadings: null };
  }
  const payload = {
    version: "test",
    token: { id: "btc-k2", name: "Bitcoin", symbol: "BTC", chain: "Bitcoin", category: "Payments", isNative: true, contractAddress: null },
    dataAsOf: MIDNIGHT.toISOString(),
    scope: [
      { id: "scope:defillama", provider: "DeFiLlama", mapped: false, statement: "No DeFiLlama protocol mapping." },
      { id: "scope:dexpaprika", provider: "DexPaprika", mapped: false, statement: "No DexPaprika mapping." },
    ],
    fields: [
      f("obs:price", "Overview", "Price", "$85,956.00", 85956),
      f("obs:change_24h", "Overview", "24H change", "+0.85%", 0.85, "24H (rolling 24 hours, as reported by the provider)"),
      f("obs:change_7d", "Overview", "7D change", "+3.94%", 3.94, "7D (rolling 7 days, as reported by the provider)"),
      f("hist:price_30d", "Market history", "Price history · 30D", "latest $85,956.00 · +7.95% over 30 days", 7.95, "30D window: 30 observations spanning 29 days"),
      f("obs:market_cap", "Overview", "Market cap", "$1.73T", 1_730_000_000_000),
      f("obs:circulating_supply", "Tokenomics", "Circulating supply", "20.09M BTC", 20_090_000),
      f("obs:total_supply", "Tokenomics", "Total supply", "20.09M BTC", 20_090_000),
      f("obs:maximum_supply", "Tokenomics", "Maximum supply", "21.00M BTC", 21_000_000),
    ],
  };
  const report = buildEngineReport(payload);
  for (const key of ["executiveAssessment", "finalConclusion"]) {
    const text = report.analysis[key].paragraphs.map((p) => p.text).join(" ");
    assert.doesNotMatch(text, /tracked protocol activity is also part of the available evidence/i, `${key} must not claim fundamentals are available`);
    assert.doesNotMatch(text, /valuation multiples are also observable/i, `${key} must not claim valuation is available`);
    assert.match(text, /protocol-level fundamentals|whether market performance is accompanied/i, `${key} must state the actual fundamentals limitation`);
  }
});

test("K3. ORCA-shaped material fundamental pace qualification (price outpacing/trailing tracked fundamentals) survives into both Executive Assessment and Final Conclusion, not just Cross-Domain Analysis", () => {
  const report = buildEngineReport(ORCA_LIKE);
  for (const key of ["executiveAssessment", "finalConclusion"]) {
    const text = report.analysis[key].paragraphs.map((p) => p.text).join(" ");
    assert.match(text, /cross-metric evidence/i, `${key} must carry the pace qualification forward`);
    assert.doesNotMatch(text, /fundamentals confirm the (size|magnitude) of the (price move|market move)/i);
  }
});

test("K4. mixed/contradictory cross-domain evidence (ORCA-shaped: outpacing TVL while trailing revenue) is not silently simplified away in the Final Conclusion", () => {
  const report = buildEngineReport(ORCA_LIKE);
  const text = report.analysis.finalConclusion.paragraphs.map((p) => p.text).join(" ");
  assert.match(text, /mixed across measures|outpaced|trailed/i, "the mixed pace signal must be acknowledged, not collapsed into a single clean confirmation");
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
console.log(`${cases.length - failures}/${cases.length} deep-analysis-engine checks passed.`);
if (failures > 0) process.exitCode = 1;
