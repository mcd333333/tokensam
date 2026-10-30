import assert from "node:assert/strict";

import {
  configuredGeckoTerminalAssets,
  GeckoTerminalMarketDataProvider,
  getUnmappedGeckoTerminalTokens,
  normalizeGeckoTerminalToken,
  selectPrimaryPool,
  storedGeckoTerminalPool,
} from "../src/lib/providers/geckoterminal.ts";
import { readGeckoTerminalPools } from "../src/lib/data/live-data.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";
import { geckoTerminalTokenMappings } from "../src/data/geckoterminal-token-mappings.ts";
import { canonicalTokens } from "../src/data/canonical-tokens.ts";

const collectedAt = "2026-09-26T12:00:00.000Z";
const assets = configuredGeckoTerminalAssets();
const aave = assets.find((asset) => asset.tokenId === "aave-aave");
const jupiter = assets.find((asset) => asset.tokenId === "jupiter-jup");
const pool = (overrides = {}) => ({
  attributes: {
    address: "0xpool-low",
    name: "AAVE / USDC",
    pool_created_at: "2023-11-14T22:13:20.000Z",
    token_price_usd: "10.5",
    fdv_usd: "100000000",
    market_cap_usd: "80000000",
    reserve_in_usd: "10000",
    price_change_percentage: { h24: "3.5" },
    transactions: { h24: { buys: 70, sells: 30 } },
    volume_usd: { h24: "20000" },
  },
  relationships: {
    base_token: { data: { id: `eth_${aave.tokenAddress.toLowerCase()}` } },
    quote_token: { data: { id: "eth_0xquote" } },
    dex: { data: { id: "fixture-dex" } },
  },
  ...overrides,
});

const cases = [];
function test(name, run) {
  cases.push({ name, run });
}

test("maps the current canonical token universe by network and explicit address only, without CoinGecko /onchain", () => {
  // Every canonical token has an explicit row: mapped (exact network + address) or
  // documented unmappedReason. The universe has grown since this integration was built
  // (see src/data/geckoterminal-token-mappings.ts); coverage counts are derived, not hard-coded.
  assert.equal(geckoTerminalTokenMappings.length, canonicalTokens.length);
  assert.equal(new Set(geckoTerminalTokenMappings.map((mapping) => mapping.tokenId)).size, canonicalTokens.length);
  for (const canonical of canonicalTokens) {
    const row = geckoTerminalTokenMappings.find((mapping) => mapping.tokenId === canonical.id);
    assert.ok(row, `${canonical.id} has an explicit GeckoTerminal mapping row`);
    assert.ok(row.gtNetworkId ? row.tokenAddress !== null : Boolean(row.unmappedReason), `${canonical.id} is either mapped or has a documented unmappedReason`);
  }
  const mappedRows = geckoTerminalTokenMappings.filter((mapping) => mapping.gtNetworkId);
  const unmappedRows = geckoTerminalTokenMappings.filter((mapping) => !mapping.gtNetworkId);
  assert.equal(assets.length, mappedRows.length);
  assert.equal(getUnmappedGeckoTerminalTokens().length, unmappedRows.length);
  // No wrapped representation is ever substituted for a native asset.
  for (const native of canonicalTokens.filter((candidate) => candidate.isNative)) {
    const row = geckoTerminalTokenMappings.find((mapping) => mapping.tokenId === native.id);
    if (row && !row.gtNetworkId) assert.doesNotMatch(row.unmappedReason ?? "", /wrapped .* is (?:used|substituted) for/i);
  }
  for (const token of canonicalTokens.filter((candidate) => !candidate.isNative && candidate.contractAddress)) {
    const asset = assets.find((item) => item.tokenId === token.id);
    if (asset) assert.equal(asset.tokenAddress.toLowerCase(), token.contractAddress.toLowerCase(), `${token.id} GeckoTerminal address is its canonical contract`);
  }
  assert.equal(assets.find((asset) => asset.tokenId === "bnb-chain-cake")?.gtNetworkId, "bsc");
  assert.equal(assets.find((asset) => asset.tokenId === "zksync-zk")?.gtNetworkId, "zksync");
  assert.equal(assets.find((asset) => asset.tokenId === "ton-gram")?.tokenAddress, "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c");
  assert.equal(assets.find((asset) => asset.tokenId === "hyperliquid-hype")?.tokenAddress, "0x0d01dc56dcaaca66ad901c959b4011ec");
  assert.equal(assets.find((asset) => asset.tokenId === "internet-computer-icp")?.gtNetworkId, "icp");
  assert.equal(assets.find((asset) => asset.tokenId === "sui-sui")?.gtNetworkId, "sui-network");
  for (const native of ["ethereum-eth", "solana-sol", "bnb-bnb", "avalanche-avax", "bitcoin-btc"]) {
    assert.equal(assets.some((asset) => asset.tokenId === native), false, `${native} has no GeckoTerminal mapping`);
  }
  assert.ok(assets.every((asset) => asset.tokenAddress && asset.externalAssetId.includes(":")));
  assert.equal(assets.some((asset) => asset.tokenId === "ethereum-usdt" && asset.tokenAddress === "0xdac17f958d2ee523a2206206994597c13d831ec7"), true);
});

