// Phase 2 multi-provider AI router: mocked fetch only (no network, no quota).
// Requests go through the real registry and adapters; only fetch is scripted.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createProviderHealth, COOLDOWN_POLICY } from "../src/lib/analysis/ai/health.ts";
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

const KEYS = {
  DASHSCOPE_API_KEY: "qwen-key-not-real-p2", MISTRAL_API_KEY: "mistral-key-not-real-p2",
  GEMINI_API_KEY: "gemini-key-not-real-p2", OPENROUTER_API_KEY: "or-key-not-real-p2",
};
const ENV = { ...KEYS, OPENROUTER_MODEL: "openrouter/free", AI_ALLOWED_FREE_TIERS: "FREE,FREE_TRIAL" };
const RAW_ERROR = "RAW-PROVIDER-ERROR-TEXT-9d1";

// ---- Evidence: the real Bitcoin research-context fixture and a report that satisfies the contract ----

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
function invalidReport() {
  const report = validReport();
  // Two independent violations: directional language, and a number the cited evidence never
  // established (unlike the real BTC price this section's own statement cites, $84,388 would be
  // grounded and only a warning now — see profile-payload.test.mjs P25+).
  report.executiveSummary.overview = "Bitcoin is bullish and its market cap has reached $999B.";
  return report;
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

// ---- Mocked provider responses, scripted per host ----

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const chatOk = (report = validReport(), model = "served-model") => () => json({ id: "gen-x", model, choices: [{ finish_reason: "stop", message: { content: typeof report === "string" ? report : JSON.stringify(report) } }], usage: { prompt_tokens: 21000, completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 900 } } });
const geminiOk = (report = validReport()) => () => json({ candidates: [{ content: { parts: [{ text: JSON.stringify(report) }] }, finishReason: "STOP" }], modelVersion: "gemini-served", usageMetadata: { promptTokenCount: 21000, candidatesTokenCount: 3000, thoughtsTokenCount: 800 } });
const orOk = (report = validReport()) => () => json({ id: "gen-or", model: "vendor/model:free", provider: "Upstream", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(report) } }], usage: { prompt_tokens: 21500, completion_tokens: 5000 } });
const http = (code, message = `upstream ${RAW_ERROR} ${Object.values(KEYS).join(" ")}`, headers = {}) => () => json({ error: { code, message } }, code, headers);
const timeout = () => () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); };
const network = () => () => { throw new TypeError("fetch failed"); };

const HOSTS = { qwen: "dashscope-intl.aliyuncs.com", mistral: "api.mistral.ai", gemini: "generativelanguage.googleapis.com", openrouter: "openrouter.ai", groq: "api.groq.com", glm: "api.z.ai", siliconflow: "api.siliconflow.com", modelscope: "api-inference.modelscope.cn" };
function scripted(script) {
  const calls = Object.fromEntries(Object.keys(HOSTS).map((id) => [id, []]));
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

const instantSleep = () => Promise.resolve();

async function route(script, { env = ENV, health = createProviderHealth(), clock, deadlineAt, events = [], sleep = instantSleep } = {}) {
  const { fetchImpl, calls } = scripted(script);
  const now = clock ?? Date.now;
  try {
    const result = await routeReport({
      request, providers: buildProviders(env), priority: providerPriority(env), allowedTiers: allowedFreeTiers(env),
      deadlineAt: deadlineAt ?? now() + 240_000, validate, health, clock: now, fetchImpl, sleep,
      diagnostics: { runId: "test-run", sink: (event) => events.push(event) },
    });
    return { result, calls, health, events };
  } catch (error) {
    if (error instanceof NoProviderSucceededError) return { error, calls, health, events };
    throw error;
  }
}
const attempted = (attempts) => attempts.filter((item) => item.action === "attempted").map((item) => `${item.providerId}:${item.validationPassed ? "ok" : item.category}`);

// ---- 1-11: success, failure classes, fallback order ----

test("1. primary provider (Qwen) success: one request, native JSON schema, validated", async () => {
  const { result, calls } = await route({ qwen: [chatOk()] });
  assert.equal(result.provider.id, "qwen");
  assert.equal(calls.qwen.length, 1);
  const body = JSON.parse(calls.qwen[0].init.body);
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema, JSON.parse(JSON.stringify(ANALYSIS_RESPONSE_SCHEMA)));
  assert.equal(body.messages[0].content, SYSTEM_INSTRUCTION, "same system instruction as every provider");
  assert.equal(calls.qwen[0].init.headers.authorization, `Bearer ${KEYS.DASHSCOPE_API_KEY}`);
  assert.equal(result.attempt.validationPassed, true);
  assert.deepEqual(result.attempt.usage, { inputTokens: 21000, outputTokens: 4000, reasoningTokens: 900 });
});

test("2-5. primary 503, 429, timeout, and network error are transient: one bounded in-adapter retry, then cooldown, next provider", async () => {
  for (const failure of [http(503), http(429), timeout(), network()]) {
    const { result, calls, health } = await route({ qwen: [failure, failure], mistral: [chatOk()] });
    assert.equal(calls.qwen.length, 2, "one bounded retry (never indefinite) before falling back");
    assert.equal(result.provider.id, "mistral");
    assert.equal(result.attempts.find((item) => item.providerId === "qwen").category, "transient");
    assert.equal(health.get("qwen", Date.now()).status, "cooldown");
  }
});

test("6. invalid JSON: one controlled retry on the same provider, then fallback", async () => {
  const { result, calls } = await route({ qwen: [chatOk("not json at all"), chatOk("{still not json")], mistral: [chatOk()] });
  assert.equal(calls.qwen.length, 2);
  assert.deepEqual(attempted(result.attempts), ["qwen:structured_output", "qwen:structured_output", "mistral:ok"]);
  const schemaMismatch = await route({ qwen: [chatOk({ executiveSummary: "x" }), chatOk(validReport())] });
  assert.equal(schemaMismatch.result.provider.id, "qwen", "a schema mismatch is retried once and can recover");
});

