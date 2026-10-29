import assert from "node:assert/strict";

import { canonicalTokens } from "../src/data/canonical-tokens.ts";
import { coingeckoTokenIds } from "../src/data/coingecko-token-mappings.ts";
import { gapMidnights, repairCoinGeckoDailyGaps } from "../src/lib/providers/repair-coingecko-daily-gaps.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-10-29T12:00:00.000Z");
const TOKEN = canonicalTokens[0];
const ENV = { COINGECKO_API_KEY: "test-key-not-real", COINGECKO_API_PLAN: "demo" };
const noSleep = async () => {};

test("gapMidnights: only a gap that swallows a UTC midnight counts", () => {
  const outage = gapMidnights({ gap_start: "2026-10-22T12:04:48Z", gap_end: "2026-10-23T11:49:52Z" });
  assert.deepEqual(outage.map((ms) => new Date(ms).toISOString()), ["2026-10-23T00:00:00.000Z"]);

  // One-point-per-day data (retention's collapsed shape): the edges are themselves midnight samples.
  assert.deepEqual(gapMidnights({ gap_start: "2026-10-10T00:00:05Z", gap_end: "2026-10-11T00:00:03Z" }), []);
  // After a repair writes the midnight point, the two halves of the old gap swallow nothing.
  assert.deepEqual(gapMidnights({ gap_start: "2026-10-22T12:04:48Z", gap_end: "2026-10-23T00:00:02Z" }), []);
  assert.deepEqual(gapMidnights({ gap_start: "2026-10-23T00:00:02Z", gap_end: "2026-10-23T11:49:52Z" }), []);
  // A multi-day outage owes one point per midnight it spans.
  assert.equal(gapMidnights({ gap_start: "2026-10-20T06:00:00Z", gap_end: "2026-10-23T06:00:00Z" }).length, 3);
});

function hourlyChart() {
  const points = [];
  for (let t = NOW.getTime() - 38 * DAY; t <= NOW.getTime(); t += HOUR) points.push([t + 17_000, 100]);
  return { prices: points, market_caps: points.map(([t]) => [t, 5_000]), total_volumes: points.map(([t]) => [t, 900]) };
}

test("repair writes only the swallowed midnight, for every CoinGecko series, and ignores collapsed-day gaps", async () => {
  const db = createFakeSupabase({ seed: { provider_token_mappings: [{ id: 7, provider_id: "coingecko", token_id: TOKEN.id }] } });
  const gaps = [
    // A true outage that swallows the 2026-10-23 midnight.
    { token_id: TOKEN.id, metric_id: "price_usd", gap_start: "2026-10-22T12:04:48Z", gap_end: "2026-10-23T11:49:52Z" },
    { token_id: TOKEN.id, metric_id: "volume_24h_usd", gap_start: "2026-10-22T12:04:48Z", gap_end: "2026-10-23T11:49:52Z" },
    // Retention's one-point-per-day shape: must not be treated as an outage.
    { token_id: TOKEN.id, metric_id: "volume_24h_usd", gap_start: "2026-10-05T00:00:05Z", gap_end: "2026-10-06T00:00:03Z" },
    { token_id: "other-token-with-only-collapsed-days", metric_id: "price_usd", gap_start: "2026-10-05T00:00:05Z", gap_end: "2026-10-06T00:00:03Z" },
  ];
  const rpcCalls = [];
  db.client.rpc = async (name) => {
    rpcCalls.push(name);
    return { data: name === "get_coingecko_midnight_gaps" ? gaps : [], error: null };
  };
  const requested = [];
  const fetchImpl = async (input) => {
    requested.push(String(input));
    return Response.json(hourlyChart());
  };

  const result = await repairCoinGeckoDailyGaps(db.client, { now: () => NOW, fetchImpl, sleep: noSleep, env: ENV });

  assert.deepEqual(rpcCalls, ["get_coingecko_midnight_gaps", "get_coingecko_daily_gaps", "get_coingecko_daily_gaps"], "audits run one at a time, intraday (midnight gaps) first");
  assert.equal(result.affectedTokens, 1, "the collapsed-day-only token is not an outage");
  assert.equal(result.remainingTokens, 0);
  assert.equal(requested.length, 1);

  const inserted = db.rows("token_metric_observations");
  assert.equal(inserted.length, 3, "one midnight point each for price, market cap and volume");
  assert.deepEqual([...new Set(inserted.map((row) => row.metric_id))].sort(), ["market_cap_usd", "price_usd", "volume_24h_usd"]);
  for (const row of inserted) {
    assert.ok(Math.abs(Date.parse(row.observed_at) - Date.parse("2026-10-23T00:00:00Z")) <= 30 * 60 * 1000, `${row.metric_id} is the midnight point`);
    assert.equal(row.mapping_id, 7);
  }
});

