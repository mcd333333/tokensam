import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { drawdownSeries, hourlyRiskSamples, pointsInPeriod, riskProfile, rollingVolatility, RISK_VOLATILITY_WINDOW_DAYS } from "../src/lib/data/historical-series.ts";
import { buildTokenHistory } from "../src/lib/data/live-data.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }
const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} ≈ ${b}`);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const TODAY = Date.parse("2026-09-25T00:00:00.000Z");
const asOf = new Date(TODAY);
const iso = (daysAgo, extraMs = 0) => new Date(TODAY - daysAgo * DAY + extraMs).toISOString();
const hourly = (values) => values.map((value, i) => ({ timestamp: new Date(TODAY - (values.length - 1 - i) * HOUR).toISOString(), valueUsd: value, sourceId: `obs:${id++}` }));
let id = 1;
/** Daily points ending today; values[i] is `values.length − 1 − i` days ago. */
const daily = (values) => values.map((value, i) => ({ timestamp: iso(values.length - 1 - i), valueUsd: value, sourceId: `obs:${id++}` }));
const values = (points) => points.map((p) => p.valueUsd);

test("1. volatility = sample σ of hourly log returns × √(24×365) × 100, capped at 7 days", () => {
  const prices = Array.from({ length: 169 }, (_, i) => 100 + Math.sin(i / 8) * 5 + i * 0.01);
  const points = hourly(prices);
  const risk = rollingVolatility(points);
  const v = risk.at(-1);
  const r = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
  const mean = r.reduce((a, b) => a + b) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
  close(v.valueUsd, sd * Math.sqrt(24 * 365) * 100);
  assert.equal(RISK_VOLATILITY_WINDOW_DAYS, 7);
  assert.equal(risk.length, 167, "169 hourly prices produce an expanding warm-up plus the full 168-return endpoint");
  assert.equal(rollingVolatility(daily(prices)).length, 0, "non-hourly points are never treated as hourly returns");
  assert.equal(values(rollingVolatility(hourly([5, 5, 5])))[0], 0, "constant prices → 0% volatility (a genuine zero)");
});

test("2–5. drawdown from the running peak: 0 at a peak, negative below, never positive", () => {
  const dd = drawdownSeries(daily([100, 120, 90, 120, 130, 65]));
  assert.deepEqual(values(dd).map((v) => Math.round(v * 100) / 100), [0, 0, -25, 0, 0, -50]);
  assert.ok(dd.every((p) => p.valueUsd <= 0 && !Object.is(p.valueUsd, -0)));
  const falling = drawdownSeries(daily([10, 9, 8, 7]));
  assert.deepEqual(values(falling).map((v) => Math.round(v * 10) / 10), [0, -10, -20, -30]);
});

test("6. missing, null, zero, negative and non-finite prices are skipped, never zero", () => {
  const points = [
    ...daily([100, 110]),
    { timestamp: iso(0, 3600e3), valueUsd: 0, sourceId: "obs:900" },
    { timestamp: iso(3), valueUsd: Number.NaN, sourceId: "obs:901" },
    { timestamp: iso(4), valueUsd: -5, sourceId: "obs:902" },
  ];
  const samples = hourlyRiskSamples(points, asOf);
  assert.ok(samples.every((p) => p.valueUsd > 0 && Number.isFinite(p.valueUsd)), "invalid prices never become risk samples");
  assert.deepEqual(values(drawdownSeries([{ timestamp: iso(1), valueUsd: 0, sourceId: "x" }, ...daily([50])])), [0], "a zero price is ignored, not a 100% drawdown");
  // Built from stored rows: an unavailable/null price is not a point at all.
  const rows = [
    { id: 1, token_id: "t", chain_id: "c", metric_id: "price_usd", provider_id: "coingecko", value: 10, status: "available", observed_at: iso(2), collected_at: iso(2), source_field: "p", note: null },
    { id: 2, token_id: "t", chain_id: "c", metric_id: "price_usd", provider_id: "coingecko", value: null, status: "unavailable", observed_at: iso(1), collected_at: iso(1), source_field: "p", note: null },
    { id: 3, token_id: "t", chain_id: "c", metric_id: "price_usd", provider_id: "coingecko", value: 8, status: "available", observed_at: iso(0), collected_at: iso(0), source_field: "p", note: null },
  ];
  const profile = riskProfile(buildTokenHistory("t", rows, asOf).priceUsd.points, "7D", asOf);
  assert.ok(profile.hourly.length >= 2, "risk profile exposes granular price samples");
  assert.deepEqual(values(profile.drawdown).map((v) => Math.round(v)), [0, -20]);
});

test("gaps are never bridged: volatility resets its expanding warm-up after a missing hour", () => {
  const points = hourly(Array.from({ length: 20 }, (_, i) => 100 + i)).filter((_, i) => i !== 10);
  const risk = rollingVolatility(points);
  assert.ok(risk.length > 0);
  const afterGap = risk.filter((point) => Date.parse(point.timestamp) > Date.parse(points[9].timestamp));
  assert.ok(afterGap.length > 0);
  assert.ok(Date.parse(afterGap[0].timestamp) - Date.parse(points[9].timestamp) >= 2 * HOUR, "post-gap volatility needs two consecutive returns");
});

test("7. chronological order: drawdown sorts by time; risk samples normalize to UTC hourly boundaries", () => {
  const shuffled = daily([100, 80, 120, 60]).reverse();
  assert.deepEqual(values(drawdownSeries(shuffled)).map((v) => Math.round(v * 1e6) / 1e6), [0, -20, 0, -50]);
  const mixed = [
    { timestamp: new Date(TODAY - 2 * HOUR + 10 * 60e3).toISOString(), valueUsd: 100, sourceId: "obs:1000" },
    { timestamp: new Date(TODAY - 1 * HOUR - 10 * 60e3).toISOString(), valueUsd: 101, sourceId: "obs:1001" },
    { timestamp: new Date(TODAY).toISOString(), valueUsd: 102, sourceId: "obs:1002" },
  ];
  assert.deepEqual(values(hourlyRiskSamples(mixed, asOf)), [100, 101, 102], "nearest observations within 30 minutes represent hourly boundaries");
});

test("8. 24H / 7D / 14D windows use granular hourly prices and volatility starts after a short expanding warm-up", () => {
  const prices = Array.from({ length: 14 * 24 + 1 }, (_, i) => 100 + Math.sin(i / 8) * 5 + i * 0.01);
  const points = hourly(prices);
  for (const [period, expectedMin] of [["24H", 24], ["7D", 7 * 24], ["14D", 14 * 24]]) {
    const { hourly: inWindow, drawdown, volatility } = riskProfile(points, period, asOf);
    assert.ok(inWindow.length >= expectedMin, `${period} has granular hourly samples`);
    assert.equal(drawdown.length, inWindow.length);
    assert.equal(drawdown[0].valueUsd, 0, `${period} starts at its own peak`);
    assert.ok(volatility.every((p) => pointsInPeriod([p], period, asOf).length === 1), `${period} volatility dates lie inside the window`);
  }
  for (const period of ["24H", "7D", "14D"]) {
    const profile = riskProfile(points, period, asOf);
    assert.ok(profile.volatility.length > 0, `${period} volatility is available`);
    const firstWindowTime = Date.parse(profile.hourly[0].timestamp);
    const firstVolatilityTime = Date.parse(profile.volatility[0].timestamp);
    assert.ok(firstVolatilityTime - firstWindowTime <= 2 * HOUR, `${period} volatility starts within the first two calculable hourly returns`);
  }
});

test("9. both series are present and independent; the card is wired into Market History", () => {
  const { volatility, drawdown } = riskProfile(hourly(Array.from({ length: 14 * 24 + 1 }, (_, i) => 100 + i * (i % 3 ? 0.01 : -0.02))), "14D", asOf);
  assert.ok(volatility.length > 0 && drawdown.length > 0);
  assert.ok(volatility.every((p) => p.valueUsd >= 0) && drawdown.every((p) => p.valueUsd <= 0));
  const chart = readFileSync(new URL("../src/components/HistoricalSection.tsx", import.meta.url), "utf8");
  for (const phrase of [">Risk profile<", "Historical risk profile based on price volatility and drawdown.", "Volatility measures historical price variability; drawdown measures the decline from a prior peak.", "<ReferenceLine y={0}", '(["volatility", "drawdown"] as const)', "RiskTooltip"]) {
    assert.ok(chart.includes(phrase), phrase);
  }
  assert.doesNotMatch(chart, /Risk analysis|risk score|bullish|bearish|volumeToMarketCap|Volume \/ market cap/i);
});

test("10. no database writes: the history and chart code only reads and computes", () => {
  for (const path of ["../src/lib/data/historical-series.ts", "../src/components/HistoricalSection.tsx"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\.(insert|upsert|update|delete)\(|createSupabase|fetch\(/, path);
  }
});

test("11. Price and Volume · 24h charts are unchanged; Market cap is no longer in Market History", () => {
  const model = readFileSync(new URL("../src/lib/ui/profile-model.ts", import.meta.url), "utf8");
  assert.match(model, /const MARKET_HISTORY: HistoryChartKey\[\] = \["priceUsd", "volumeUsd", "riskProfile"\];/);
  const chart = readFileSync(new URL("../src/components/HistoricalSection.tsx", import.meta.url), "utf8");
  assert.match(chart, /priceUsd: \{ label: "Price", color: "#d0443b" \}/);
  assert.match(chart, /volumeUsd: \{ label: "Volume · 24h", color: "#c9a45c" \}/);
  assert.match(chart, /<strong>\{formatUsd\(value\)\}<\/strong>/, "USD charts keep their tooltip");
  assert.match(chart, /metric === "riskProfile"\n\s+\? <RiskProfileCard/);
});

let failures = 0;
for (const { name, run } of cases) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}
console.log(`${cases.length - failures}/${cases.length} risk-profile checks passed.`);
if (failures > 0) process.exitCode = 1;
