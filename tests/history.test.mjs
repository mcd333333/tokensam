import assert from "node:assert/strict";

import { buildHistoricalSeries, coverageChangePct, periodCoverage, pointsInPeriod } from "../src/lib/data/historical-series.ts";
import { buildTokenHistory } from "../src/lib/data/live-data.ts";
import { normalizeMarketChartHistory } from "../src/lib/providers/coingecko-history.ts";
import { runCoinGeckoBackfill } from "../src/lib/providers/run-coingecko-backfill.ts";
import { buildResearchContext } from "../src/lib/analysis/research-context.ts";
import { SYSTEM_INSTRUCTION } from "../src/lib/analysis/prompt.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const NOW = new Date("2026-09-25T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();
const point = (hoursAgo, value = 100, id = hoursAgo) => ({ timestamp: at(hoursAgo), valueUsd: value, sourceId: `obs:${id}` });
const series = (points) => buildHistoricalSeries({ metric: "priceUsd", providerId: "coingecko", scope: "token", points, asOf: NOW });

// ---- 1-4: period selection ----

test("1-4. 24H, 7D, 30D, and 90D windows select only stored points inside each window", () => {
  const points = [91 * 24, 89 * 24, 31 * 24, 29 * 24, 8 * 24, 6 * 24, 23, 1].map((hours) => point(hours));
  const built = series(points);
  assert.equal(built.periods["24H"].observationCount, 2);
  assert.equal(built.periods["7D"].observationCount, 3, "6 days, 23 hours, and 1 hour ago");
  assert.equal(built.periods["30D"].observationCount, 5);
  assert.equal(built.periods["90D"].observationCount, 7, "the 91-day-old point is outside every window");
  for (const period of ["24H", "7D", "30D", "90D"]) {
    const coverage = built.periods[period];
    assert.equal(coverage.windowEnd, NOW.toISOString(), "windows end at the server's asOf, not the latest observation");
    assert.equal(pointsInPeriod(built.points, period, NOW).length, coverage.observationCount);
  }
  assert.equal(built.periods["24H"].coverageLabel, "2 observations spanning 22 hours");
});

// ---- 5-7: sparse, insufficient, boundaries ----

test("5. sparse history reports its actual span, not the requested window", () => {
  const built = series([point(5), point(2.5), point(0.7)]);
  const coverage = built.periods["21D"];
  assert.equal(coverage.status, "available");
  assert.equal(coverage.observationCount, 3);
  assert.equal(coverage.coverageHours, 4.3);
  assert.equal(coverage.fullCoverage, false);
  assert.equal(coverage.coverageLabel, "3 observations spanning 4.3 hours");
  assert.equal(coverage.coverageStart, at(5));
  assert.equal(coverage.coverageEnd, at(0.7));
});

test("6. one point is insufficient; none is unavailable, with explicit reasons", () => {
  const one = series([point(3)]).periods["7D"];
  assert.equal(one.status, "insufficient_history");
  assert.match(one.unavailableReason, /at least two are needed/);
  const none = series([point(40)]).periods["24H"];
  assert.equal(none.status, "unavailable");
  assert.match(none.unavailableReason, /No stored observations fall in the requested 24H window/);
  const unmapped = buildHistoricalSeries({ metric: "tvlUsd", providerId: "defillama", scope: "protocol", points: [], asOf: NOW, unavailableReason: "No curated DeFiLlama protocol mapping." });
  assert.equal(unmapped.periods["90D"].unavailableReason, "No curated DeFiLlama protocol mapping.");
});

test("7. window boundaries are exact and inclusive; future points are excluded", () => {
  const edge = [point(24, 1, "start"), point(24 + 1 / 3_600_000, 2, "just-before"), point(0, 3, "end"), point(-1, 4, "future")];
  const selected = pointsInPeriod(edge.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)), "24H", NOW).map((item) => item.sourceId);
  assert.deepEqual(selected, ["obs:start", "obs:end"]);
});

// ---- 8-10: no fabrication, nulls, zeros ----

const dbRow = (id, provider, metric, value, hoursAgo, status = value === null ? "unavailable" : "available") => ({
  id, token_id: "uniswap-uni", chain_id: "ethereum", provider_id: provider, metric_id: metric, value, status,
  observed_at: at(hoursAgo), collected_at: at(hoursAgo), source_field: metric, note: null,
});

