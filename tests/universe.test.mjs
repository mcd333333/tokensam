import assert from "node:assert/strict";

import { canonicalTokens, additionalCanonicalTokens, phase15CanonicalTokens, phase16CanonicalTokens } from "../src/data/canonical-tokens.ts";
import { coingeckoTokenIds, nativeTokenIds } from "../src/data/coingecko-token-mappings.ts";
import { defillamaProtocolMappings } from "../src/data/defillama-protocol-mappings.ts";
import { onchainTokenMappings } from "../src/data/onchain-token-mappings.ts";
import { dexPoolAssets } from "../src/data/onchain-identity.ts";
import { dexPaprikaNetwork } from "../src/lib/providers/dexpaprika-pools.ts";
import { persistProviderSnapshots } from "../src/lib/providers/persist-snapshots.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

// The verified 50-token baseline (Phase 10). Phase 15 may only append after it.
const BASELINE_50 = [
  "ethereum-eth", "bitcoin-btc", "solana-sol", "bnb-bnb", "xrp-xrp", "avalanche-avax", "arbitrum-arb", "optimism-op", "aave-aave", "uniswap-uni",
  "lido-ldo", "maker-mkr", "chainlink-link", "sui-sui", "aptos-apt", "polygon-pol", "near-near", "celestia-tia", "render-render", "jupiter-jup",
  "ethereum-usdt", "ethereum-usdc", "ethereum-wbtc", "dogecoin-doge", "tron-trx", "cardano-ada", "polkadot-dot", "cosmos-atom", "litecoin-ltc", "stellar-xlm",
  "monero-xmr", "internet-computer-icp", "filecoin-fil", "ethereum-crv", "ethereum-comp", "ethereum-pendle", "ethereum-dai", "ethereum-ena", "ethereum-ondo", "ethereum-shib",
  "ethereum-pepe", "solana-bonk", "solana-ray", "solana-jto", "solana-pyth", "base-aero", "ethereum-morpho", "ethereum-grt", "arweave-ar", "ethereum-mnt",
];

test("the canonical set grows from 50 to 238 with unique chain-scoped identities; the baseline 50 are unchanged", () => {
  assert.equal(canonicalTokens.length, 238);
  assert.equal(additionalCanonicalTokens.length, 30);
  assert.equal(phase15CanonicalTokens.length, 50);
  assert.equal(phase16CanonicalTokens.length, 138);
  assert.deepEqual(canonicalTokens.slice(0, 50).map((token) => token.id), BASELINE_50, "existing canonical IDs are neither removed nor reordered");
  assert.equal(coingeckoTokenIds["maker-mkr"], "sky");
  assert.equal(coingeckoTokenIds["avalanche-avax"], "avalanche-2");
  assert.equal(new Set(canonicalTokens.map((token) => token.id)).size, 238);
  // On-chain identity key: a real contract address, or "chain:native" for the chain's native asset.
  // A non-native token with no curated contract address (Phase 16) makes no on-chain identity claim
  // at all, so it cannot collide with anything and falls back to its already-unique token id.
  const onChainIdentity = (token) => token.contractAddress
    ? `${token.chainId}:${token.contractAddress.toLowerCase()}`
    : token.isNative ? `${token.chainId}:native` : `id:${token.id}`;
  assert.equal(new Set(canonicalTokens.map(onChainIdentity)).size, 238);
  assert.equal(new Set(canonicalTokens.filter((token) => token.isNative).map((token) => token.chainId)).size, canonicalTokens.filter((token) => token.isNative).length);
  assert.ok(canonicalTokens.every((token) => token.id && token.chainId && token.symbol && token.name));
});

test("provider mappings are unique, explicit, chain-consistent, and leave unsupported assets unmapped", () => {
  const ids = new Set(canonicalTokens.map((token) => token.id));
  const coinIds = canonicalTokens.map((token) => coingeckoTokenIds[token.id]);
  assert.equal(coinIds.filter(Boolean).length, 238);
  assert.equal(new Set(coinIds).size, 238);
  assert.equal(new Set(onchainTokenMappings.map((mapping) => mapping.tokenId)).size, 238);
  const dexAssetsByToken = new Map(dexPoolAssets.map((asset) => [asset.tokenId, asset]));
  for (const mapping of onchainTokenMappings) {
    assert.ok(ids.has(mapping.tokenId));
    if (mapping.tokenAddress) {
      assert.ok(mapping.dexChainId);
      // A network DexPaprika does not index (e.g. ICP) stays unqueried; every other mapping is queried by its exact address.
      const asset = dexAssetsByToken.get(mapping.tokenId);
      if (dexPaprikaNetwork(mapping.dexChainId)) assert.equal(asset?.tokenAddress, mapping.tokenAddress);
      else assert.equal(asset, undefined);
    } else {
      assert.ok(mapping.unmappedReason);
    }
  }
  assert.equal(new Set(defillamaProtocolMappings.map((mapping) => mapping.tokenId)).size, defillamaProtocolMappings.length);
  assert.ok(defillamaProtocolMappings.every((mapping) => ids.has(mapping.tokenId) && mapping.externalAssetId && mapping.relationship));
  assert.equal(nativeTokenIds.size, 93);
  assert.ok(canonicalTokens.every((token) => token.isNative === nativeTokenIds.has(token.id)), "native flags agree with the native set");
});