test("selects the most liquid exact base-token pool, with deterministic tie breaks", () => {
  const baseLow = pool();
  const baseHigh = pool({ attributes: { ...pool().attributes, address: "0xpool-high", reserve_in_usd: "50000", volume_usd: { h24: "30000" }, token_price_usd: "11" } });
  const quoteOnly = pool({
    attributes: { ...pool().attributes, address: "0xpool-quote", reserve_in_usd: "100000", token_price_usd: "99" },
    relationships: {
      base_token: { data: { id: "eth_0xother" } },
      quote_token: { data: { id: `eth_${aave.tokenAddress.toLowerCase()}` } },
      dex: { data: { id: "fixture-dex" } },
    },
  });
  const wrongAddress = pool({ attributes: { ...pool().attributes, address: "0xfake" }, relationships: { base_token: { data: { id: "eth_0xfake" } }, quote_token: { data: { id: "eth_0xquote" } }, dex: { data: { id: "fixture-dex" } } } });

  assert.equal(selectPrimaryPool(aave, [baseLow, quoteOnly, wrongAddress, baseHigh])?.attributes.address, "0xpool-high");
  assert.equal(selectPrimaryPool(aave, [baseLow, pool({ attributes: { ...pool().attributes, address: "0xpool-a", reserve_in_usd: "10000" } })])?.attributes.address, "0xpool-a");
});

test("normalizes selected-pool metrics and aggregate pool activity while retaining all exact pools", () => {
  const best = pool({ attributes: { ...pool().attributes, address: "0xpool-best", reserve_in_usd: "50000", volume_usd: { h24: "30000" }, token_price_usd: "11", price_change_percentage: { h24: "4.2" }, fdv_usd: "110000000", market_cap_usd: "90000000" } });
  const secondary = pool({ attributes: { ...pool().attributes, address: "0xpool-secondary", reserve_in_usd: "15000", volume_usd: { h24: "12000" }, transactions: { h24: { buys: 10, sells: 8 } } } });
  const quoteOnly = pool({
    attributes: { ...pool().attributes, address: "0xpool-quote", reserve_in_usd: "100000", volume_usd: { h24: "8000" }, transactions: { h24: { buys: 4, sells: 6 } }, token_price_usd: "99" },
    relationships: {
      base_token: { data: { id: "eth_0xother" } },
      quote_token: { data: { id: `eth_${aave.tokenAddress.toLowerCase()}` } },
      dex: { data: { id: "fixture-dex" } },
    },
  });
  const snapshot = normalizeGeckoTerminalToken(aave, [best, secondary, quoteOnly], collectedAt);
  const metric = (id) => snapshot.observations.find((item) => item.metricId === id);

  assert.equal(snapshot.providerId, "geckoterminal");
  assert.equal(snapshot.providerPairs.length, 3);
  assert.equal(snapshot.rawPayload.providerPools.length, 3);
  assert.equal(metric("price_usd")?.value, 11, "price is from the primary exact base-token pool");
  assert.equal(metric("price_change_24h_pct")?.value, 4.2);
  assert.equal(metric("liquidity_usd")?.value, 50_000);
  assert.equal(metric("volume_24h_usd")?.value, 50_000, "24-hour pool volume aggregates across matched pools");
  assert.equal(metric("buys_24h_count")?.value, 84);
  assert.equal(metric("sells_24h_count")?.value, 44);
  assert.equal(metric("transactions_24h_count")?.value, 128);
  assert.equal(metric("fdv_usd")?.value, 110_000_000);
  assert.equal(metric("market_cap_usd")?.value, 90_000_000);
  assert.equal(snapshot.providerPairs.find((item) => item.pairAddress === "0xpool-best")?.pairCreatedAt, "2023-11-14T22:13:20.000Z");
  assert.equal(snapshot.observedAt, collectedAt, "API response has no provider snapshot timestamp");
});

