import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CoinGeckoApiError,
  CoinGeckoMarketDataProvider,
  getCoinGeckoConfig,
  STORED_MARKET_PAYLOAD_FIELDS,
  normalizeCoinGeckoMarketItem,
} from "../src/lib/providers/coingecko.ts";
import { canonicalTokens } from "../src/data/canonical-tokens.ts";
import { coingeckoTokenIds } from "../src/data/coingecko-token-mappings.ts";

const asset = {
  tokenId: "same-token-id",
  chainId: "chain-a",
  externalAssetId: "asset-provider-id",
};

const cases = [];
function test(name, run) {
  cases.push({ name, run });
}

test("CoinGecko plan configuration keeps keys in the proper server header", () => {
  const demo = getCoinGeckoConfig({ COINGECKO_API_KEY: "demo-test-key" });
  assert.equal(demo.baseUrl, "https://api.coingecko.com/api/v3");
  assert.equal(demo.keyHeader, "x-cg-demo-api-key");

  const pro = getCoinGeckoConfig({ COINGECKO_API_KEY: "pro-test-key", COINGECKO_API_PLAN: "pro" });
  assert.equal(pro.baseUrl, "https://pro-api.coingecko.com/api/v3");
  assert.equal(pro.keyHeader, "x-cg-pro-api-key");
  assert.throws(() => getCoinGeckoConfig({}), /COINGECKO_API_KEY/);
});

test("market item normalization maps metrics and preserves unavailable values", () => {
  const snapshot = normalizeCoinGeckoMarketItem(
    asset,
    {
      id: "asset-provider-id",
      last_updated: "2026-09-23T10:00:00Z",
      current_price: 12.5,
      market_cap: 1_000_000,
      total_volume: 90_000,
      price_change_percentage_24h: -1.5,
      price_change_percentage_7d_in_currency: 5.75,
      circulating_supply: 80_000,
      total_supply: 100_000,
      max_supply: null,
    },
    "2026-09-23T10:01:00.000Z",
  );

  assert.equal(snapshot.providerId, "coingecko");
  assert.equal(snapshot.endpointLabel, "GET /coins/markets");
  assert.equal(snapshot.observations.length, 8);
  assert.equal(snapshot.observations.find((row) => row.metricId === "price_usd")?.value, 12.5);
  assert.equal(snapshot.observations.find((row) => row.metricId === "price_change_7d_pct")?.windowDays, 7);
  const maximumSupply = snapshot.observations.find((row) => row.metricId === "maximum_supply");
  assert.equal(maximumSupply?.status, "unavailable");
  assert.equal(maximumSupply?.value, null);
  assert.equal(snapshot.observedAt, "2026-09-23T10:00:00.000Z");
});

test("every existing canonical demo token has one explicit, unique CoinGecko ID", () => {
  const tokenIds = canonicalTokens.map((token) => token.id);
  const providerIds = tokenIds.map((tokenId) => coingeckoTokenIds[tokenId]);
  assert.equal(tokenIds.length, 238);
  assert.equal(providerIds.filter(Boolean).length, tokenIds.length);
  assert.equal(new Set(providerIds).size, providerIds.length);
});

test("market requests batch IDs, use an auth header, and avoid key query parameters", async () => {
  let requestUrl;
  let requestHeaders;
  const provider = new CoinGeckoMarketDataProvider({
    apiKey: "never-print-test-key",
    baseUrl: "https://api.coingecko.com/api/v3",
    keyHeader: "x-cg-demo-api-key",
    fetchImpl: async (url, init) => {
      requestUrl = new URL(url);
      requestHeaders = new Headers(init.headers);
      return new Response(JSON.stringify([{ id: asset.externalAssetId, current_price: 1 }]), { status: 200 });
    },
    sleep: async () => {},
    now: () => new Date("2026-09-23T10:00:00Z"),
  });

  const snapshots = await provider.fetchSnapshots([asset]);
  assert.equal(requestUrl.pathname, "/api/v3/coins/markets");
  assert.equal(requestUrl.searchParams.get("ids"), asset.externalAssetId);
  assert.equal(requestUrl.searchParams.get("price_change_percentage"), "24h,7d");
  assert.equal(requestUrl.searchParams.get("include_rehypothecated"), "true");
  assert.equal(requestUrl.searchParams.has("x_cg_demo_api_key"), false);
  assert.equal(requestHeaders.get("x-cg-demo-api-key"), "never-print-test-key");
  assert.equal(snapshots.length, 1);
});

test("429 responses honor Retry-After and stop after the bounded retry count", async () => {
  const delays = [];
  let requestCount = 0;
  const provider = new CoinGeckoMarketDataProvider({
    apiKey: "test-key",
    baseUrl: "https://api.coingecko.com/api/v3",
    keyHeader: "x-cg-demo-api-key",
    fetchImpl: async () => {
      requestCount += 1;
      return new Response("", { status: 429, headers: { "retry-after": "0" } });
    },
    sleep: async (delay) => delays.push(delay),
  });

  await assert.rejects(provider.fetchSnapshots([asset]), CoinGeckoApiError);
  assert.equal(requestCount, 3);
  assert.deepEqual(delays, [0, 0]);
});

test("the stored market payload keeps only the fields the site reads, and observations are unaffected", () => {
  const item = {
    id: "bitcoin", symbol: "btc", name: "Bitcoin", image: "https://assets.example/btc.png", current_price: 100, market_cap: 2_000, total_volume: 300,
    fully_diluted_valuation: 2_100, market_cap_rank: 1, ath: 999, sparkline_in_7d: { price: [1, 2, 3] }, last_updated: "2026-10-29T10:00:00.000Z",
    price_change_percentage_24h: 1.5, price_change_percentage_7d_in_currency: 2.5, circulating_supply: 10, total_supply: 11, max_supply: 21,
  };
  const snapshot = normalizeCoinGeckoMarketItem(asset, item, "2026-10-29T10:01:00.000Z");
  assert.deepEqual(Object.keys(snapshot.rawPayload).sort(), [...STORED_MARKET_PAYLOAD_FIELDS].sort());
  assert.equal(snapshot.rawPayload.image, item.image);
  assert.equal(snapshot.rawPayload.fully_diluted_valuation, 2_100);
  assert.equal(snapshot.rawPayload.current_price, 100);
  assert.equal(snapshot.observations.length, 8, "every metric is still stored as its own observation");
  assert.equal(snapshot.observations.find((row) => row.metricId === "market_cap_usd").value, 2_000);
  // A missing optional field stays an explicit null, which the SQL readers (payload->>x) treat as null.
  assert.equal(normalizeCoinGeckoMarketItem(asset, { id: "x" }).rawPayload.fully_diluted_valuation, null);
});

test("live-data only reads stored CoinGecko payload fields that the trimmed payload keeps", () => {
  const source = readFileSync(new URL("../src/lib/data/live-data.ts", import.meta.url), "utf8");
  const read = [...source.matchAll(/payload->>?([a-z_]+)/g)].map((match) => match[1]);
  assert.ok(read.length >= 4, "found the logo and FDV payload reads");
  for (const field of read) assert.ok(STORED_MARKET_PAYLOAD_FIELDS.includes(field), `live-data reads payload field "${field}", which the trimmed payload would drop`);
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

console.log(`${cases.length - failures}/${cases.length} CoinGecko checks passed.`);
if (failures > 0) process.exitCode = 1;
