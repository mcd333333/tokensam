import assert from "node:assert/strict";

import { canonicalTokens } from "../src/data/canonical-tokens.ts";
import { coingeckoTokenIds } from "../src/data/coingecko-token-mappings.ts";
import { onchainTokenMappings } from "../src/data/onchain-token-mappings.ts";
import { coverageMatrix, defillamaCoinsIdentifier, tokenCoverage } from "../src/data/provider-coverage.ts";
import { normalizeCoinGeckoMarketItem } from "../src/lib/providers/coingecko.ts";
import { normalizeCoinsPrice } from "../src/lib/providers/defillama-coins.ts";
import { normalizeDefiLlamaCurrent, normalizeDefiLlamaHistory } from "../src/lib/providers/defillama.ts";
import { dexPoolAssets } from "../src/data/onchain-identity.ts";
import { buildDexPaprikaSnapshot } from "../src/lib/providers/dexpaprika.ts";
import { calculateTokenMetrics, hasCompatibleScope } from "../src/lib/metrics/engine.ts";
import { buildResearchContext } from "../src/lib/analysis/research-context.ts";
import { visibleColumns } from "../src/lib/data/column-visibility.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const NOW = "2026-09-25T12:00:00.000Z";
const byId = (id) => canonicalTokens.find((token) => token.id === id);
const WRAPPED_ADDRESSES = new Set([
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
  "so11111111111111111111111111111111111111112", // wSOL
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
  "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", // WAVAX
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", // WBTC
]);

// ---- 1-4: provider observations carry their scope ----

test("1. CoinGecko token data is unchanged and token-scoped", () => {
  const snapshot = normalizeCoinGeckoMarketItem({ tokenId: "bitcoin-btc", chainId: "bitcoin", externalAssetId: "bitcoin" }, {
    id: "bitcoin", last_updated: NOW, current_price: 84000, market_cap: 1.6e12, total_volume: 4e10,
    price_change_percentage_24h: 0.3, price_change_percentage_7d_in_currency: 10, circulating_supply: 2e7, total_supply: 2e7, max_supply: 2.1e7,
  }, NOW);
  assert.deepEqual(snapshot.observations.map((item) => item.metricId), ["price_usd", "market_cap_usd", "volume_24h_usd", "price_change_24h_pct", "price_change_7d_pct", "circulating_supply", "total_supply", "maximum_supply"]);
  assert.equal(snapshot.observations[0].value, 84000);
  assert.ok(snapshot.observations.every((item) => item.scope === "token"));
});

test("2. a DeFiLlama coins-API observation is token-scoped", () => {
  const snapshot = normalizeCoinsPrice({ tokenId: "bitcoin-btc", chainId: "bitcoin", externalAssetId: "coingecko:bitcoin" }, { price: 84054.75, symbol: "BTC", timestamp: 1790272720, confidence: 0.99 }, NOW);
  assert.equal(snapshot.providerId, "defillama_coins");
  assert.equal(snapshot.observations[0].scope, "token");
  assert.equal(snapshot.observations[0].value, 84054.75);
  assert.match(snapshot.observations[0].note, /confidence 0\.99/);
  assert.match(snapshot.observations[0].note, /may source this price from CoinGecko/);
});

test("3. a DeFiLlama protocol observation is protocol-scoped", () => {
  const aave = { tokenId: "aave-aave", chainId: "ethereum", externalAssetId: "aave", recordId: "parent#aave" };
  const snapshot = normalizeDefiLlamaCurrent(aave, { tvl: 3e10, fees: null, revenue: null }, NOW);
  assert.ok(snapshot.observations.length > 0);
  assert.ok(snapshot.observations.every((item) => item.scope === "protocol"));
  const { snapshot: history } = normalizeDefiLlamaHistory(aave, { id: "parent#aave", tvl: [{ date: Date.parse(NOW) / 1000 - 86400, totalLiquidityUSD: 3e10 }] }, NOW);
  assert.ok(history.observations.every((item) => item.scope === "protocol"));
});