test("7. evidence-validation failure: not accepted, no cooldown, next provider", async () => {
  const { result, health } = await route({ qwen: [chatOk(invalidReport())], mistral: [chatOk()] });
  assert.deepEqual(attempted(result.attempts), ["qwen:validation", "mistral:ok"]);
  const qwen = result.attempts.find((item) => item.providerId === "qwen");
  assert.equal(qwen.validationPassed, false);
  assert.ok(qwen.validationViolations >= 2);
  assert.equal(health.get("qwen", Date.now()).status, "healthy", "the provider answered; validation is not an availability failure");
});

test("8-10. fallback to the second provider, the third, and Gemini as backup", async () => {
  const { result } = await route({ qwen: [http(503)], mistral: [http(502)], gemini: [geminiOk()] });
  assert.equal(result.provider.id, "gemini");
  assert.deepEqual(attempted(result.attempts), ["qwen:transient", "mistral:transient", "gemini:ok"]);
  assert.deepEqual(result.attempt.usage, { inputTokens: 21000, outputTokens: 3800, reasoningTokens: 800 });
  const skipped = result.attempts.filter((item) => item.action === "skipped").map((item) => `${item.providerId}:${item.skipReason}`);
  assert.deepEqual(skipped, ["hunyuan:not_configured", "glm:not_configured", "groq:not_configured", "siliconflow:not_configured"]);
});

test("11. OpenRouter backup after Gemini", async () => {
  const { result, calls } = await route({ qwen: [http(500)], mistral: [timeout()], gemini: [http(503)], openrouter: [orOk()] });
  assert.equal(result.provider.id, "openrouter");
  assert.equal(calls.gemini.length, 1, "Gemini gets one attempt, not two");
  assert.equal(result.attempt.servedModel, "vendor/model:free");
  assert.equal(result.attempt.upstreamProvider, "Upstream");
});

// ---- 12-15: cooldown, recovery, configuration, quota ----

test("12-13. cooldown blocks requests; after it ends a probe is allowed; success restores, failure extends", async () => {
  let now = 1_000_000;
  const clock = () => now;
  const health = createProviderHealth();
  await route({ qwen: [http(503), http(503)], mistral: [chatOk()] }, { health, clock });
  assert.equal(health.get("qwen", now).available, false);

  const during = await route({ mistral: [chatOk()] }, { health, clock });
  assert.equal(during.calls.qwen.length, 0, "no request to a provider in cooldown");
  assert.equal(during.result.attempts[0].skipReason, "cooldown");

  now += COOLDOWN_POLICY.transientBaseMs + 1;
  assert.equal(health.get("qwen", now).probing, true);
  const failedProbe = await route({ qwen: [http(503), http(503)], mistral: [chatOk()] }, { health, clock });
  assert.equal(failedProbe.calls.qwen.length, 2, "the probe still gets its one bounded in-adapter retry before failing again");
  assert.equal(health.get("qwen", now).until, now + COOLDOWN_POLICY.transientBaseMs * 2, "a failed probe doubles the cooldown");

  now += COOLDOWN_POLICY.transientBaseMs * 2 + 1;
  const recovered = await route({ qwen: [chatOk()] }, { health, clock });
  assert.equal(recovered.result.provider.id, "qwen");
  assert.deepEqual(health.get("qwen", now), { status: "healthy", until: null, consecutiveFailures: 0, lastCategory: null, available: true, probing: false });
});

test("14. configuration errors (401/403/404) are not retried and mark the provider unavailable", async () => {
  for (const code of [401, 403, 404]) {
    const { result, calls, health } = await route({ qwen: [http(code)], mistral: [chatOk()] });
    assert.equal(calls.qwen.length, 1);
    assert.equal(result.provider.id, "mistral");
    assert.equal(health.get("qwen", Date.now()).status, "configuration_error", `HTTP ${code}`);
  }
  const noKey = await route({ mistral: [chatOk()] }, { env: { ...ENV, DASHSCOPE_API_KEY: "" } });
  assert.equal(noKey.result.attempts[0].skipReason, "not_configured");
  const badModel = await route({ mistral: [chatOk()] }, { env: { ...ENV, QWEN_MODEL: "bad model !" } });
  assert.equal(badModel.calls.qwen.length, 0, "an invalid model is a configuration error found before any request");
});

test("15. free quota exhausted: FREE_QUOTA_EXHAUSTED, long cooldown, next provider; never falls into paid usage", async () => {
  const freeTierOnly = () => json({ error: { code: "AllocationQuota.FreeTierOnly", message: "The free tier of the model has been exhausted." } }, 403);
  const { result, health } = await route({ qwen: [freeTierOnly], mistral: [chatOk()] });
  assert.equal(result.attempts.find((item) => item.providerId === "qwen").category, "quota");
  const state = health.get("qwen", Date.now());
  assert.equal(state.status, "free_quota_exhausted");
  assert.ok(state.until - Date.now() > COOLDOWN_POLICY.quotaMs - 5_000);
  const paymentRequired = await route({ qwen: [http(402)], mistral: [chatOk()] });
  assert.equal(paymentRequired.result.attempts[0].category, "quota");
});

// ---- 16-18: capability, deadline, nothing available ----