test("Phase 16 (100 -> 238) tokens all carry a verified CoinGecko ID and no fabricated contract/DEX mapping", () => {
  for (const token of phase16CanonicalTokens) {
    assert.ok(coingeckoTokenIds[token.id], `${token.id} has a CoinGecko ID`);
    assert.equal(token.contractAddress, null, `${token.id}: no contract address is invented in this phase`);
    assert.equal(token.isNative, nativeTokenIds.has(token.id));
  }
  const phase16Ids = new Set(phase16CanonicalTokens.map((token) => token.id));
  for (const mapping of onchainTokenMappings.filter((entry) => phase16Ids.has(entry.tokenId))) {
    assert.equal(mapping.tokenAddress, null, `${mapping.tokenId}: no DexPaprika address is invented in this phase`);
    assert.ok(mapping.unmappedReason, `${mapping.tokenId} explains why it is unmapped`);
  }
  assert.equal(new Set(phase16CanonicalTokens.map((token) => coingeckoTokenIds[token.id])).size, phase16CanonicalTokens.length, "no duplicate CoinGecko IDs among the new tokens");
});

test("provider observation persistence is idempotent while raw snapshots remain append-only", async () => {
  const observations = [];
  let nextRawId = 1;
  const client = {
    from(table) {
      if (table === "raw_provider_records") {
        return {
          insert(rows) {
            return {
              select: async () => ({
                data: rows.map((row) => ({ id: nextRawId++, token_id: row.token_id, chain_id: row.chain_id })),
                error: null,
              }),
            };
          },
        };
      }
      if (table === "token_metric_observations") {
        const query = {
          select() { return this; },
          in() { return this; },
          gte() { return this; },
          lte() { return this; },
          gt() { return this; },
          order() { return this; },
          limit: async () => ({ data: observations, error: null }),
          insert: async (rows) => { observations.push(...rows); return { error: null }; },
        };
        return query;
      }
      if (table === "provider_token_mappings") {
        const query = { in: () => query, then: (resolve) => resolve({ data: [], error: null }) };
        return { select: () => query };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };
  const snapshot = {
    providerId: "coingecko",
    endpointLabel: "fixture",
    asset: { tokenId: "ethereum-usdt", chainId: "ethereum", externalAssetId: "tether" },
    observedAt: "2026-09-24T00:00:00.000Z",
    collectedAt: "2026-09-24T00:01:00.000Z",
    rawPayload: { fixture: true },
    observations: [{
      tokenId: "ethereum-usdt", chainId: "ethereum", metricId: "price_usd", value: 1,
      status: "available", observedAt: "2026-09-24T00:00:00.000Z", collectedAt: "2026-09-24T00:01:00.000Z",
      windowDays: null, sourceField: "fixture", note: null,
    }],
  };
  const first = await persistProviderSnapshots(client, [snapshot]);
  const second = await persistProviderSnapshots(client, [snapshot]);
  assert.equal(first.observations, 1);
  assert.equal(second.observations, 0);
  assert.equal(observations.length, 1);
  assert.equal(first.rawRecords, 1);
  assert.equal(second.rawRecords, 1, "each sync preserves its own raw response for provenance");
});

test("large raw provider responses are persisted in bounded payload batches", async () => {
  const rawBatchSizes = [];
  const client = {
    from(table) {
      if (table === "raw_provider_records") {
        return {
          insert(rows) {
            rawBatchSizes.push(rows.length);
            return { select: async () => ({
              data: rows.map((row, index) => ({ id: index + 1, token_id: row.token_id, chain_id: row.chain_id })),
              error: null,
            }) };
          },
        };
      }
      if (table === "token_metric_observations") {
        return {
          select() { return this; },
          in() { return this; },
          gte() { return this; },
          lte() { return this; },
          gt() { return this; },
          order() { return this; },
          limit: async () => ({ data: [], error: null }),
          insert: async () => ({ error: null }),
        };
      }
      if (table === "provider_token_mappings") {
        const query = { in: () => query, then: (resolve) => resolve({ data: [], error: null }) };
        return { select: () => query };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };
  const makeSnapshot = (tokenId, externalAssetId) => ({
    providerId: "defillama",
    endpointLabel: "fixture",
    asset: { tokenId, chainId: "ethereum", externalAssetId },
    observedAt: "2026-09-24T00:00:00.000Z",
    collectedAt: "2026-09-24T00:01:00.000Z",
    rawPayload: { response: "x".repeat(110_000) },
    observations: [{
      tokenId, chainId: "ethereum", metricId: "price_usd", value: 1, status: "available",
      observedAt: "2026-09-24T00:00:00.000Z", collectedAt: "2026-09-24T00:01:00.000Z",
      windowDays: null, sourceField: "fixture", note: null,
    }],
  });
  await persistProviderSnapshots(client, [makeSnapshot("ethereum-one", "one"), makeSnapshot("ethereum-two", "two")]);
  assert.deepEqual(rawBatchSizes, [1, 1]);
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
console.log(`${cases.length - failures}/${cases.length} universe checks passed.`);
if (failures > 0) process.exitCode = 1;
