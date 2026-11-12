// Phase 1B free-provider bake-off harness: mocked tests only (no network, no quota).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ADAPTERS, JSON_OBJECT_SCHEMA_PREFIX } from "../benchmark/adapters.ts";
import { categorize, schemaErrors, sectionsPresent } from "../benchmark/evaluate.ts";
import { BENCHMARK_MAX_OUTPUT_TOKENS, runBenchmark, runOne } from "../benchmark/run.ts";
import { SYSTEM_INSTRUCTION, buildUserContent } from "../src/lib/analysis/prompt.ts";
import { ANALYSIS_RESPONSE_SCHEMA } from "../src/lib/analysis/schema.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const context = JSON.parse(readFileSync("tests/fixtures/bitcoin-context-2026-09-24.json", "utf8"));
const TOKEN = { tokenId: "bitcoin-btc", context };
const KEYS = { GEMINI_API_KEY: "gem-key-not-real-1b", OPENROUTER_API_KEY: "or-key-not-real-1b", MISTRAL_API_KEY: "mis-key-not-real-1b", GROQ_API_KEY: "groq-key-not-real-1b" };
const OUTPUT_MARKER = "Supply figures come from CoinGecko.";

const obs = (metric) => context.observations.find((item) => item.provider === "CoinGecko" && item.metric === metric);
const calc = (metricId) => context.calculatedMetrics.find((item) => item.metricId === metricId);
const st = (kind, text, sourceIds, period = "") => ({ kind, text, sourceIds, period });

/** A Bitcoin report that satisfies the existing evidence contract (as in evidence-contract.test.mjs). */
function validReport() {
  const price = obs("price_usd");
  const growth = calc("price_growth_pct");
  return {
    executiveSummary: { overview: "Bitcoin evidence here is limited to CoinGecko market data.", statements: [st("observed", `CoinGecko reported a price of about $${Math.round(price.value).toLocaleString("en-US")}.`, [price.id])] },
    marketPerformance: { overview: "Price changes are reported over their own stated periods.", statements: [st("calculated", `Price decreased by about ${Math.abs(growth.value).toFixed(2)}% between the two most recent stored observations.`, [growth.id], growth.period.label)] },
    fundamentalPerformance: { overview: "No protocol-level fundamentals are available for this token.", statements: [st("uncertainty", "Bitcoin has no DeFiLlama mapping, so protocol TVL, fees, and revenue are unavailable by design.", ["scope:defillama"])] },
    valuation: { overview: "Only one valuation ratio is available.", statements: [st("calculated", `CoinGecko volume was about ${(calc("volume_to_market_cap").value * 100).toFixed(1)}% of market capitalization.`, [calc("volume_to_market_cap").id])] },
    marketFundamentalRelationships: { overview: "No price-to-fundamentals relationship can be assessed for this token.", statements: [] },
    liquidityMarketStructure: { overview: "DEX market structure is unavailable by design for this token.", statements: [st("uncertainty", "No verified DexPaprika address mapping exists for Bitcoin, so DEX metrics are unavailable by design.", ["scope:dexpaprika"])] },
    tokenomics: { overview: OUTPUT_MARKER, statements: [] },
    risks: [{ title: "Protocol fundamentals unavailable", basis: "data_limitation", detail: "Bitcoin has no DeFiLlama mapping, so TVL, fees, and revenue are unavailable by design.", sourceIds: ["scope:defillama"] }],
    dataGaps: [{ category: "mapping_limitation", detail: "Bitcoin has no DeFiLlama mapping; TVL, fees, and revenue are unavailable by design.", sourceIds: ["scope:defillama"] }],
    furtherResearchQuestions: [{ question: "Which additional data sources could describe Bitcoin market structure beyond CoinGecko aggregates?", rationale: "Only CoinGecko market data is available in this context.", sourceIds: [] }],
  };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const geminiOk = (report = validReport()) => json({ candidates: [{ content: { parts: [{ text: JSON.stringify(report) }] }, finishReason: "STOP" }], modelVersion: "gemini-served", usageMetadata: { promptTokenCount: 21000, candidatesTokenCount: 3000, thoughtsTokenCount: 1200, totalTokenCount: 25200 } });
const chatOk = (content, extra = {}) => json({ id: "gen-1", model: "served/model", provider: "Upstream", choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 21500, completion_tokens: 5000, completion_tokens_details: { reasoning_tokens: 2000 }, ...extra } });