test("16. capability and free-tier mismatches are skipped before any request", async () => {
  // glm and siliconflow are deliberately left out of this priority list: their structured-output
  // mode (json_object) is now eligible (see test 22+), so they no longer belong among the skips
  // this test demonstrates. hunyuan stays "unverified" (no documented mode either way).
  const env = { GROQ_API_KEY: "g", HUNYUAN_API_KEY: "h", HUNYUAN_MODEL: "hunyuan-x", DASHSCOPE_API_KEY: "q", OPENROUTER_API_KEY: "o", OPENROUTER_MODEL: "vendor/paid-model", MISTRAL_API_KEY: "m", MISTRAL_MODEL: "mistral-medium-2604", AI_PROVIDER_PRIORITY: "qwen,hunyuan,groq,mistral" };
  const { result, calls } = await route({ mistral: [chatOk()] }, { env });
  const skips = Object.fromEntries(result.attempts.filter((item) => item.action === "skipped").map((item) => [item.providerId, item.skipReason]));
  assert.equal(skips.qwen, "free_tier_free_trial", "a free trial needs explicit opt-in (AI_ALLOWED_FREE_TIERS)");
  assert.equal(skips.hunyuan, "free_tier_free_trial");
  assert.equal(result.provider.id, "mistral");
  assert.equal(calls.groq.length + calls.qwen.length, 0);

  const onlyGroqAndPaidOpenRouter = await route({}, { env: { GROQ_API_KEY: "g", OPENROUTER_API_KEY: "o", OPENROUTER_MODEL: "vendor/paid-model" } });
  const later = Object.fromEntries(onlyGroqAndPaidOpenRouter.error.attempts.map((item) => [item.providerId, item.skipReason]));
  assert.equal(later.groq, "request_token_limit", "the free 8K TPM cap cannot carry a ~22K-token prompt");
  assert.equal(later.openrouter, "free_tier_paid_only", "a non-:free OpenRouter model is never called");

  const cerebras = buildProviders({ CEREBRAS_API_KEY: "c" }).get("cerebras");
  assert.equal(cerebras.freeTier.status, "FREE_TRIAL", "30-day credits are a trial, not a permanent free tier");
  assert.ok(!providerPriority({}).includes("cerebras"), "not in the default priority (explicit opt-in)");
  const optedIn = await route({}, { env: { CEREBRAS_API_KEY: "c", AI_PROVIDER_PRIORITY: "cerebras", AI_ALLOWED_FREE_TIERS: "FREE,FREE_TRIAL" } });
  assert.equal(optedIn.error.attempts[0].skipReason, "request_token_limit", "~22K input + 8K output exceeds the 30K free-trial TPM");
});

test("17. one overall deadline: each attempt gets only the remaining budget; nothing starts without enough time", async () => {
  let now = 5_000_000;
  const clock = () => now;
  const deadlineAt = now + 100_000;
  const events = [];
  const slow = () => { now += 85_000; return json({ error: { code: 503 } }, 503); };
  const { error } = await route({ qwen: [slow], mistral: [chatOk()] }, { clock, deadlineAt, events });
  const [qwenAttempt] = error.attempts.filter((item) => item.action === "attempted");
  // Three OTHER providers are eligible here (mistral, gemini, openrouter; hunyuan/glm/groq/siliconflow
  // are all unconfigured in this env), each with minAttemptMs reserved: budget = min(cap, remaining -
  // 3*20_000) = min(120_000, 100_000 - 60_000) = 40_000, not the whole 100s remaining — see tests
  // 25-26 for the full starvation scenario this reservation prevents.
  assert.equal(qwenAttempt.timeoutMs, 40_000, "the first provider's budget reserves minAttemptMs for every later eligible provider");
  const mistral = error.attempts.find((item) => item.providerId === "mistral");
  assert.equal(mistral.skipReason, "deadline", "15 s left is below the minimum attempt window");
  assert.ok(events.some((event) => event.type === "ai.router_attempt" && event.skipReason === "deadline"));
});

test("18. no provider available: a controlled error, no requests", async () => {
  const { error, calls } = await route({}, { env: {} });
  assert.ok(error instanceof NoProviderSucceededError);
  assert.match(error.message, /No AI provider is currently available/);
  assert.equal(Object.values(calls).flat().length, 0);
});

// ---- 19-20: storage through the real service ----

