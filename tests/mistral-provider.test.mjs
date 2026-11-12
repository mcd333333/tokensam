// Mistral provider through the existing router, with AI_PROVIDER_PRIORITY=mistral,gemini,openrouter.
// Mocked fetch only (no network, no quota).

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { retryAfterMs } from "../src/lib/analysis/ai/adapters.ts";
import { COOLDOWN_POLICY, createProviderHealth } from "../src/lib/analysis/ai/health.ts";
import { schemaErrors } from "../src/lib/analysis/ai/json-schema.ts";
import { allowedFreeTiers, buildProviders, providerPriority } from "../src/lib/analysis/ai/registry.ts";
import { NoProviderSucceededError, routeReport } from "../src/lib/analysis/ai/router.ts";
import { buildEvidenceIndex } from "../src/lib/analysis/evidence-rules.ts";
import { SYSTEM_INSTRUCTION, buildUserContent } from "../src/lib/analysis/prompt.ts";
import { ANALYSIS_RESPONSE_SCHEMA, AnalysisValidationError, validateModelAnalysis } from "../src/lib/analysis/schema.ts";
import { generateTokenAnalysis } from "../src/lib/analysis/service.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const MISTRAL_KEY = "mistral-key-not-real-m1";
const GEMINI_KEY = "gemini-key-not-real-m1";
const OR_KEY = "or-key-not-real-m1";
const ENV = { MISTRAL_API_KEY: MISTRAL_KEY, GEMINI_API_KEY: GEMINI_KEY, OPENROUTER_API_KEY: OR_KEY, OPENROUTER_MODEL: "openrouter/free", AI_PROVIDER_PRIORITY: "mistral,gemini,openrouter" };

const context = JSON.parse(readFileSync("tests/fixtures/bitcoin-context-2026-09-24.json", "utf8"));
const obs = (metric) => context.observations.find((item) => item.provider === "CoinGecko" && item.metric === metric);
const calc = (metricId) => context.calculatedMetrics.find((item) => item.metricId === metricId);
const st = (kind, text, sourceIds, period = "") => ({ kind, text, sourceIds, period });
function validReport() {
  const growth = calc("price_growth_pct");
  return {
    executiveSummary: { overview: "Bitcoin evidence here is limited to CoinGecko market data.", statements: [st("observed", `CoinGecko reported a price of about $${Math.round(obs("price_usd").value).toLocaleString("en-US")}.`, [obs("price_usd").id])] },
    marketPerformance: { overview: "Price changes are reported over their own stated periods.", statements: [st("calculated", `Price decreased by about ${Math.abs(growth.value).toFixed(2)}% between the two most recent stored observations.`, [growth.id], growth.period.label)] },
    fundamentalPerformance: { overview: "No protocol-level fundamentals are available for this token.", statements: [st("uncertainty", "Bitcoin has no DeFiLlama mapping, so protocol TVL, fees, and revenue are unavailable by design.", ["scope:defillama"])] },
    valuation: { overview: "Only one valuation ratio is available.", statements: [st("calculated", `CoinGecko volume was about ${(calc("volume_to_market_cap").value * 100).toFixed(1)}% of market capitalization.`, [calc("volume_to_market_cap").id])] },
    marketFundamentalRelationships: { overview: "No price-to-fundamentals relationship can be assessed for this token.", statements: [] },
    liquidityMarketStructure: { overview: "DEX market structure is unavailable by design for this token.", statements: [st("uncertainty", "No verified DexPaprika address mapping exists for Bitcoin, so DEX metrics are unavailable by design.", ["scope:dexpaprika"])] },
    tokenomics: { overview: "Supply figures come from CoinGecko.", statements: [] },
    risks: [{ title: "Protocol fundamentals unavailable", basis: "data_limitation", detail: "Bitcoin has no DeFiLlama mapping, so TVL, fees, and revenue are unavailable by design.", sourceIds: ["scope:defillama"] }],
    dataGaps: [{ category: "mapping_limitation", detail: "Bitcoin has no DeFiLlama mapping; TVL, fees, and revenue are unavailable by design.", sourceIds: ["scope:defillama"] }],
    furtherResearchQuestions: [{ question: "Which additional data sources could describe Bitcoin market structure beyond CoinGecko aggregates?", rationale: "Only CoinGecko market data is available in this context.", sourceIds: [] }],
  };
}
const evidence = buildEvidenceIndex(context);
function validate(json) {
  const shape = schemaErrors(json, ANALYSIS_RESPONSE_SCHEMA);
  if (shape.length) return { ok: false, category: "structured_output", violations: shape.length, reason: "schema_mismatch" };
  try {
    return { ok: true, value: validateModelAnalysis(json, evidence), violations: 0 };
  } catch (error) {
    if (!(error instanceof AnalysisValidationError)) throw error;
    return { ok: false, category: "validation", violations: error.violations.length, reason: "evidence_contract" };
  }
}
const request = { systemInstruction: SYSTEM_INSTRUCTION, userText: buildUserContent(context), responseSchema: ANALYSIS_RESPONSE_SCHEMA, estimatedInputTokens: 22_000 };

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const mistralOk = (report = validReport()) => () => json({ id: "cmpl-1", model: "mistral-medium-2604", choices: [{ finish_reason: "stop", message: { role: "assistant", content: typeof report === "string" ? report : JSON.stringify(report) } }], usage: { prompt_tokens: 21800, completion_tokens: 3900, total_tokens: 25700 } });
const geminiOk = () => () => json({ candidates: [{ content: { parts: [{ text: JSON.stringify(validReport()) }] }, finishReason: "STOP" }], modelVersion: "gemini-served" });
const orOk = () => () => json({ model: "vendor/model:free", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(validReport()) } }] });
const status = (code, headers = {}) => () => json({ object: "error", message: `upstream detail ${MISTRAL_KEY}`, type: "error", code: String(code) }, code, headers);

