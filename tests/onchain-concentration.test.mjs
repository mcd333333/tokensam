import assert from "node:assert/strict";

import { buildConcentrationIndicators } from "../src/lib/indicators/onchain-concentration.ts";

const provenance = { collectedAt: "2026-09-26T07:56:50.000Z", calculatedAt: "2026-09-26T08:00:00.000Z" };
const pool = (overrides = {}) => ({ pairAddress: "0xpool", dexId: "uniswap_v3", liquidityUsd: 1000, ...overrides });

const cases = [];
function test(name, run) {
  cases.push({ name, run });
}

function indicatorsById(pools) {
  const list = buildConcentrationIndicators(pools, provenance);
  return Object.fromEntries(list.map((item) => [item.id, item]));
}

function hhiValue(indicator) {
  return indicator.readings.find((reading) => reading.label === "HHI").value;
}

function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
}

test("evenly distributed liquidity across pools/DEXes yields HHI = 1/n and 'Diversified'", () => {
  // 10 equal pools/DEXes -> HHI = 10 x 0.1^2 = 0.1, well under the 0.15 diversified threshold.
  const pools = Array.from({ length: 10 }, (_, i) => pool({ pairAddress: `0x${i}`, dexId: `dex-${i}`, liquidityUsd: 1000 }));
  const { pool_concentration_hhi, dex_concentration_hhi } = indicatorsById(pools);
  assertClose(hhiValue(pool_concentration_hhi), 0.1, "pool HHI");
  assert.equal(pool_concentration_hhi.state, "Diversified");
  assertClose(hhiValue(dex_concentration_hhi), 0.1, "dex HHI");
  assert.equal(dex_concentration_hhi.state, "Diversified");
  // Percentage reading matches HHI x 100, as requested.
  assertClose(pool_concentration_hhi.readings.find((r) => r.label === "Concentration").value, 10, "percentage reading");
});

test("four evenly split pools sit exactly at the moderate/highly-concentrated boundary (HHI = 0.25)", () => {
  const pools = [
    pool({ pairAddress: "0xa", dexId: "uniswap_v3", liquidityUsd: 1000 }),
    pool({ pairAddress: "0xb", dexId: "sushiswap", liquidityUsd: 1000 }),
    pool({ pairAddress: "0xc", dexId: "curve", liquidityUsd: 1000 }),
    pool({ pairAddress: "0xd", dexId: "balancer", liquidityUsd: 1000 }),
  ];
  const { pool_concentration_hhi } = indicatorsById(pools);
  assert.equal(hhiValue(pool_concentration_hhi), 0.25);
  assert.equal(pool_concentration_hhi.state, "Highly concentrated");
});

test("highly concentrated liquidity (one dominant pool) yields HHI close to 1 and 'Highly concentrated'", () => {
  const pools = [
    pool({ pairAddress: "0xbig", dexId: "uniswap_v3", liquidityUsd: 990_000 }),
    pool({ pairAddress: "0xsmall1", dexId: "sushiswap", liquidityUsd: 5_000 }),
    pool({ pairAddress: "0xsmall2", dexId: "curve", liquidityUsd: 5_000 }),
  ];
  const { pool_concentration_hhi } = indicatorsById(pools);
  const hhi = hhiValue(pool_concentration_hhi);
  assert.ok(hhi > 0.95, `expected near-1 HHI, got ${hhi}`);
  assert.equal(pool_concentration_hhi.state, "Highly concentrated");
});

test("a single pool is a valid degenerate case: HHI = 1, not an error", () => {
  const pools = [pool({ pairAddress: "0xonly", dexId: "uniswap_v3", liquidityUsd: 42 })];
  const { pool_concentration_hhi, dex_concentration_hhi } = indicatorsById(pools);
  assert.equal(hhiValue(pool_concentration_hhi), 1);
  assert.equal(hhiValue(dex_concentration_hhi), 1);
  assert.equal(pool_concentration_hhi.periodLabel, "1 pool with valid liquidity");
  assert.equal(dex_concentration_hhi.periodLabel, "1 exchange with valid liquidity");
});