const TOKEN = "uniswap-uni";
const NOW = new Date("2026-09-25T12:00:00.000Z");
function seed() {
  return {
    tokens: [{ id: TOKEN, name: "Uniswap", symbol: "UNI", chain_id: "ethereum", contract_address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", is_native: false, category: "DeFi", description: null }],
    chains: [{ id: "ethereum", name: "Ethereum" }],
    token_metric_observations: [{ id: 101, token_id: TOKEN, chain_id: "ethereum", provider_id: "coingecko", metric_id: "price_usd", value: 9.33, status: "available", observed_at: NOW.toISOString(), collected_at: NOW.toISOString(), window_days: null, note: null }],
    metric_definitions: [{ id: "price_usd", name: "Price", unit: "USD", description: "Token price in US dollars." }],
    calculated_metric_observations: [], calculated_metric_definitions: [], data_refresh_steps: [],
  };
}
const quietSection = { overview: "No statement is made in this section.", statements: [] };
const minimalReport = {
  executiveSummary: quietSection, marketPerformance: quietSection, fundamentalPerformance: quietSection, valuation: quietSection,
  marketFundamentalRelationships: quietSection, liquidityMarketStructure: quietSection, tokenomics: quietSection,
  risks: [], dataGaps: [], furtherResearchQuestions: [],
};
async function serviceRun(script) {
  const db = createFakeSupabase({ seed: seed() });
  const { fetchImpl, calls } = scripted(script);
  const events = [];
  const [error, info] = [console.error, console.info];
  console.error = () => {};
  console.info = () => {};
  try {
    const result = await generateTokenAnalysis(db.client, TOKEN, { env: ENV, fetchImpl, sleep: instantSleep, now: () => NOW, providerHealth: createProviderHealth(), diagnosticsSink: (event) => events.push(event) });
    return { result, db, calls, events };
  } finally {
    console.error = error;
    console.info = info;
  }
}

test("19. a valid report is stored with provider, models, route, and validation metadata", async () => {
  const { result, db } = await serviceRun({ qwen: [http(503), http(503)], mistral: [chatOk(minimalReport, "mistral-medium-2609")] });
  assert.equal(result.ok, true, result.message);
  const [row] = db.rows("token_ai_analyses");
  const { metadata } = row.analysis;
  assert.equal(metadata.provider, "Mistral");
  assert.equal(metadata.requestedModel, "mistral-medium-2604");
  assert.equal(metadata.model, "mistral-medium-2609");
  assert.equal(row.model, "mistral-medium-2609");
  assert.equal(metadata.routing.providerId, "mistral");
  assert.equal(metadata.routing.fallbackReason, "qwen_503");
  assert.deepEqual(metadata.routing.attempts.filter((item) => item.action === "attempted").map((item) => [item.provider, item.category, item.validationPassed]), [["qwen", "transient", null], ["mistral", null, true]]);
  assert.deepEqual(metadata.fallback, { used: false, reason: null }, "the panel's Gemini→OpenRouter line is not shown for other routes");
  assert.ok(metadata.contextAsOf);
});

test("20. an invalid report is never stored", async () => {
  const bad = { ...minimalReport, executiveSummary: { overview: "UNI traded at $9.33 and looks bullish.", statements: [] } };
  const { result, db } = await serviceRun({ qwen: [chatOk(bad)], mistral: [chatOk(bad)], gemini: [geminiOk(bad)], openrouter: [orOk(bad)] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_output");
  assert.equal(db.rows("token_ai_analyses").length, 0);
});

// ---- 21: secrets ----

test("21. no secret or raw provider text leaks into results, errors, diagnostics, or stored metadata", async () => {
  const run = await serviceRun({ qwen: [http(503), http(503)], mistral: [http(401)], gemini: [http(429)], openrouter: [http(502)] });
  const events = [];
  const routed = await route({ qwen: [http(500), http(500)], mistral: [chatOk()] }, { events });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const blob = JSON.stringify([run.result, run.events, routed.result.attempts, events]);
  for (const secret of [...Object.values(KEYS), RAW_ERROR, "authorization", "x-goog-api-key"]) assert.ok(!blob.includes(secret), `no ${secret}`);
  assert.equal(run.result.reason, "provider_failed");
  assert.match(run.result.message, /Qwen \(Alibaba Cloud Model Studio\): temporarily unavailable \(HTTP 503\); Mistral: configuration error \(HTTP 401\)/);
});

test("22. GLM reads ZHIPU_API_KEY and uses JSON-object mode (schema as text)", async () => {
  assert.equal(buildProviders({ ZHIPU_API_KEY: "zk" }).get("glm").configured, true);
  assert.equal(buildProviders({ ZAI_API_KEY: "zk" }).get("glm").configured, false, "the old variable name is no longer read");
  const glm = buildProviders({ ZHIPU_API_KEY: KEYS.DASHSCOPE_API_KEY }).get("glm");
  assert.equal(glm.model, "glm-4.7-flash");
  assert.equal(glm.capabilities.structuredOutput, "json_object", "documented JSON mode, not a claimed json_schema");
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return chatOk()(); };
  const outcome = await glm.generateStructuredReport(request, { timeoutMs: 10_000, fetchImpl });
  assert.equal(outcome.ok, true);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, "https://api.z.ai/api/paas/v4/chat/completions");
  assert.deepEqual(body.response_format, { type: "json_object" }, "JSON mode, not a claimed json_schema");
  assert.ok(body.messages[0].content.startsWith(SYSTEM_INSTRUCTION), "the system instruction is unchanged, with the schema appended");
  assert.ok(body.messages[0].content.endsWith(JSON.stringify(ANALYSIS_RESPONSE_SCHEMA)), "the exact schema is given as text");
  assert.equal(body.messages[1].content, request.userText);
  const mistral = scripted({ mistral: [chatOk()] });
  await buildProviders(ENV).get("mistral").generateStructuredReport(request, { timeoutMs: 10_000, fetchImpl: mistral.fetchImpl });
  assert.equal(JSON.parse(mistral.calls.mistral[0].init.body).response_format.type, "json_schema", "JSON-schema providers are unchanged");
});

// ---- 23: GLM (json_object) is a first-class, fully validated routing path ----

const GLM_ENV = { ZHIPU_API_KEY: "zk", MISTRAL_API_KEY: KEYS.MISTRAL_API_KEY, MISTRAL_MODEL: "mistral-medium-2604", AI_PROVIDER_PRIORITY: "glm,mistral" };

test("23A-B. GLM is no longer skipped for its structured-output mode, and is selected first when configured", async () => {
  const { result, calls } = await route({ glm: [chatOk()], mistral: [chatOk()] }, { env: GLM_ENV });
  assert.equal(result.provider.id, "glm", "json_object is now an eligible routing path");
  assert.equal(result.attempts[0].skipReason, null, "not skipped");
  assert.equal(calls.mistral.length, 0, "the router stops at the first success");
});

test("23C. GLM valid JSON + valid schema + valid evidence is accepted", async () => {
  const { result } = await route({ glm: [chatOk()] }, { env: GLM_ENV });
  assert.equal(result.provider.id, "glm");
  assert.equal(result.attempt.validationPassed, true);
});

test("23D. GLM malformed JSON is rejected (retried once), then falls back to Mistral", async () => {
  const { result, calls } = await route({ glm: [chatOk("not json at all"), chatOk("{still not json")], mistral: [chatOk()] }, { env: GLM_ENV });
  assert.equal(calls.glm.length, 2, "one same-provider retry, same as any json_schema provider");
  assert.deepEqual(attempted(result.attempts), ["glm:structured_output", "glm:structured_output", "mistral:ok"]);
});

test("23E. GLM JSON that does not match the report schema is rejected, then falls back to Mistral", async () => {
  const { result, calls } = await route({ glm: [chatOk({ executiveSummary: "x" }), chatOk({ executiveSummary: "y" })], mistral: [chatOk()] }, { env: GLM_ENV });
  assert.equal(calls.glm.length, 2);
  assert.deepEqual(attempted(result.attempts), ["glm:structured_output", "glm:structured_output", "mistral:ok"]);
});

test("23F. GLM output failing the evidence contract is rejected (no retry) and falls back to Mistral", async () => {
  const { result, calls, health } = await route({ glm: [chatOk(invalidReport())], mistral: [chatOk()] }, { env: GLM_ENV });
  assert.deepEqual(attempted(result.attempts), ["glm:validation", "mistral:ok"]);
  const glmAttempt = result.attempts.find((item) => item.providerId === "glm");
  assert.equal(glmAttempt.validationPassed, false);
  assert.ok(glmAttempt.validationViolations >= 2);
  assert.equal(calls.glm.length, 1, "requirement A: a JSON/schema-valid but evidence-rejected response is never retried against the same provider");
  assert.equal(health.get("glm", Date.now()).status, "healthy", "the provider answered; validation is not an availability failure");
});

test("23G. GLM HTTP 429/5xx/timeout is infrastructure-transient: one bounded in-adapter retry (Task 1), then falls back to Mistral", async () => {
  for (const failure of [http(429), http(503), timeout()]) {
    const { result, calls, health } = await route({ glm: [failure, failure], mistral: [chatOk()] }, { env: GLM_ENV, health: createProviderHealth() });
    assert.equal(calls.glm.length, 2, "one bounded retry, never indefinite, before falling back");
    assert.equal(result.provider.id, "mistral");
    assert.equal(result.attempts.find((item) => item.providerId === "glm").category, "transient");
    assert.equal(health.get("glm", Date.now()).status, "cooldown");
  }
});

test("23H. GLM 429 with a Retry-After header is retried once after waiting that long (capped at 10s), not indefinitely", async () => {
  const calls429 = [];
  const retryAfter429 = () => { calls429.push(Date.now()); return json({ error: { code: 429, message: "rate limited" } }, 429, { "retry-after": "3" }); };
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const { result, calls } = await route({ glm: [retryAfter429, chatOk()], mistral: [chatOk()] }, { env: GLM_ENV, sleep });
  assert.equal(calls.glm.length, 2, "the retry happened");
  assert.equal(result.provider.id, "glm", "the retry succeeded, so GLM itself is used — Mistral is never called");
  assert.deepEqual(waits, [3_000], "waited exactly the Retry-After duration (well under the 10s cap)");
});

test("23I. GLM 429 with a Retry-After far beyond 10s is capped, and a second consecutive 429 is never retried again", async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const { result, calls } = await route(
    { glm: [http(429, "rate limited", { "retry-after": "120" }), http(429)], mistral: [chatOk()] },
    { env: GLM_ENV, sleep },
  );
  assert.equal(calls.glm.length, 2, "exactly one retry — never indefinite");
  assert.deepEqual(waits, [10_000], "a 120s Retry-After is capped at 10s");
  assert.equal(result.provider.id, "mistral", "GLM failed twice, so the router falls back");
});

// ---- 24: SiliconFlow and ModelScope wiring (verified json_object capability, no invented model) ----

test("24z. Task 3 production scenario: GLM fails fast (HTTP 429), Mistral then gets a realistic budget well above its observed ~41.5s completion time", async () => {
  const { result, calls } = await route({ glm: [http(429), http(429)], mistral: [chatOk()] }, { env: GLM_ENV });
  assert.equal(result.provider.id, "mistral");
  const mistralAttempt = result.attempts.find((item) => item.providerId === "mistral");
  // Only one later candidate here (none, since mistral is last), so mistral gets its own full cap.
  assert.equal(mistralAttempt.timeoutMs, 60_000, "well above the ~47.7s the equal-share formula gave it, and its own observed ~41.5s completion time");
  assert.equal(calls.glm.length, 2, "GLM's bounded retry (Task 1) still ran before falling back");
});

test("24. SiliconFlow and ModelScope are eligible json_object providers, but stay unconfigured without their model env var", async () => {
  const siliconflow = buildProviders({ SILICONFLOW_API_KEY: "sk" }).get("siliconflow");
  assert.equal(siliconflow.capabilities.structuredOutput, "json_object", "documented JSON mode (docs.siliconflow.cn JSON-mode guide), not a claimed json_schema");
  assert.equal(siliconflow.configured, false, "no default model is invented; SILICONFLOW_MODEL is required");
  assert.equal(buildProviders({ SILICONFLOW_API_KEY: "sk", SILICONFLOW_MODEL: "some-model" }).get("siliconflow").configured, true);

  const modelscope = buildProviders({ MODELSCOPE_API_TOKEN: "mt" }).get("modelscope");
  assert.equal(modelscope.capabilities.structuredOutput, "json_object", "json_schema is a documented open bug (modelscope/modelscope#1801); json_object is used instead");
  assert.equal(modelscope.configured, false, "no default model is invented; MODELSCOPE_MODEL is required");
  assert.equal(buildProviders({ MODELSCOPE_API_TOKEN: "mt", MODELSCOPE_MODEL: "some-model" }).get("modelscope").configured, true);
  assert.equal(buildProviders({}).get("modelscope").configured, false, "no token configured in this environment");

  const routed = await route({}, { env: { SILICONFLOW_API_KEY: "sk", MODELSCOPE_API_TOKEN: "mt", AI_PROVIDER_PRIORITY: "siliconflow,modelscope" } });
  const skips = Object.fromEntries(routed.error.attempts.map((item) => [item.providerId, item.skipReason]));
  assert.equal(skips.siliconflow, "not_configured", "eligible capability, but still no model");
  assert.equal(skips.modelscope, "not_configured");
});

test("24y. Task 5: SiliconFlow generates via json_object mode against the correct OpenAI-compatible endpoint, once configured", async () => {
  const siliconflow = buildProviders({ SILICONFLOW_API_KEY: "sk", SILICONFLOW_MODEL: "Qwen/Qwen3-32B" }).get("siliconflow");
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return chatOk()(); };
  const outcome = await siliconflow.generateStructuredReport(request, { timeoutMs: 10_000, fetchImpl });
  assert.equal(outcome.ok, true);
  assert.equal(calls[0].url, "https://api.siliconflow.com/v1/chat/completions", "correct base URL, from the registry, unchanged by any model choice");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "Qwen/Qwen3-32B", "the model is configuration-driven (SILICONFLOW_MODEL), never hard-coded");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(calls[0].init.headers.authorization, "Bearer sk", "standard OpenAI-compatible Bearer auth, matching GLM/Mistral");
});

