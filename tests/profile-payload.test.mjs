// Token Profile payload: the canonical dataset shared by the page, "Copy data", and the AI analysis.
// Built through the page's own loader (getLiveTokenProfile) against an in-memory database. No network.

import assert from "node:assert/strict";

import { getLiveTokenProfile } from "../src/lib/data/live-data.ts";
import { buildProfileModel } from "../src/lib/ui/profile-model.ts";
import { buildProfilePayload, formatProfilePayloadText } from "../src/lib/analysis/profile-payload.ts";
import { buildProfileEvidenceIndex } from "../src/lib/analysis/profile-evidence.ts";
import { PROFILE_SYSTEM_INSTRUCTION, buildProfileUserContent } from "../src/lib/analysis/prompt.ts";
import { ANALYSIS_RESPONSE_SCHEMA, AnalysisValidationError, validateModelAnalysis } from "../src/lib/analysis/schema.ts";
import { allowedEvidenceIds, attachEvidencePeriods, buildProfileResponseSchema, buildProfileValidationSchema } from "../src/lib/analysis/profile-contract.ts";
import { schemaErrors } from "../src/lib/analysis/ai/json-schema.ts";
import { CALCULATED_METRICS } from "../src/lib/metrics/engine.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const HOUR = 60 * 60 * 1000;
const at = (hoursAgo) => new Date(Date.now() - hoursAgo * HOUR).toISOString();