test("multiple pools on the same DEX are aggregated before computing DEX concentration", () => {
  const pools = [
    pool({ pairAddress: "0xa", dexId: "uniswap_v3", liquidityUsd: 500 }),
    pool({ pairAddress: "0xb", dexId: "uniswap_v3", liquidityUsd: 500 }),
    pool({ pairAddress: "0xc", dexId: "sushiswap", liquidityUsd: 1000 }),
  ];
  const { pool_concentration_hhi, dex_concentration_hhi } = indicatorsById(pools);
  // Pool-level: three equal pools of 500/500/1000 -> shares 0.25, 0.25, 0.5.
  assert.equal(hhiValue(pool_concentration_hhi), 0.25 ** 2 + 0.25 ** 2 + 0.5 ** 2);
  // DEX-level: uniswap_v3 aggregates to 1000, sushiswap is 1000 -> even split, HHI = 0.5.
  assert.equal(hhiValue(dex_concentration_hhi), 0.5);
  assert.equal(dex_concentration_hhi.periodLabel, "2 exchanges with valid liquidity");
});

test("null and non-positive liquidity is excluded, never treated as zero", () => {
  const pools = [
    pool({ pairAddress: "0xa", dexId: "uniswap_v3", liquidityUsd: 1000 }),
    pool({ pairAddress: "0xb", dexId: "sushiswap", liquidityUsd: null }),
    pool({ pairAddress: "0xc", dexId: "curve", liquidityUsd: 0 }),
    pool({ pairAddress: "0xd", dexId: "balancer", liquidityUsd: -5 }),
  ];
  const { pool_concentration_hhi, dex_concentration_hhi } = indicatorsById(pools);
  // Only 0xa is eligible, so both indicators collapse to the single-pool/single-DEX case.
  assert.equal(hhiValue(pool_concentration_hhi), 1);
  assert.equal(hhiValue(dex_concentration_hhi), 1);
  assert.equal(pool_concentration_hhi.periodLabel, "1 pool with valid liquidity");
});

test("no valid pools yields no indicators at all (never NaN, Infinity, or a fabricated zero)", () => {
  assert.deepEqual(buildConcentrationIndicators([], provenance), []);
  assert.deepEqual(buildConcentrationIndicators([pool({ liquidityUsd: null })], provenance), []);
  assert.deepEqual(buildConcentrationIndicators([pool({ liquidityUsd: 0 })], provenance), []);
  assert.deepEqual(buildConcentrationIndicators([pool({ liquidityUsd: Number.NaN })], provenance), []);
});

test("a duplicate pool record (same address) is not double-counted", () => {
  const pools = [
    pool({ pairAddress: "0xSAME", dexId: "uniswap_v3", liquidityUsd: 1000 }),
    pool({ pairAddress: "0xsame", dexId: "uniswap_v3", liquidityUsd: 1000 }), // same pool, different case
    pool({ pairAddress: "0xother", dexId: "sushiswap", liquidityUsd: 1000 }),
  ];
  const { pool_concentration_hhi } = indicatorsById(pools);
  // If deduped correctly: two distinct pools, even split -> HHI = 0.5. If double-counted, it would not be 0.5.
  assert.equal(pool_concentration_hhi.periodLabel, "2 pools with valid liquidity");
  assert.equal(hhiValue(pool_concentration_hhi), 0.5);
});

test("a pool with no dexId is excluded from DEX concentration but still counts for pool concentration", () => {
  const pools = [
    pool({ pairAddress: "0xa", dexId: "uniswap_v3", liquidityUsd: 1000 }),
    pool({ pairAddress: "0xb", dexId: null, liquidityUsd: 1000 }),
  ];
  const { pool_concentration_hhi, dex_concentration_hhi } = indicatorsById(pools);
  assert.equal(pool_concentration_hhi.periodLabel, "2 pools with valid liquidity");
  assert.equal(hhiValue(pool_concentration_hhi), 0.5);
  // Only one attributable DEX remains, so DEX concentration is the single-exchange degenerate case.
  assert.equal(dex_concentration_hhi.periodLabel, "1 exchange with valid liquidity");
  assert.equal(hhiValue(dex_concentration_hhi), 1);
});

test("provenance names DexPaprika as the backend provider and uses the snapshot's own collection time", () => {
  const { pool_concentration_hhi } = indicatorsById([pool()]);
  assert.deepEqual(pool_concentration_hhi.provenance.providers, ["dexpaprika"]);
  assert.equal(pool_concentration_hhi.provenance.observationStart, provenance.collectedAt);
  assert.equal(pool_concentration_hhi.provenance.observationEnd, provenance.collectedAt);
  assert.equal(pool_concentration_hhi.provenance.calculatedAt, provenance.calculatedAt);
  assert.equal(pool_concentration_hhi.category, "on_chain");
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
console.log(`${cases.length - failures}/${cases.length} on-chain concentration checks passed.`);
if (failures > 0) process.exitCode = 1;