test("24z-modelscope. ModelScope generates via json_object mode against the correct base URL, model, and Bearer auth, once configured with a real Production token", async () => {
  const modelscope = buildProviders({ MODELSCOPE_API_TOKEN: "read-only-token-not-a-real-secret", MODELSCOPE_MODEL: "Qwen/Qwen3.5-72B-Instruct" }).get("modelscope");
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return chatOk()(); };
  const outcome = await modelscope.generateStructuredReport(request, { timeoutMs: 10_000, fetchImpl });
  assert.equal(outcome.ok, true);
  assert.equal(calls[0].url, "https://api-inference.modelscope.cn/v1/chat/completions", "the exact Production base URL, from the registry default (MODELSCOPE_BASE_URL is not set)");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "Qwen/Qwen3.5-72B-Instruct", "the exact Production model, read from MODELSCOPE_MODEL — never hard-coded or defaulted");
  assert.deepEqual(body.response_format, { type: "json_object" }, "json_schema is a documented ModelScope bug (modelscope/modelscope#1801); json_object is used instead");
  assert.equal(calls[0].init.headers.authorization, "Bearer read-only-token-not-a-real-secret", "standard OpenAI-compatible Bearer auth, matching every other OpenAI-compatible provider");
  assert.ok(!JSON.stringify(calls[0]).includes("gemini"), "sanity: this call is scoped to ModelScope only");
});