function scripted(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      const next = responses.shift();
      if (!next) throw new Error("No scripted response left");
      return typeof next === "function" ? next() : next;
    },
  };
}

function assertNoSecrets(value) {
  const text = JSON.stringify(value);
  for (const key of Object.values(KEYS)) assert.ok(!text.includes(key), "no key in results");
  assert.ok(!text.includes(OUTPUT_MARKER), "no model output in results");
  assert.ok(!text.includes(SYSTEM_INSTRUCTION.slice(0, 60)), "no prompt in results");
}

test("B1. every adapter sends the identical instruction, context, schema, and token cap via native structured output; keys only in headers", () => {
  const request = { systemInstruction: SYSTEM_INSTRUCTION, userText: buildUserContent(context), responseSchema: ANALYSIS_RESPONSE_SCHEMA, maxOutputTokens: BENCHMARK_MAX_OUTPUT_TOKENS };
  const schema = JSON.parse(JSON.stringify(ANALYSIS_RESPONSE_SCHEMA));
  for (const adapter of Object.values(ADAPTERS)) {
    const key = KEYS[adapter.keyEnv];
    const built = adapter.buildRequest({ apiKey: key, model: "m" }, request);
    assert.ok(!built.url.includes(key) && !built.body.includes(key), `${adapter.id}: key never in URL or body`);
    assert.ok(Object.values(built.headers).some((value) => value.includes(key)), `${adapter.id}: key sent as a header`);
    const body = JSON.parse(built.body);
    if (adapter.id === "gemini") {
      assert.equal(body.systemInstruction.parts[0].text, SYSTEM_INSTRUCTION);
      assert.equal(body.contents[0].parts[0].text, request.userText);
      assert.deepEqual(body.generationConfig.responseJsonSchema, schema);
      assert.equal(body.generationConfig.responseMimeType, "application/json");
      assert.equal(body.generationConfig.maxOutputTokens, BENCHMARK_MAX_OUTPUT_TOKENS);
      assert.equal(body.generationConfig.temperature, undefined);
    } else {
      assert.equal(body.messages[1].content, request.userText, `${adapter.id}: identical research context`);
      if (adapter.mode === "json_object") {
        // JSON-mode-only providers cannot take a schema natively: the identical instruction plus the identical schema as text.
        assert.equal(body.response_format.type, "json_object");
        assert.equal(body.messages[0].content, `${SYSTEM_INSTRUCTION}${JSON_OBJECT_SCHEMA_PREFIX}${JSON.stringify(ANALYSIS_RESPONSE_SCHEMA)}`);
      } else {
        assert.equal(body.messages[0].content, SYSTEM_INSTRUCTION);
        assert.equal(body.response_format.type, "json_schema");
        assert.equal(body.response_format.json_schema.strict, true);
        assert.deepEqual(body.response_format.json_schema.schema, schema, `${adapter.id}: unmodified Token Samurai schema`);
      }
      assert.equal(body.max_tokens ?? body.max_completion_tokens, BENCHMARK_MAX_OUTPUT_TOKENS);
      assert.equal(body.temperature, undefined);
    }
  }
  assert.equal(ADAPTERS.openrouter.model({ OPENROUTER_MODEL: "nvidia/nemotron-3-super-120b-a12b:free" }), "openrouter/free", "benchmark does not reuse the production Nemotron model");
  assert.equal(ADAPTERS.gemini.model({ GEMINI_MODEL: "gemini-configured" }), "gemini-configured", "Gemini uses the configured production model");
});