function seed(tokenId, chainId, rows, calculated = []) {
  let id = 1000;
  const obs = ([provider, metric, value, hoursAgo = 0.5, extra = {}]) => ({
    id: id++, token_id: tokenId, chain_id: chainId, provider_id: provider, metric_id: metric, value,
    status: value === null ? "unavailable" : "available", observed_at: at(hoursAgo), collected_at: at(hoursAgo), window_days: null, note: null, ...extra,
  });
  return {
    tokens: [
      { id: "uniswap-uni", name: "Uniswap", symbol: "UNI", chain_id: "ethereum", contract_address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", is_native: false, category: "DeFi", description: null },
      { id: "bitcoin-btc", name: "Bitcoin", symbol: "BTC", chain_id: "bitcoin", contract_address: null, is_native: true, category: "Layer 1", description: null },
    ],
    chains: [{ id: "ethereum", name: "Ethereum" }, { id: "bitcoin", name: "Bitcoin" }],
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

const UNISWAP = seed("uniswap-uni", "ethereum", [
  ["coingecko", "price_usd", 9.33], ["coingecko", "price_usd", 9.21, 26], ["coingecko", "market_cap_usd", 5_790_000_000],
  ["coingecko", "volume_24h_usd", 0], ["coingecko", "price_change_24h_pct", -0.13, 0.5, { window_days: 1 }],
  ["coingecko", "price_change_7d_pct", 32.95, 0.5, { window_days: 7 }], ["coingecko", "circulating_supply", 620_668_000],
  ["coingecko", "maximum_supply", null], ["defillama", "tvl_usd", 3_910_000_000, 2], ["defillama", "fees_24h_usd", 1_250_000, 2],
], [
  { metric: "price_growth_pct", value: 1.3, start: at(1.5), end: at(0.5) },
  { metric: "market_cap_to_tvl", value: 1.481, start: at(2), end: at(0.5) },
]);
const BITCOIN = seed("bitcoin-btc", "bitcoin", [
  ["coingecko", "price_usd", 84388.12], ["coingecko", "market_cap_usd", 1_690_000_000_000], ["coingecko", "circulating_supply", 20_088_743],
  ["coingecko", "maximum_supply", 21_000_000],
]);

// getLiveTokenProfile also does a live Binance fetch for any token with a Binance mapping
// (uniswap-uni and bitcoin-btc both have one); block it here so this file stays "no network" and
// deterministic regardless of the test sandbox's actual connectivity. fetchLiveBinanceObservations
// already treats a failed fetch as "no live Binance data" (falls back to the stored provider data),
// so a rejected fetch here is the correct, already-handled way to disable it.
const realFetch = globalThis.fetch;
globalThis.fetch = () => Promise.reject(new Error("network disabled in profile-payload.test.mjs"));
const profile = (tokenId, data) => getLiveTokenProfile(tokenId, createFakeSupabase({ seed: data }).client);
const uniswap = await profile("uniswap-uni", UNISWAP);
const bitcoin = await profile("bitcoin-btc", BITCOIN);
globalThis.fetch = realFetch;
const uniPayload = buildProfilePayload(uniswap);
const btcPayload = buildProfilePayload(bitcoin);
const field = (payload, id) => payload.fields.find((item) => item.id === id);

function violations(output, payload) {
  try {
    validateModelAnalysis(output, buildProfileEvidenceIndex(payload));
  } catch (error) {
    if (error instanceof AnalysisValidationError) return error.violations;
    throw error;
  }
  return [];
}
/** Non-fatal warnings: from a successful validation, or from a rejected one (still collected). */
function warnings(output, payload) {
  try {
    return validateModelAnalysis(output, buildProfileEvidenceIndex(payload)).warnings;
  } catch (error) {
    if (error instanceof AnalysisValidationError) return error.warnings;
    throw error;
  }
}
const empty = { overview: "No statement is made in this section.", statements: [] };
function report(overrides = {}) {
  return {
    executiveSummary: empty, marketPerformance: empty, fundamentalPerformance: empty, valuation: empty, marketFundamentalRelationships: empty,
    liquidityMarketStructure: empty, tokenomics: empty, risks: [], dataGaps: [], furtherResearchQuestions: [], ...overrides,
  };
}
const st = (kind, text, sourceIds, period = "") => ({ kind, text, sourceIds, period });

test("P1. every card the page displays is a payload field with the same label and displayed value", () => {
  const model = buildProfileModel(uniswap);
  const displayed = [...model.snapshot.cards, ...model.snapshot.changes, ...(model.fundamentals.available ? [...model.fundamentals.primary, ...model.fundamentals.valuation, ...model.fundamentals.changes] : []), ...(model.tokenomics.available ? model.tokenomics.items : [])];
  assert.ok(displayed.length >= 6);
  for (const card of displayed) {
    const match = uniPayload.fields.find((item) => item.label === card.label && item.value === card.value);
    assert.ok(match, `displayed "${card.label}: ${card.value}" is in the payload`);
  }
  assert.equal(field(uniPayload, "obs:price").value, "$9.33", "the header price as displayed");
  assert.equal(field(uniPayload, "calc:market_cap_to_tvl").value, model.fundamentals.valuation.find((card) => card.id === "market_cap_to_tvl").value);
});

test("P2. deterministic: the same profile data yields the identical payload, prompt input, and copy text", async () => {
  const again = buildProfilePayload(await profile("uniswap-uni", UNISWAP));
  const strip = (payload) => JSON.parse(JSON.stringify(payload, (key, value) => (key === "asOf" || key === "dataAsOf" ? undefined : value)));
  assert.deepEqual(strip(again), strip(uniPayload), "no randomness or provider-specific content");
  assert.equal(buildProfileUserContent(uniPayload), buildProfileUserContent(uniPayload));
  assert.equal(formatProfilePayloadText(uniPayload), formatProfilePayloadText(buildProfilePayload(uniswap)));
});

test("P3. unavailable is 'not reported', never zero; a real zero stays a value", () => {
  const max = field(uniPayload, "obs:maximum_supply");
  assert.deepEqual([max.status, max.value, max.raw], ["not_reported", "Not reported", null]);
  const volume = field(uniPayload, "obs:volume_24h");
  assert.equal(volume.status, "shown", "a stored zero is displayed and passed on");
  assert.equal(volume.raw, 0);
  assert.equal(volume.value, "$0");
});

test("P4. provider-reported windows keep their periods; point-in-time ratios carry none", () => {
  assert.match(field(uniPayload, "obs:change_24h").period, /^24H/);
  assert.match(field(uniPayload, "obs:change_7d").period, /^7D/);
  assert.match(field(uniPayload, "obs:volume_24h").period, /^24H/);
  assert.equal(field(uniPayload, "obs:change_7d").periodRequired, true);
  assert.equal(field(uniPayload, "calc:market_cap_to_tvl").period, null, "a ratio is not a change over an interval");
  assert.match(field(uniPayload, "calc:price_growth_pct").period, /1 hour/, "a snapshot change states its actual interval");
});

test("P5. scope: protocol data is labelled protocol; unmapped providers are stated as unmapped", () => {
  assert.equal(field(uniPayload, "obs:tvl").scope, "protocol");
  assert.match(field(uniPayload, "obs:tvl").section, /associated protocol/);
  const defillama = btcPayload.scope.find((note) => note.id === "scope:defillama");
  const dex = btcPayload.scope.find((note) => note.id === "scope:dexpaprika");
  assert.equal(defillama.mapped, false);
  assert.match(defillama.statement, /no DeFiLlama protocol mapping/);
  assert.equal(dex.mapped, false);
  assert.match(dex.statement, /no verified DexPaprika address mapping/);
  assert.ok(!btcPayload.fields.some((item) => item.id === "obs:tvl"), "no protocol TVL is invented for an unmapped token");
});

test("P6. the AI input is the payload itself: compact, and without research-context-only data", () => {
  const text = buildProfileUserContent(uniPayload);
  const json = JSON.parse(text.slice(text.indexOf("<token_samurai_data>\n") + 21, text.lastIndexOf("\n</token_samurai_data>")));
  assert.deepEqual(json, JSON.parse(JSON.stringify(uniPayload)));
  assert.ok(!/"calculatedMetrics"|"providerFreshness"|"points"/.test(text), "no internal research-context structures");
  assert.ok(!uniPayload.fields.some((item) => /^obs:\d+$/.test(item.id)), "IDs name displayed fields, not database rows");
  assert.match(PROFILE_SYSTEM_INSTRUCTION, /Use only the supplied Token Samurai data as factual evidence\. Do not introduce unsupported factual claims\. If the supplied data is insufficient to support a conclusion, say so\./);
});

test("P7. Copy data text is the same dataset, human-readable", () => {
  const text = formatProfilePayloadText(btcPayload);
  assert.match(text, /^TOKEN SAMURAI — BITCOIN\nToken: Bitcoin \(BTC\)\nChain: Bitcoin\nCategory: Layer 1/);
  for (const item of btcPayload.fields) assert.ok(text.includes(`${item.label}: ${item.value}`), `${item.label} is copied`);
  assert.match(text, /Price: \$84,388\.12/);
  assert.match(text, /Maximum supply: 21M BTC/);
});

test("P8. the unchanged validator runs on payload IDs: grounded numbers and exact periods pass", () => {
  const change = field(uniPayload, "obs:change_7d");
  const ok = report({
    executiveSummary: { overview: "The profile shows token-level market data.", statements: [st("observed", "The profile shows a price of $9.33.", ["obs:price"])] },
    marketPerformance: { overview: "Changes are shown over their stated periods.", statements: [st("observed", `The 7-day change shown is ${change.value}.`, [change.id], change.period)] },
    dataGaps: [{ category: "unavailable_metric", detail: "Maximum supply is not reported.", sourceIds: ["obs:maximum_supply"] }],
  });
  assert.deepEqual(violations(ok, uniPayload), []);
});

test("P9. the validator still rejects unsupported numbers, missing periods, unknown IDs, and outside concepts", () => {
  const change = field(uniPayload, "obs:change_7d");
  const found = violations(report({
    executiveSummary: { overview: "The profile shows market data.", statements: [
      st("observed", "The price was $12.40.", ["obs:price"]),
      st("observed", `The 7-day change shown is ${change.value}.`, [change.id]),
      st("observed", "Supply is capped.", ["obs:row_123"]),
      st("interpretation", "The halving may explain this.", ["obs:price"]),
    ] },
  }), uniPayload);
  assert.ok(found.some((item) => /number\(s\) 12\.40/.test(item)), "unsupported number");
  assert.ok(found.some((item) => /cites time-based evidence but has no period/.test(item)), "missing period");
  assert.ok(found.some((item) => /unknown source ID "obs:row_123"/.test(item)), "unknown ID");
  assert.ok(found.some((item) => /introduces "halving"/.test(item)), "outside concept");
});

test("P10. the prompt's prescribed unmapped-provider wording still passes (mentioning the provider was never required to use it — see P20+)", () => {
  const wording = (provider) => {
    const match = PROFILE_SYSTEM_INSTRUCTION.match(new RegExp(`- ${provider}: "([^"]+)"`));
    assert.ok(match, `the prompt prescribes wording for ${provider}`);
    return match[1];
  };
  const defillama = wording("DeFiLlama");
  const dex = wording("DexPaprika");
  const btc = violations(report({
    fundamentalPerformance: { overview: `Protocol TVL, fees, and revenue are not shown: ${defillama}.`, statements: [] },
    liquidityMarketStructure: { overview: `DEX liquidity and pairs are not shown: ${dex}.`, statements: [] },
    dataGaps: [
      { category: "mapping_limitation", detail: `TVL is not reported: ${defillama}.`, sourceIds: ["scope:defillama"] },
      { category: "mapping_limitation", detail: `Liquidity is not reported: ${dex}.`, sourceIds: ["scope:dexpaprika"] },
    ],
  }), btcPayload);
  assert.deepEqual(btc, [], "the wording passes wherever it is used");
});

// ---- Structural evidence contract (profile-contract.ts) ----

const btcSchema = buildProfileResponseSchema(btcPayload);
const idEnum = (schema) => schema.properties.executiveSummary.properties.statements.items.properties.sourceIds.items.enum;

test("C1. the response schema's evidence IDs are generated per token from the payload (no hand-written list)", () => {
  assert.deepEqual(idEnum(btcSchema), allowedEvidenceIds(btcPayload));
  assert.deepEqual(allowedEvidenceIds(btcPayload), ["token", ...btcPayload.scope.map((note) => note.id), ...btcPayload.fields.map((item) => item.id)]);
  const uniIds = idEnum(buildProfileResponseSchema(uniPayload));
  assert.ok(uniIds.includes("obs:tvl") && !idEnum(btcSchema).includes("obs:tvl"), "each token gets its own IDs");
  for (const path of [btcSchema.properties.risks.items, btcSchema.properties.dataGaps.items, btcSchema.properties.furtherResearchQuestions.items]) {
    assert.deepEqual(path.properties.sourceIds.items.enum, allowedEvidenceIds(btcPayload), "risks, gaps, and questions are constrained too");
  }
  assert.ok(!idEnum(btcSchema).includes("obs:change_30d"), "an ID the payload lacks cannot be selected");
});

test("C2. the model does not write periods; the static report schema is unchanged", () => {
  const statement = btcSchema.properties.marketPerformance.properties.statements.items;
  assert.equal(statement.properties.period, undefined);
  assert.ok(!statement.required.includes("period"));
  assert.ok(ANALYSIS_RESPONSE_SCHEMA.required.length === 10 && JSON.stringify(ANALYSIS_RESPONSE_SCHEMA).includes('"period"'), "the stored report format keeps its period field");
  assert.equal(statement.additionalProperties, false);
});

test("C3. periods are attached from the cited fields, overriding anything a model writes", () => {
  const change = field(uniPayload, "obs:change_7d");
  const out = attachEvidencePeriods(report({ marketPerformance: { overview: "x", statements: [
    { kind: "observed", text: "t", sourceIds: [change.id] },
    { kind: "observed", text: "t", sourceIds: [change.id], period: "30 days (invented)" },
    { kind: "observed", text: "t", sourceIds: ["obs:price"] },
    { kind: "observed", text: "t", sourceIds: ["obs:price", "obs:change_24h"] },
  ] } }), uniPayload);
  assert.deepEqual(out.marketPerformance.statements.map((item) => item.period), [change.period, change.period, "", field(uniPayload, "obs:change_24h").period]);
  assert.equal(attachEvidencePeriods("not an object", uniPayload), "not an object", "malformed output is left for the schema check");
});

test("C4. after attachment, an invented ID fails the constrained schema; the unchanged validator still judges the rest", () => {
  const validation = buildProfileValidationSchema(uniPayload);
  const change = field(uniPayload, "obs:change_7d");
  const invented = attachEvidencePeriods(report({ executiveSummary: { overview: "x.", statements: [{ kind: "observed", text: "t", sourceIds: ["obs:change_30d"] }] } }), uniPayload);
  assert.ok(schemaErrors(invented, validation).some((error) => /value not in enum/.test(error)));
  const withoutPeriod = report({ marketPerformance: { overview: "Changes are shown over their stated periods.", statements: [
    { kind: "observed", text: `The 7-day change shown is ${change.value}.`, sourceIds: [change.id] },
  ] } });
  const attached = attachEvidencePeriods(withoutPeriod, uniPayload);
  assert.deepEqual(schemaErrors(attached, validation), []);
  assert.deepEqual(violations(attached, uniPayload), [], "the attached exact period satisfies the unchanged period rule");
  const namedPeriod = attachEvidencePeriods(report({ marketPerformance: { overview: "x.", statements: [
    { kind: "observed", text: "The price is shown over 30 days.", sourceIds: ["obs:price"] },
  ] } }), uniPayload);
  assert.ok(violations(namedPeriod, uniPayload).some((item) => /"30 days" is not a period established/.test(item)), "period words in text are still checked");
});

// ---- Regression: Production run gdj2hhww (GLM overview digits; Mistral unsupported 24/24-hour/30-day
// and a DexPaprika mention with no mapping). The generation prompt was strengthened (prompt.ts P7,
// 4g, U0, and rule 6) to stop these at the source; these tests prove the unchanged validator already
// rejects every one of them as a second line of defense, so the fix is generation-side only.

test("P11. an overview containing an ungrounded number is rejected, even when every statement below it is properly sourced (a grounded one now passes — see P25+)", () => {
  const found = violations(report({
    executiveSummary: { overview: "The price is $12.40 as of today.", statements: [st("observed", "The profile shows a price of $9.33.", ["obs:price"])] },
  }), uniPayload);
  assert.ok(found.some((item) => /executiveSummary\.overview: number\(s\) 12\.40 do not match any value in the cited sources\./.test(item)));
});

test("P12. a period is never inferred from a metric's name: citing a field with no period text still fails when the statement names a period anyway", () => {
  const found = violations(report({
    marketPerformance: { overview: "Market capitalization is shown.", statements: [
      st("observed", "Market capitalization increased over the past 24 hours.", ["obs:market_cap"]),
    ] },
  }), uniPayload);
  assert.ok(found.some((item) => /"24 hours" is not a period established by the cited sources/.test(item)), "\"market cap\" is not itself a 24-hour metric just because 24-hour metrics commonly exist elsewhere");
});

test("P13. a historical/trend claim is rejected when no hist: evidence is cited for it (the case behind a series with no usable stored points)", () => {
  const found = violations(report({
    marketPerformance: { overview: "The price is shown.", statements: [
      st("observed", "The price has trended upward over the past 90 days.", ["obs:price"]),
    ] },
  }), uniPayload);
  assert.ok(found.some((item) => /"90 days" is not a period established by the cited sources/.test(item)), "obs:price alone establishes no history, regardless of how many hist: series the payload defines elsewhere");
});

test("P14. a DexPaprika mention with no mapping now passes: mentioning a legitimate provider is not itself a violation (see P20+ for the full provider-neutral rule)", () => {
  const found = violations(report({
    liquidityMarketStructure: { overview: "DexPaprika does not cover this token.", statements: [] },
  }), btcPayload);
  assert.deepEqual(found, [], "GLM/Mistral's gdj2hhww text made no unsupported factual claim, so it should never have been fatal");
});

// ---- Regression: Production run svtndn2v (profile-5 cut GLM 3→1 and Mistral 9→5 violations, but
// left two patterns: DexPaprika named in overview/research-question text with no mapping, and a
// period/number inferred from a metric — including a calculated metric — that does not itself state
// it). prompt.ts U1a and the extended rule 6 target these on the generation side; P16 was updated
// after the validator's own provider-name policing was retired (see P20+) in favor of relying
// entirely on number/period grounding, which still catches genuinely fabricated facts.

test("P16. a bare DexPaprika mention in a research question's rationale with no mapping now passes (no fact is claimed)", () => {
  const found = violations(report({
    furtherResearchQuestions: [{ question: "What is the on-chain market structure for this token?", rationale: "DexPaprika does not report pairs for this token.", sourceIds: [] }],
  }), btcPayload);
  assert.deepEqual(found, [], "Mistral's svtndn2v text named the provider but claimed no specific fact");
});

test("P17. an unsupported '30 days' in a risk detail is rejected, exactly as Mistral's svtndn2v risks[3].detail failure", () => {
  const ratio = field(uniPayload, "calc:market_cap_to_tvl");
  const found = violations(report({
    risks: [{ title: "Valuation ratio risk", basis: "evidence", detail: "The market-cap-to-TVL ratio has moved over the past 30 days.", sourceIds: [ratio.id] }],
  }), uniPayload);
  assert.ok(found.some((item) => /"30 days" is not a period established by the cited sources/.test(item)), "a point-in-time ratio (no period) does not establish a 30-day window just because 30-day comparisons are common");
});

test("P18. a period and number are never inferred from the mere existence of a calculated metric, exactly as Mistral's svtndn2v marketPerformance.statements[5] failure (number 24 and \"24-hour\")", () => {
  // A field with no clock-derived note text (deterministic across test runs, unlike a "Measured … UTC" note).
  const ratio = field(btcPayload, "calc:circulating_of_max_supply");
  assert.equal(ratio.period, null, "a composition ratio is a point-in-time calculated metric with no period of its own");
  const found = violations(report({
    marketPerformance: { overview: "The circulating share is shown.", statements: [
      st("calculated", "The circulating share changed by 24% over the past 24 hours.", [ratio.id]),
    ] },
  }), btcPayload);
  assert.ok(found.some((item) => /number\(s\) 24, 24 do not match any value in the cited sources/.test(item)), "the invented number 24");
  assert.ok(found.some((item) => /"24 hours" is not a period established by the cited sources/.test(item)), "a calculated ratio existing at all does not establish a 24-hour period");
});

test("P19. a properly evidence-established period (including a calculated metric's own real interval) remains valid", () => {
  const growth = field(uniPayload, "calc:price_growth_pct");
  assert.match(growth.period, /1 hour/, "a snapshot change states its own real interval, not a rounded 24-hour convention");
  const found = violations(report({
    marketPerformance: { overview: "Price changes are shown over their stated periods.", statements: [
      st("calculated", `Price decreased by about ${Math.abs(growth.raw).toFixed(1)}% between the two most recent stored observations.`, [growth.id], growth.period),
    ] },
  }), uniPayload);
  assert.deepEqual(found, []);
});

test("P15. valid numeric and period claims inside properly sourced statements still pass (the fix does not over-tighten the validator)", () => {
  const change = field(uniPayload, "obs:change_24h");
  const hist = uniPayload.fields.find((item) => item.id.startsWith("hist:price_") && item.periodRequired);
  const found = violations(report({
    marketPerformance: { overview: "Price changes are shown over their stated periods.", statements: [
      st("observed", `CoinGecko reported a 24-hour price change of ${change.value}.`, [change.id], change.period),
      ...(hist ? [st("observed", `Price history shows ${hist.value}.`, [hist.id], hist.period)] : []),
    ] },
  }), uniPayload);
  assert.deepEqual(found, []);
});

// ---- Shared evidence-validation semantics: legitimate Token Samurai providers (CoinGecko,
// DeFiLlama, DexPaprika, GeckoTerminal) may always be mentioned, mapped or not — Token Samurai
// genuinely uses all four. Only a claim that a provider supplied a specific fact this context does
// not contain is a violation, and that is caught by the (unchanged) number/period grounding rules
// regardless of which provider, if any, the text names. This lives in evidence-rules.ts/schema.ts,
// so it applies identically for all six AI providers with no router or provider-specific change.

const LEGITIMATE_PROVIDERS = ["DexPaprika", "DeFiLlama", "CoinGecko", "GeckoTerminal"];

test("P20. mentioning any of the four legitimate providers is never itself a violation, mapped or not", () => {
  for (const provider of LEGITIMATE_PROVIDERS) {
    const found = violations(report({
      liquidityMarketStructure: { overview: `${provider} data is unavailable for this token.`, statements: [] },
    }), btcPayload);
    assert.deepEqual(found, [], `"${provider} data is unavailable for this token." should pass`);
  }
  assert.deepEqual(violations(report({
    executiveSummary: { overview: "Token Samurai uses CoinGecko for market data.", statements: [] },
  }), btcPayload), [], "a platform-level fact about a provider is not a token-specific claim");
});

test("P21. a research question referring to any of the four providers passes when it asserts no fact as already established", () => {
  for (const provider of LEGITIMATE_PROVIDERS) {
    const found = violations(report({
      furtherResearchQuestions: [{
        question: `What does ${provider} report about this token's market data?`,
        rationale: `Further research could examine ${provider} data alongside the available context.`,
        sourceIds: [],
      }],
    }), btcPayload);
    assert.deepEqual(found, [], `a research question naming ${provider} should pass`);
  }
});

test("P22. an unsupported numerical claim attributed to any of the four providers still fails", () => {
  const claims = {
    "DexPaprika": "DexPaprika shows $118K in liquidity.",
    "DeFiLlama": "DeFiLlama reports $120M TVL.",
    "CoinGecko": "CoinGecko reports a $5.2B market cap.",
    "GeckoTerminal": "GeckoTerminal reports $3.4M liquidity.",
  };
  for (const provider of LEGITIMATE_PROVIDERS) {
    const found = violations(report({
      executiveSummary: { overview: "The token is summarized.", statements: [st("observed", claims[provider], ["obs:price"])] },
    }), btcPayload);
    assert.ok(found.some((item) => /number\(s\)/.test(item)), `an unsupported numeric claim from ${provider} should still fail ("${claims[provider]}"); got ${JSON.stringify(found)}`);
  }
});

test("P23. an unsupported historical claim attributed to any of the four providers still fails", () => {
  const claims = {
    "DexPaprika": "DexPaprika shows a 24-hour volume of $9M.",
    "DeFiLlama": "DeFiLlama recorded a 30% TVL decline over 30 days.",
    "CoinGecko": "CoinGecko recorded a 30% decline over 30 days.",
    "GeckoTerminal": "GeckoTerminal shows a 24-hour volume increase of 12%.",
  };
  for (const provider of LEGITIMATE_PROVIDERS) {
    const found = violations(report({
      marketPerformance: { overview: "Price history is summarized.", statements: [st("observed", claims[provider], ["obs:price"])] },
    }), btcPayload);
    assert.ok(found.some((item) => /number\(s\)/.test(item) || /is not a period established/.test(item)), `an unsupported historical claim from ${provider} should still fail ("${claims[provider]}"); got ${JSON.stringify(found)}`);
  }
});

test("P24. a properly evidenced provider claim still passes: naming the provider adds no extra scrutiny beyond normal grounding", () => {
  const tvl = field(uniPayload, "obs:tvl");
  const fees = field(uniPayload, "obs:fees_24h");
  const found = violations(report({
    fundamentalPerformance: { overview: "Protocol fundamentals are reported by DeFiLlama.", statements: [
      st("observed", `DeFiLlama reports a protocol TVL of about ${tvl.value}.`, [tvl.id]),
      st("observed", `DeFiLlama reports fees of about ${fees.value}.`, [fees.id], fees.period),
    ] },
  }), uniPayload);
  assert.deepEqual(found, []);
});

// ---- Regression: Production run 1f6fha8x — Mistral's complete, otherwise-valid report was
// rejected solely because tokenomics.overview repeated a number its own cited statement already
// established. schema.ts's section() now grounds overview numbers/dates against the section's own
// cited evidence exactly like periods (grounded => warning, ungrounded => still fatal), instead of
// banning every digit outright.

test("P25. a grounded number in tokenomics.overview now passes (previously fatal on any digit at all)", () => {
  const circ = field(uniPayload, "obs:circulating_supply");
  const found = violations(report({
    tokenomics: { overview: "Circulating supply is about 620.67M tokens, as CoinGecko reports.", statements: [
      st("observed", `CoinGecko reports a circulating supply of about ${circ.value}.`, [circ.id]),
    ] },
  }), uniPayload);
  assert.deepEqual(found, []);
});

test("P26. a grounded date in tokenomics.overview now passes", () => {
  const fresh = field(uniPayload, "fresh:calculated_metrics");
  const found = violations(report({
    tokenomics: { overview: `Supply figures reflect data ${fresh.value}.`, statements: [
      st("uncertainty", `Calculated tokenomics metrics were ${fresh.value}.`, [fresh.id]),
    ] },
  }), uniPayload);
  assert.deepEqual(found, []);
});

test("P27. an unsupported number in tokenomics.overview still fails", () => {
  const circ = field(uniPayload, "obs:circulating_supply");
  const found = violations(report({
    tokenomics: { overview: "Circulating supply is about 8888M tokens.", statements: [
      st("observed", `CoinGecko reports a circulating supply of about ${circ.value}.`, [circ.id]),
    ] },
  }), uniPayload);
  assert.ok(found.some((item) => /tokenomics\.overview: number\(s\) 8888 do not match any value in the cited sources\./.test(item)));
});

test("P28. an unsupported date/period in tokenomics.overview still fails", () => {
  const circ = field(uniPayload, "obs:circulating_supply");
  const found = violations(report({
    tokenomics: { overview: "Supply figures are reported over a 30-day window.", statements: [
      st("observed", `CoinGecko reports a circulating supply of about ${circ.value}.`, [circ.id]),
    ] },
  }), uniPayload);
  assert.ok(found.some((item) => /tokenomics\.overview: names a period \("30-day"\)/.test(item)));
});

// ---- Regression: Production run 3zwsdqzh — Mistral's report was rejected for exactly 3 issues,
// all in marketPerformance: an unsupported "7 days", plus an unsupported number 24 and "24-hour"
// on a separate statement. prompt.ts rule 6a reinforces that marketPerformance statements are
// grounded exactly like any other (a calc: or obs: field supports only its own stated value and
// period), and the unchanged validator remains the actual enforcement — these prove it still
// passes a genuinely grounded 7-day/24-hour statement and still rejects each unsupported case.

test("P29. a grounded 7-day and a grounded 24-hour statement in marketPerformance both pass", () => {
  const change7d = field(uniPayload, "obs:change_7d");
  const change24h = field(uniPayload, "obs:change_24h");
  const found = violations(report({
    marketPerformance: { overview: "Price changes are reported over their own stated periods.", statements: [
      st("observed", `CoinGecko reported a price change of about ${change7d.value} over its rolling 7-day window.`, [change7d.id], change7d.period),
      st("observed", `CoinGecko reported a price change of about ${change24h.value} over its rolling 24-hour window.`, [change24h.id], change24h.period),
    ] },
  }), uniPayload);
  assert.deepEqual(found, []);
});

test("P30. an unsupported inferred 7-day period in marketPerformance still fails", () => {
  const marketCap = field(uniPayload, "obs:market_cap");
  const found = violations(report({
    marketPerformance: { overview: "Market capitalization is reported.", statements: [
      st("observed", `Market capitalization was about ${marketCap.value} over the past 7 days.`, [marketCap.id]),
    ] },
  }), uniPayload);
  assert.ok(found.some((item) => /marketPerformance\.statements\[0\]\.text: "7 days" is not a period established by the cited sources\./.test(item)), "obs:market_cap has no period of its own, regardless of how commonly a 7-day figure is reported elsewhere");
});

test("P31. an unsupported inferred 24-hour period in marketPerformance still fails", () => {
  const marketCap = field(uniPayload, "obs:market_cap");
  const found = violations(report({
    marketPerformance: { overview: "Market capitalization is reported.", statements: [
      st("observed", `Market capitalization was about ${marketCap.value} over the past 24 hours.`, [marketCap.id]),
    ] },
  }), uniPayload);
  assert.ok(found.some((item) => /marketPerformance\.statements\[0\]\.text: "24 hours" is not a period established by the cited sources\./.test(item)));
});

test("P32. an unsupported numerical value in marketPerformance still fails, exactly as Mistral's svtndn2v marketPerformance.statements[11] failure (number 24)", () => {
  const change24h = field(uniPayload, "obs:change_24h");
  const found = violations(report({
    marketPerformance: { overview: "Price changes are reported over their own stated periods.", statements: [
      st("observed", "The 24-hour price change was about 87%.", [change24h.id], change24h.period),
    ] },
  }), uniPayload);
  assert.ok(found.some((item) => /marketPerformance\.statements\[0\]\.text: number\(s\) 87 do not match any value in the cited sources\./.test(item)), "the field's own real change value, not the invented number 87");
});

// ---- Regression: the successful Cardano Production run exposed raw evidence-contract markers
// (obs:price, hist:price_30d, calc:volume_to_market_cap, scope:defillama, ...) as literal visible
// text. Traced to two places: (1) the model can write an ID inline in prose (now a fatal validator
// rule, so it is caught before it is ever stored), and (2) the renderer showed the raw id instead
// of its human-readable provenance label (fixed in DeepAnalysisPanel.tsx — see
// tests/deep-analysis-panel.test.mjs). This section also covers Part 2's semantic-quality review:
// unsupported causal language, overstated characterization words, and legitimate scope statements.

test("P33. an internal evidence marker written literally into prose text is rejected, even when the statement is otherwise properly sourced", () => {
  const price = field(uniPayload, "obs:price");
  const found = violations(report({
    executiveSummary: { overview: "The price is shown.", statements: [
      st("observed", `The price shown in obs:price is ${price.value}.`, [price.id]),
    ] },
  }), uniPayload);
  assert.ok(found.some((item) => /executiveSummary\.statements\[0\]\.text: contains the internal evidence marker "obs:price"; cite it in sourceIds instead of writing it in the text\./.test(item)));
});

test("P34. internal evidence markers remain fully available to the validator: sourceIds still cite and ground exactly as before, only prose text may not repeat them literally", () => {
  const price = field(uniPayload, "obs:price");
  const tvl = field(uniPayload, "obs:tvl");
  const found = violations(report({
    executiveSummary: { overview: "The price is shown.", statements: [st("observed", `The profile shows a price of ${price.value}.`, [price.id])] },
    fundamentalPerformance: { overview: "Protocol fundamentals are reported.", statements: [st("observed", `Protocol TVL is about ${tvl.value}.`, [tvl.id])] },
  }), uniPayload);
  assert.deepEqual(found, [], "citing obs:price and obs:tvl in sourceIds — never in text — passes exactly as it always has");
});

test("P35. unsupported causal language is rejected regardless of grounding, but a legitimate 'due to <data limitation>' explanation remains allowed", () => {
  const price = field(uniPayload, "obs:price");
  const marketCap = field(uniPayload, "obs:market_cap");
  const causal = violations(report({
    marketPerformance: { overview: "Price and market cap are shown.", statements: [
      st("interpretation", `The change in ${price.value} drove the market capitalization of ${marketCap.value}.`, [price.id, marketCap.id]),
    ] },
  }), uniPayload);
  assert.ok(causal.some((item) => /marketPerformance\.statements\[0\]\.text: causal language \("drove"\)/.test(item)));
  const dueTo = violations(report({
    liquidityMarketStructure: { overview: "DEX market structure is unavailable for this token.", statements: [
      st("uncertainty", "DEX market data is unavailable due to no verified DexPaprika mapping for this token.", ["scope:dexpaprika"]),
    ] },
  }), uniPayload);
  assert.deepEqual(dueTo, [], "'due to' explaining a data limitation is not a market-causal claim and remains allowed");
});

test("P36. overstated characterization words ('consistent', 'significant', 'stable') are recorded as warnings, not silently accepted or fatally rejected, exactly like existing analytical language", () => {
  const price = field(uniPayload, "obs:price");
  const output = report({
    executiveSummary: { overview: "The price is shown.", statements: [
      st("observed", `The price has remained consistent at about ${price.value}.`, [price.id]),
    ] },
  });
  assert.deepEqual(violations(output, uniPayload), [], "the underlying claim is grounded, so the word choice alone does not fail the report");
  assert.ok(warnings(output, uniPayload).some((item) => /executiveSummary\.statements\[0\]\.text: analytical language \("consistent"\)/.test(item)), "but it is still flagged for review");
});

test("P37. legitimate DeFiLlama/DexPaprika scope-unavailability statements remain valid after this round's changes", () => {
  const found = violations(report({
    fundamentalPerformance: { overview: "This section's data is unavailable for this token.", statements: [
      st("uncertainty", "There is no DeFiLlama mapping for this token, so this data is unavailable by design.", ["scope:defillama"]),
    ] },
    liquidityMarketStructure: { overview: "This section's data is unavailable for this token.", statements: [
      st("uncertainty", "There is no verified DexPaprika mapping for this token, so DEX data is unavailable by design.", ["scope:dexpaprika"]),
    ] },
  }), btcPayload);
  assert.deepEqual(found, []);
});

// ---- Regression: recent Production Mistral (ministral-14b-2512) failures — observed statements
// without obs:/hist: evidence, unsupported numbers, unsupported "24-hour"/"7 days" periods. prompt.ts
// rule 4h and its valid/invalid example reinforce splitting independently-sourced facts into their
// own statements; the (unchanged) validator remains the actual enforcement. Each test below maps to
// one bullet of the requested regression checklist.

test("P38. an 'observed' marketPerformance statement citing no obs:/hist: field is rejected", () => {
  const ratio = field(uniPayload, "calc:market_cap_to_tvl");
  const found = violations(report({
    marketPerformance: { overview: "Price changes are reported.", statements: [
      st("observed", "The price changed recently.", [ratio.id]),
    ] },
  }), uniPayload);
  assert.ok(found.some((item) => /marketPerformance\.statements\[0\]: a "observed" statement must cite an observation \(obs:\) or history \(hist:\) source\./.test(item)));
});

test("P39. an 'observed' valuation statement citing no obs:/hist: field is rejected", () => {
  const ratio = field(uniPayload, "calc:market_cap_to_tvl");
  const found = violations(report({
    valuation: { overview: "Valuation ratios are reported.", statements: [
      st("observed", "The valuation ratio was favorable.", [ratio.id]),
    ] },
  }), uniPayload);
  assert.ok(found.some((item) => /valuation\.statements\[0\]: a "observed" statement must cite an observation \(obs:\) or history \(hist:\) source\./.test(item)));
});

test("P40. a valid obs: statement is accepted", () => {
  const price = field(uniPayload, "obs:price");
  const found = violations(report({
    executiveSummary: { overview: "The price is shown.", statements: [st("observed", `The profile shows a price of ${price.value}.`, [price.id])] },
  }), uniPayload);
  assert.deepEqual(found, []);
});

test("P41. a valid hist: statement (a real, grounded price-history window) is accepted", () => {
  const hist30d = field(uniPayload, "hist:price_30d");
  const found = violations(report({
    marketPerformance: { overview: "Price history is reported over its stated window.", statements: [
      st("observed", `Price history shows ${hist30d.value}.`, [hist30d.id], hist30d.period),
    ] },
  }), uniPayload);
  assert.deepEqual(found, []);
});

test("P42. a calc: statement is accepted only when its own inputs/period are grounded, and rejected when its number/period is invented instead", () => {
  const growth = field(uniPayload, "calc:price_growth_pct");
  const grounded = violations(report({
    marketPerformance: { overview: "Price changes are reported over their stated periods.", statements: [
      st("calculated", `Price decreased by about ${Math.abs(growth.raw).toFixed(1)}% between the two most recent stored observations.`, [growth.id], growth.period),
    ] },
  }), uniPayload);
  assert.deepEqual(grounded, [], "the calculated metric's own real value and period are used, so it passes");
  const invented = violations(report({
    marketPerformance: { overview: "Price changes are reported over their stated periods.", statements: [
      st("calculated", "Price decreased by about 8888% over the past 7 days.", [growth.id]),
    ] },
  }), uniPayload);
  assert.ok(invented.some((item) => /number\(s\) 8888, 7 do not match any value in the cited sources/.test(item)));
  assert.ok(invented.some((item) => /"7 days" is not a period established by the cited sources/.test(item)));
});

// ---- Risk profile: 7D/30D/90D volatility must genuinely differ by window, never resample the same
// rolling-7-day reading under three labels. (historical-series.ts's own rollingVolatility/riskProfile
// are unchanged and correctly power the Market History chart — see risk-profile.test.mjs's own
// coverage of that; this covers the single-figure AI-report field this module builds from it.) ----

/** A UTC-midnight timestamp `daysAgo` days before the most recent UTC midnight — real-time based (no
 *  hardcoded past date), so `dailyCloses`'s "nearest 00:00 UTC" sampling picks it up regardless of
 *  what day the test actually runs on. */
function utcMidnight(daysAgo) {
  const now = new Date();
  const midnightToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(midnightToday - daysAgo * 24 * HOUR).toISOString();
}

function dailyPriceRows(tokenId, values) {
  let id = 90_000;
  return values.map(([daysAgo, price]) => ({
    id: id++, token_id: tokenId, chain_id: "bitcoin", provider_id: "coingecko", metric_id: "price_usd", value: price,
    status: "available", observed_at: utcMidnight(daysAgo), collected_at: utcMidnight(daysAgo), window_days: null, note: null,
  }));
}

test("P43. 7D and 30D risk-profile volatility genuinely differ when the underlying daily closes actually have a different character (previously both silently resampled the same rolling-7-day figure)", async () => {
  // Calm for days 94..7 (small wiggle), choppy for the most recent week (days 6..0) — a real
  // difference in realized volatility between the 7-day and 30-day lookback.
  const values = [];
  for (let d = 94; d >= 0; d -= 1) {
    const choppy = d < 7;
    values.push([d, 80000 + d * 20 + Math.sin(d * (choppy ? 2.3 : 0.4)) * (choppy ? 4000 : 300)]);
  }
  const seedData = seed("bitcoin-btc", "bitcoin", []);
  seedData.token_metric_observations = dailyPriceRows("bitcoin-btc", values);
  const btc = await profile("bitcoin-btc", seedData);
  const payload = buildProfilePayload(btc);
  const risk7d = field(payload, "hist:risk_7d");
  const risk30d = field(payload, "hist:risk_30d");
  assert.ok(risk7d && risk30d, "both windows produce a risk-profile field from 95 days of daily closes");
  assert.notEqual(risk7d.value, risk30d.value, "the 7D and 30D cards must state different readings, not the same rolling-7-day figure twice");
});

test("P44. a risk-profile window without enough consecutive daily closes for its own lookback omits volatility rather than fabricating or resampling a shorter window's figure", async () => {
  // Only 40 days of history: not enough for a genuine 90-consecutive-day volatility lookback.
  const values = [];
  for (let d = 39; d >= 0; d -= 1) values.push([d, 80000 + Math.sin(d * 0.5) * 1000]);
  const seedData = seed("bitcoin-btc", "bitcoin", []);
  seedData.token_metric_observations = dailyPriceRows("bitcoin-btc", values);
  const btc = await profile("bitcoin-btc", seedData);
  const payload = buildProfilePayload(btc);
  const risk90d = field(payload, "hist:risk_90d");
  if (risk90d) assert.doesNotMatch(risk90d.value, /volatility/i, "no genuine 90-day volatility can be computed from only 40 days of history, so it must not appear at all — never a duplicated 7D/30D figure standing in for it");
});

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
console.log(`${cases.length - failures}/${cases.length} profile-payload checks passed.`);
if (failures > 0) process.exitCode = 1;