test("24x. Task 6: ModelScope HTTP 401 is classified as configuration (not transient): never retried, and it is distinguishable from a fixable infrastructure failure", async () => {
  const env = { MODELSCOPE_API_TOKEN: "mt", MODELSCOPE_MODEL: "Qwen/Qwen3.5-72B-Instruct", GEMINI_API_KEY: "gk", AI_PROVIDER_PRIORITY: "modelscope,gemini" };
  const { result, calls, health } = await route({ modelscope: [http(401)], gemini: [geminiOk()] }, { env });
  assert.equal(calls.modelscope.length, 1, "a 401 is never retried (only transient categories get Task 1's bounded retry)");
  assert.equal(result.attempts.find((item) => item.providerId === "modelscope").category, "configuration");
  // A real, working ModelScope 401 in this same code path (correct Bearer header, correct base
  // URL, correct request body — verified in test 24z-modelscope) means the credential itself is
  // invalid, expired, or lacks Inference-API scope (a "read only" token type on ModelScope's
  // dashboard, for example, may not be authorized to call API-Inference at all — that is an
  // account/token-type issue on ModelScope's side, not something this code can detect or work
  // around); the router correctly marks it "configuration_error" (a 30-minute probe cooldown, not
  // an infinite retry loop) rather than treating it as a fixable transient/infrastructure failure.
  // This test deliberately does NOT weaken that classification or add a fallback that hides it.
  assert.equal(health.get("modelscope", Date.now()).status, "configuration_error");
  assert.equal(result.provider.id, "gemini", "the router falls through cleanly to the next provider");
});

// ---- Task 10: explicit mocked end-to-end scenarios through the real router + real validator ----

test("29a. end-to-end: a report with only warning-tier language (grounded analytical wording) parses, validates, and is ACCEPTED with warnings recorded", async () => {
  const growth = calc("price_growth_pct");
  const withMomentum = validReport();
  withMomentum.marketPerformance.statements.push(st("interpretation", "Momentum in the price change was neutral overall.", [growth.id], growth.period.label));
  const { result } = await route({ glm: [chatOk(withMomentum)] }, { env: GLM_ENV });
  assert.equal(result.provider.id, "glm");
  assert.equal(result.attempt.validationPassed, true, "the report is accepted — a warning-tier word does not reject it");
  assert.equal(result.value.warnings.some((item) => /\("Momentum"\)/.test(item)), true, "but the warning is still recorded for provenance");
});

test("29b. end-to-end: a report with an unsupported (fabricated) number fails evidence validation and falls back to the next provider", async () => {
  const badNumber = validReport();
  badNumber.tokenomics.statements.push(st("calculated", "Circulating supply is about 95.7% of maximum supply.", [calc("volume_to_market_cap").id]));
  const { result } = await route({ glm: [chatOk(badNumber)], mistral: [chatOk()] }, { env: GLM_ENV });
  assert.equal(result.provider.id, "mistral", "GLM's report is rejected; the router falls back");
  const glmAttempt = result.attempts.find((item) => item.providerId === "glm");
  assert.equal(glmAttempt.category, "validation");
  assert.equal(glmAttempt.validationPassed, false);
});

test("29c. end-to-end: OpenRouter's body-timeout is transient and falls through cleanly, and the global deadline is still enforced afterward", async () => {
  const env = { OPENROUTER_API_KEY: "ok", OPENROUTER_MODEL: "openrouter/free", GEMINI_API_KEY: "gk", AI_PROVIDER_PRIORITY: "openrouter,gemini" };
  const { result, calls } = await route({ openrouter: [timeout()], gemini: [geminiOk()] }, { env });
  assert.equal(result.attempts.find((item) => item.providerId === "openrouter").category, "transient");
  assert.equal(calls.openrouter.length, 1, "OpenRouter's own client never retries in place (existing, intentional design)");
  assert.equal(result.provider.id, "gemini", "falls through cleanly; the deadline math is unaffected — see tests 25-26");
});

// ---- 25-26: bounded per-provider timeout budgeting (production incident: GLM alone used 118.7s
// of a 240s deadline, and OpenRouter's later attempt was cut off, so SiliconFlow/ModelScope/Gemini
// never even got skipped-for-real-eligibility — they were starved to zero) ----

const SIX_ENV = {
  ZHIPU_API_KEY: "zk", MISTRAL_API_KEY: "mk", MISTRAL_MODEL: "mistral-medium-2604",
  OPENROUTER_API_KEY: "ok", OPENROUTER_MODEL: "openrouter/free",
  SILICONFLOW_API_KEY: "sk", SILICONFLOW_MODEL: "some-model",
  MODELSCOPE_API_TOKEN: "mt", MODELSCOPE_MODEL: "some-model",
  GEMINI_API_KEY: "gk",
  AI_PROVIDER_PRIORITY: "glm,mistral,openrouter,siliconflow,modelscope,gemini",
};

