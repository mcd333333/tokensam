// Phase 16 (100 -> 238 tokens): every newly added token must resolve through
// /tokens/[id] via getLiveTokenProfile(), exactly like the original 100, with
// no special-casing. This exercises representative tokens across chains and
// categories (natives and non-natives, with and without market data) against
// an in-memory Supabase stand-in. No network.

import assert from "node:assert/strict";

import { canonicalTokens, phase16CanonicalTokens } from "../src/data/canonical-tokens.ts";
import { coingeckoTokenIds } from "../src/data/coingecko-token-mappings.ts";
import { getLiveTokenProfile } from "../src/lib/data/live-data.ts";
import { buildProfileModel } from "../src/lib/ui/profile-model.ts";
import { buildProfilePayload } from "../src/lib/analysis/profile-payload.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const byId = (id) => canonicalTokens.find((token) => token.id === id);
const dbToken = (token) => ({
  id: token.id, name: token.name, symbol: token.symbol, chain_id: token.chainId,
  contract_address: token.contractAddress, is_native: token.isNative, category: token.category, description: token.identityNote,
});
const profileFor = (tokenId, extraSeed = {}) => {
  const token = byId(tokenId);
  const client = createFakeSupabase({ seed: { tokens: [dbToken(token)], chains: [{ id: token.chainId, name: token.chainName }], ...extraSeed } }).client;
  return getLiveTokenProfile(tokenId, client);
};

test("1. a Phase 16 token with no stored observations yet still resolves (never a 404) with unavailable market data", async () => {
  // A freshly-added token before its first CoinGecko collection run: the tokens/chains rows exist
  // (upserted by prepareDatabase in run-coingecko-collection.ts), but no observations yet.
  const profile = await profileFor("fantom-ftm");
  assert.ok(profile, "the profile resolves instead of the page calling notFound()");
  assert.equal(profile.token.id, "fantom-ftm");
  assert.equal(profile.token.priceUsd, null, "no fabricated price before the first collection");
  assert.equal(profile.isNative, true);
  assert.equal(profile.contractAddress, null);
  assert.equal(profile.coverage.find((item) => item.provider === "coingecko").status, "mapped");
  assert.equal(profile.coverage.find((item) => item.provider === "dexpaprika").status, "unavailable");
});

test("2. a Phase 16 token with a stored CoinGecko observation shows real, non-fabricated market data", async () => {
  // ethereum-stg has no Binance mapping (see binance-token-mappings.ts), so the live Binance
  // read in getLiveTokenProfile contributes nothing here and the stored CoinGecko value is what
  // the profile reports -- a token with a Binance mapping would legitimately prefer that live
  // price over this stored one, which is exactly the live-fetch architecture working as intended.
  const observedAt = "2026-09-26T00:00:00.000Z";
  const profile = await profileFor("ethereum-stg", {
    token_metric_observations: [
      { id: 1, token_id: "ethereum-stg", chain_id: "ethereum", metric_id: "price_usd", provider_id: "coingecko", value: 1.23, status: "available", observed_at: observedAt, collected_at: observedAt, source_field: "current_price", note: null },
    ],
  });
  assert.ok(profile);
  assert.equal(profile.token.priceUsd, 1.23);
  assert.equal(profile.token.symbol, "STG");
  assert.equal(profile.isNative, false);
});

test("3. representative Phase 16 tokens across distinct chains and categories all resolve identically to the original 100", async () => {
  const representative = ["fantom-ftm", "berachain-bera", "ethereum-snx", "solana-mnde", "bnb-chain-xvs", "ton-not", "polygon-ghst", "arbitrum-magic", "linea-linea"];
  for (const tokenId of representative) {
    const token = byId(tokenId);
    assert.ok(token, `${tokenId} is a real canonical token`);
    const profile = await profileFor(tokenId);
    assert.ok(profile, `${tokenId} resolves via getLiveTokenProfile`);
    assert.equal(profile.token.id, tokenId);
    assert.equal(profile.token.chain, token.chainName);
    assert.equal(profile.token.category, token.category);
  }
  const chains = new Set(representative.map((id) => byId(id).chainId));
  assert.equal(chains.size, representative.length, "each representative token is on a distinct chain");
});

test("4. an unknown token id still resolves to null (real 404), proving Phase 16 tokens are not special-cased", async () => {
  const client = createFakeSupabase({ seed: { tokens: [], chains: [] } }).client;
  const profile = await getLiveTokenProfile("not-a-real-token-id", client);
  assert.equal(profile, null);
});

test("6. Phase 16 tokens with no DexPaprika mapping never fabricate market-structure data (UI and AI evidence)", async () => {
  const unmapped = ["fantom-ftm", "ethereum-snx", "solana-mnde", "kucoin-kcs"];
  for (const tokenId of unmapped) {
    const data = await profileFor(tokenId);
    assert.ok(data, `${tokenId} resolves`);
    assert.equal(data.dexMapped, false, `${tokenId} has no DexPaprika mapping`);
    assert.equal(data.dexActivity.transactions24h, null, `${tokenId}: no fabricated transaction count`);
    assert.equal(data.dexActivity.buys24h, null);
    assert.equal(data.dexActivity.sells24h, null);
    assert.equal(data.coverage.find((item) => item.provider === "dexpaprika").status, "unavailable");

    const model = buildProfileModel(data);
    assert.equal(model.marketStructure.available, false, `${tokenId}: Market Structure section is hidden rather than showing fabricated zeros`);
    assert.ok(model.marketStructure.note.reason, `${tokenId}: the hidden section still explains why`);
    assert.ok(!model.sections.some((section) => section.id === "market-structure"), `${tokenId}: no Market Structure nav entry is shown`);

    // The canonical evidence payload the AI reads must not invent DEX/market-structure fields either.
    const payload = buildProfilePayload(data);
    const dexFields = payload.fields.filter((field) => /dex/i.test(field.id));
    assert.ok(dexFields.every((field) => field.value === null || field.value === undefined), `${tokenId}: any DEX-scoped evidence field stays unavailable, never a fabricated value`);
  }
});

test("5. every Phase 16 token has the identity fields the profile page and AI evidence contract require", () => {
  for (const token of phase16CanonicalTokens) {
    assert.ok(token.id && token.name && token.symbol && token.chainId && token.chainName && token.category, `${token.id} has all required identity fields`);
    assert.ok(coingeckoTokenIds[token.id], `${token.id} has a CoinGecko mapping so the AI router and dashboard can use it automatically`);
  }
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
console.log(`${cases.length - failures}/${cases.length} Phase 16 token-profile checks passed.`);
if (failures > 0) process.exitCode = 1;