test("repair does nothing when no gap swallows a midnight", async () => {
  const db = createFakeSupabase();
  db.client.rpc = async (name) => ({
    data: name === "get_coingecko_midnight_gaps"
      ? [{ token_id: TOKEN.id, metric_id: "price_usd", gap_start: "2026-10-05T00:00:05Z", gap_end: "2026-10-06T00:00:03Z" }]
      : [],
    error: null,
  });
  let fetched = 0;
  const result = await repairCoinGeckoDailyGaps(db.client, {
    now: () => NOW, fetchImpl: async () => { fetched += 1; return Response.json(hourlyChart()); }, sleep: noSleep, env: ENV,
  });
  assert.equal(result.affectedTokens, 0);
  assert.equal(fetched, 0, "no CoinGecko request is spent");
  assert.equal(db.rows("token_metric_observations").length, 0);
});

test("midnightOnly writes one point for a whole missing day; normal mode keeps its hourly points", async () => {
  async function run(midnightOnly) {
    const db = createFakeSupabase({ seed: { provider_token_mappings: [{ id: 7, provider_id: "coingecko", token_id: TOKEN.id }] } });
    db.client.rpc = async (name, params) => ({
      data: name === "get_coingecko_daily_gaps" && params.p_metric_ids.includes("price_usd")
        ? [{ token_id: TOKEN.id, metric_id: "price_usd", missing_date: "2026-10-20" }]
        : [],
      error: null,
    });
    await repairCoinGeckoDailyGaps(db.client, { now: () => NOW, fetchImpl: async () => Response.json(hourlyChart()), sleep: noSleep, env: ENV, midnightOnly });
    return db.rows("token_metric_observations");
  }
  const normal = await run(false);
  assert.equal(normal.length, 24, "all 24 hourly points of the missing day");
  const reduced = await run(true);
  assert.equal(reduced.length, 1);
  assert.ok(Math.abs(Date.parse(reduced[0].observed_at) - Date.parse("2026-10-20T00:00:00Z")) <= 30 * 60 * 1000, "the kept point is the one nearest midnight");
});

test("a timed-out daily audit does not stop the intraday midnight repair, and total failure still throws", async () => {
  const gap = { token_id: TOKEN.id, metric_id: "price_usd", gap_start: "2026-10-22T12:04:48Z", gap_end: "2026-10-23T11:49:52Z" };
  const timeout = { data: null, error: { message: "canceling statement due to statement timeout" } };

  const db = createFakeSupabase({ seed: { provider_token_mappings: [{ id: 7, provider_id: "coingecko", token_id: TOKEN.id }] } });
  db.client.rpc = async (name) => name === "get_coingecko_midnight_gaps" ? { data: [gap], error: null } : timeout;
  const result = await repairCoinGeckoDailyGaps(db.client, { now: () => NOW, fetchImpl: async () => Response.json(hourlyChart()), sleep: noSleep, env: ENV });
  assert.equal(result.affectedTokens, 1);
  assert.equal(db.rows("token_metric_observations").length, 3, "the midnight point is still written");
  assert.equal(result.auditErrors.length, 2, "both timed-out audits are reported, not hidden");

  const failing = createFakeSupabase();
  failing.client.rpc = async () => timeout;
  await assert.rejects(
    repairCoinGeckoDailyGaps(failing.client, { now: () => NOW, fetchImpl: async () => Response.json(hourlyChart()), sleep: noSleep, env: ENV }),
    /gap audits all failed/,
  );
});

assert.ok(coingeckoTokenIds[TOKEN.id], "the test token has a CoinGecko id");

let failures = 0;
for (const { name, run } of cases) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : error}`);
  }
}
console.log(`${cases.length - failures}/${cases.length} gap repair checks passed.`);
if (failures) process.exitCode = 1;