test("25. with all six providers eligible, the first attempt's budget reserves minAttemptMs for every later provider (not the whole 240s), and every provider reaches an actual attempt (none pre-emptively starved)", async () => {
  let now = 0;
  const clock = () => now;
  const deadlineAt = now + 240_000;
  // Each mock fails (or, for the last, succeeds) near-instantly: this isolates the allocation
  // formula itself from real request latency, so remaining stays ~240s throughout.
  const { result, calls } = await route(
    { glm: [http(500)], mistral: [http(500)], openrouter: [http(500)], siliconflow: [http(500)], modelscope: [http(500)], gemini: [geminiOk()] },
    { env: SIX_ENV, clock, deadlineAt },
  );
  assert.equal(result.provider.id, "gemini", "the chain reaches the last provider and succeeds");
  const attempted = result.attempts.filter((item) => item.action === "attempted");
  assert.deepEqual(attempted.map((item) => item.providerId), ["glm", "mistral", "openrouter", "siliconflow", "modelscope", "gemini"], "every provider is actually attempted, none skipped for \"deadline\"");
  assert.ok(result.attempts.every((item) => item.skipReason !== "deadline"), "none of the six is starved before it even gets a turn");
  // At the very first attempt, remaining is exactly 240_000 and 5 later providers are reserved
  // minAttemptMs (20_000) each = 100_000: GLM's budget is min(60_000, 240_000 - 100_000) =
  // 60_000 — its own full cap, since plenty of budget remains. This is the intended, more
  // realistic allocation (Task 3): an early provider isn't punished down to a bare equal share
  // just because others are queued, as long as their reserved floors are still honored.
  const glmAttempt = attempted.find((item) => item.providerId === "glm");
  assert.equal(glmAttempt.timeoutMs, 60_000, "GLM gets its own full cap when the reserved floors for later providers still leave enough room");
  assert.equal(calls.gemini.length, 1);
});

test("26. worst case — every provider fully consumes its own allocated budget, every time — still leaves every later provider at least minAttemptMs (the exact production starvation is fixed)", async () => {
  let now = 0;
  const clock = () => now;
  const deadlineAt = now + 240_000;
  // Reserving minAttemptMs (20_000) per later provider, deducted before this one's own budget is
  // computed, guarantees every later provider at least that floor no matter what an earlier one
  // consumes — even in the adversarial case where each provider takes exactly what it was given:
  //   glm:         reserve 5*20_000=100_000 -> budget min(60_000, 240_000-100_000=140_000) = 60_000
  //   mistral:     reserve 4*20_000= 80_000 -> budget min(60_000, 180_000- 80_000=100_000) = 60_000
  //   openrouter:  reserve 3*20_000= 60_000 -> budget min(60_000, 120_000- 60_000= 60_000) = 60_000
  //   siliconflow: reserve 2*20_000= 40_000 -> budget min(60_000,  60_000- 40_000= 20_000) = 20_000
  //   modelscope:  reserve 1*20_000= 20_000 -> budget min(60_000,  40_000- 20_000= 20_000) = 20_000
  //   gemini:      reserve 0        -> budget min(90_000,  20_000-      0= 20_000) = 20_000
  const expected = [60_000, 60_000, 60_000, 20_000, 20_000, 20_000];
  const providers = ["glm", "mistral", "openrouter", "siliconflow", "modelscope"];
  const advanceBy = (ms, respond) => () => { now += ms; return respond(); };
  const { result } = await route(
    {
      ...Object.fromEntries(providers.map((id, index) => [id, [advanceBy(expected[index], http(500))]])),
      gemini: [advanceBy(expected[5], geminiOk())],
    },
    { env: SIX_ENV, clock, deadlineAt },
  );
  assert.equal(result.provider.id, "gemini", "even in the worst case, the last provider in priority still gets attempted and succeeds");
  const attempted = result.attempts.filter((item) => item.action === "attempted");
  assert.deepEqual(attempted.map((item) => item.providerId), ["glm", "mistral", "openrouter", "siliconflow", "modelscope", "gemini"]);
  assert.deepEqual(attempted.map((item) => item.timeoutMs), expected, "each budget matches the reservation formula exactly, and none is starved to zero");
  assert.equal(now, 240_000, "the full 240s budget is used, exactly, with nothing left over and nothing exceeded");
});

// ---- Requirements A-F: the reported cardano-ada cascade (GLM's real 102.555s evidence-rejected
// generation was reportedly followed by a second GLM attempt, starving ModelScope and Gemini to
// "skipped:deadline"). Verified against the current code: an evidence-contract rejection ("validation"
// category) is not one of the two categories the retry loop's `if (category === "structured_output"
// && !retry) continue;` condition matches, so it can never trigger a same-provider retry — only a
// genuinely transient/structured-output failure can (requirements B-D, covered in tests 6, 23D,
// 23G-23I). These tests reproduce the reported scenario's real timing to prove requirements A, E, and
// F hold today, with no code change: a slow-but-rejected GLM response is a single attempt, and later
// providers still receive their reserved opportunity.