const HOSTS = { mistral: "api.mistral.ai", gemini: "generativelanguage.googleapis.com", openrouter: "openrouter.ai" };
function scripted(script) {
  const calls = { mistral: [], gemini: [], openrouter: [] };
  const fetchImpl = async (url, init) => {
    const host = new URL(String(url)).hostname;
    const id = Object.keys(HOSTS).find((key) => host === HOSTS[key]);
    if (!id) throw new Error(`Unexpected host ${host}`);
    calls[id].push({ url: String(url), init });
    const next = script[id]?.shift();
    if (!next) throw new Error(`No scripted ${id} response left`);
    return next();
  };
  return { fetchImpl, calls };
}
async function route(script, { env = ENV, health = createProviderHealth(), now = Date.now, sleep = () => Promise.resolve() } = {}) {
  const { fetchImpl, calls } = scripted(script);
  try {
    const result = await routeReport({
      request, providers: buildProviders(env), priority: providerPriority(env), allowedTiers: allowedFreeTiers(env),
      deadlineAt: now() + 240_000, validate, health, clock: now, fetchImpl, sleep, diagnostics: { runId: "m", sink: () => {} },
    });
    return { result, calls, health };
  } catch (error) {
    if (error instanceof NoProviderSucceededError) return { error, calls, health };
    throw error;
  }
}
const tried = (attempts) => attempts.filter((item) => item.action === "attempted").map((item) => `${item.providerId}:${item.validationPassed ? "ok" : item.category}`);

test("M1. provider ordering: mistral, gemini, openrouter; Mistral is FREE, JSON-schema capable, 256K context", () => {
  assert.deepEqual(providerPriority(ENV), ["mistral", "gemini", "openrouter"]);
  const mistral = buildProviders(ENV).get("mistral");
  assert.equal(mistral.configured, true);
  assert.equal(mistral.model, "mistral-medium-2604");
  assert.equal(buildProviders({ ...ENV, MISTRAL_MODEL: "mistral-small-2603" }).get("mistral").model, "mistral-small-2603", "MISTRAL_MODEL overrides the default");
  assert.equal(mistral.freeTier.status, "FREE");
  assert.equal(mistral.capabilities.structuredOutput, "json_schema");
  assert.equal(mistral.capabilities.maxContextTokens, 256_000);
});

