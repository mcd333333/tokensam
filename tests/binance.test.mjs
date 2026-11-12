import assert from "node:assert/strict";

import {
  BINANCE_PRICE_NOTE,
  BinanceApiError,
  BinanceMarketDataProvider,
  getBinanceConfig,
  normalizeBinanceTicker,
} from "../src/lib/providers/binance.ts";
import { binanceSymbols, binanceUnmapped } from "../src/data/binance-token-mappings.ts";
import { canonicalTokens } from "../src/data/canonical-tokens.ts";
import { tokenCoverage } from "../src/data/provider-coverage.ts";
import { coinbaseProducts } from "../src/data/coinbase-token-mappings.ts";
import { BINANCE_PREFERRED_MAX_AGE_MS, buildDashboardTokens } from "../src/lib/data/live-data.ts";
import { PROVIDER_STEPS } from "../src/lib/refresh/config.ts";

const asset = { tokenId: "token-a", chainId: "chain-a", externalAssetId: "AAAUSDT" };

const cases = [];
function test(name, run) {
  cases.push({ name, run });
}

test("the default host is the unrestricted market-data mirror, overridable by env", () => {
  // api.binance.com answers 451 from this deployment's egress; the mirror does not.
  assert.equal(getBinanceConfig({}).baseUrl, "https://data-api.binance.vision/api/v3");
  assert.equal(
    getBinanceConfig({ BINANCE_API_BASE_URL: "https://proxy.example/api/v3/" }).baseUrl,
    "https://proxy.example/api/v3",
  );
});

test("a bare-origin override gets /api/v3, which a custom proxy path keeps", () => {
  // The first production deployment set this to a bare origin, so every request went to
  // the host root and Binance answered 404 on all 288 runs/day. Both forms must work.
  for (const value of ["https://data-api.binance.vision", "https://data-api.binance.vision/"]) {
    assert.equal(getBinanceConfig({ BINANCE_API_BASE_URL: value }).baseUrl, "https://data-api.binance.vision/api/v3");
  }
  // A host with its own path is a deliberate proxy mount and is left exactly as given.
  assert.equal(
    getBinanceConfig({ BINANCE_API_BASE_URL: "https://worker.example/binance-proxy" }).baseUrl,
    "https://worker.example/binance-proxy",
  );
});

test("ticker normalization writes only price and 24h change, with provenance", () => {
  const collectedAt = "2026-10-06T12:00:00.000Z";
  const snapshot = normalizeBinanceTicker(
    asset,
    { symbol: "AAAUSDT", lastPrice: "12.50", priceChangePercent: "-1.500", closeTime: Date.parse(collectedAt) - 1000 },
    collectedAt,
  );

  assert.equal(snapshot.providerId, "binance");
  // Binance must never populate a global metric with a single-venue figure.
  assert.deepEqual(snapshot.observations.map((row) => row.metricId), ["price_usd", "price_change_24h_pct"]);

  const [price, change] = snapshot.observations;
  assert.equal(price.value, 12.5);
  assert.equal(price.status, "available");
  assert.equal(price.sourceField, "lastPrice");
  assert.equal(price.note, BINANCE_PRICE_NOTE);
  // observedAt is the ticker's own closeTime, not this run's wall clock.
  assert.equal(price.observedAt, new Date(Date.parse(collectedAt) - 1000).toISOString());
  assert.equal(change.value, -1.5);
  assert.equal(change.windowDays, 1);
});

test("a ticker older than the freshness limit is unavailable, not a stale live price", () => {
  const collectedAt = "2026-10-06T12:00:00.000Z";
  // A halted symbol (status BREAK) keeps reporting its last trade from before the halt.
  const snapshot = normalizeBinanceTicker(
    asset,
    { symbol: "AAAUSDT", lastPrice: "0.184", priceChangePercent: "0.000", closeTime: Date.parse(collectedAt) - 3 * 24 * 60 * 60 * 1000 },
    collectedAt,
  );

  for (const row of snapshot.observations) {
    assert.equal(row.status, "unavailable");
    assert.equal(row.value, null, "a stale price must not be served as a value");
    assert.match(row.note, /not served as a live price/);
  }
});

test("a thinly traded symbol's lagging last trade is still served as live", () => {
  const collectedAt = "2026-10-06T12:00:00.000Z";
  // DGBUSDT and XNOUSDT measured 645 s and 519 s behind while correctly priced:
  // closeTime is the last trade, so a quiet pair lags without being stale.
  const snapshot = normalizeBinanceTicker(
    asset,
    { symbol: "AAAUSDT", lastPrice: "0.01", priceChangePercent: "0.5", closeTime: Date.parse(collectedAt) - 11 * 60 * 1000 },
    collectedAt,
  );
  assert.equal(snapshot.observations[0].status, "available");
  assert.equal(snapshot.observations[0].value, 0.01);
});