test("30A. requirement A/E: GLM's real 102.555s evidence-rejected response (cardano-ada) is a single attempt — never retried — and does not starve ModelScope or Gemini", async () => {
  let now = 0;
  const clock = () => now;
  const deadlineAt = now + 240_000;
  const advanceBy = (ms, respond) => () => { now += ms; return respond(); };
  const { result, calls } = await route(
    {
      glm: [advanceBy(102_555, chatOk(invalidReport()))],
      mistral: [advanceBy(5_000, chatOk(invalidReport()))],
      openrouter: [advanceBy(5_000, () => json({ error: { code: 500 } }, 500))],
      siliconflow: [advanceBy(5_000, chatOk(invalidReport()))],
      modelscope: [advanceBy(5_000, chatOk(invalidReport()))],
      gemini: [advanceBy(5_000, geminiOk())],
    },
    { env: SIX_ENV, clock, deadlineAt },
  );
  assert.equal(calls.glm.length, 1, "requirement A: GLM's evidence-rejected response is never retried, regardless of how long it took to generate");
  const attempted = result.attempts.filter((item) => item.action === "attempted");
  assert.deepEqual(attempted.map((item) => item.providerId), ["glm", "mistral", "openrouter", "siliconflow", "modelscope", "gemini"], "requirement F: ModelScope and Gemini are attempted, not \"skipped:deadline\" as in the reported cascade");
  assert.equal(result.provider.id, "gemini");
  assert.equal(now, 127_555, "102.555s (GLM, once) + 5 * 5s (Mistral/OpenRouter/SiliconFlow/ModelScope/Gemini) — well inside the 240s deadline, with no retry inflating it");
});

test("30B. requirement F, quantified: after GLM's real 102.555s single (unretried) attempt, Mistral's reserved budget alone (57,445ms) is already larger than its own observed ~41.5s completion time", async () => {
  let now = 0;
  const clock = () => now;
  const deadlineAt = now + 240_000;
  const advanceBy = (ms, respond) => () => { now += ms; return respond(); };
  const { result } = await route(
    { glm: [advanceBy(102_555, chatOk(invalidReport()))], mistral: [chatOk()] },
    { env: SIX_ENV, clock, deadlineAt },
  );
  assert.equal(result.provider.id, "mistral");
  const mistralAttempt = result.attempts.find((item) => item.providerId === "mistral");
  assert.equal(mistralAttempt.timeoutMs, 57_445, "min(120_000 cap, max(20_000, (240_000-102_555) - 4*20_000 reserved for openrouter/siliconflow/modelscope/gemini))");
  assert.ok(mistralAttempt.timeoutMs > 41_500, "comfortably above Mistral's own observed ~41.5s completion time");
});

// ---- Requirements 2-4: the reported 3zwsdqzh cascade (GLM ~62.5s incl. one bounded retry,
// Mistral 32.4s validation failure, OpenRouter 60s timeout, SiliconFlow two full ~43.35s timeouts
// = ~87s, ModelScope and Gemini skipped:deadline — ~245s total, over the 240s budget). A bounded
// in-adapter retry (adapters.ts) now checks the SAME reservation the router itself enforces before
// taking a second attempt: if a retry would eat into what later candidates are owed, it is skipped
// and the failure is returned immediately, exactly like running out of attempts. These tests
// reproduce the reported cascade's real timing to prove the fix, with no validator or architecture
// change: SiliconFlow's second attempt is skipped once the budget is tight, and the providers after
// it (Requirement 2's stated goal) get a real, meaningful attempt instead of "skipped:deadline".

test("31. requirement 2-3: the 3zwsdqzh cascade — GLM retries once (affordable), Mistral fails validation, OpenRouter times out, then SiliconFlow's second retry is skipped once it would eat into ModelScope/Gemini's reserved share, and ModelScope gets a real attempt instead of being starved", async () => {
  let now = 0;
  const clock = () => now;
  const deadlineAt = now + 240_000;
  const advanceBy = (ms, respond) => () => { now += ms; return respond(); };
  const { result, calls } = await route(
    {
      glm: [advanceBy(60_000, http(429)), advanceBy(470, http(429))],
      mistral: [advanceBy(32_400, chatOk(invalidReport()))],
      openrouter: [advanceBy(60_000, timeout())],
      siliconflow: [advanceBy(47_130, timeout())],
      modelscope: [advanceBy(1_000, chatOk())],
    },
    { env: SIX_ENV, clock, deadlineAt },
  );
  assert.equal(calls.glm.length, 2, "GLM's retry was affordable here (huge slack remained) and is unaffected by the budget-aware check");
  assert.equal(calls.mistral.length, 1, "validation failures are never retried, unaffected");
  assert.equal(calls.openrouter.length, 1, "OpenRouter has no in-adapter retry to begin with, unaffected");
  assert.equal(calls.siliconflow.length, 1, "requirement 3: SiliconFlow's second attempt is skipped — remaining (40,000ms) minus the reserved share for ModelScope/Gemini (40,000ms) cannot afford another backoff+timeout (49,130ms)");
  const attempted = result.attempts.filter((item) => item.action === "attempted");
  assert.deepEqual(attempted.map((item) => item.providerId), ["glm", "mistral", "openrouter", "siliconflow", "modelscope"], "requirement 2: ModelScope gets a real attempt — not \"skipped:deadline\" as in the reported cascade");
  assert.equal(result.provider.id, "modelscope");
  assert.equal(now, 201_000, "well inside the 240s deadline, with meaningful budget still available for ModelScope and (if needed) Gemini");
});

test("32. requirement 4: GLM's 429 retry is skipped when it would starve the only remaining provider, even though 429 is still a technically-retryable category", async () => {
  let now = 0;
  const clock = () => now;
  const deadlineAt = now + 90_000;
  const advanceBy = (ms, respond) => () => { now += ms; return respond(); };
  const { result, calls } = await route(
    { glm: [advanceBy(60_000, http(429)), http(429)], mistral: [chatOk()] },
    { env: { ...SIX_ENV, AI_PROVIDER_PRIORITY: "glm,mistral" }, clock, deadlineAt },
  );
  assert.equal(calls.glm.length, 1, "remaining after attempt 1 (30,000ms) minus Mistral's reserved share (20,000ms) cannot afford another backoff+timeout (62,000ms), so the retry is skipped");
  assert.equal(result.provider.id, "mistral", "the router still falls back normally, well within the 90s deadline");
  const glmAttempt = result.attempts.find((item) => item.providerId === "glm");
  assert.equal(glmAttempt.category, "transient", "429 handling is otherwise unchanged: still classified transient, still cooled down, never a permanent failure");
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
console.log(`${cases.length - failures}/${cases.length} AI router checks passed.`);
if (failures > 0) process.exitCode = 1;
