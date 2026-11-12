import assert from "node:assert/strict";

import { MAX_POOLS_PER_TOKEN, fetchDexPools, normalizeDexPools } from "../src/lib/providers/dexscreener-pools.ts";
import { DEX_POOL_REFRESH_AFTER_MS, dexPoolAssets, runDexPoolCollection } from "../src/lib/providers/run-dex-pool-collection.ts";
import { getLiveTokenProfile } from "../src/lib/data/live-data.ts";
import { canonicalTokens } from "../src/data/canonical-tokens.ts";
import { buildProfileModel } from "../src/lib/ui/profile-model.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const UNI = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984";
const pair = (address, overrides = {}) => ({
  chainId: "ethereum", dexId: "uniswap", labels: ["v3"], pairAddress: address,
  baseToken: { address: UNI }, quoteToken: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  priceUsd: "6.2", liquidity: { usd: 1000 }, volume: { h24: 500 }, priceChange: { h24: -2.5 },
  fdv: 6_200_000_000, marketCap: 3_700_000_000, pairCreatedAt: 1_600_000_000_000, ...overrides,
});

test("keeps exact-address pools on the requested chain, most liquid first, with version-qualified DEX ids", () => {
  const pools = normalizeDexPools("ethereum", UNI.toLowerCase(), [
    pair("0xaaa", { liquidity: { usd: 10 } }),
    pair("0xbbb", { liquidity: { usd: 9_000 }, dexId: "sushiswap", labels: null }),
    pair("0xccc", { baseToken: { address: "0xdead" }, quoteToken: { address: UNI } }), // token as the quote side still matches
    pair("0xddd", { baseToken: { address: "0xdead" }, quoteToken: { address: "0xbeef" } }), // a different token: dropped
    pair("0xeee", { chainId: "base" }), // another chain: dropped
    pair("0xaaa"), // duplicate pair address: dropped
  ]);
  assert.deepEqual(pools.map((pool) => pool.pairAddress), ["0xbbb", "0xccc", "0xaaa"]);
  assert.equal(pools[0].dexId, "sushiswap");
  assert.equal(pools[1].dexId, "uniswap_v3");
  assert.equal(pools[1].liquidityUsd, 1000);
  assert.equal(pools[1].priceChange24hPct, -2.5);
  assert.equal(pools[1].createdAt, new Date(1_600_000_000_000).toISOString());
});

test("non-numeric fields become null, never zero, and the list is capped", () => {
  const [pool] = normalizeDexPools("ethereum", UNI, [pair("0x1", { liquidity: null, volume: {}, priceUsd: "n/a", fdv: undefined, pairCreatedAt: 0 })]);
  assert.equal(pool.liquidityUsd, null);
  assert.equal(pool.volume24hUsd, null);
  assert.equal(pool.priceUsd, null);
  assert.equal(pool.fdvUsd, null);
  assert.equal(pool.createdAt, null);
  const many = Array.from({ length: 40 }, (_, index) => pair(`0x${index}`, { liquidity: { usd: index } }));
  assert.equal(normalizeDexPools("ethereum", UNI, many).length, MAX_POOLS_PER_TOKEN);
  assert.deepEqual(normalizeDexPools("ethereum", UNI, null), []);
});

