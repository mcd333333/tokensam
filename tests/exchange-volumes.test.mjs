import assert from "node:assert/strict";

import { aggregateExchangeVolumes, fetchExchangeVolumes } from "../src/lib/providers/coingecko-exchanges.ts";
import { DEFAULT_MONTHLY_CALL_CAP, EXCHANGE_REFRESH_AFTER_MS, runExchangeCollection } from "../src/lib/providers/run-exchange-collection.ts";
import { canonicalTokens } from "../src/data/canonical-tokens.ts";
import { getLiveTokenProfile } from "../src/lib/data/live-data.ts";
import { buildProfileModel } from "../src/lib/ui/profile-model.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const ticker = (identifier, name, base, target, usd, extra = {}) => ({
  base, target, market: { identifier, name }, converted_volume: { usd }, ...extra,
});

test("aggregates volume and pair count per exchange, sorted by volume", () => {
  const out = aggregateExchangeVolumes([
    ticker("binance", "Binance", "BTC", "USDT", 600), ticker("binance", "Binance", "BTC", "USDC", 150),
    ticker("gdax", "Coinbase Exchange", "BTC", "USD", 900),
  ]);
  assert.deepEqual(out, [
    { id: "gdax", name: "Coinbase Exchange", kind: "cex", volumeUsd: 900, pairs: 1 },
    { id: "binance", name: "Binance", kind: "cex", volumeUsd: 750, pairs: 2 },
  ]);
});

test("tags DEX tickers as decentralised, and drops anomalous, stale and non-positive rows", () => {
  const out = aggregateExchangeVolumes([
    ticker("uniswap_v3", "Uniswap V3", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "0xdAC17F958D2ee523a2206206994597C13D831ec7", 5_000_000),
    ticker("uniswap_v3", "Uniswap V3", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 1_000_000),
    ticker("orca", "Orca", "So11111111111111111111111111111111111111112", "USDC", 4_000_000),
    ticker("somedex", "SomeDex", "ETH", "USDC", 3_000_000, { token_info_url: "https://www.geckoterminal.com/eth/pools/0x1" }),
    ticker("kraken", "Kraken", "ETH", "USD", 2_000_000, { is_anomaly: true }),
    ticker("okx", "OKX", "ETH", "USDT", 1_000_000, { is_stale: true }),
    ticker("bybit", "Bybit", "ETH", "USDT", 0),
    ticker("bitget", "Bitget", "ETH", "USDT", 800),
  ]);
  assert.deepEqual(out.map((item) => [item.id, item.kind, item.volumeUsd, item.pairs]), [
    ["bitget", "cex", 800, 1],
    ["uniswap_v3", "dex", 6_000_000, 2],
    ["orca", "dex", 4_000_000, 1],
    ["somedex", "dex", 3_000_000, 1],
  ]);
});

test("keeps the top 15 centralised and top 10 decentralised exchanges and tolerates a bad payload", () => {
  const cex = Array.from({ length: 20 }, (_, index) => ticker(`ex${index}`, `Ex ${index}`, "ETH", "USDT", 100 + index));
  const dex = Array.from({ length: 14 }, (_, index) => ticker(`dx${index}`, `Dx ${index}`, "0x" + "a".repeat(40), "0x" + "b".repeat(40), 100 + index));
  const out = aggregateExchangeVolumes([...cex, ...dex]);
  assert.equal(out.filter((item) => item.kind === "cex").length, 15);
  assert.equal(out.filter((item) => item.kind === "dex").length, 10);
  assert.deepEqual(aggregateExchangeVolumes(null), []);
});

test("fetch uses the volume-sorted first page and the configured key header", async () => {
  let seen = null;
  const out = await fetchExchangeVolumes("bitcoin", {
    env: { COINGECKO_API_KEY: "key", COINGECKO_API_PLAN: "demo" },
    fetchImpl: async (url, init) => { seen = { url: String(url), headers: init.headers }; return new Response(JSON.stringify({ tickers: [ticker("binance", "Binance", "BTC", "USDT", 10)] })); },
  });
  assert.match(seen.url, /\/coins\/bitcoin\/tickers\?/);
  assert.match(seen.url, /order=volume_desc/);
  assert.equal(seen.headers["x-cg-demo-api-key"], "key");
  assert.equal(out.length, 1);
});