test("null values stay unavailable, numeric zero stays available, and quote-only price is not inverted", () => {
  const quoteOnly = pool({
    attributes: { ...pool().attributes, reserve_in_usd: null, volume_usd: { h24: 0 }, transactions: { h24: { buys: 0, sells: 0 } }, token_price_usd: "123.45", price_change_percentage: { h24: "5" }, fdv_usd: "100", market_cap_usd: "90" },
    relationships: {
      base_token: { data: { id: "eth_0xother" } },
      quote_token: { data: { id: `eth_${aave.tokenAddress.toLowerCase()}` } },
      dex: { data: { id: "fixture-dex" } },
    },
  });
  const snapshot = normalizeGeckoTerminalToken(aave, [quoteOnly], collectedAt);
  const metric = (id) => snapshot.observations.find((item) => item.metricId === id);

  for (const id of ["price_usd", "price_change_24h_pct", "fdv_usd", "market_cap_usd", "liquidity_usd"]) {
    assert.equal(metric(id)?.status, "unavailable", `${id} should not be misread from quote-side/no-liquidity data`);
    assert.equal(metric(id)?.value, null);
  }
  assert.equal(metric("volume_24h_usd")?.value, 0);
  assert.equal(metric("volume_24h_usd")?.status, "available");
  assert.equal(metric("buys_24h_count")?.value, 0);
  assert.equal(metric("sells_24h_count")?.value, 0);
  assert.equal(metric("transactions_24h_count")?.value, 0);
});

test("adapter requests the standalone GeckoTerminal API directly, one token at a time, and uses fixtures only", async () => {
  const requests = [];
  const delays = [];
  const provider = new GeckoTerminalMarketDataProvider({
    sleep: async (ms) => delays.push(ms),
    now: () => new Date(collectedAt),
    fetchImpl: async (url, init) => {
      requests.push({ url: new URL(url), headers: new Headers(init.headers) });
      return new Response(JSON.stringify({ data: [pool()] }), { status: 200 });
    },
  });
  const snapshots = await provider.fetchSnapshots([aave, jupiter]);

  assert.equal(requests.length, 2);
  assert.equal(requests.every((request) => request.url.origin === "https://api.geckoterminal.com"), true, "requests go directly to the standalone GeckoTerminal API");
  assert.equal(requests.every((request) => !request.url.pathname.includes("/onchain")), true, "never uses CoinGecko's /onchain endpoints");
  assert.equal(requests[0].url.pathname, `/api/v2/networks/eth/tokens/${aave.tokenAddress}/pools`);
  assert.equal(requests[1].url.pathname, `/api/v2/networks/solana/tokens/${jupiter.tokenAddress}/pools`);
  assert.equal(requests.every((request) => !request.headers.has("authorization") && !request.headers.has("x-api-key")), true, "no API key is sent");
  assert.deepEqual(delays, [6_500]);
  assert.equal(snapshots.length, 2);
});

test("429 responses never trust an unreliable Retry-After below the cooldown floor, and bound retries", async () => {
  let requests = 0;
  const delays = [];
  const provider = new GeckoTerminalMarketDataProvider({
    sleep: async (ms) => delays.push(ms),
    fetchImpl: async () => {
      requests += 1;
      // Live testing observed GeckoTerminal send Retry-After: 0 while genuinely
      // throttled; a 429 must always wait at least the cooldown floor.
      return new Response("", { status: 429, headers: { "retry-after": "0" } });
    },
  });
  await assert.rejects(provider.fetchSnapshots([aave]), /HTTP 429/);
  assert.equal(requests, 3);
  assert.deepEqual(delays, [20_000, 20_000]);
});

test("a large Retry-After above the cooldown floor is honored as-is", async () => {
  let requests = 0;
  const delays = [];
  const provider = new GeckoTerminalMarketDataProvider({
    sleep: async (ms) => delays.push(ms),
    fetchImpl: async () => {
      requests += 1;
      if (requests === 1) return new Response("", { status: 429, headers: { "retry-after": "25" } });
      return new Response(JSON.stringify({ data: [pool()] }), { status: 200 });
    },
  });
  await provider.fetchSnapshots([aave]);
  assert.deepEqual(delays, [25_000]);
});