test("non-numeric and absent fields become unavailable rather than zero", () => {
  const snapshot = normalizeBinanceTicker(
    asset,
    { symbol: "AAAUSDT", lastPrice: null, priceChangePercent: "" },
    "2026-10-06T12:00:00.000Z",
  );
  for (const row of snapshot.observations) {
    assert.equal(row.status, "unavailable");
    assert.equal(row.value, null);
  }
});

test("HTTP 451 fails immediately with the fix, instead of burning retries", async () => {
  let requestCount = 0;
  const provider = new BinanceMarketDataProvider({
    baseUrl: "https://api.binance.com/api/v3",
    fetchImpl: async () => {
      requestCount += 1;
      return new Response("{}", { status: 451 });
    },
    sleep: async () => {},
  });

  await assert.rejects(provider.fetchSnapshots([asset]), (error) => {
    assert.ok(error instanceof BinanceApiError);
    assert.equal(error.status, 451);
    assert.match(error.message, /BINANCE_API_BASE_URL/);
    return true;
  });
  // A geo block is not transient: retrying it cannot clear it.
  assert.equal(requestCount, 1);
});

test("429 is retried with Retry-After, then surfaces as a provider error", async () => {
  let requestCount = 0;
  const delays = [];
  const provider = new BinanceMarketDataProvider({
    baseUrl: "https://mirror.example/api/v3",
    fetchImpl: async () => {
      requestCount += 1;
      return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    },
    sleep: async (ms) => { delays.push(ms); },
  });

  await assert.rejects(provider.fetchSnapshots([asset]), BinanceApiError);
  assert.equal(requestCount, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test("the multi-symbol request uses Binance's JSON-array form and matches by symbol", async () => {
  let requestedUrl = null;
  const provider = new BinanceMarketDataProvider({
    baseUrl: "https://mirror.example/api/v3",
    now: () => new Date("2026-10-06T12:00:00.000Z"),
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return Response.json([
        // Returned out of order, and with an extra symbol that was never requested.
        { symbol: "BBBUSDT", lastPrice: "2", priceChangePercent: "1", closeTime: Date.parse("2026-10-06T11:59:00Z") },
        { symbol: "ZZZUSDT", lastPrice: "9", priceChangePercent: "9", closeTime: Date.parse("2026-10-06T11:59:00Z") },
        { symbol: "AAAUSDT", lastPrice: "1", priceChangePercent: "-1", closeTime: Date.parse("2026-10-06T11:59:00Z") },
      ]);
    },
    sleep: async () => {},
  });

  const snapshots = await provider.fetchSnapshots([
    asset,
    { tokenId: "token-b", chainId: "chain-b", externalAssetId: "BBBUSDT" },
  ]);

  assert.equal(requestedUrl.searchParams.get("symbols"), '["AAAUSDT","BBBUSDT"]');
  // An unrequested symbol is dropped rather than attached to an arbitrary token.
  assert.deepEqual(snapshots.map((snapshot) => snapshot.asset.tokenId).sort(), ["token-a", "token-b"]);
  const byToken = new Map(snapshots.map((snapshot) => [snapshot.asset.tokenId, snapshot]));
  assert.equal(byToken.get("token-a").observations[0].value, 1);
  assert.equal(byToken.get("token-b").observations[0].value, 2);
});

test("curated symbols are unique per token and cover the universe minus explicit gaps", () => {
  const mappedIds = Object.keys(binanceSymbols);
  // Every mapped id is a real canonical token.
  const canonicalIds = new Set(canonicalTokens.map((token) => token.id));
  for (const id of mappedIds) assert.ok(canonicalIds.has(id), `${id} is not a canonical token`);

  // No two canonical tokens may share a Binance symbol: a Binance symbol is a ticker pair,
  // so a collision would make one token silently adopt another's price.
  const symbols = mappedIds.map((id) => binanceSymbols[id]);
  assert.equal(new Set(symbols).size, symbols.length, "duplicate Binance symbol across canonical tokens");

  // Every canonical token is either mapped or has a stated reason it is not.
  for (const token of canonicalTokens) {
    const mapped = Boolean(binanceSymbols[token.id]);
    const explained = Boolean(binanceUnmapped[token.id]);
    assert.ok(mapped !== explained, `${token.id} must be either mapped or explicitly unmapped, not both/neither`);
  }
});

test("coverage reports the live exchange price slot (now Coinbase) as live-price-only, and states why a gap exists", () => {
  const mapped = canonicalTokens.find((token) => coinbaseProducts[token.id]);
  const entry = tokenCoverage(mapped).find((item) => item.provider === "binance");
  assert.equal(entry.status, "mapped");
  assert.equal(entry.label, "Coinbase");
  assert.equal(entry.identifier, coinbaseProducts[mapped.id]);
  assert.match(entry.detail, /live price/i);
  // The coverage text must not promise metrics this provider never writes.
  assert.match(entry.detail, /Not market cap, supply, volume, or history/);

  const gapToken = canonicalTokens.find((token) => !coinbaseProducts[token.id]);
  const gap = tokenCoverage(gapToken).find((item) => item.provider === "binance");
  assert.equal(gap.status, "unavailable");
  assert.equal(gap.identifier, null);
  assert.match(gap.detail, /falls back to CoinGecko/);
});

test("binance is fetched live at render time, not as a refresh-pipeline step", () => {
  // Binance is no longer collected on a schedule and written to Supabase (see
  // fetchLiveBinanceObservations in live-data.ts) -- it is fetched live on every
  // dashboard/profile render instead, the same way the client-side flashing ticker
  // already worked. There is accordingly no refresh-cadence config for it to check.
  assert.ok(!PROVIDER_STEPS.includes("binance"));
  assert.ok(BINANCE_PREFERRED_MAX_AGE_MS > 0);
});

// ---- Read-layer preference and fallback ----

const token = {
  id: "token-a",
  name: "Token A",
  symbol: "AAA",
  chain_id: "chain-a",
  contract_address: null,
  is_native: true,
  category: "Layer 1",
  description: null,
};
const now = Date.parse("2026-10-06T12:00:00.000Z");

function row(id, providerId, metricId, value, observedAt, status = "available", collectedAt = observedAt) {
  return {
    id,
    token_id: "token-a",
    chain_id: "chain-a",
    metric_id: metricId,
    provider_id: providerId,
    value,
    status,
    observed_at: observedAt,
    collected_at: collectedAt,
    source_field: null,
    note: `${providerId} note`,
  };
}

const fresh = "2026-10-06T11:58:00.000Z";
const geckoAt = "2026-10-06T11:50:00.000Z";

test("a fresh Binance price wins over CoinGecko, and is attributed to Binance", () => {
  const [built] = buildDashboardTokens([token], [], [
    row(1, "binance", "price_usd", "101.5", fresh),
    row(2, "coingecko", "price_usd", "100", geckoAt),
    row(3, "binance", "price_change_24h_pct", "2.5", fresh),
    row(4, "coingecko", "price_change_24h_pct", "2", geckoAt),
  ], now);

  assert.equal(built.priceUsd, 101.5);
  assert.equal(built.change24hPct, 2.5);
  assert.equal(built.metricSources.priceUsd.providerId, "binance");
  assert.equal(built.metricSources.change24hPct.providerId, "binance");
});

test("CoinGecko is used when Binance is stale, unavailable, or absent", () => {
  const stale = new Date(now - BINANCE_PREFERRED_MAX_AGE_MS - 60_000).toISOString();

  const staleCase = buildDashboardTokens([token], [], [
    row(1, "binance", "price_usd", "999", stale),
    row(2, "coingecko", "price_usd", "100", geckoAt),
  ], now)[0];
  assert.equal(staleCase.priceUsd, 100, "a stale Binance price must not win");
  assert.equal(staleCase.metricSources.priceUsd.providerId, "coingecko");

  const unavailableCase = buildDashboardTokens([token], [], [
    row(1, "binance", "price_usd", null, fresh, "unavailable"),
    row(2, "coingecko", "price_usd", "100", geckoAt),
  ], now)[0];
  assert.equal(unavailableCase.priceUsd, 100);
  assert.equal(unavailableCase.metricSources.priceUsd.providerId, "coingecko");

  const absentCase = buildDashboardTokens([token], [], [
    row(2, "coingecko", "price_usd", "100", geckoAt),
  ], now)[0];
  assert.equal(absentCase.priceUsd, 100);
  assert.equal(absentCase.metricSources.priceUsd.providerId, "coingecko");
});

test("freshness is judged on collection time, not on the last-trade time", () => {
  // A quiet pair: last trade 40 minutes ago, but collected seconds ago. The data is
  // current, so Binance should still win -- judging this on observed_at would have
  // pushed every thinly traded token onto CoinGecko.
  const [built] = buildDashboardTokens([token], [], [
    row(1, "binance", "price_usd", "101.5", new Date(now - 40 * 60_000).toISOString(), "available", fresh),
    row(2, "coingecko", "price_usd", "100", geckoAt),
  ], now);

  assert.equal(built.priceUsd, 101.5);
  assert.equal(built.metricSources.priceUsd.providerId, "binance");
});

test("Binance never supplies market cap, volume, or 7-day change", () => {
  const [built] = buildDashboardTokens([token], [], [
    // A Binance row for a metric it must not own is ignored by the read layer.
    row(1, "binance", "market_cap_usd", "999", fresh),
    row(2, "binance", "volume_24h_usd", "888", fresh),
    row(3, "coingecko", "market_cap_usd", "500", geckoAt),
    row(4, "coingecko", "volume_24h_usd", "400", geckoAt),
    row(5, "coingecko", "price_change_7d_pct", "7", geckoAt),
  ], now);

  assert.equal(built.marketCapUsd, 500);
  assert.equal(built.volume24hUsd, 400);
  assert.equal(built.metricSources.marketCapUsd.providerId, "coingecko");
  assert.equal(built.metricSources.volume24hUsd.providerId, "coingecko");
  assert.equal(built.change7dPct, 7);
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

console.log(`${cases.length - failures}/${cases.length} Binance checks passed.`);
if (failures > 0) process.exitCode = 1;