test("8-10. history uses stored rows only: nulls skipped, zeros kept, nothing synthesized", () => {
  const rows = [
    dbRow(1, "coingecko", "price_usd", 9.0, 30), dbRow(2, "coingecko", "price_usd", null, 20), dbRow(3, "coingecko", "price_usd", 9.3, 10),
    dbRow(4, "coingecko", "volume_24h_usd", 0, 30), dbRow(5, "coingecko", "volume_24h_usd", 1000, 10),
    dbRow(6, "defillama", "tvl_usd", 3_800_000_000, 48),
  ];
  const history = buildTokenHistory("uniswap-uni", rows, NOW, { defiLlamaMapped: true });
  assert.deepEqual(history.priceUsd.points.map((item) => item.sourceId), ["obs:1", "obs:3"], "the unavailable row is not plotted or zero-filled");
  assert.ok(history.priceUsd.points.every((item) => rows.some((row) => `obs:${row.id}` === item.sourceId)), "every point is a stored row");
  assert.equal(history.volumeUsd.points[0].valueUsd, 0, "a legitimate zero stays a zero");
  assert.equal(coverageChangePct(history.volumeUsd.points), null, "change from a zero base is undefined, not infinite");
  assert.equal(history.tvlUsd.periods["24H"].status, "unavailable");
  assert.equal(history.tvlUsd.periods["7D"].status, "insufficient_history");
});

// ---- 14: DeFiLlama scope ----

test("14. DeFiLlama TVL history stays protocol-scoped; unmapped tokens are unavailable by design", () => {
  const mapped = buildTokenHistory("uniswap-uni", [dbRow(6, "defillama", "tvl_usd", 1, 48), dbRow(7, "defillama", "tvl_usd", 2, 24)], NOW, { defiLlamaMapped: true });
  assert.equal(mapped.tvlUsd.scope, "protocol");
  assert.equal(mapped.tvlUsd.providerId, "defillama");
  const unmapped = buildTokenHistory("bitcoin-btc", [], NOW, { defiLlamaMapped: false });
  assert.match(unmapped.tvlUsd.unavailableReason, /No curated DeFiLlama protocol mapping.*unavailable by design/);
  assert.equal(unmapped.tvlUsd.points.length, 0);
});

// ---- 11-13: backfill provenance, idempotency, failure ----

const ms = (hoursAgo) => NOW.getTime() - hoursAgo * HOUR;
function marketChart(hoursList, base = 100) {
  const pairs = (offset) => hoursList.map((hours, index) => [ms(hours), base + offset + index]);
  return { prices: pairs(0), market_caps: pairs(1000), total_volumes: [...pairs(50).slice(0, -1), [ms(hoursList.at(-1)), null]] };
}

test("11. backfilled points keep provider timestamps and never supersede the newest stored value", () => {
  const snapshot = normalizeMarketChartHistory({
    asset: { tokenId: "bitcoin-btc", chainId: "bitcoin", externalAssetId: "bitcoin" },
    daily: marketChart([72, 48, 24]),
    hourly: marketChart([3, 2, 1, 0.1]),
    collectedAt: NOW.toISOString(),
    notAfter: { price_usd: at(1.5), market_cap_usd: at(1.5), volume_24h_usd: at(1.5) },
    existing: new Set([`price_usd|${at(48)}`]),
  });
  const prices = snapshot.observations.filter((item) => item.metricId === "price_usd");
  assert.deepEqual(prices.map((item) => item.observedAt), [at(72), at(24), at(3), at(2)], "already-stored and newer-than-latest points are excluded");
  assert.ok(snapshot.observations.every((item) => item.sourceField.startsWith("market_chart.") && item.status === "available" && item.value !== null));
  assert.ok(snapshot.observations.every((item) => item.collectedAt === NOW.toISOString()), "collection time is recorded separately");
  assert.match(snapshot.endpointLabel, /market_chart/);
  assert.ok(snapshot.rawPayload.daily.prices.length === 3);
});

function coingeckoFetch(calls, mode = "ok") {
  return async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (mode === "error") return new Response("{}", { status: 500 });
    if (mode === "rate_limited") return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    return Response.json(url.searchParams.get("interval") === "daily" ? marketChart([96, 72, 48, 24]) : marketChart([6, 5, 4, 3, 2, 1]));
  };
}
const liveRows = () => ["price_usd", "market_cap_usd", "volume_24h_usd"].map((metric, index) => ({
  id: 900 + index, token_id: "bitcoin-btc", chain_id: "bitcoin", provider_id: "coingecko", metric_id: metric, raw_record_id: null,
  value: 84_736, status: "available", observed_at: at(1.5), collected_at: at(1.4), window_days: null, source_field: metric, note: null,
}));
const env = { COINGECKO_API_KEY: "test-key-not-real" };

