import assert from "node:assert/strict";

import { buildCalculatedMetrics, buildDashboardTokens, buildTokenHistory } from "../src/lib/data/live-data.ts";

const token = {
  id: "ethereum-usdt",
  name: "Tether",
  symbol: "USDT",
  chain_id: "ethereum",
  contract_address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  is_native: false,
  category: "Stablecoin",
  description: "Ethereum Tether contract.",
};
const chains = [{ id: "ethereum", name: "Ethereum" }];
const now = Date.parse("2026-09-24T00:00:00.000Z");
const atDaysAgo = (days) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
const observation = (metric, provider, days, value, status = "available", id = 1) => ({
  id,
  token_id: token.id,
  chain_id: token.chain_id,
  metric_id: metric,
  provider_id: provider,
  value,
  status,
  observed_at: atDaysAgo(days),
  collected_at: atDaysAgo(days),
  source_field: metric,
  note: null,
});

const rows = [
  observation("price_usd", "coingecko", 6, 1.01, "available", 1),
  observation("price_usd", "coingecko", 1, 1.02, "available", 2),
  observation("price_usd", "coingecko", 0, null, "unavailable", 3),
  observation("price_usd", "dexpaprika", 0, 99, "available", 4),
  observation("price_change_24h_pct", "coingecko", 0, 0, "available", 5),
  observation("price_change_7d_pct", "coingecko", 0, 1.5, "available", 6),
  observation("market_cap_usd", "coingecko", 0, 0, "available", 7),
  observation("volume_24h_usd", "coingecko", 0, null, "unavailable", 8),
  observation("tvl_usd", "defillama", 31, 100, "available", 9),
  observation("tvl_usd", "defillama", 1, 120, "available", 10),
  observation("fees_24h_usd", "defillama", 0, 0, "available", 11),
  observation("revenue_24h_usd", "defillama", 0, null, "unavailable", 12),
];

const [dashboardToken] = buildDashboardTokens([token], chains, rows);
assert.equal(dashboardToken.chain, "Ethereum");
assert.equal(dashboardToken.priceUsd, null, "latest CoinGecko unavailability must not fall back to older or DEX data");
assert.equal(dashboardToken.change24hPct, 0, "a true numeric zero remains available");
assert.equal(dashboardToken.marketCapUsd, 0);
assert.equal(dashboardToken.volume24hUsd, null);
assert.equal(dashboardToken.tvlUsd, 120);
assert.ok(Math.abs(dashboardToken.tvlChange30dPct - 20) < 0.000001);
assert.equal(dashboardToken.fees24hUsd, 0);
assert.equal(dashboardToken.revenue24hUsd, null);
assert.equal(dashboardToken.metricSources.priceUsd.providerId, "coingecko");

const history = buildTokenHistory(token.id, rows, new Date(now));
assert.equal(history.priceUsd.points.length, 2, "unavailable point is not plotted");
assert.equal(history.tvlUsd.points.length, 2);
assert.equal(history.tvlUsd.scope, "protocol");
assert.equal(history.volumeUsd.periods["90D"].status, "unavailable", "the only volume row is unavailable, so nothing is plotted or zero-filled");
assert.equal(history.priceUsd.periods["7D"].coverageLabel, "2 observations spanning 5 days", "coverage reports the actual span");
assert.equal(history.sources.priceUsd.providerId, "coingecko");

const calculatedRow = (id, metricId, name, calculatedAt, value, status = "available") => ({
  id, token_id: token.id, chain_id: token.chain_id, metric_id: metricId, metric_name: name, unit: "ratio",
  value, status, formula: "a / b", calculated_at: calculatedAt, period_start_at: null, period_end_at: null,
});
const calculated = buildCalculatedMetrics([
  calculatedRow(1, "volume_to_market_cap", "Volume / market cap", "2026-09-22T00:00:00.000Z", "0.1"),
  calculatedRow(2, "volume_to_market_cap", "Volume / market cap", "2026-09-23T00:00:00.000Z", null, "unavailable"),
  calculatedRow(3, "price_growth_pct", "Price growth", "2026-09-23T00:00:00.000Z", "2.5"),
  calculatedRow(4, "retired_metric", "Retired", "2026-09-23T00:00:00.000Z", "1"),
], [
  { id: "volume_to_market_cap", category: "valuation" },
  { id: "price_growth_pct", category: "growth" },
]);
assert.deepEqual(calculated.map((metric) => [metric.id, metric.category]), [["volume_to_market_cap", "valuation"], ["price_growth_pct", "growth"]],
  "categories come from definitions, ordered by category; undefined metrics are dropped");
assert.equal(calculated[0].value, null, "latest calculation wins even when unavailable");
assert.equal(calculated[1].value, 2.5);

console.log("PASS live projection preserves provider scope, freshness, nulls, zeros, and historical sufficiency.");