test("the request hits token-pairs/v1 with a User-Agent, retries a 429 once, and does not surface bodies", async () => {
  let calls = 0;
  const seen = [];
  const fetchImpl = async (url, init) => {
    calls += 1;
    seen.push({ url: String(url), agent: init.headers["user-agent"] });
    return calls === 1 ? new Response("limited", { status: 429 }) : Response.json([pair("0x1")]);
  };
  const pools = await fetchDexPools("ethereum", UNI, { fetchImpl, sleep: async () => {} });
  assert.equal(pools.length, 1);
  assert.equal(calls, 2);
  assert.ok(seen.every((entry) => entry.url === `https://api.dexscreener.com/token-pairs/v1/ethereum/${UNI}` && /^tokensam\//.test(entry.agent)));
  await assert.rejects(
    fetchDexPools("ethereum", UNI, { fetchImpl: async () => new Response("secret body", { status: 403 }), sleep: async () => {} }),
    (error) => error.status === 403 && !/secret body/.test(error.message),
  );
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

test("reports none_due when everything is fresh, and stops the slice on a 429", async () => {
  const now = new Date("2026-11-12T12:00:00Z");
  const all = dexPoolAssets.map((asset) => ({ token_id: asset.tokenId, fetched_at: now.toISOString() }));
  const idle = await runDexPoolCollection(fakeClient({ snapshots: all }).client, { ...baseOptions, now, maxTokens: 5 });
  assert.equal(idle.stoppedReason, "none_due");

  const { DexPoolApiError } = await import("../src/lib/providers/dexscreener-pools.ts");
  const limited = await runDexPoolCollection(fakeClient().client, {
    ...baseOptions, now, maxTokens: 5, fetchPools: async () => { throw new DexPoolApiError("limited", 429); },
  });
  assert.equal(limited.attempted, 1);
  assert.equal(limited.stoppedReason, "rate_limited");
});

const profileFor = (tokenId, snapshot) => {
  const token = canonicalTokens.find((candidate) => candidate.id === tokenId);
  const asset = dexPoolAssets.find((candidate) => candidate.tokenId === tokenId);
  const client = createFakeSupabase({ seed: {
    tokens: [{ id: token.id, name: token.name, symbol: token.symbol, chain_id: token.chainId, contract_address: token.contractAddress, is_native: token.isNative, category: token.category, description: token.identityNote }],
    chains: [{ id: token.chainId, name: token.chainName }],
    provider_token_mappings: [{ provider_id: "dexscreener", token_id: tokenId, chain_id: token.chainId, external_asset_id: asset.tokenAddress, external_contract_address: asset.tokenAddress }],
    ...(snapshot ? { token_dex_pools: [{ token_id: tokenId, ...snapshot }] } : {}),
  } }).client;
  return getLiveTokenProfile(tokenId, client);
};

test("a profile builds its DEX Markets and concentration from the stored DEX Screener pool snapshot", async () => {
  const [first] = dexPoolAssets;
  const data = await profileFor(first.tokenId, { fetched_at: "2026-11-12T11:55:00.000Z", pools: [
    { pairAddress: "0xaaa", dexId: "uniswap_v3", liquidityUsd: 9_000_000, volume24hUsd: 4_000_000, priceUsd: 6.2, priceChange24hPct: -2.5, fdvUsd: 6.2e9, marketCapUsd: 3.7e9, createdAt: null },
    { pairAddress: "0xbbb", dexId: "sushiswap", liquidityUsd: 1_000_000, volume24hUsd: 1_000_000, priceUsd: 6.2, priceChange24hPct: -2.4, fdvUsd: null, marketCapUsd: null, createdAt: "2021-05-01T00:00:00.000Z" },
  ] });
  assert.equal(data.onchainMarkets.liquidityUsd, 9_000_000, "most liquid pool");
  assert.equal(data.onchainMarkets.volume24hUsd, 5_000_000, "summed across pools");
  assert.equal(data.onchainMarkets.priceChange24hPct, -2.5, "from the most liquid pool");
  assert.equal(data.onchainMarkets.fdvUsd, 6.2e9);
  assert.deepEqual(data.onchainMarkets.dexes, ["uniswap_v3", "sushiswap"]);
  const model = buildProfileModel(data);
  assert.equal(model.dexMarkets.available, true);
  assert.deepEqual(model.dexMarkets.pools.map((pool) => pool.dexLabel), ["Uniswap V3", "Sushiswap"]);
  const hhi = data.technicalIndicators?.groups.flatMap((group) => group.indicators ?? []).find((item) => item.id === "pool_concentration_hhi");
  assert.ok(hhi, "the pool concentration indicator is built from the snapshot");
  assert.deepEqual(hhi.provenance.providers, ["dexscreener"]);
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