test("M2. Mistral success: one request with the existing schema as strict json_schema; the router stops (no Gemini, no OpenRouter)", async () => {
  const { result, calls } = await route({ mistral: [mistralOk()] });
  assert.equal(result.provider.id, "mistral");
  assert.equal(calls.mistral.length, 1);
  assert.equal(calls.gemini.length, 0, "Gemini is not called");
  assert.equal(calls.openrouter.length, 0, "OpenRouter is not called");
  const [call] = calls.mistral;
  assert.equal(call.url, "https://api.mistral.ai/v1/chat/completions");
  assert.equal(call.init.headers.authorization, `Bearer ${MISTRAL_KEY}`);
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, "mistral-medium-2604");
  assert.deepEqual(body.messages, [{ role: "system", content: SYSTEM_INSTRUCTION }, { role: "user", content: request.userText }]);
  assert.deepEqual(body.response_format, { type: "json_schema", json_schema: { name: "token_samurai_deep_analysis", strict: true, schema: JSON.parse(JSON.stringify(ANALYSIS_RESPONSE_SCHEMA)) } });
  assert.ok(!call.init.body.includes(MISTRAL_KEY), "the key is only in the header");
  assert.equal(result.attempt.validationPassed, true);
  assert.deepEqual(result.attempt.usage, { inputTokens: 21800, outputTokens: 3900, reasoningTokens: null });
  assert.equal(result.attempt.servedModel, "mistral-medium-2604");
});

test("M3. malformed Mistral output: one controlled retry, then Gemini", async () => {
  const { result, calls } = await route({ mistral: [mistralOk("```json\n{}\n```"), mistralOk("{not json")], gemini: [geminiOk()] });
  assert.equal(calls.mistral.length, 2);
  assert.deepEqual(tried(result.attempts), ["mistral:structured_output", "mistral:structured_output", "gemini:ok"]);
  assert.equal(calls.openrouter.length, 0);
});

test("M4. HTTP 429 with Retry-After: one bounded in-adapter retry (capped at 10s, not the full 300s), then cooldown honours the real Retry-After; Gemini is next", async () => {
  const now = 2_000_000;
  const { result, calls, health } = await route({ mistral: [status(429, { "retry-after": "300" }), status(429, { "retry-after": "300" })], gemini: [geminiOk()] }, { now: () => now });
  assert.equal(calls.mistral.length, 2, "one bounded retry, capped well under the 300s Retry-After");
  assert.equal(result.provider.id, "gemini");
  const state = health.get("mistral", now);
  assert.equal(state.status, "cooldown");
  assert.equal(state.until, now + 300_000, "300 s Retry-After outlasts the 60 s base cooldown");
  assert.equal(retryAfterMs("7"), 7000);
  assert.equal(retryAfterMs(new Date(now + 90_000).toUTCString(), now) > 0, true);
  assert.equal(retryAfterMs("soon"), null);
  const capped = createProviderHealth();
  capped.recordFailure("mistral", "transient", now, 48 * 60 * 60_000);
  assert.equal(capped.get("mistral", now).until, now + COOLDOWN_POLICY.quotaMs, "Retry-After is capped");
});

test("M5. HTTP 401/403 and 400: configuration errors, never retried; Gemini is next", async () => {
  for (const code of [401, 403, 400]) {
    const { result, calls, health } = await route({ mistral: [status(code)], gemini: [geminiOk()] });
    assert.equal(calls.mistral.length, 1, `HTTP ${code}`);
    assert.equal(result.attempts[0].category, "configuration");
    assert.equal(health.get("mistral", Date.now()).status, "configuration_error");
    assert.equal(result.provider.id, "gemini");
  }
});

test("M6. HTTP 5xx, 408, timeout, and network failure: transient, one bounded in-adapter retry (Task 1), Gemini next", async () => {
  const timeout = () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); };
  const network = () => { throw new TypeError("fetch failed"); };
  for (const failure of [status(500), status(503), status(408), timeout, network]) {
    const { result, calls } = await route({ mistral: [failure, failure], gemini: [geminiOk()] });
    assert.equal(calls.mistral.length, 2, "one bounded retry before falling back");
    assert.equal(result.attempts[0].category, "transient");
    assert.equal(result.attempts[0].reason.startsWith("mistral_"), true, "failures are labelled as Mistral's");
    assert.equal(result.provider.id, "gemini");
  }
});

test("M7. fallback chain: Mistral fails → Gemini fails → OpenRouter", async () => {
  const { result, calls } = await route({ mistral: [status(502), status(502)], gemini: [() => json({ error: { code: 503, status: "UNAVAILABLE" } }, 503)], openrouter: [orOk()] });
  assert.deepEqual(tried(result.attempts), ["mistral:transient", "gemini:transient", "openrouter:ok"]);
  // Mistral gets its one bounded in-adapter retry (Task 1); Gemini and OpenRouter are unaffected (existing, intentional single-attempt designs).
  assert.deepEqual([calls.mistral.length, calls.gemini.length, calls.openrouter.length], [2, 1, 1]);
});

