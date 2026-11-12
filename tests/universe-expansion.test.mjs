import assert from "node:assert/strict";

import { canonicalTokens, phase15CanonicalTokens } from "../src/data/canonical-tokens.ts";
import { coingeckoTokenIds, nativeTokenIds } from "../src/data/coingecko-token-mappings.ts";
import { defillamaProtocolMappings } from "../src/data/defillama-protocol-mappings.ts";
import { onchainTokenMappings } from "../src/data/onchain-token-mappings.ts";
import { tokenCoverage } from "../src/data/provider-coverage.ts";
import { normalizeCoinGeckoMarketItem } from "../src/lib/providers/coingecko.ts";
import { dexPoolAssets } from "../src/data/onchain-identity.ts";
import { calculateTokenMetrics } from "../src/lib/metrics/engine.ts";
import { logosFromRecords, validatedLogoUrl } from "../src/lib/data/token-logos.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const NOW = "2026-09-25T12:00:00.000Z";
const byId = (id) => canonicalTokens.find((token) => token.id === id);
const dexAsset = (id) => dexPoolAssets.find((asset) => asset.tokenId === id);
const protocolFor = (id) => defillamaProtocolMappings.find((mapping) => mapping.tokenId === id);
// Wrapped/proxy representations that must never stand in for a native asset.
const WRAPPED = new Set([
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
  "so11111111111111111111111111111111111111112", // wSOL
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
  "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", // WAVAX
  "0x5555555555555555555555555555555555555555", // WHYPE (HyperEVM)
  "0x039e2fb66102314ce7b64ce5ce3e5183bc94ad38", // wS (Sonic)
  "0x5c7f8a570d578ed84e63fdfa7b1ee72deae1ae23", // WCRO (Cronos)
]);

// ---- Identity ----