test("4, 6. chain-scoped TVL is a distinct scope and can never feed a protocol or token metric", () => {
  assert.equal(hasCompatibleScope({ provider_id: "defillama", scope: "chain" }), false);
  assert.equal(hasCompatibleScope({ provider_id: "defillama", scope: "protocol" }), true);
  assert.equal(hasCompatibleScope({ provider_id: "defillama", scope: null }), true, "rows stored before scope keep their provider's scope");
  const btc = tokenCoverage(byId("bitcoin-btc")).find((item) => item.provider === "defillama");
  assert.equal(btc.status, "unavailable");
  assert.match(btc.detail, /chain-level TVL is not BTC token data and is not used/);
});

// ---- 5, 15: calculated metrics enforce source scopes ----

function obs(id, provider, metric, value, scope) {
  return { id, token_id: "aave-aave", chain_id: "ethereum", metric_id: metric, provider_id: provider, raw_record_id: null, value, status: "available", observed_at: NOW, collected_at: NOW, source_field: metric, note: null, scope };
}
const aaveToken = { id: "aave-aave", chain_id: "ethereum", name: "Aave", symbol: "AAVE" };
const capToTvl = (rows) => calculateTokenMetrics(aaveToken, rows, [], NOW).find((row) => row.metric_id === "market_cap_to_tvl");

test("5, 15. protocol TVL feeds only the protocol-association ratio; incompatible scopes are rejected", () => {
  const good = capToTvl([obs(1, "coingecko", "market_cap_usd", 2e9, "token"), obs(2, "defillama", "tvl_usd", 1e9, "protocol")]);
  assert.equal(good.status, "available");
  assert.equal(good.metric_name, "Market cap / associated protocol TVL");
  assert.equal(good.provenance.source_scopes, "token/protocol");
  assert.ok(good.provenance.sources.every((source) => source.scope));
  for (const badScope of ["chain", "token"]) {
    const bad = capToTvl([obs(1, "coingecko", "market_cap_usd", 2e9, "token"), obs(2, "defillama", "tvl_usd", 1e9, badScope)]);
    assert.equal(bad.status, "unavailable", `${badScope}-scoped TVL is rejected`);
    assert.equal(bad.value, null);
  }
  const protocolCap = capToTvl([obs(1, "coingecko", "market_cap_usd", 2e9, "protocol"), obs(2, "defillama", "tvl_usd", 1e9, "protocol")]);
  assert.equal(protocolCap.status, "unavailable", "a protocol-scoped value can never stand in for token market cap");
});

// ---- 7-11: identity, substitution, mapping ----

test("7. WBTC can never populate BTC", () => {
  const btc = tokenCoverage(byId("bitcoin-btc"));
  assert.equal(btc.find((item) => item.provider === "defillama_coins").identifier, "coingecko:bitcoin");
  assert.equal(btc.find((item) => item.provider === "dexpaprika").status, "unavailable");
  assert.equal(dexPoolAssets.some((asset) => asset.tokenId === "bitcoin-btc"), false);
  const wbtc = tokenCoverage(byId("ethereum-wbtc"));
  assert.match(wbtc.find((item) => item.provider === "dexpaprika").identifier, /0x2260fac5e5542a773aa44fbcfedf7c193bc2c599/i);
  assert.notEqual(coingeckoTokenIds["bitcoin-btc"], coingeckoTokenIds["ethereum-wbtc"]);
});

test("8. ETH is never substituted with WETH (nor SOL/BNB/AVAX with their wrappers)", () => {
  for (const native of ["ethereum-eth", "solana-sol", "bnb-bnb", "avalanche-avax"]) {
    const dex = tokenCoverage(byId(native)).find((item) => item.provider === "dexpaprika");
    assert.equal(dex.status, "unavailable");
    assert.equal(dex.reason, "wrapped_representation_only");
    assert.match(dex.detail, /distinct wrapped asset that is not substituted/);
  }
  assert.equal(defillamaCoinsIdentifier(byId("ethereum-eth")), "coingecko:ethereum");
});