test("B2. providers without a key are NOT CONFIGURED and make no request", async () => {
  const { fetchImpl, calls } = scripted([]);
  const results = await runBenchmark(["mistral", "groq"], [TOKEN, TOKEN], { env: {}, fetchImpl });
  assert.equal(calls.length, 0);
  assert.ok(results.every((result) => result.errorCategory === "not_configured" && !result.success));
});

test("B3. Gemini success: tokens mapped without invention, JSON valid, existing validator passes, 10/10 sections", async () => {
  const { fetchImpl, calls } = scripted([geminiOk()]);
  const result = await runOne("gemini", TOKEN, { env: { ...KEYS, GEMINI_MODEL: "gemini-configured" }, fetchImpl });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("gemini-configured:generateContent"));
  assert.equal(result.success, true);
  assert.equal(result.servedModel, "gemini-served");
  assert.deepEqual([result.inputTokens, result.outputTokens, result.reasoningTokens, result.visibleOutputTokens], [21000, 4200, 1200, 3000]);
  assert.equal(result.structuredOutputValid, true);
  assert.equal(result.validationPassed, true, JSON.stringify(result.validationViolationTypes));
  assert.equal(result.validationViolationCount, 0);
  assert.equal(result.sectionsPresent, "10/10");
  assert.equal(result.cost, "UNVERIFIED", "Gemini reports no per-request cost");
  assert.ok(result.responseBytes > 1000);
  assertNoSecrets(result);
});

test("B4. Gemini 503: one attempt, sanitized status, no retry", async () => {
  const { fetchImpl, calls } = scripted([json({ error: { code: 503, status: "UNAVAILABLE", message: `This model is currently experiencing high demand ${KEYS.GEMINI_API_KEY}` } }, 503)]);
  const result = await runOne("gemini", TOKEN, { env: KEYS, fetchImpl });
  assert.equal(calls.length, 1, "no automatic retry");
  assert.equal(result.success, false);
  assert.equal(result.errorCategory, "http_error");
  assert.equal(result.errorStatus, "503 UNAVAILABLE high_demand");
  assertNoSecrets(result);
});

test("B5. OpenRouter free: served model, provider, zero cost is FREE; evidence violations are counted by category", async () => {
  const report = validReport();
  report.marketPerformance.statements[0].period = "past day";
  report.executiveSummary.overview = "Bitcoin traded near $84,388.";
  report.executiveSummary.statements[0].sourceIds = [];
  const { fetchImpl } = scripted([chatOk(JSON.stringify(report), { cost: 0 })]);
  const result = await runOne("openrouter", TOKEN, { env: KEYS, fetchImpl });
  assert.equal(result.success, true, "a completed generation");
  assert.equal(result.structuredOutputValid, true);
  assert.equal(result.validationPassed, false, "valid JSON that breaks the evidence contract is not a valid report");
  assert.equal(result.validationViolationTypes.period, 1);
  // The numeric overview, plus the price in the statement whose citation was removed.
  assert.equal(result.validationViolationTypes.number_grounding, 2);
  assert.equal(result.validationViolationTypes.missing_citation, 1);
  assert.deepEqual([result.servedModel, result.upstreamProvider, result.cost, result.reasoningTokens, result.visibleOutputTokens], ["served/model", "Upstream", "FREE", 2000, 3000]);
});

