import assert from "node:assert/strict";

import { MIN_RAW_READINGS_PER_DAY, buildDashboardTokens } from "../src/lib/data/live-data.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const token = { id: "uniswap-uni", name: "Uniswap", symbol: "UNI", chain_id: "ethereum", contract_address: "0x1f98", is_native: false, category: "DeFi", description: "" };
const chains = [{ id: "ethereum", name: "Ethereum" }];
const dayStart = Date.parse("2026-11-12T00:00:00.000Z");
const asOf = dayStart + 10 * 3_600_000;

/** Raw 15-minute readings for one completed UTC day (daysAgo = 1 is yesterday). */
const readings = (daysAgo, count, marketCap, volume, startId) => Array.from({ length: count }, (_, i) => {
  const at = new Date(dayStart - daysAgo * 86_400_000 + i * 15 * 60_000).toISOString();
  const base = { token_id: token.id, chain_id: token.chain_id, provider_id: "coingecko", status: "available", observed_at: at, collected_at: at, note: null };
  return [
    { ...base, id: startId + i * 2, metric_id: "market_cap_usd", value: marketCap, source_field: "market_cap" },
    { ...base, id: startId + i * 2 + 1, metric_id: "volume_24h_usd", value: volume, source_field: "total_volume" },
  ];
}).flat();

test("a day with no stored daily summary is built from its raw readings, so the market-cap and volume/market-cap changes appear", () => {
  const out = buildDashboardTokens([token], chains, [...readings(2, 96, 100, 10, 1000), ...readings(1, 96, 110, 11, 2000)], asOf)[0];
  assert.ok(Math.abs(out.marketCapChangeDailyAveragePct - 10) < 1e-9, `market cap +10% (got ${out.marketCapChangeDailyAveragePct})`);
  assert.ok(Math.abs(out.volumeToMarketCapChangeDailyAveragePct - (((11 / 110) / (10 / 100)) - 1) * 100) < 1e-9);
});

test("a day with too few raw readings is not a full-day average, so no change is shown", () => {
  assert.equal(MIN_RAW_READINGS_PER_DAY, 72);
  const out = buildDashboardTokens([token], chains, [...readings(2, 96, 100, 10, 1000), ...readings(1, 30, 110, 11, 2000)], asOf)[0];
  assert.equal(out.marketCapChangeDailyAveragePct, null);
  assert.equal(out.volumeToMarketCapChangeDailyAveragePct, null);
});

test("days that are not consecutive give no change (a missing day is never bridged)", () => {
  const out = buildDashboardTokens([token], chains, [...readings(3, 96, 100, 10, 1000), ...readings(1, 96, 110, 11, 2000)], asOf)[0];
  assert.equal(out.marketCapChangeDailyAveragePct, null);
});

let failures = 0;
for (const { name, run } of cases) {
  try { run(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : "unknown error"}`); }
}
console.log(`${cases.length - failures}/${cases.length} daily-change checks passed.`);
if (failures > 0) process.exitCode = 1;