test("9. a verified DexPaprika address mapping works by exact network and address", () => {
  const aave = dexPoolAssets.find((asset) => asset.tokenId === "aave-aave");
  const stats = { summary: { liquidity_usd: 1_000_000, pools: 12, "24h": { volume_usd: 50_000, buys: 10, sells: 5, txns: 15 } } };
  const snapshot = buildDexPaprikaSnapshot({ ...aave, externalAssetId: `${aave.network}:${aave.tokenAddress}` }, stats, null, NOW);
  assert.equal(snapshot.observations.find((item) => item.metricId === "liquidity_usd").value, 1_000_000);
  assert.ok(snapshot.observations.every((item) => item.scope === "market"));
  assert.equal(tokenCoverage(byId("aave-aave")).find((item) => item.provider === "dexpaprika").mappingClass, "A_deterministic");
});

test("11. a missing mapping stays unavailable with an explicit reason", () => {
  for (const id of ["bitcoin-btc", "dogecoin-doge", "cardano-ada"]) {
    const dex = tokenCoverage(byId(id)).find((item) => item.provider === "dexpaprika");
    assert.equal(dex.status, "unavailable");
    assert.equal(dex.reason, "native_asset_lacks_provider_identifier");
    assert.ok(dex.detail.length > 20);
  }
});

// ---- 12-13: zeros and timestamps ----

test("12-13. a legitimate zero stays available; token-level prices keep provider timestamps", () => {
  const zero = normalizeCoinsPrice({ tokenId: "ethereum-usdt", chainId: "ethereum", externalAssetId: "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7" }, { price: 0, timestamp: 1790272720, confidence: 0.5 }, NOW);
  assert.equal(zero.observations[0].value, 0);
  assert.equal(zero.observations[0].status, "available");
  assert.equal(zero.observations[0].observedAt, new Date(1790272720 * 1000).toISOString());
  assert.equal(zero.observations[0].collectedAt, NOW);
  const missing = normalizeCoinsPrice({ tokenId: "ethereum-usdt", chainId: "ethereum", externalAssetId: "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7" }, undefined, NOW);
  assert.equal(missing.observations[0].value, null);
  assert.equal(missing.observations[0].status, "unavailable");
});

// ---- 14: AI research context carries scope ----

test("14. the AI research context carries explicit scope on every evidence item", () => {
  const row = (id, provider, metric, value, scope) => ({ id, token_id: "aave-aave", chain_id: "ethereum", provider_id: provider, metric_id: metric, value, status: "available", observed_at: NOW, collected_at: NOW, note: null, scope });
  const context = buildResearchContext({
    now: new Date(NOW),
    token: { id: "aave-aave", name: "Aave", symbol: "AAVE", chainId: "ethereum", chainName: "Ethereum", contractAddress: byId("aave-aave").contractAddress, isNative: false, category: "Lending", description: null },
    latestObservations: [row(1, "coingecko", "price_usd", 300, "token"), row(2, "defillama_coins", "price_usd", 301, "token"), row(3, "defillama", "tvl_usd", 3e10, "protocol"), row(4, "dexpaprika", "liquidity_usd", 1e6, "market")],
    history: [], metricDefinitions: [],
    calculated: [{ id: 9, metric_id: "market_cap_to_tvl", metric_name: "Market cap / associated protocol TVL", unit: "ratio", value: 0.2, status: "available", formula: "x", calculated_at: NOW, period_start_at: NOW, period_end_at: NOW, source_observation_ids: [1, 3], provenance: null }],
    calculatedCategories: { market_cap_to_tvl: "valuation" }, calculatedSourceScopes: { market_cap_to_tvl: "token/protocol" },
    lastSuccess: {}, latestAttempts: {},
  });
  assert.deepEqual(context.observations.map((item) => [item.provider, item.scope]).sort(), [["CoinGecko", "token"], ["DexPaprika", "market"], ["DeFiLlama", "protocol"], ["DeFiLlama (token prices)", "token"]].sort());
  assert.equal(context.calculatedMetrics[0].scope, "calculated");
  assert.equal(context.calculatedMetrics[0].sourceScopes, "token/protocol");
  assert.ok(context.scope.some((item) => item.id === "scope:defillama_coins"));
  assert.ok(context.history.every((series) => ["token", "protocol", "chain", "market"].includes(series.scope)));
});

// ---- 16: availability logic ----