test("B6. a billable OpenRouter response (cost > 0) is PAID and stops that provider", async () => {
  const { fetchImpl, calls } = scripted([chatOk(JSON.stringify(validReport()), { cost: 0.0042 })]);
  const results = await runBenchmark(["openrouter"], [TOKEN, TOKEN], { env: KEYS, fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(results[0].cost, "PAID");
  assert.equal(results[1].errorCategory, "skipped");
  assert.match(results[1].notes[0], /billable/);
});

test("B7. a provider failing for every token tested is stopped; one attempt per token, no retries", async () => {
  const fail = () => json({ error: { code: 503 } }, 503);
  const { fetchImpl, calls } = scripted([fail, fail]);
  const results = await runBenchmark(["gemini"], [TOKEN, TOKEN, TOKEN], { env: KEYS, fetchImpl });
  assert.equal(calls.length, 2);
  assert.deepEqual(results.map((result) => result.errorCategory), ["http_error", "http_error", "skipped"]);
});

test("B8. fenced JSON is not repaired; schema violations mark structured output invalid", async () => {
  const fenced = scripted([chatOk("```json\n" + JSON.stringify(validReport()) + "\n```")]);
  const result = await runOne("groq", TOKEN, { env: KEYS, fetchImpl: fenced.fetchImpl });
  assert.equal(result.structuredOutputValid, false);
  assert.equal(result.errorCategory, "malformed_json");
  assert.match(result.notes.join(" "), /code fence/);

  const extra = validReport();
  extra.executiveSummary.statements[0].confidence = "high";
  delete extra.dataGaps;
  const shaped = scripted([chatOk(JSON.stringify(extra))]);
  const shapedResult = await runOne("mistral", TOKEN, { env: KEYS, fetchImpl: shaped.fetchImpl });
  assert.equal(shapedResult.structuredOutputValid, false);
  assert.ok(shapedResult.schemaErrors.some((error) => /confidence: property not allowed/.test(error)));
  assert.ok(shapedResult.schemaErrors.some((error) => /dataGaps: missing required property/.test(error)));
  assert.equal(shapedResult.sectionsPresent, "9/10");
});

test("B9. in-body provider errors, truncation, and timeouts are categorized", async () => {
  const inBody = scripted([json({ error: { code: 503, message: "Provider overloaded" } })]);
  assert.equal((await runOne("openrouter", TOKEN, { env: KEYS, fetchImpl: inBody.fetchImpl })).errorCategory, "provider_error");

  const truncated = scripted([json({ choices: [{ finish_reason: "length", message: { content: "{\"executiveSummary\":" } }], usage: { prompt_tokens: 1, completion_tokens: 16384 } })]);
  const cut = await runOne("groq", TOKEN, { env: KEYS, fetchImpl: truncated.fetchImpl });
  assert.equal(cut.errorCategory, "incomplete");
  assert.equal(cut.success, false);

  const slow = scripted([() => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); }]);
  const timedOut = await runOne("mistral", TOKEN, { env: KEYS, fetchImpl: slow.fetchImpl });
  assert.equal(timedOut.errorCategory, "timeout");
});

test("B10. schema checker, section counter, and violation categories", () => {
  assert.deepEqual(schemaErrors(validReport(), ANALYSIS_RESPONSE_SCHEMA), []);
  const badEnum = validReport();
  badEnum.risks[0].basis = "speculation";
  assert.ok(schemaErrors(badEnum, ANALYSIS_RESPONSE_SCHEMA).some((error) => /basis: value not in enum/.test(error)));
  assert.deepEqual(sectionsPresent({}).present, 0);
  assert.equal(categorize('marketPerformance.statements[1]: period is not the label of a cited source.'), "period");
  assert.equal(categorize('x.text: number(s) 95.7 do not match any value in the cited sources.'), "number_grounding");
  assert.equal(categorize('x: unknown source ID "obs:1".'), "missing_citation");
  assert.equal(categorize('x.text: introduces "halving", which the research context does not contain.'), "external_concept");
  assert.equal(categorize('x.text: refers to WBTC, a distinct asset the research context does not establish for this token.'), "asset_substitution");
  assert.equal(categorize('x.text: directional/sentiment language ("bearish"); describe observed changes neutrally.'), "sentiment");
  assert.equal(categorize('x.detail: explains unavailable DeFiLlama data as "stale", but the context\'s reason is that DeFiLlama has no mapping for this token.'), "unmapped_reason");
  assert.equal(categorize('x.text contains investment-advice or prediction language ("price target").'), "advice_prediction");
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
console.log(`${cases.length - failures}/${cases.length} provider-benchmark checks passed.`);
if (failures > 0) process.exitCode = 1;
