import assert from "node:assert/strict";

import { MAX_POOLS_PER_TOKEN, dexPaprikaAddress, dexPaprikaNetwork, fetchDexPools, normalizeDexPools, DexPoolApiError } from "../src/lib/providers/dexpaprika-pools.ts";
import { DEX_POOLS_REFRESH_AFTER_MS, DEX_STATS_REFRESH_AFTER_MS, dexPoolAssets, onchainIdentityFor, runDexPaprikaCollection } from "../src/lib/providers/run-dexpaprika-collection.ts";
import { buildDexPaprikaSnapshot, fetchTokenStats } from "../src/lib/providers/dexpaprika.ts";
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

test("Sui coin types are padded to the full package id DexPaprika matches; other addresses are untouched", () => {
  assert.equal(dexPaprikaAddress("sui", "0x2::sui::SUI"), "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI");
  assert.equal(dexPaprikaAddress("sui", "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"), "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI");
  assert.equal(dexPaprikaAddress("aptos", "0x1::aptos_coin::AptosCoin"), "0x1::aptos_coin::AptosCoin");
  assert.equal(dexPaprikaAddress("ethereum", UNI), UNI);
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

const STATS = {
  last_updated: "2026-11-12T08:00:30Z",
  price_stats: { high_24h: 6.65, low_24h: 6.12, ath: 1937.8 },
  summary: {
    price_usd: 6.14, fdv: 6.1e9, liquidity_usd: 25_524_098, pools: 997, last_updated: "2026-11-12T08:00:30Z",
    "24h": { volume_usd: 6_819_134, sells: 3782, buys: 2908, txns: 6690, buy_usd: 2_831_831, sell_usd: 3_987_303, last_price_usd_change: -3.58 },
    "6h": { volume_usd: 1_022_253, sells: 605, buys: 627, txns: 1232, buy_usd: 507_436, sell_usd: 514_817, last_price_usd_change: -0.58 },
    "1h": { volume_usd: 56_779, sells: 55, buys: 72, txns: 127, buy_usd: 46_343, sell_usd: 10_436, last_price_usd_change: 0.11 },
  },
};
const asset = { tokenId: "uniswap-uni", chainId: "ethereum", externalAssetId: `ethereum:${UNI}`, network: "ethereum", tokenAddress: UNI };
const byMetric = (snapshot) => Object.fromEntries(snapshot.observations.map((item) => [item.metricId, item]));

test("token stats become market-scope observations for every non-overlapping data point", () => {
  const snapshot = buildDexPaprikaSnapshot(asset, STATS, null, "2026-11-12T08:05:00.000Z");
  const m = byMetric(snapshot);
  assert.equal(snapshot.providerId, "dexpaprika");
  assert.equal(m.liquidity_usd.value, 25_524_098);
  assert.equal(m.dex_pool_count.value, 997);
  assert.equal(m.volume_24h_usd.value, 6_819_134);
  assert.equal(m.transactions_24h_count.value, 6690);
  assert.equal(m.buys_24h_count.value, 2908);
  assert.equal(m.sells_24h_count.value, 3782);
  assert.equal(m.dex_buy_volume_24h_usd.value, 2_831_831);
  assert.equal(m.dex_sell_volume_24h_usd.value, 3_987_303);
  assert.equal(m.dex_volume_6h_usd.value, 1_022_253);
  assert.equal(m.dex_volume_1h_usd.value, 56_779);
  assert.equal(m.dex_transactions_6h_count.value, 1232);
  assert.equal(m.dex_transactions_1h_count.value, 127);
  assert.equal(m.dex_price_change_6h_pct.value, -0.58);
  assert.equal(m.dex_price_change_1h_pct.value, 0.11);
  assert.equal(m.dex_price_high_24h_usd.value, 6.65);
  assert.equal(m.dex_price_low_24h_usd.value, 6.12);
  assert.ok(snapshot.observations.every((item) => item.scope === "market" && item.status === "available"));
  assert.equal(snapshot.observedAt, "2026-11-12T08:00:30.000Z", "the provider's own update time");
});

test("data points CoinGecko already supplies are not stored", () => {
  const ids = new Set(buildDexPaprikaSnapshot(asset, STATS, [{ pairAddress: "0x1", volume7dUsd: 1, volume30dUsd: 2 }]).observations.map((item) => item.metricId));
  for (const overlapping of ["price_usd", "price_change_24h_pct", "fdv_usd", "market_cap_usd"]) assert.ok(!ids.has(overlapping), `${overlapping} is CoinGecko's`);
});

test("7-day and 30-day volumes appear only when the pool list was refreshed, summed across the pools, with a partial-coverage note", () => {
  assert.ok(!("dex_volume_7d_usd" in byMetric(buildDexPaprikaSnapshot(asset, STATS, null))));
  const pools = [{ pairAddress: "0x1", volume7dUsd: 100, volume30dUsd: 400 }, { pairAddress: "0x2", volume7dUsd: 50, volume30dUsd: null }];
  const m = byMetric(buildDexPaprikaSnapshot(asset, STATS, pools));
  assert.equal(m.dex_volume_7d_usd.value, 150);
  assert.equal(m.dex_volume_30d_usd.value, 400);
  assert.match(m.dex_volume_7d_usd.note, /most liquid pool/);
});

test("a token DexPaprika does not index, or missing fields, give unavailable observations rather than zeros", () => {
  const empty = buildDexPaprikaSnapshot(asset, null, null);
  assert.ok(empty.observations.every((item) => item.value === null && item.status === "unavailable"));
  assert.equal(empty.rawPayload.indexed, false);
  const partial = byMetric(buildDexPaprikaSnapshot(asset, { summary: { liquidity_usd: 5 } }, null));
  assert.equal(partial.liquidity_usd.status, "available");
  assert.equal(partial.volume_24h_usd.status, "unavailable");
});

test("fetchTokenStats: bare Authorization key only when set, a 404 means not indexed, a 429 is retried once", async () => {
  let calls = 0;
  const seen = [];
  const withKey = await fetchTokenStats("ethereum", UNI, { apiKey: "api_k", sleep: async () => {}, fetchImpl: async (url, init) => {
    calls += 1; seen.push({ url: String(url), headers: init.headers });
    return calls === 1 ? new Response("slow", { status: 429 }) : Response.json(STATS);
  } });
  assert.equal(withKey.summary.pools, 997);
  assert.equal(calls, 2);
  assert.ok(seen.every((entry) => entry.url === `https://api.dexpaprika.com/networks/ethereum/tokens/${UNI}` && entry.headers.authorization === "api_k"));
  assert.equal(await fetchTokenStats("ethereum", UNI, { apiKey: null, fetchImpl: async () => new Response("", { status: 404 }) }), null);
  await assert.rejects(fetchTokenStats("ethereum", UNI, { apiKey: null, fetchImpl: async () => new Response("secret", { status: 402 }), sleep: async () => {} }), (error) => error.status === 402 && !/secret/.test(error.message));
});

function fakeClient({ rows = [], calls = 0 } = {}) {
  const state = { calls, upserts: [], rpc: 0 };
  const client = {
    from(table) {
      const query = {
        select() { return query; },
        eq() { return query; },
        maybeSingle: async () => ({ data: { calls: state.calls }, error: null }),
        then(resolve) { return Promise.resolve({ data: table === "token_dex_pools" ? rows : [], error: null }).then(resolve); },
        upsert: async (payload) => { state.upserts.push({ table, payload }); return { error: null }; },
      };
      return query;
    },
    rpc: async (_name, args) => { state.calls += args.p_calls; state.rpc += 1; return { data: state.calls, error: null }; },
  };
  return { client, state };
}
const POOLS = [{ pairAddress: "0x1", dexId: "uniswap_v3", liquidityUsd: 1, volume7dUsd: 1, volume30dUsd: 1 }];
const makeFetchers = (log = []) => ({
  fetchStats: async (network, address) => { log.push(["stats", network, address]); return STATS; },
  fetchPools: async (network, address) => { log.push(["pools", network, address]); return POOLS; },
});
const baseOptions = () => ({ deadlineAt: Date.now() + 120_000, sleep: async () => {}, minIntervalMs: 0, persist: async () => ({}) });
const NOW = new Date("2026-11-12T12:00:00Z");
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

test("stalest tokens first, fresh ones skipped, slice limit honoured, every request counted", async () => {
  const [fresh, stale] = dexPoolAssets;
  const { client, state } = fakeClient({ rows: [
    { token_id: fresh.tokenId, stats_at: ago(60_000), pools_at: ago(60_000) },
    { token_id: stale.tokenId, stats_at: ago(DEX_STATS_REFRESH_AFTER_MS + 1), pools_at: ago(60_000) },
  ] });
  const log = [];
  const persisted = [];
  const result = await runDexPaprikaCollection(client, { ...baseOptions(), now: NOW, maxTokens: 3, fetchers: makeFetchers(log), persist: async (_c, snapshots) => { persisted.push(...snapshots); return {}; } });
  assert.equal(result.attempted, 3);
  assert.equal(result.stoppedReason, "slice_limit");
  assert.ok(!persisted.some((snapshot) => snapshot.asset.tokenId === fresh.tokenId), "a fresh token is not refetched");
  assert.ok(!persisted.slice(0, 2).some((snapshot) => snapshot.asset.tokenId === stale.tokenId), "never-fetched tokens go before the stalest one");
  assert.equal(state.calls, log.length, "each request is counted against the monthly cap");
  assert.ok(state.upserts.some((entry) => entry.table === "provider_token_mappings"));
});

test("pool lists are refreshed only when older than six hours; otherwise only the stats stamp is written", async () => {
  const [a, b] = dexPoolAssets;
  const { client, state } = fakeClient({ rows: [
    { token_id: a.tokenId, stats_at: ago(DEX_STATS_REFRESH_AFTER_MS + 1), pools_at: ago(60_000) },
    { token_id: b.tokenId, stats_at: ago(DEX_STATS_REFRESH_AFTER_MS + 1), pools_at: ago(DEX_POOLS_REFRESH_AFTER_MS + 1) },
  ] });
  const everyone = dexPoolAssets.filter((asset) => asset.tokenId !== a.tokenId && asset.tokenId !== b.tokenId).map((asset) => ({ token_id: asset.tokenId, stats_at: ago(60_000), pools_at: ago(60_000) }));
  const { client: c2, state: s2 } = fakeClient({ rows: [...everyone, { token_id: a.tokenId, stats_at: ago(DEX_STATS_REFRESH_AFTER_MS + 1), pools_at: ago(60_000) }, { token_id: b.tokenId, stats_at: ago(DEX_STATS_REFRESH_AFTER_MS + 2), pools_at: ago(DEX_POOLS_REFRESH_AFTER_MS + 1) }] });
  const log = [];
  const result = await runDexPaprikaCollection(c2, { ...baseOptions(), now: NOW, maxTokens: 5, fetchers: makeFetchers(log) });
  assert.equal(result.attempted, 2);
  assert.equal(result.poolsRefreshed, 1, "only the token with an old pool list gets a pools request");
  assert.equal(log.filter(([kind]) => kind === "pools").length, 1);
  const writes = s2.upserts.filter((entry) => entry.table === "token_dex_pools");
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map((entry) => Object.keys(entry.payload[0]).sort().join(",")).sort(), ["stats_at,token_id", "pools,pools_at,stats_at,token_id"].sort());
  assert.ok(state.upserts.length === 0);
});

test("the monthly cap stops the collector before another request, and 402 stops it at once", async () => {
  const capped = await runDexPaprikaCollection(fakeClient({ calls: 10 }).client, { ...baseOptions(), now: NOW, maxTokens: 5, monthlyCap: 10, fetchers: makeFetchers() });
  assert.equal(capped.attempted, 0);
  assert.equal(capped.stoppedReason, "monthly_cap");

  const broke = await runDexPaprikaCollection(fakeClient().client, { ...baseOptions(), now: NOW, maxTokens: 5, fetchers: { ...makeFetchers(), fetchStats: async () => { throw new DexPoolApiError("no credits", 402); } } });
  assert.equal(broke.attempted, 1);
  assert.equal(broke.stoppedReason, "credits_exhausted");
});

test("a lone 429 is skipped after a cooldown, two in a row stop the slice, and idle when nothing is due", async () => {
  const sleeps = [];
  let call = 0;
  const lone = await runDexPaprikaCollection(fakeClient().client, { ...baseOptions(), now: NOW, maxTokens: 3, sleep: async (ms) => { sleeps.push(ms); },
    fetchers: { ...makeFetchers(), fetchStats: async () => { call += 1; if (call === 1) throw new DexPoolApiError("limited", 429); return STATS; } } });
  assert.equal(lone.failed, 1);
  assert.equal(lone.succeeded, 2);
  assert.ok(sleeps.includes(8_000));
  const throttled = await runDexPaprikaCollection(fakeClient().client, { ...baseOptions(), now: NOW, maxTokens: 5, fetchers: { ...makeFetchers(), fetchStats: async () => { throw new DexPoolApiError("limited", 429); } } });
  assert.equal(throttled.attempted, 2);
  assert.equal(throttled.stoppedReason, "rate_limited");
  assert.match(throttled.firstError, /limited/);
  const fresh = dexPoolAssets.map((asset) => ({ token_id: asset.tokenId, stats_at: NOW.toISOString(), pools_at: NOW.toISOString() }));
  assert.equal((await runDexPaprikaCollection(fakeClient({ rows: fresh }).client, { ...baseOptions(), now: NOW, maxTokens: 5, fetchers: makeFetchers() })).stoppedReason, "none_due");
});

test("only canonical-universe tokens are collected, so every row has a token to attach to", () => {
  assert.ok(dexPoolAssets.length >= 90 && dexPoolAssets.length <= 100, "the previously mapped tokens plus the curated extras");
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