// A minimal stand-in for the Supabase client, covering only what the collector touches.
function fakeClient({ mappings, snapshots = [], calls = 0 }) {
  const state = { calls, upserts: [] };
  const client = {
    from(table) {
      const query = {
        select() { return query; },
        eq() { return query; },
        maybeSingle: async () => ({ data: table === "coingecko_exchange_call_usage" ? { calls: state.calls } : null, error: null }),
        then(resolve) {
          const data = table === "provider_token_mappings" ? mappings : table === "token_exchange_volumes" ? snapshots : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
        upsert: async (row) => { state.upserts.push(row); return { error: null }; },
      };
      return query;
    },
    rpc: async (_name, args) => { state.calls += args.p_calls; return { data: state.calls, error: null }; },
  };
  return { client, state };
}

const mappings = Array.from({ length: 5 }, (_, index) => ({ token_id: `t${index}`, external_asset_id: `coin-${index}` }));
const fetchVolumes = async (coinId) => [{ id: "binance", name: "Binance", kind: "cex", volumeUsd: 10, pairs: 1 }];
const baseOptions = { deadlineAt: Date.now() + 60_000, sleep: async () => {}, minIntervalMs: 0, fetchVolumes };

test("fetches never-fetched and stale tokens only, oldest first, up to the slice limit", async () => {
  const now = new Date("2026-11-12T00:00:00Z");
  const { client, state } = fakeClient({
    mappings,
    snapshots: [
      { token_id: "t0", fetched_at: new Date(now.getTime() - 3_600_000).toISOString() }, // fresh: skipped
      { token_id: "t1", fetched_at: new Date(now.getTime() - EXCHANGE_REFRESH_AFTER_MS - 1).toISOString() },
    ],
  });
  const result = await runExchangeCollection(client, { ...baseOptions, now, maxTokens: 3 });
  assert.equal(result.attempted, 3);
  assert.equal(result.stoppedReason, "slice_limit");
  assert.ok(!state.upserts.some((row) => row.token_id === "t0"), "a fresh snapshot is not refetched");
  assert.equal(state.calls, 3, "each attempt is counted against the monthly cap");
});

test("stops at the monthly call cap without making further calls", async () => {
  const { client, state } = fakeClient({ mappings, calls: 9 });
  const result = await runExchangeCollection(client, { ...baseOptions, now: new Date("2026-11-12T00:00:00Z"), maxTokens: 10, monthlyCap: 10 });
  assert.equal(result.attempted, 1);
  assert.equal(result.stoppedReason, "monthly_cap");
  assert.equal(state.calls, 10);
  assert.ok(DEFAULT_MONTHLY_CALL_CAP < 10_000 - 5_760, "default cap leaves the price refresh its calls");
});

test("reports none_due when every snapshot is fresh", async () => {
  const now = new Date("2026-11-12T00:00:00Z");
  const snapshots = mappings.map((row) => ({ token_id: row.token_id, fetched_at: now.toISOString() }));
  const { client, state } = fakeClient({ mappings, snapshots });
  const result = await runExchangeCollection(client, { ...baseOptions, now, maxTokens: 10 });
  assert.equal(result.stoppedReason, "none_due");
  assert.equal(state.calls, 0);
});

test("stops the slice on a rate-limit response", async () => {
  const { CoinGeckoApiError } = await import("../src/lib/providers/coingecko.ts");
  const { client } = fakeClient({ mappings });
  const result = await runExchangeCollection(client, {
    ...baseOptions, now: new Date("2026-11-12T00:00:00Z"), maxTokens: 10,
    fetchVolumes: async () => { throw new CoinGeckoApiError("limited", 429); },
  });
  assert.equal(result.attempted, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.stoppedReason, "rate_limited");
});

// getLiveTokenProfile caches per token id, so each case uses its own token.
const profileWith = (seed, index = 0) => {
  const token = canonicalTokens[index];
  const client = createFakeSupabase({ seed: {
    tokens: [{ id: token.id, name: token.name, symbol: token.symbol, chain_id: token.chainId, contract_address: token.contractAddress, is_native: token.isNative, category: token.category, description: token.identityNote }],
    chains: [{ id: token.chainId, name: token.chainName }],
    ...seed,
  } }).client;
  return getLiveTokenProfile(token.id, client);
};

test("profile shows each exchange, grouped as centralised and decentralised, with its 24h volume and share, plus a nav entry", async () => {
  const data = await profileWith({ token_exchange_volumes: [{
    token_id: canonicalTokens[0].id, fetched_at: "2026-11-12T00:10:00.000Z",
    exchanges: [
      { id: "binance", name: "Binance", kind: "cex", volumeUsd: 3_000_000, pairs: 2 },
      { id: "gdax", name: "Coinbase Exchange", kind: "cex", volumeUsd: 1_000_000, pairs: 1 },
      { id: "uniswap_v3", name: "Uniswap V3", kind: "dex", volumeUsd: 500_000, pairs: 3 },
    ],
  }] });
  const model = buildProfileModel(data);
  assert.equal(model.exchanges.available, true);
  assert.deepEqual(model.exchanges.groups.map((group) => group.kind), ["cex", "dex"]);
  assert.deepEqual(model.exchanges.groups[0].rows.map((row) => [row.name, row.sharePct]), [["Binance", 75], ["Coinbase Exchange", 25]]);
  assert.deepEqual(model.exchanges.groups[1].rows.map((row) => [row.name, row.sharePct]), [["Uniswap V3", 100]]);
  assert.ok(model.exchanges.groups.every((group) => group.rows.every((row) => row.volume24h.startsWith("$"))));
  assert.ok(model.sections.some((section) => section.id === "exchanges"));
});

test("profile omits the exchanges section when no snapshot is stored", async () => {
  const model = buildProfileModel(await profileWith({}, 1));
  assert.equal(model.exchanges.available, false);
  assert.ok(!model.sections.some((section) => section.id === "exchanges"));
});

let failures = 0;
for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : "unknown error"}`); }
}
console.log(`${cases.length - failures}/${cases.length} exchange-volume checks passed.`);
if (failures > 0) process.exitCode = 1;
