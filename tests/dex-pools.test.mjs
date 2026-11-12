import assert from "node:assert/strict";

import { MAX_POOLS_PER_TOKEN, dexPaprikaNetwork, fetchDexPools, normalizeDexPools, DexPoolApiError } from "../src/lib/providers/dexpaprika-pools.ts";
import { DEX_POOL_REFRESH_AFTER_MS, dexPoolAssets, onchainIdentityFor, runDexPoolCollection } from "../src/lib/providers/run-dex-pool-collection.ts";
import { getLiveTokenProfile } from "../src/lib/data/live-data.ts";
import { canonicalTokens } from "../src/data/canonical-tokens.ts";
import { buildProfileModel } from "../src/lib/ui/profile-model.ts";
import { extraOnchainMappings } from "../src/data/dexpaprika-extra-mappings.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const UNI = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984";
const raw = (id, overrides = {}) => ({
  id, dex_id: "uniswap_v3", dex_name: "Uniswap V3", chain: "ethereum", created_at: "2021-05-04T19:52:36Z",
  liquidity_usd: 1000, volume_usd_24h: 500, price_usd: 6.2, price_change_percentage_24h: -2.5, ...overrides,
});

test("reads DexPaprika pool search results: most liquid first, deduplicated, with null for missing numbers", () => {
  const pools = normalizeDexPools({ results: [
    raw("0xaaa", { liquidity_usd: 10 }),
    raw("0xbbb", { liquidity_usd: 9_000, dex_id: "sushiswap" }),
    raw("0xaaa"), // duplicate pool address: dropped
    raw("0xccc", { liquidity_usd: null, volume_usd_24h: "n/a", price_usd: undefined, created_at: "garbage" }),
  ], has_next_page: true });
  assert.deepEqual(pools.map((pool) => pool.pairAddress), ["0xbbb", "0xaaa", "0xccc"]);
  assert.equal(pools[0].dexId, "sushiswap");
  assert.equal(pools[1].priceChange24hPct, -2.5);
  assert.equal(pools[1].createdAt, "2021-05-04T19:52:36.000Z");
  assert.equal(pools[2].liquidityUsd, null);
  assert.equal(pools[2].volume24hUsd, null);
  assert.equal(pools[2].createdAt, null);
  assert.equal(pools[0].fdvUsd, null, "the search carries no FDV");
  assert.equal(pools[0].marketCapUsd, null, "nor a market cap");
  assert.deepEqual(normalizeDexPools(null), []);
  const many = Array.from({ length: 130 }, (_, index) => raw(`0x${index}`, { liquidity_usd: index }));
  assert.equal(MAX_POOLS_PER_TOKEN, 100);
  assert.equal(normalizeDexPools({ results: many }).length, MAX_POOLS_PER_TOKEN);
});

test("network names: Hyperliquid maps to hyperevm, ICP is unsupported, the rest keep their id", () => {
  assert.equal(dexPaprikaNetwork("hyperliquid"), "hyperevm");
  assert.equal(dexPaprikaNetwork("icp"), null);
  assert.equal(dexPaprikaNetwork("ethereum"), "ethereum");
  assert.ok(dexPoolAssets.every((asset) => asset.network !== "icp" && asset.network !== "hyperliquid"));
});

test("the request is a token_address pool search; the key goes in Authorization only when set; a 429 is retried once", async () => {
  let calls = 0;
  const seen = [];
  const fetchImpl = async (url, init) => {
    calls += 1;
    seen.push({ url: new URL(String(url)), headers: init.headers });
    return calls === 1 ? new Response("limited", { status: 429 }) : Response.json({ results: [raw("0x1")] });
  };
  const withKey = await fetchDexPools("ethereum", UNI, { apiKey: "api_secret", fetchImpl, sleep: async () => {} });
  assert.equal(withKey.length, 1);
  assert.equal(calls, 2);
  for (const { url, headers } of seen) {
    assert.equal(url.origin + url.pathname, "https://api.dexpaprika.com/networks/ethereum/pools/search");
    assert.equal(url.searchParams.get("token_address"), UNI);
    assert.equal(url.searchParams.get("order_by"), "liquidity_usd");
    assert.equal(url.searchParams.get("limit"), "100");
    assert.equal(headers.authorization, "api_secret");
  }
  seen.length = 0;
  await fetchDexPools("ethereum", UNI, { apiKey: null, fetchImpl: async (url, init) => { seen.push(init.headers); return Response.json({ results: [] }); }, sleep: async () => {} });
  assert.equal(seen[0].authorization, undefined, "keyless requests send no Authorization header");
});

