import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { correlation, emaSeries, linearRegression, rsi, sampleStdev, sma, stdev } from "../src/lib/indicators/math.ts";
import { DAY_MS, SERIES_RULES, alignSeries, contiguousTail, dailySamples, maxHistoryAgeDays } from "../src/lib/indicators/series.ts";
import { INDICATOR_DEFINITIONS, direction, relationState, relationshipLabel, spansExactly, swingPoints } from "../src/lib/indicators/catalog.ts";
import { evaluateTechnicalIndicators } from "../src/lib/indicators/build.ts";
import { formatReading, readingTone } from "../src/lib/ui/indicator-format.ts";
import { horizonLabel, intervalBetween } from "../src/lib/ui/format.ts";
import { buildProfileModel } from "../src/lib/ui/profile-model.ts";
import { buildTokenHistory } from "../src/lib/data/live-data.ts";
import { namesProvider } from "../src/lib/ui/data-language.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }
const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} ≈ ${b}`);

// asOf is 06:00 UTC; the newest daily sample is today's 00:00 boundary.
const AS_OF = new Date("2026-09-25T06:00:00.000Z");
const TODAY = Date.parse("2026-09-25T00:00:00.000Z");
let nextId = 1;
/** `values[i]` is stored at 00:00 UTC, (values.length − 1 − i) days before TODAY (the last value is today). */
function daily(metric, provider, values, { endDaysAgo = 0, offsetMs = 0 } = {}) {
  return values.map((value, i) => ({
    id: nextId++, metric_id: metric, provider_id: provider, value, status: "available",
    observed_at: new Date(TODAY - (endDaysAgo + values.length - 1 - i) * DAY_MS + offsetMs).toISOString(),
  }));
}
const wave = (n, base = 100, amp = 8, drift = 0.3) => Array.from({ length: n }, (_, i) => base + drift * i + amp * Math.sin(i / 3) + 2 * Math.cos(i * 1.7));
const price = (values, opts) => daily("price_usd", "coingecko", values, opts);
const volume = (values, opts) => daily("volume_24h_usd", "coingecko", values, opts);
const marketCap = (values, opts) => daily("market_cap_usd", "coingecko", values, opts);
const tvl = (values, opts) => daily("tvl_usd", "defillama", values, opts);
const evaluate = (rows, protocolMapped = false) => evaluateTechnicalIndicators(rows, { asOf: AS_OF, protocolMapped });
const ids = (view) => view.groups.flatMap((group) => group.indicators.map((indicator) => indicator.id));
const byId = (view, id) => view.groups.flatMap((group) => group.indicators).find((indicator) => indicator.id === id);
const reading = (indicator, label) => indicator.readings.find((item) => item.label === label)?.value;

const full = (opts) => {
  const p = wave(90);
  return [
    ...price(p, opts),
    ...volume(p.map((v, i) => 1e6 * (1 + 0.3 * Math.sin(i))), opts),
    ...marketCap(p.map((v) => v * 1e7), opts),
    ...tvl(p.map((v, i) => 5e8 + 1e6 * i + 3e6 * Math.cos(i / 2)), opts),
  ];
};

// ---- Math ----

test("SMA, EMA (SMA-seeded, k = 2/(n+1)) and standard deviations match hand calculations", () => {
  assert.equal(sma([1, 2, 3, 4, 5], 5), 3);
  assert.equal(sma([1, 2, 3], 5), null);
  const ema = emaSeries([1, 2, 3, 4, 5, 6], 3);
  assert.deepEqual(ema.map((v) => +v.toFixed(6)), [2, 3, 4, 5]);
  close(stdev([2, 4, 4, 4, 5, 5, 7, 9]), 2);
  close(sampleStdev([2, 4, 4, 4, 5, 5, 7, 9]), Math.sqrt(32 / 7));
});

test("Wilder RSI: all gains = 100, all losses = 0, no movement is undefined, and a known mixed series", () => {
  assert.equal(rsi([1, 2, 3, 4, 5, 6], 3), 100);
  assert.equal(rsi([6, 5, 4, 3, 2, 1], 3), 0);
  assert.equal(rsi([5, 5, 5, 5, 5], 3), null);
  // changes +1, −1, +2, then +1 with Wilder smoothing: gain (1+0+2)/3=1 → (1×2+1)/3=1; loss 1/3 → (1/3×2)/3=2/9
  close(rsi([10, 11, 10, 12, 13], 3), 100 - 100 / (1 + 1 / (2 / 9)));
  assert.equal(rsi([1, 2, 3], 3), null, "needs period + 1 values");
});

test("linear regression, correlation and swing points", () => {
  const fit = linearRegression([3, 5, 7, 9, 11]);
  close(fit.slope, 2); close(fit.r2, 1);
  close(correlation([1, 2, 3, 4], [2, 4, 6, 8]), 1);
  close(correlation([1, 2, 3, 4], [8, 6, 4, 2]), -1);
  assert.equal(correlation([1, 1, 1, 1], [1, 2, 3, 4]), null, "no variation → undefined");
  const points = [1, 2, 3, 9, 3, 2, 1, 0, 1, 2, 3].map((value, i) => ({ time: i * DAY_MS, value, obsId: i }));
  const { highs, lows } = swingPoints(points, 3);
  assert.deepEqual(highs.map((p) => p.value), [9]);
  assert.deepEqual(lows.map((p) => p.value), [0]);
});

test("MACD equals EMA12 − EMA26 of the same closes, with a 9-day EMA signal", () => {
  const values = wave(90);
  const { view } = evaluate(price(values));
  const macd = byId(view, "macd");
  const naiveEma = (n) => { const k = 2 / (n + 1); let e = values.slice(0, n).reduce((a, b) => a + b) / n; for (let i = n; i < values.length; i += 1) e = values[i] * k + e * (1 - k); return e; };
  const fast = emaSeries(values, 12), slow = emaSeries(values, 26);
  const line = slow.map((v, i) => fast[i + 14] - v);
  close(reading(macd, "MACD line"), naiveEma(12) - naiveEma(26), 1e-9);
  close(reading(macd, "Signal line"), emaSeries(line, 9).at(-1), 1e-9);
  close(reading(macd, "Histogram"), reading(macd, "MACD line") - reading(macd, "Signal line"), 1e-12);
});

test("Bollinger Bands, ROC and historical volatility use exactly their stated windows", () => {
  const values = wave(90);
  const { view } = evaluate(price(values));
  const last20 = values.slice(-20);
  const bb = byId(view, "bollinger_20_2");
  close(reading(bb, "Middle"), sma(last20, 20));
  close(reading(bb, "Upper"), sma(last20, 20) + 2 * stdev(last20));
  assert.equal(bb.provenance.observationCount, 20);
  assert.equal(bb.provenance.observationStart, new Date(TODAY - 19 * DAY_MS).toISOString());
  assert.equal(bb.provenance.observationEnd, new Date(TODAY).toISOString());
  close(reading(byId(view, "roc_14"), "ROC"), (values.at(-1) / values.at(-15) - 1) * 100);
  assert.equal(byId(view, "roc_14").provenance.observationCount, 15);
  const returns = values.slice(-31).slice(1).map((v, i) => Math.log(v / values.slice(-31)[i]));
  close(reading(byId(view, "historical_volatility_30"), "Annualized"), sampleStdev(returns) * Math.sqrt(365) * 100);
  close(reading(byId(view, "sma_50"), "SMA"), sma(values, 50));
});

// ---- Normalization ----

test("daily samples: the observation nearest 00:00 UTC within 30 minutes; off-hour points are ignored", () => {
  const rows = [
    ...price([10, 11, 12]),
    { id: 900, metric_id: "price_usd", provider_id: "coingecko", value: 99, status: "available", observed_at: new Date(TODAY - 5 * 3600e3).toISOString() },
    { id: 901, metric_id: "price_usd", provider_id: "coingecko", value: 77, status: "available", observed_at: new Date(TODAY + 20 * 60e3).toISOString() },
    { id: 902, metric_id: "price_usd", provider_id: "coingecko", value: null, status: "unavailable", observed_at: new Date(TODAY).toISOString() },
  ];
  const samples = dailySamples(rows, SERIES_RULES.price, AS_OF.getTime());
  assert.deepEqual(samples.map((p) => p.value), [10, 11, 12], "exact midnight wins over a point 20 minutes later; 19:00 is not a daily sample");
});

test("gaps break the series: only the consecutive run ending at the newest sample is used", () => {
  const withGap = [...price(wave(40), { endDaysAgo: 22 }), ...price(wave(21))];
  const samples = dailySamples(withGap, SERIES_RULES.price, AS_OF.getTime());
  assert.equal(contiguousTail(samples, AS_OF.getTime()).length, 21);
  const { view, omitted } = evaluate(withGap);
  assert.ok(ids(view).includes("sma_20"));
  assert.ok(!ids(view).includes("sma_50") && !ids(view).includes("rsi_14"), "history before the gap is not bridged");
  assert.equal(omitted.find((o) => o.id === "sma_50").reason, "insufficient_history");
});

test("aligned inputs use only days present in every series", () => {
  const a = [1, 2, 3].map((value, i) => ({ time: TODAY - (2 - i) * DAY_MS, value, obsId: i }));
  const b = [5, 6].map((value, i) => ({ time: TODAY - (1 - i) * DAY_MS, value, obsId: 10 + i }));
  const [x, y] = alignSeries([a, b], AS_OF.getTime());
  assert.deepEqual(x.map((p) => p.value), [2, 3]);
  assert.deepEqual(y.map((p) => p.value), [5, 6]);
});

// ---- Availability ----

test("price-only history shows price indicators; volume, TVL and divergence indicators do not appear", () => {
  const { view, omitted } = evaluate(price(wave(90)));
  const shown = ids(view);
  for (const id of ["sma_20", "sma_50", "ema_20", "macd", "linreg_slope_20", "rsi_14", "roc_14", "bollinger_20_2", "historical_volatility_30", "ulcer_index_14", "swing_structure", "closing_range_30"]) {
    assert.ok(shown.includes(id), `${id} shown`);
  }
  for (const id of ["vwma_20", "volume_sma_20", "obv_20", "tvl_change_7d", "price_vs_tvl_30d", "market_cap_vs_tvl_30d", "price_vs_volume_30d", "volume_to_market_cap_30d"]) {
    assert.ok(!shown.includes(id), `${id} hidden`);
    assert.equal(omitted.find((o) => o.id === id).reason, "missing_input");
  }
  assert.deepEqual(view.groups.map((g) => g.category), ["trend", "momentum", "volatility", "market_structure"], "empty categories are not rendered");
});

test("minimum history is enforced per indicator (30 days: no SMA50, EMA20, MACD or RSI)", () => {
  const shown = ids(evaluate(price(wave(30))).view);
  assert.ok(shown.includes("sma_20") && shown.includes("bollinger_20_2") && shown.includes("closing_range_30"));
  for (const id of ["sma_50", "ema_20", "macd", "rsi_14"]) assert.ok(!shown.includes(id), `${id} needs more history`);
  const definition = Object.fromEntries(INDICATOR_DEFINITIONS.map((d) => [d.id, d.minPoints]));
  assert.deepEqual([definition.sma_20, definition.ema_20, definition.macd, definition.rsi_14, definition.historical_volatility_30], [20, 40, 61, 43, 31]);
  assert.deepEqual(ids(evaluate(price(wave(14))).view), [], "14 days calculate nothing");
});

test("indicators disappear when their inputs are removed; TVL needs a curated protocol mapping", () => {
  const all = full();
  const mapped = ids(evaluate(all, true).view);
  for (const id of ["vwma_20", "obv_20", "tvl_change_7d", "price_vs_tvl_30d", "market_cap_vs_tvl_30d", "price_vs_volume_30d", "volume_to_market_cap_30d"]) assert.ok(mapped.includes(id), id);
  const unmapped = ids(evaluate(all, false).view);
  assert.ok(!unmapped.some((id) => ["tvl_change_7d", "price_vs_tvl_30d", "market_cap_vs_tvl_30d"].includes(id)), "TVL rows without a mapping are never used");
  const noVolume = ids(evaluate(all.filter((row) => row.metric_id !== "volume_24h_usd"), true).view);
  assert.ok(!noVolume.some((id) => ["vwma_20", "obv_20", "volume_sma_20", "price_vs_volume_30d", "volume_to_market_cap_30d"].includes(id)));
  assert.ok(noVolume.includes("price_vs_tvl_30d"));
  assert.deepEqual(ids(evaluate([]).view), [], "no data → no section content");
});

test("derivatives are never shown: no derivatives inputs exist, so no definitions are registered", () => {
  assert.equal(INDICATOR_DEFINITIONS.filter((d) => d.category === "derivatives").length, 0);
  assert.ok(!evaluate(full(), true).view.groups.some((g) => g.category === "derivatives"));
});

test("only the declared series feed indicators: 24h/7d changes, DEX prices and wrapped-proxy rows are ignored", () => {
  const base = price(wave(90));
  const noise = [
    ...daily("price_change_7d_pct", "coingecko", wave(90, 50)),
    ...daily("price_change_24h_pct", "coingecko", wave(90, 5)),
    ...daily("price_usd", "dexpaprika", wave(90, 999)),
    ...daily("price_usd", "defillama_coins", wave(90, 555)),
  ];
  assert.deepEqual(JSON.stringify(evaluate(base).view.groups.map((g) => g.indicators.map((i) => i.readings))),
    JSON.stringify(evaluate([...base, ...noise]).view.groups.map((g) => g.indicators.map((i) => i.readings))));
});

test("no fabricated values: every shown reading is finite, flat data omits undefined indicators, and provenance is traceable", () => {
  const flat = evaluate(price(Array(90).fill(5)));
  const flatIds = ids(flat.view);
  for (const id of ["bollinger_20_2", "rsi_14", "closing_range_30", "swing_structure"]) {
    assert.ok(!flatIds.includes(id), `${id} is undefined for constant prices`);
    assert.equal(flat.omitted.find((o) => o.id === id).reason, "not_calculable");
  }
  const rows = full();
  const rowIds = new Set(rows.map((row) => row.id));
  const { view } = evaluate(rows, true);
  for (const indicator of view.groups.flatMap((g) => g.indicators)) {
    assert.equal(indicator.available, true);
    for (const r of indicator.readings) if (typeof r.value === "number") assert.ok(Number.isFinite(r.value), `${indicator.id} ${r.label}`);
    assert.ok(indicator.provenance.sourceObservationIds.length > 0 && indicator.provenance.sourceObservationIds.every((id) => rowIds.has(id)), `${indicator.id} ids trace to stored rows`);
    assert.equal(indicator.provenance.calculatedAt, AS_OF.toISOString());
    assert.ok(indicator.formula && indicator.description && indicator.periodLabel);
  }
});

test("divergence wording is neutral and rule-based", () => {
  assert.equal(direction(0.5), "flat");
  assert.equal(relationState("price", 5, "TVL", -3), "Divergence detected: price ↑, TVL ↓");
  assert.equal(relationState("price", 5, "TVL", 2), "Same direction: price and TVL both ↑");
  assert.equal(relationState("price", 0.2, "TVL", -4), "price little changed, TVL ↓");
  assert.equal(relationshipLabel(0.1), "No clear linear relationship");
  const text = JSON.stringify(INDICATOR_DEFINITIONS.map(({ name, description, formula, periodLabel }) => ({ name, description, formula, periodLabel })))
    + readFileSync(new URL("../src/components/TechnicalIndicators.tsx", import.meta.url), "utf8")
    + JSON.stringify(evaluate(full(), true).view);
  assert.doesNotMatch(text, /\b(buy|sell|bullish|bearish|overbought|oversold|entry|exit|recommend\w*|predict\w*|price target)\b/i);
});

// ---- Presentation ----

test("UI receives only available indicators; the Technical section and nav entry exist only with indicators", () => {
  const view = evaluate(full(), true).view;
  const profile = (technicalIndicators) => ({
    token: { id: "aave-aave", name: "Aave", symbol: "AAVE", chain: "Ethereum", category: "DeFi", priceUsd: 1, change24hPct: null, change7dPct: null, marketCapUsd: null, volume24hUsd: null, tvlUsd: null, tvlChange30dPct: null, fees24hUsd: null, revenue24hUsd: null, observedAt: "", metricSources: {} },
    technicalIndicators, description: null, contractAddress: null, isNative: false, circulatingSupply: null, totalSupply: null, maximumSupply: null,
    metricSources: {}, calculatedMetrics: [], history: buildTokenHistory("aave-aave", [], AS_OF),
    dataNotes: [], dexMapped: false, defiLlamaMapped: false, datasetFreshness: [],
    coverage: [], tokenLevelPrice: null, logoUrl: null, protocol: null, dexActivity: { transactions24h: null, buys24h: null, sells24h: null },
  });
  const sections = buildProfileModel(profile(view)).sections.map((s) => s.id);
  assert.deepEqual(sections, ["overview", "market", "technical", "analysis", "sources"], "only sections with content; cross-metric analysis sits inside Technical");
  const model = buildProfileModel(profile(view));
  assert.ok(!model.technical.some((group) => group.category === "divergence"), "cross-metric groups are not repeated under Technical");
  assert.deepEqual(model.divergence.indicators.map((i) => i.category), model.divergence.indicators.map(() => "divergence"));
  assert.ok(!buildProfileModel(profile({ ...view, groups: [] })).sections.some((s) => s.id === "technical"));
  assert.ok(!buildProfileModel(profile(null)).sections.some((s) => s.id === "technical"));
  const profileSource = readFileSync(new URL("../src/components/TokenProfile.tsx", import.meta.url), "utf8");
  assert.match(profileSource, /data.technicalIndicators && technical.length > 0/);
  const component = readFileSync(new URL("../src/components/TechnicalIndicators.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(component, /N\/A|Not available|No data/i, "no placeholders");
  assert.equal(namesProvider(component + JSON.stringify(view.groups.map((g) => g.indicators.map((i) => [i.name, i.description, i.formula, i.readings])))), false, "no provider names in visible text");
});

// ---- Historical freshness vs current-market freshness ----

test("A. indicators stay available when the newest historical sample is older than the 3-day market threshold", () => {
  const rows = full({ endDaysAgo: 5 });
  const { view, omitted } = evaluate(rows, true);
  const shown = ids(view);
  for (const id of ["sma_20", "sma_50", "ema_20", "macd", "rsi_14", "roc_14", "bollinger_20_2", "historical_volatility_30", "ulcer_index_14",
    "volume_sma_20", "obv_20", "linreg_slope_20", "price_vs_tvl_30d", "market_cap_vs_tvl_30d", "price_vs_volume_30d", "volume_to_market_cap_30d"]) {
    assert.ok(shown.includes(id), `${id} shown with 5-day-old history`);
  }
  assert.equal(omitted.find((o) => o.id === "tvl_change_7d").reason, "stale_history", "a 7-day indicator allows 3 days");
  const asOfSample = new Date(TODAY - 5 * DAY_MS).toISOString();
  for (const indicator of view.groups.flatMap((g) => g.indicators)) assert.equal(indicator.provenance.observationEnd, asOfSample, `${indicator.id} is as of its newest sample`);
  // Values are exactly those calculated on the day of the newest sample: nothing is carried to "now".
  const then = evaluateTechnicalIndicators(rows, { asOf: new Date(TODAY - 5 * DAY_MS + 3600e3), protocolMapped: true }).view;
  const readings = (v) => JSON.stringify(v.groups.flatMap((g) => g.indicators.map((i) => [i.id, i.readings])).filter(([id]) => shown.includes(id)));
  assert.equal(readings(view), readings(then));
  // A current (off-midnight) market snapshot is not substituted for a missing daily sample.
  const withSnapshot = [...rows, { id: 99999, metric_id: "price_usd", provider_id: "coingecko", value: 1e6, status: "available", observed_at: AS_OF.toISOString() }];
  assert.equal(readings(evaluate(withSnapshot, true).view), readings(view));
});

test("B. indicators disappear when history is genuinely insufficient or too old for their window", () => {
  assert.deepEqual([7, 10, 13, 15, 25, 3].map(String), [14, 20, 26, 30, 50, 7].map((w) => String(maxHistoryAgeDays(w))));
  const eight = ids(evaluate(full({ endDaysAgo: 8 }), true).view);
  assert.ok(!eight.includes("rsi_14") && !eight.includes("roc_14") && !eight.includes("ulcer_index_14"), "14-day indicators allow 7 days");
  assert.ok(eight.includes("sma_20") && eight.includes("price_vs_tvl_30d"));
  const sixteen = ids(evaluate(full({ endDaysAgo: 16 }), true).view);
  assert.ok(!sixteen.some((id) => id.endsWith("_30d") || id === "historical_volatility_30") && sixteen.includes("sma_50"));
  assert.deepEqual(ids(evaluate(full({ endDaysAgo: 26 }), true).view), [], "older than every window allows");
  assert.ok(!ids(evaluate(price(wave(19))).view).includes("sma_20"), "19 closes are not enough for SMA(20)");
});

// ---- Horizons: Snapshot vs 7D vs 30D ----

test("C. a 30D label needs an exactly 30-day, aligned interval (8.9 hours is not 30D)", () => {
  assert.equal(horizonLabel(8.9), "Snapshot");
  assert.equal(horizonLabel(intervalBetween("2026-09-24T18:00:00Z", "2026-09-25T02:54:00Z").hours), "Snapshot");
  assert.equal(horizonLabel(30 * 24), "30D");
  assert.equal(horizonLabel(30 * 24 - 20), "Snapshot", "29 days 4 hours is not 30D");
  assert.equal(horizonLabel(7 * 24), "7D");
  const pt = (hours, value = 1) => ({ time: TODAY + hours * 3600e3, value, obsId: hours });
  assert.equal(spansExactly(30, [pt(0), pt(8.9)]), false);
  assert.equal(spansExactly(30, [pt(0), pt(720)], [pt(1), pt(720)]), false, "misaligned inputs");
  assert.equal(spansExactly(30, [pt(0), pt(720)], [pt(0), pt(720)]), true);
  // Fed 31 points only 8.9 hours apart in total, the 30D definitions refuse to calculate.
  const squeezed = Array.from({ length: 40 }, (_, i) => ({ time: TODAY - (39 - i) * (8.9 / 39) * 3600e3, value: 100 + i, obsId: i }));
  for (const id of ["price_vs_tvl_30d", "market_cap_vs_tvl_30d", "price_vs_volume_30d", "volume_to_market_cap_30d", "tvl_change_7d"]) {
    const definition = INDICATOR_DEFINITIONS.find((d) => d.id === id);
    assert.equal(definition.compute(definition.inputs.map(() => squeezed)), null, id);
  }
  for (const d of INDICATOR_DEFINITIONS.filter((d) => /_(7|30)d$/.test(d.id))) assert.match(d.name, d.id.endsWith("30d") ? /· 30D$/ : /· 7D$/);
});

test("D. a genuine 30D comparison uses timestamp-aligned observations exactly 30 days apart", () => {
  const p = wave(90), t = p.map((v, i) => 5e8 + 1e6 * i);
  const tvlRows = tvl(t).filter((_, i) => i !== 49); // TVL missing 40 days ago
  const rows = [...price(p), ...marketCap(p.map((v) => v * 1e7)), ...tvlRows];
  const { view } = evaluate(rows, true);
  const pvt = byId(view, "price_vs_tvl_30d");
  assert.equal(pvt.provenance.observationStart, new Date(TODAY - 30 * DAY_MS).toISOString());
  assert.equal(pvt.provenance.observationEnd, new Date(TODAY).toISOString());
  close(reading(pvt, "Price change"), (p.at(-1) / p.at(-31) - 1) * 100);
  close(reading(pvt, "TVL change"), (t.at(-1) / t.at(-31) - 1) * 100);
  const mt = byId(view, "market_cap_vs_tvl_30d");
  close(reading(mt, "30 days earlier"), (p.at(-31) * 1e7) / t.at(-31));
  // TVL stored at noon has no midnight samples, so it is never paired with midnight prices.
  const noon = [...price(p), ...tvl(t, { offsetMs: 12 * 3600e3 })];
  assert.ok(!ids(evaluate(noon, true).view).includes("price_vs_tvl_30d"));
});

test("F. no interpolation or zero-filling: gaps and invalid values shorten the run instead of being filled", () => {
  const p = wave(90);
  const gap = price(p).filter((_, i) => i !== 80); // missing 9 days ago
  assert.equal(dailySamples(gap, SERIES_RULES.price, AS_OF.getTime()).length, 89);
  const shown = ids(evaluate(gap).view);
  assert.ok(!shown.includes("sma_20") && shown.includes("roc_14") === false, "only 9 consecutive days remain");
  const zero = price(p.map((v, i) => (i === 85 ? 0 : v)));
  const zeroTail = contiguousTail(dailySamples(zero, SERIES_RULES.price, AS_OF.getTime()));
  assert.equal(zeroTail.length, 4, "a zero price is invalid and breaks the run");
  assert.ok(zeroTail.every((point) => point.value > 0));
  const rowIds = new Set(gap.map((row) => row.id));
  for (const indicator of evaluate(gap).view.groups.flatMap((g) => g.indicators)) assert.ok(indicator.provenance.sourceObservationIds.every((id) => rowIds.has(id)));
});

test("research order: overview → market → fundamentals → tokenomics → history → trading & liquidity → technical → divergence → AI → sources", () => {
  const rows = full();
  const view = evaluate(rows, true).view;
  const metric = (id, category, value, sourceScopes) => ({ id, name: id, category, unit: "percentage_points", value, status: "available", formula: "f", calculatedAt: AS_OF.toISOString(), periodStartAt: new Date(TODAY - DAY_MS).toISOString(), periodEndAt: AS_OF.toISOString(), unavailableReason: null, sourceScopes });
  const data = {
    token: { id: "aave-aave", name: "Aave", symbol: "AAVE", chain: "Ethereum", category: "DeFi", priceUsd: 130, change24hPct: 1, change7dPct: 2, marketCapUsd: 2e9, volume24hUsd: 3e8, tvlUsd: 2e10, tvlChange30dPct: 7, fees24hUsd: 1e6, revenue24hUsd: 2e5, fdvUsd: 2.6e9, observedAt: "", metricSources: {} },
    technicalIndicators: view, description: null, contractAddress: "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9", isNative: false,
    circulatingSupply: 1.5e7, totalSupply: 1.6e7, maximumSupply: 1.6e7, metricSources: {},
    calculatedMetrics: [
      metric("price_change_vs_tvl_growth_pct_points", "growth", 3.2, "token/protocol"),
      metric("tvl_growth_pct", "growth", 1.1, "protocol"),
    ],
    history: buildTokenHistory("aave-aave", rows.map((r) => ({ ...r, token_id: "aave-aave", chain_id: "ethereum", collected_at: r.observed_at, source_field: r.metric_id, note: null })), AS_OF),
    dataNotes: [], dexMapped: true, defiLlamaMapped: true, refreshStatus: { providers: [], metricsCalculatedAt: null, latestRunStatus: null },
    coverage: [{ provider: "defillama", status: "mapped" }, { provider: "dexpaprika", status: "mapped" }],
    tokenLevelPrice: null, logoUrl: null, protocol: { name: "Aave", aggregatesVersions: true },
    dexActivity: { transactions24h: 1200, buys24h: 700, sells24h: 500 },
  };
  const model = buildProfileModel(data);
  assert.deepEqual(model.sections.map((s) => s.id),
    ["overview", "market", "fundamentals", "tokenomics", "history", "market-structure", "technical", "analysis", "sources"]);
  assert.deepEqual(model.sections.map((s) => s.label),
    ["Overview", "Market", "Fundamentals", "Tokenomics", "History", "Trading & Liquidity", "Technical", "AI Analysis", "Sources"]);
  assert.ok(model.fundamentals.available && !model.fundamentals.changes.some((c) => c.id.includes("_vs_")), "comparisons moved out of Fundamentals");
  assert.ok(model.fundamentals.changes.some((c) => c.id === "tvl_growth_pct"), "protocol growth stays in Fundamentals");
  assert.deepEqual(model.divergence.comparisons.map((c) => c.id), ["price_change_vs_tvl_growth_pct_points"]);

  // E. Stored comparisons take their horizon from their actual interval.
  const stored = (hours, extra = {}) => ({ ...metric("price_change_vs_tvl_growth_pct_points", "growth", 3.2, "token/protocol"), periodStartAt: new Date(TODAY - hours * 3600e3).toISOString(), periodEndAt: new Date(TODAY).toISOString(), ...extra });
  const flag = (hours) => ({ ...stored(hours), id: "divergence_price_up_tvl_down", category: "divergence", unit: "boolean", value: 1, sourceScopes: "token/protocol" });
  const snapshot = buildProfileModel({ ...data, calculatedMetrics: [stored(8.9), flag(8.9)] }).divergence;
  assert.match(snapshot.comparisons[0].label, /· Snapshot$/);
  assert.ok(!snapshot.comparisons[0].label.includes("30D") && !snapshot.comparisons[0].label.includes("7D"));
  assert.equal(snapshot.signalsHorizon, "Snapshot");
  assert.match(buildProfileModel({ ...data, calculatedMetrics: [stored(720)] }).divergence.comparisons[0].label, /· 30D$/, "a stored 30-day interval may say 30D");
  assert.ok(model.divergence.indicators.every((i) => /· 30D$/.test(i.name)), "indicator-layer comparisons are genuine 30D");
  const profileSource = readFileSync(new URL("../src/components/TokenProfile.tsx", import.meta.url), "utf8");
  assert.match(profileSource, /Divergence flags · \$\{divergence\.signalsHorizon \?\? "24h"\}/);
  assert.ok(model.history.available && model.history.tvl, "TVL history lives in Market history");
  assert.ok(model.tokenomics.available);
  assert.deepEqual(model.tokenomics.items.map((i) => i.id), ["circulating_supply", "total_supply", "maximum_supply", "fdv", "market_cap_of_fdv"]);
  assert.equal(model.tokenomics.items.at(-1).value, "76.92%");
  const noFdv = buildProfileModel({ ...data, token: { ...data.token, fdvUsd: null } });
  assert.ok(!noFdv.tokenomics.items.some((i) => i.id === "fdv" || i.id === "market_cap_of_fdv"), "no FDV → no FDV fields");
  // Supply composition: from the token's own circulating and maximum supply.
  assert.deepEqual(model.tokenomics.composition, { circulatingPct: 93.75, remainingPct: 6.25, barPct: 93.75, circulating: "15M", maximum: "16M", symbol: "AAVE" });
  assert.equal(buildProfileModel({ ...data, maximumSupply: null }).tokenomics.composition, null, "no maximum → no composition (never treated as zero)");
  const over = buildProfileModel({ ...data, circulatingSupply: 1.7e7 }).tokenomics.composition;
  assert.deepEqual([over.barPct, over.remainingPct], [100, 0], "bar and remaining are clamped; the actual ratio is still reported");
  const unmapped = buildProfileModel({ ...data, coverage: [], protocol: null });
  assert.ok(!unmapped.history.tvl && unmapped.divergence.comparisons.length === 0, "protocol-scope items need a curated mapping");
  const source = readFileSync(new URL("../src/components/TokenProfile.tsx", import.meta.url), "utf8");
  const order = ['id="overview"', 'id="market"', 'id="fundamentals"', 'id="tokenomics"', 'id="history"', 'id="market-structure"', 'id="technical"', 'id="cross-metric"', 'id="analysis"', "<SourcesMethodology"].map((marker) => source.indexOf(marker));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])), `rendered in research order: ${order}`);
});

test("profile terminology, no unavailable-data cards, cross-metric inside Technical, concise cards", () => {
  const profileSource = readFileSync(new URL("../src/components/TokenProfile.tsx", import.meta.url), "utf8");
  for (const phrase of ['eyebrow="Token performance" title="Market history"', 'eyebrow="Token analysis" title="Technical indicators"', "Token dynamics", "Cross-metric analysis", "Associated Protocol TVL"]) {
    assert.ok(profileSource.includes(phrase), phrase);
  }
  for (const gone of [/Stored observations/i, /stored daily history/i, /Token · protocol · market/, /Token · multi-metric/, /Cross-metric divergence/, /Not available/, /<Notes\b/, /coverage-note/, /id="divergence"/]) {
    assert.doesNotMatch(profileSource, gone);
  }
  const technicalStart = profileSource.indexOf('id="technical"'), crossMetric = profileSource.indexOf('id="cross-metric"'), analysis = profileSource.indexOf('id="analysis"');
  assert.ok(technicalStart < crossMetric && crossMetric < analysis, "cross-metric subsection renders inside the Technical section");
  assert.match(profileSource, /technical\.length > 0 \|\| hasCrossMetric/, "Technical shows for indicators or cross-metric content alone");
  // Cards lead with a one-line summary; the long description, window and formula live in the disclosure.
  const card = readFileSync(new URL("../src/components/TechnicalIndicators.tsx", import.meta.url), "utf8");
  const [front, disclosure] = card.slice(card.indexOf("export function IndicatorCard"), card.indexOf("export function TechnicalIndicators")).split("<details");
  assert.ok(front.includes("indicator.summary") && !front.includes("indicator.description") && !front.includes("indicator.formula") && !front.includes("periodLabel"));
  assert.ok(disclosure.includes("indicator.description") && disclosure.includes("indicator.formula") && disclosure.includes("calculatedAt"));
  for (const d of INDICATOR_DEFINITIONS) assert.ok(d.summary && d.summary.length <= 80 && d.summary.length < d.description.length, `${d.id} has a short summary`);
});

test("Sources & methodology: 'Data provenance' with providers; raw collection notes are not rendered", () => {
  const source = readFileSync(new URL("../src/components/SourcesMethodology.tsx", import.meta.url), "utf8");
  assert.match(source, /<summary>Data provenance<\/summary>/);
  assert.doesNotMatch(source, /Technical provenance|Collection notes|provenance\.notes/);
  assert.match(source, /methodology\.provenance\.datasets\.map/, "dataset → provider list is still shown");
  assert.match(source, /methodology\.referencePrice \?/, "the reference-price caveat stays visible when applicable");
  assert.match(source, /not independent confirmation/);
  for (const internal of [/stored observations/i, /backfill/i, /raw record/i, /ingestion/i, /payload/i]) assert.doesNotMatch(source.replace(/\/\*\*[\s\S]*?\*\//g, ""), internal);
});

test("readings format by unit", () => {
  assert.equal(formatReading({ label: "x", value: 12.345, unit: "percent_change" }), "+12.35%");
  assert.equal(formatReading({ label: "x", value: -0.5, unit: "percent_per_day" }), "-0.50% / day");
  assert.equal(formatReading({ label: "x", value: 65.51, unit: "index" }), "65.5");
  assert.equal(formatReading({ label: "x", value: 0.111, unit: "multiple" }), "0.111×");
  assert.equal(formatReading({ label: "x", value: 43.2, unit: "percent" }), "43.2%");
  assert.equal(formatReading({ label: "x", value: Number.NaN, unit: "usd" }), null);
});

test("reading tone: only explicit change/gap units (percent_change, percent_per_day) carry a direction; a zero reading is flat, and every other unit stays neutral however its value is signed", () => {
  assert.equal(readingTone({ label: "x", value: 6.02, unit: "percent_change" }), "positive");
  assert.equal(readingTone({ label: "x", value: -0.53, unit: "percent_change" }), "negative");
  assert.equal(readingTone({ label: "x", value: 0, unit: "percent_change" }), "flat");
  assert.equal(readingTone({ label: "x", value: 0.16, unit: "percent_per_day" }), "positive");
  assert.equal(readingTone({ label: "x", value: -1.2, unit: "percent_per_day" }), "negative");
  // Not a change/delta: a plain magnitude, ratio, or index never gets colored just because its value is negative.
  assert.equal(readingTone({ label: "x", value: -43.2, unit: "percent" }), "neutral");
  assert.equal(readingTone({ label: "x", value: -65.51, unit: "index" }), "neutral");
  assert.equal(readingTone({ label: "x", value: -0.111, unit: "multiple" }), "neutral");
  assert.equal(readingTone({ label: "x", value: -5, unit: "usd" }), "neutral");
  assert.equal(readingTone({ label: "x", value: "2026-01-01", unit: "date" }), "neutral");
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
console.log(`${cases.length - failures}/${cases.length} technical-indicator checks passed.`);
if (failures > 0) process.exitCode = 1;