test("the stored pool payload keeps only what the token page reads, plus identity context", () => {
  const full = pool({
    id: "eth_0xpool-low",
    attributes: { ...pool().attributes, address: "0xPool-Low", reserve_in_usd: "123456.5", volume_usd: { h24: "777.5", h6: "10", h1: "1" }, transactions: { h24: { buys: 3, sells: 4 } }, price_change_percentage: { h24: "5" } },
  });
  const stored = storedGeckoTerminalPool(full);
  assert.deepEqual(Object.keys(stored.attributes).sort(), ["address", "name", "pool_created_at", "reserve_in_usd", "token_price_usd", "volume_usd"]);
  assert.deepEqual(stored.attributes.volume_usd, { h24: "777.5" }, "only the 24 h volume the page reads");
  assert.equal(stored.attributes.address, "0xPool-Low");
  assert.equal(stored.attributes.reserve_in_usd, "123456.5", "values keep their original string form");
  assert.ok(JSON.stringify(stored).length < JSON.stringify(full).length / 2, "the stored pool is much smaller than the full one");
  assert.equal(storedGeckoTerminalPool({}).attributes.volume_usd.h24, null, "a pool with missing fields stores nulls, not a crash");
});

test("the stored payload is the trimmed pools, while every metric and pair still comes from the full response", () => {
  const full = pool({ attributes: { ...pool().attributes, address: "0xpool-full", reserve_in_usd: "9000", volume_usd: { h24: "1200" }, transactions: { h24: { buys: 5, sells: 6 } } } });
  const snapshot = normalizeGeckoTerminalToken(aave, [full], collectedAt);
  assert.equal(snapshot.rawPayload.providerPools.length, 1);
  assert.equal(snapshot.rawPayload.providerPools[0].attributes.transactions, undefined, "unread fields are not stored");
  assert.equal(snapshot.observations.find((item) => item.metricId === "transactions_24h_count")?.value, 11, "transaction counts still come from the full pool");
  assert.equal(snapshot.observations.find((item) => item.metricId === "liquidity_usd")?.value, 9000);
  assert.equal(snapshot.providerPairs.length, 1);
});

test("the token page's pool list is identical whether the stored payload is full or trimmed", async () => {
  const pools = [
    pool({ id: "eth_0xaaa", attributes: { ...pool().attributes, address: "0xAAA", reserve_in_usd: "50000", volume_usd: { h24: "4000", h6: "1" }, token_price_usd: "11", transactions: { h24: { buys: 9, sells: 8 } } } }),
    pool({ id: "eth_0xbbb", attributes: { ...pool().attributes, address: "0xbbb", reserve_in_usd: null, volume_usd: {}, token_price_usd: "10.4" } }),
    pool({ id: "eth_0xccc", attributes: { ...pool().attributes, address: "0xccc", reserve_in_usd: 1200.5, volume_usd: { h24: 33 }, token_price_usd: null } }),
  ];
  const pairs = [
    { provider_id: "geckoterminal", token_id: "aave-aave", pair_address: "0xaaa", dex_id: "uniswap_v3", pair_created_at: "2023-01-01T00:00:00Z" },
    { provider_id: "geckoterminal", token_id: "aave-aave", pair_address: "0xBBB", dex_id: "sushiswap", pair_created_at: null },
    { provider_id: "geckoterminal", token_id: "aave-aave", pair_address: "0xccc", dex_id: null, pair_created_at: "2024-02-02T00:00:00Z" },
    { provider_id: "geckoterminal", token_id: "aave-aave", pair_address: "0xnot-in-payload", dex_id: "curve", pair_created_at: null },
  ];
  const read = async (providerPools) => {
    const db = createFakeSupabase({ seed: {
      provider_pairs: pairs,
      raw_provider_records: [{ id: 1, provider_id: "geckoterminal", token_id: "aave-aave", chain_id: "ethereum", collected_at: collectedAt, excluded_reason: null, payload: { providerPools } }],
    } });
    return readGeckoTerminalPools(db.client, "aave-aave");
  };

  const fromFull = await read(pools);
  const fromTrimmed = await read(pools.map(storedGeckoTerminalPool));
  assert.deepEqual(fromTrimmed, fromFull);
  assert.equal(fromFull.pools.length, 4);
  assert.equal(fromFull.pools.find((item) => item.pairAddress === "0xaaa")?.liquidityUsd, 50000, "the full path really read the values being compared");
  assert.equal(fromFull.pools.find((item) => item.pairAddress === "0xccc")?.volume24hUsd, 33);
  assert.equal(fromFull.pools.find((item) => item.pairAddress === "0xnot-in-payload")?.liquidityUsd, null);
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
console.log(`${cases.length - failures}/${cases.length} GeckoTerminal checks passed.`);
if (failures > 0) process.exitCode = 1;