test("errors never surface response bodies, and 402 (credits exhausted) is not retried", async () => {
  let calls = 0;
  await assert.rejects(
    fetchDexPools("ethereum", UNI, { apiKey: "k", fetchImpl: async () => { calls += 1; return new Response("secret body", { status: 402 }); }, sleep: async () => {} }),
    (error) => error.status === 402 && !/secret body/.test(error.message),
  );
  assert.equal(calls, 1);
});

function fakeClient({ snapshots = [] } = {}) {
  const state = { upserts: [] };
  const client = {
    from() {
      const query = {
        select() { return query; },
        then(resolve) { return Promise.resolve({ data: snapshots, error: null }).then(resolve); },
        upsert: async (row) => { state.upserts.push(row); return { error: null }; },
      };
      return query;
    },
  };
  return { client, state };
}
const baseOptions = { deadlineAt: Date.now() + 60_000, sleep: async () => {}, minIntervalMs: 0, fetchPools: async () => [{ pairAddress: "0x1", dexId: "uniswap_v3", liquidityUsd: 1 }] };

test("refreshes never-fetched tokens first, then the stalest, skipping fresh ones, up to the slice limit", async () => {
  const now = new Date("2026-11-12T12:00:00Z");
  const [fresh, stale] = dexPoolAssets;
  const { client, state } = fakeClient({ snapshots: [
    { token_id: fresh.tokenId, fetched_at: new Date(now.getTime() - 60_000).toISOString() },
    { token_id: stale.tokenId, fetched_at: new Date(now.getTime() - DEX_POOL_REFRESH_AFTER_MS - 1).toISOString() },
  ] });
  const result = await runDexPoolCollection(client, { ...baseOptions, now, maxTokens: 3 });
  assert.equal(result.attempted, 3);
  assert.equal(result.stoppedReason, "slice_limit");
  const ids = state.upserts.map((row) => row.token_id);
  assert.ok(!ids.includes(fresh.tokenId), "a fresh snapshot is not refetched");
  assert.ok(!ids.slice(0, 2).includes(stale.tokenId), "never-fetched tokens go before the stalest one");
});

test("reports none_due when everything is fresh; a lone 429 is skipped after a cooldown, two in a row stop the slice", async () => {
  const now = new Date("2026-11-12T12:00:00Z");
  const all = dexPoolAssets.map((asset) => ({ token_id: asset.tokenId, fetched_at: now.toISOString() }));
  const idle = await runDexPoolCollection(fakeClient({ snapshots: all }).client, { ...baseOptions, now, maxTokens: 5 });
  assert.equal(idle.stoppedReason, "none_due");

    const sleeps = [];
  let call = 0;
  const lone = await runDexPoolCollection(fakeClient().client, {
    ...baseOptions, now, maxTokens: 3, sleep: async (ms) => { sleeps.push(ms); },
    fetchPools: async () => { call += 1; if (call === 1) throw new DexPoolApiError("limited", 429); return [{ pairAddress: "0x1" }]; },
  });
  assert.equal(lone.attempted, 3);
  assert.equal(lone.failed, 1);
  assert.equal(lone.succeeded, 2, "the slice carries on after one 429");
  assert.ok(sleeps.includes(8_000), "with a cooldown after the 429");

  const throttled = await runDexPoolCollection(fakeClient().client, {
    ...baseOptions, now, maxTokens: 5, fetchPools: async () => { throw new DexPoolApiError("limited", 429); },
  });
  assert.equal(throttled.attempted, 2);
  assert.equal(throttled.stoppedReason, "rate_limited");
  assert.match(throttled.firstError, /limited/);

  const broke = await runDexPoolCollection(fakeClient().client, {
    ...baseOptions, now, maxTokens: 5, fetchPools: async () => { throw new DexPoolApiError("no credits", 402); },
  });
  assert.equal(broke.attempted, 1);
  assert.equal(broke.stoppedReason, "credits_exhausted");
});

test("only canonical-universe tokens are collected, so every row has a token to attach to", () => {
  assert.ok(dexPoolAssets.length >= 90 && dexPoolAssets.length <= 100, "the DEX Screener-mapped tokens plus the curated extras");
  const ids = new Set(canonicalTokens.map((token) => token.id));
  for (const asset of dexPoolAssets) assert.ok(ids.has(asset.tokenId), asset.tokenId);
});

const profileFor = (tokenId, snapshot) => {
  const token = canonicalTokens.find((candidate) => candidate.id === tokenId);
  const client = createFakeSupabase({ seed: {
    tokens: [{ id: token.id, name: token.name, symbol: token.symbol, chain_id: token.chainId, contract_address: token.contractAddress, is_native: token.isNative, category: token.category, description: token.identityNote }],
    chains: [{ id: token.chainId, name: token.chainName }],
    ...(snapshot ? { token_dex_pools: [{ token_id: tokenId, ...snapshot }] } : {}),
  } }).client;
  return getLiveTokenProfile(tokenId, client);
};