test("11-12. backfill stores provenance, is idempotent, and leaves the latest value untouched", async () => {
  const db = createFakeSupabase({ seed: { token_metric_observations: liveRows() } });
  const calls = [];
  const first = await runCoinGeckoBackfill(db.client, { tokenIds: ["bitcoin-btc"], env, fetchImpl: coingeckoFetch(calls), sleep: async () => {}, now: () => NOW });
  assert.equal(first.requests, 2, "two bounded requests per token");
  assert.equal(first.results[0].status, "backfilled");
  const raw = db.rows("raw_provider_records");
  assert.equal(raw.length, 1);
  assert.match(raw[0].endpoint_label, /market_chart/);
  const added = db.rows("token_metric_observations").filter((row) => row.source_field?.startsWith("market_chart."));
  assert.equal(added.length, first.results[0].newObservations);
  assert.ok(added.every((row) => row.raw_record_id === raw[0].id), "each backfilled row links to its raw provider record");
  assert.ok(added.every((row) => Date.parse(row.observed_at) < Date.parse(at(1.5))), "nothing newer than the latest live observation");
  const { data: latestRows } = await db.client.from("latest_token_metric_observations").select("*").eq("token_id", "bitcoin-btc");
  const latestPrice = latestRows.find((row) => row.metric_id === "price_usd");
  assert.equal(latestPrice.id, 900, "the live observation remains the latest value");

  const second = await runCoinGeckoBackfill(db.client, { tokenIds: ["bitcoin-btc"], env, fetchImpl: coingeckoFetch(calls), sleep: async () => {}, now: () => NOW });
  assert.equal(second.results[0].status, "up_to_date");
  assert.equal(second.results[0].newObservations, 0);
  assert.equal(db.rows("raw_provider_records").length, 1, "a rerun with nothing new writes no raw record");
  assert.equal(db.rows("token_metric_observations").length, 3 + added.length, "no duplicate observations");
});

test("13. provider failure writes nothing and preserves stored history; 429 stops the run", async () => {
  const db = createFakeSupabase({ seed: { token_metric_observations: liveRows() } });
  const before = JSON.stringify(db.rows("token_metric_observations"));
  const failed = await runCoinGeckoBackfill(db.client, { tokenIds: ["bitcoin-btc"], env, fetchImpl: coingeckoFetch([], "error"), sleep: async () => {}, now: () => NOW });
  assert.equal(failed.results[0].status, "failed");
  assert.equal(JSON.stringify(db.rows("token_metric_observations")), before);
  assert.equal(db.rows("raw_provider_records").length, 0);

  const calls = [];
  const limited = await runCoinGeckoBackfill(db.client, { tokenIds: ["bitcoin-btc", "ethereum-eth", "ethereum-usdt"], env, fetchImpl: coingeckoFetch(calls, "rate_limited"), sleep: async () => {}, now: () => NOW });
  assert.deepEqual(limited.results.map((result) => result.status), ["failed", "skipped", "skipped"]);
  assert.equal(calls.length, 3, "bounded retries on the first request, then the run stops");
  await assert.rejects(runCoinGeckoBackfill(db.client, { tokenIds: ["not-a-token"], env }), /Unknown canonical token/);
});

// ---- 15-16: Gemini coverage and labels ----

test("15-16. the AI context receives actual coverage; short spans are never labelled as full periods", () => {
  const token = { id: "bitcoin-btc", name: "Bitcoin", symbol: "BTC", chainId: "bitcoin", chainName: "Bitcoin", contractAddress: null, isNative: true, category: "Layer 1", description: null };
  const history = [21, 10, 0.5].map((hours, index) => ({ ...dbRow(700 + index, "coingecko", "price_usd", 84_000 + index, hours), token_id: "bitcoin-btc", chain_id: "bitcoin" }));
  const context = buildResearchContext({ now: NOW, token, latestObservations: [], history, metricDefinitions: [], calculated: [], calculatedCategories: {}, lastSuccess: {}, latestAttempts: {} });
  const price = context.history.find((item) => item.id === "hist:coingecko:price_usd");
  const day = price.coverage["24H"];
  assert.equal(day.observationCount, 3, "coverage uses every stored observation, not the daily sample");
  assert.equal(day.coverageHours, 20.5);
  assert.equal(day.coversRequestedWindow, false, "20.5 hours does not cover a 24-hour window");
  assert.equal(day.coverageLabel, "3 observations spanning 20.5 hours");
  assert.equal(price.coverage["21D"].coversRequestedWindow, false);
  for (const coverage of Object.values(price.coverage)) assert.doesNotMatch(coverage.coverageLabel, /24H|7D|21D|24-hour|7-day|21-day/);
  assert.match(SYSTEM_INSTRUCTION, /A requested window is not achieved coverage/);
  assert.equal(periodCoverage([point(23), point(0)], "24H", NOW).fullCoverage, true, "23 of 24 hours counts as covering the window");
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
console.log(`${cases.length - failures}/${cases.length} history checks passed.`);
if (failures > 0) process.exitCode = 1;