test("16. columns hide only when no displayed row has valid data; zero is data; recomputed after filtering", () => {
  const columns = [{ key: "name", alwaysVisible: true }, { key: "tvl" }, { key: "fees" }, { key: "revenue" }];
  const rows = [{ name: "A", tvl: null, fees: 0, revenue: null }, { name: "B", tvl: 5, fees: null, revenue: null }];
  const all = visibleColumns(columns, rows);
  assert.deepEqual(all.visible.map((column) => column.key), ["name", "tvl", "fees"]);
  assert.deepEqual(all.hidden.map((column) => column.key), ["revenue"]);
  const filtered = visibleColumns(columns, rows.slice(0, 1));
  assert.deepEqual(filtered.visible.map((column) => column.key), ["name", "fees"], "after filtering to A, TVL has no data and is hidden; the zero keeps fees");
});

// ---- Coverage across all 238 canonical tokens ----

test("coverage: every token has an identity or an explicit reason for each provider; no ticker identity; no wrapped proxies", () => {
  const matrix = coverageMatrix();
  assert.equal(matrix.length, 238);
  const reasons = new Set(["provider_does_not_support_token", "native_asset_lacks_provider_identifier", "wrapped_representation_only", "contract_address_unavailable", "requires_paid_access", "token_level_metric_unavailable", "requires_manual_verification", "no_protocol_association", "no_provider_data"]);
  const llamaKeys = new Set();
  for (const { tokenId, symbol, isNative, coverage } of matrix) {
    assert.equal(coverage.length, 4, tokenId);
    for (const item of coverage) {
      if (item.status === "mapped") {
        assert.ok(item.identifier, `${tokenId}/${item.provider} has an identifier`);
        assert.ok(["token", "protocol", "market"].includes(item.scope));
        // Identity comes from explicit provider identifiers, never from the ticker.
        const token = byId(tokenId);
        if (item.provider === "coingecko") assert.equal(item.identifier, coingeckoTokenIds[tokenId]);
        if (item.provider === "defillama_coins") {
          assert.ok(item.identifier === `coingecko:${coingeckoTokenIds[tokenId]}` || (token.contractAddress && item.identifier.endsWith(`:${token.contractAddress}`)), `${tokenId} DeFiLlama key is a documented identifier`);
        }
        if (item.provider === "dexpaprika") {
          const asset = dexPoolAssets.find((entry) => entry.tokenId === tokenId);
          assert.equal(item.identifier, `${asset.network}:${asset.tokenAddress}`);
        }
        assert.notEqual(item.identifier, symbol, `${tokenId}/${item.provider} is not the raw ticker`);
      } else {
        assert.ok(reasons.has(item.reason), `${tokenId}/${item.provider} has a known reason`);
        assert.ok(item.detail, `${tokenId}/${item.provider} explains the gap`);
      }
    }
    const dex = coverage.find((item) => item.provider === "dexpaprika");
    if (isNative && dex.status === "mapped") assert.ok(!WRAPPED_ADDRESSES.has(dex.identifier.split(":").slice(1).join(":").toLowerCase()), `${tokenId} is not mapped to a wrapper`);
    const llama = coverage.find((item) => item.provider === "defillama_coins").identifier;
    assert.ok(!llamaKeys.has(llama), `${tokenId} has a unique DeFiLlama key`);
    llamaKeys.add(llama);
  }
  const count = (provider) => matrix.filter((row) => row.coverage.find((item) => item.provider === provider).status === "mapped").length;
  assert.deepEqual({ coingecko: count("coingecko"), defillama_coins: count("defillama_coins"), defillama: count("defillama"), dexpaprika: count("dexpaprika") }, { coingecko: 238, defillama_coins: 238, defillama: 24, dexpaprika: dexPoolAssets.length });
  assert.equal(onchainTokenMappings.filter((mapping) => mapping.tokenAddress && WRAPPED_ADDRESSES.has(mapping.tokenAddress.toLowerCase())).map((mapping) => mapping.tokenId).join(), "ethereum-wbtc", "only the WBTC record (its own asset) uses a wrapped address");
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
console.log(`${cases.length - failures}/${cases.length} token-centric checks passed.`);
if (failures > 0) process.exitCode = 1;