test("the curated extras are real, non-native, non-duplicated tokens, and their identity resolves without any database row", () => {
  const ids = new Set(canonicalTokens.map((token) => token.id));
  const seen = new Set();
  for (const mapping of extraOnchainMappings) {
    const token = canonicalTokens.find((candidate) => candidate.id === mapping.tokenId);
    assert.ok(token, `${mapping.tokenId} is a canonical token`);
    assert.equal(token.isNative, false, `${mapping.tokenId} is not a native asset (wrapped assets are never substituted)`);
    assert.ok(!seen.has(mapping.tokenId), `${mapping.tokenId} is listed once`);
    seen.add(mapping.tokenId);
    assert.deepEqual(onchainIdentityFor(mapping.tokenId), { chainId: mapping.canonicalChainId, tokenAddress: mapping.tokenAddress });
  }
  const assetIds = dexPoolAssets.map((asset) => asset.tokenId);
  assert.equal(new Set(assetIds).size, assetIds.length, "no token is collected twice");
  assert.ok(assetIds.every((id) => ids.has(id)));
  assert.equal(onchainIdentityFor("bitcoin-btc"), undefined, "a native asset has no on-chain identity");
});

test("a profile builds its DEX Markets and concentration from the stored DEX Screener pool snapshot", async () => {
  const [first] = dexPoolAssets;
  const data = await profileFor(first.tokenId, { fetched_at: "2026-11-12T11:55:00.000Z", pools: [
    { pairAddress: "0xaaa", dexId: "uniswap_v3", liquidityUsd: 9_000_000, volume24hUsd: 4_000_000, priceUsd: 6.2, priceChange24hPct: -2.5, fdvUsd: null, marketCapUsd: null, createdAt: null },
    { pairAddress: "0xbbb", dexId: "sushiswap", liquidityUsd: 1_000_000, volume24hUsd: 1_000_000, priceUsd: 6.2, priceChange24hPct: -2.4, fdvUsd: null, marketCapUsd: null, createdAt: "2021-05-01T00:00:00.000Z" },
  ] });
  assert.equal(data.onchainMarkets.liquidityUsd, 9_000_000, "most liquid pool");
  assert.equal(data.onchainMarkets.volume24hUsd, 5_000_000, "summed across pools");
  assert.equal(data.onchainMarkets.priceChange24hPct, -2.5, "from the most liquid pool");
  assert.equal(data.onchainMarkets.fdvUsd, null, "no FDV from the pool source, so that card is not shown");
  assert.deepEqual(data.onchainMarkets.dexes, ["uniswap_v3", "sushiswap"]);
  const model = buildProfileModel(data);
  assert.equal(model.dexMarkets.available, true);
  assert.deepEqual(model.dexMarkets.pools.map((pool) => pool.dexLabel), ["Uniswap V3", "Sushiswap"]);
  const hhi = data.technicalIndicators?.groups.flatMap((group) => group.indicators ?? []).find((item) => item.id === "pool_concentration_hhi");
  assert.ok(hhi, "the pool concentration indicator is built from the snapshot");
  assert.deepEqual(hhi.provenance.providers, ["dexpaprika"]);
});

test("a token with more than 30 stored pools lists the 30 most liquid and counts the rest, while totals use all of them", async () => {
  const [, , third] = dexPoolAssets;
  const pools = Array.from({ length: 45 }, (_, index) => ({
    pairAddress: `0x${index}`, dexId: "uniswap_v3", liquidityUsd: 1_000_000 - index * 1_000, volume24hUsd: 100, priceUsd: 1, priceChange24hPct: 0, fdvUsd: null, marketCapUsd: null, createdAt: null,
  }));
  const data = await profileFor(third.tokenId, { fetched_at: "2026-11-12T11:55:00.000Z", pools });
  const model = buildProfileModel(data);
  assert.equal(model.dexMarkets.pools.length, 30);
  assert.equal(model.dexMarkets.morePools, 15);
  assert.equal(data.onchainMarkets.volume24hUsd, 4_500, "volume is summed over all 45 stored pools");
});

test("a mapped token with no snapshot yet shows no pools rather than failing", async () => {
  const data = await profileFor(dexPoolAssets[1].tokenId, null);
  assert.deepEqual(data.onchainMarkets.pools, []);
  assert.equal(buildProfileModel(data).dexMarkets.available, false);
});

let failures = 0;
for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : "unknown error"}`); }
}
console.log(`${cases.length - failures}/${cases.length} dex-pool checks passed.`);
if (failures > 0) process.exitCode = 1;