test("M8. missing MISTRAL_API_KEY: Mistral is skipped without a request; Gemini is next", async () => {
  const { result, calls } = await route({ gemini: [geminiOk()] }, { env: { ...ENV, MISTRAL_API_KEY: "" } });
  assert.equal(calls.mistral.length, 0);
  assert.equal(result.attempts[0].skipReason, "not_configured");
  assert.equal(result.provider.id, "gemini");
});

test("M9. evidence-validation failure: the Mistral report is rejected (not repaired) and Gemini is tried", async () => {
  const report = validReport();
  // Three independent violations: directional language, an invented number the cited evidence
  // never established (unlike the real BTC price this section's own statement cites, which would
  // now be grounded and only a warning), and a reference to a distinct asset.
  report.executiveSummary.overview = "Bitcoin looks bullish, with a market cap near $999B.";
  report.furtherResearchQuestions[0].question = "Could WBTC liquidity serve as a proxy for Bitcoin?";
  const { result } = await route({ mistral: [mistralOk(report)], gemini: [geminiOk()] });
  const mistral = result.attempts[0];
  assert.equal(mistral.category, "validation");
  assert.equal(mistral.validationPassed, false);
  assert.ok(mistral.validationViolations >= 3);
  assert.equal(result.provider.id, "gemini");
});

test("M10. end to end through the service: Mistral report validated and stored with Mistral provenance", async () => {
  const TOKEN = "uniswap-uni";
  const NOW = new Date("2026-09-26T12:00:00.000Z");
  const db = createFakeSupabase({ seed: {
    tokens: [{ id: TOKEN, name: "Uniswap", symbol: "UNI", chain_id: "ethereum", contract_address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", is_native: false, category: "DeFi", description: null }],
    chains: [{ id: "ethereum", name: "Ethereum" }],
    token_metric_observations: [{ id: 101, token_id: TOKEN, chain_id: "ethereum", provider_id: "coingecko", metric_id: "price_usd", value: 9.33, status: "available", observed_at: NOW.toISOString(), collected_at: NOW.toISOString(), window_days: null, note: null }],
    metric_definitions: [{ id: "price_usd", name: "Price", unit: "USD", description: "Token price in US dollars." }],
    calculated_metric_observations: [], calculated_metric_definitions: [], data_refresh_steps: [],
  } });
  const quiet = { overview: "No statement is made in this section.", statements: [] };
  const minimal = { executiveSummary: quiet, marketPerformance: quiet, fundamentalPerformance: quiet, valuation: quiet, marketFundamentalRelationships: quiet, liquidityMarketStructure: quiet, tokenomics: quiet, risks: [], dataGaps: [], furtherResearchQuestions: [] };
  const { fetchImpl, calls } = scripted({ mistral: [mistralOk(minimal)] });
  const result = await generateTokenAnalysis(db.client, TOKEN, { env: ENV, fetchImpl, now: () => NOW, providerHealth: createProviderHealth(), diagnosticsSink: () => {} });
  assert.equal(result.ok, true, result.message);
  assert.equal(calls.gemini.length + calls.openrouter.length, 0);
  const [row] = db.rows("token_ai_analyses");
  assert.equal(row.analysis.metadata.provider, "Mistral");
  assert.equal(row.model, "mistral-medium-2604");
  assert.equal(row.analysis.metadata.routing.providerId, "mistral");
  assert.ok(!JSON.stringify(row).includes(MISTRAL_KEY));
});

test("M11. the Mistral key stays server-side: no client module references it; provider modules are server-only", () => {
  const files = [];
  const walk = (dir) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (/\.(ts|tsx)$/.test(name)) files.push(path); } };
  walk("src");
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.ok(!/NEXT_PUBLIC_MISTRAL/.test(source), `${file}: no public Mistral variable`);
    if (/^["']use client["']/.test(source)) {
      assert.ok(!/MISTRAL_API_KEY|api\.mistral\.ai/.test(source), `${file}: client code never reads the key or calls Mistral`);
      assert.ok(!/^import (?!type)[^\n]*lib\/analysis\/ai\//m.test(source), `${file}: no client import of the provider layer`);
    }
  }
  for (const file of ["src/lib/analysis/ai/adapters.ts", "src/lib/analysis/ai/registry.ts"]) assert.match(readFileSync(file, "utf8"), /^import "server-only";/);
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
console.log(`${cases.length - failures}/${cases.length} Mistral provider checks passed.`);
if (failures > 0) process.exitCode = 1;