test("1. the 50 Phase 15 tokens have explicit, unique CoinGecko IDs and chain-scoped identities", () => {
  assert.equal(phase15CanonicalTokens.length, 50);
  const expected = {
    "ton-gram": "the-open-network", "hyperliquid-hype": "hyperliquid", "dydx-dydx": "dydx-chain", "stacks-stx": "blockstack",
    "cronos-cro": "crypto-com-chain", "ethereum-strk": "starknet", "bnb-chain-cake": "pancakeswap-token", "ethereum-usde": "ethena-usde",
    "solana-wif": "dogwifcoin", "ethereum-eigen": "eigenlayer", "ethereum-wld": "worldcoin-wld", "theta-theta": "theta-token",
  };
  for (const [tokenId, coingeckoId] of Object.entries(expected)) assert.equal(coingeckoTokenIds[tokenId], coingeckoId, tokenId);
  for (const token of phase15CanonicalTokens) {
    assert.ok(coingeckoTokenIds[token.id], `${token.id} has a CoinGecko ID`);
    assert.ok(token.chainId && token.chainName && token.category && token.name && token.symbol && token.identityNote);
    assert.equal(token.isNative, nativeTokenIds.has(token.id));
    if (token.isNative) assert.equal(token.contractAddress, null, `${token.id}: a native asset has no contract address`);
    else assert.match(token.contractAddress ?? "", /^(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/, `${token.id}: contract is a lowercase EVM address or a Solana mint`);
  }
  // Same ticker does not mean same asset: ETC is not ETH, BCH is not BTC.
  assert.notEqual(byId("ethereum-classic-etc").chainId, byId("ethereum-eth").chainId);
  assert.notEqual(coingeckoTokenIds["bitcoin-cash-bch"], coingeckoTokenIds["bitcoin-btc"]);
});

test("2. universe diversity: 106 chains and 23 categories, with no chain holding a native asset twice", () => {
  assert.equal(new Set(canonicalTokens.map((token) => token.chainId)).size, 106);
  assert.equal(new Set(canonicalTokens.map((token) => token.category)).size, 23);
  for (const category of ["Restaking", "RWA", "Privacy", "DePIN", "AI & compute", "Interoperability", "Derivatives", "Gaming", "Exchange token", "Identity"]) {
    assert.ok(canonicalTokens.some((token) => token.category === category), `${category} is represented`);
  }
  const natives = canonicalTokens.filter((token) => token.isNative);
  assert.equal(new Set(natives.map((token) => token.chainId)).size, natives.length);
});

// ---- Native / wrapped separation ----

test("3. natives map to DEX data only through their own-chain identifier; no wrapped representation is used anywhere", () => {
  for (const mapping of onchainTokenMappings) {
    if (mapping.tokenAddress) assert.ok(!WRAPPED.has(mapping.tokenAddress.toLowerCase()) || mapping.tokenId === "ethereum-wbtc", `${mapping.tokenId} does not use a wrapped proxy`);
  }
  const mappedNatives = phase15CanonicalTokens.filter((token) => token.isNative && dexAsset(token.id)).map((token) => token.id).sort();
  assert.deepEqual(mappedNatives, ["hyperliquid-hype", "ton-gram"]);
  for (const token of phase15CanonicalTokens.filter((candidate) => candidate.isNative && !dexAsset(candidate.id))) {
    const coverage = tokenCoverage(token).find((item) => item.provider === "dexpaprika");
    assert.equal(coverage.status, "unavailable");
    assert.match(coverage.detail, /(not|no representation is) substituted|DexPaprika does not cover/, `${token.id} explains the gap without a proxy`);
  }
});

// ---- Provider scope ----

test("4. new protocol mappings are protocol-scoped, pinned to a verified record, and never chain-level", () => {
  const added = ["bnb-chain-cake", "solana-orca", "arbitrum-gmx", "solana-kmno", "ethereum-syrup", "ethereum-ethfi", "dydx-dydx", "hyperliquid-hype", "ethereum-eigen", "ethereum-rpl", "ethereum-cvx", "thorchain-rune", "ethereum-zro"];
  for (const tokenId of added) {
    const mapping = protocolFor(tokenId);
    assert.ok(mapping, `${tokenId} has a protocol mapping`);
    assert.ok(mapping.recordId && mapping.relationship);
    const coverage = tokenCoverage(byId(tokenId)).find((item) => item.provider === "defillama");
    assert.equal(coverage.scope, "protocol");
    assert.match(coverage.detail, /Not token-level data/);
  }
  // Native assets mapped to an exchange protocol say explicitly that it is not chain TVL.
  for (const tokenId of ["hyperliquid-hype", "dydx-dydx", "thorchain-rune"]) assert.match(protocolFor(tokenId).relationship, /not .*chain-level TVL/);
  assert.equal(protocolFor("ethereum-ethfi").externalAssetId, "ether.fi");
  assert.equal(protocolFor("solana-kmno").recordId, "parent#kamino-finance");
  // Reviewed and declined: bridge/module/fee-only records, and stablecoins without a governance relationship.
  for (const tokenId of ["injective-inj", "solana-w", "ethereum-strk", "cronos-cro", "ethereum-imx", "ethereum-sand", "ethereum-ens", "base-virtual", "ethereum-ath", "solana-hnt", "solana-grass", "ethereum-usde", "ethereum-usds", "ethereum-pyusd", "ethereum-eurc", "ton-gram", "bittensor-tao"]) {
    assert.equal(protocolFor(tokenId), undefined, `${tokenId} has no protocol mapping`);
  }
  for (const token of phase15CanonicalTokens) {
    const scopes = Object.fromEntries(tokenCoverage(token).map((item) => [item.provider, item.scope]));
    // Binance is market-scoped: it reports one venue's traded price, not a token-scoped
    // aggregate like CoinGecko's, so it must never be read as a token-scope figure.
    assert.deepEqual(scopes, { coingecko: "token", binance: "market", defillama_coins: "token", defillama: "protocol", dexpaprika: "market" }, token.id);
  }
});

// ---- CoinGecko and logos ----

test("7. CoinGecko market items for new tokens keep missing supply unavailable, not zero", () => {
  const snapshot = normalizeCoinGeckoMarketItem({ tokenId: "sonic-s", chainId: "sonic", externalAssetId: "sonic-3" }, {
    id: "sonic-3", last_updated: NOW, current_price: 0.0404, market_cap: 156_885_180, total_volume: 1e7,
    price_change_percentage_24h: 0, price_change_percentage_7d_in_currency: -3, circulating_supply: 3_885_497_663, total_supply: 3_885_497_663, max_supply: null,
  }, NOW);
  const value = (metricId) => snapshot.observations.find((row) => row.metricId === metricId);
  assert.equal(value("maximum_supply").status, "unavailable");
  assert.equal(value("maximum_supply").value, null);
  assert.equal(value("price_change_24h_pct").value, 0, "a reported zero change stays zero");
  assert.ok(snapshot.observations.every((row) => row.scope === "token"));
});

test("8. logos for new tokens are accepted only for their own CoinGecko ID", () => {
  const url = "https://coin-images.coingecko.com/coins/images/17980/large/ton_symbol.png?1696517498";
  assert.equal(validatedLogoUrl("ton-gram", "the-open-network", url), url);
  assert.equal(validatedLogoUrl("ton-gram", "toncoin", url), null, "a record for a different CoinGecko ID is rejected");
  assert.equal(validatedLogoUrl("ethereum-classic-etc", "ethereum", url), null, "a related chain's logo is not reused");
  const logos = logosFromRecords([
    { token_id: "hyperliquid-hype", collected_at: NOW, endpoint_label: "GET /coins/markets", image: "https://coin-images.coingecko.com/coins/images/50882/large/hyperliquid.jpg", payload_id: "hyperliquid" },
    { token_id: "dydx-dydx", collected_at: NOW, endpoint_label: "GET /coins/markets", image: "https://coin-images.coingecko.com/coins/images/17500/large/dydx.png", payload_id: "dydx" },
  ]);
  assert.ok(logos["hyperliquid-hype"]);
  assert.equal(logos["dydx-dydx"], undefined, "the legacy ethDYDX record (CoinGecko dydx) is not the native dYdX Chain asset (dydx-chain)");
});

test("9. refresh budgets fit the 238-token universe inside the cron route's 300 s limit", async () => {
  const { REFRESH_POLICY, METRICS_TIMEOUT_MS } = await import("../src/lib/refresh/config.ts");
  const { readFileSync } = await import("node:fs");
  const maxDuration = Number(readFileSync("src/app/api/cron/refresh/route.ts", "utf8").match(/maxDuration = (\d+)/)[1]) * 1000;
  const longestProvider = Math.max(...Object.values(REFRESH_POLICY).map((policy) => policy.timeoutMs));
  assert.ok(longestProvider + METRICS_TIMEOUT_MS < maxDuration, "providers run in parallel, then metrics");
  // DeFiLlama current mode: 3 requests per protocol at >= 1.1 s pacing must fit its budget.
  assert.ok(defillamaProtocolMappings.length * 3 * 1_100 < REFRESH_POLICY.defillama.timeoutMs);
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
console.log(`${cases.length - failures}/${cases.length} universe-expansion checks passed.`);
if (failures > 0) process.exitCode = 1;
