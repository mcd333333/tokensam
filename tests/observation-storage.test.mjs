import assert from "node:assert/strict";
import { createFakeSupabase } from "./support/fake-supabase.mjs";
import { observationRead, RESOLVED_OBSERVATIONS } from "../src/lib/data/observation-storage.ts";
import { readObservationWindow } from "../src/lib/data/observation-reads.ts";
import { buildTokenHistory } from "../src/lib/data/live-data.ts";
import { riskProfile } from "../src/lib/data/historical-series.ts";

const cases = [];
const test = (name, run) => cases.push({ name, run });
const NOW = new Date("2026-10-13T06:00:00Z");
const metadata = { id: 7, note: "Provider provenance", source_field: "market_chart.prices", scope: "token", provider_asset_id: null };
const priceRows = Array.from({ length: 200 }, (_, i) => ({
  id: i + 1, token_id: "bnb-chain-cake", chain_id: "bnb-chain", metric_id: "price_usd", provider_id: "coingecko",
  raw_record_id: null, value: 100 + Math.sin(i / 7) * 4, status: "available",
  observed_at: new Date(NOW.getTime() - (199 - i) * 3600000).toISOString(), collected_at: NOW.toISOString(),
  note: metadata.note, source_field: metadata.source_field, scope: metadata.scope, provider_asset_id: metadata.provider_asset_id,
  mapping_id: null, excluded_reason: null,
}));
const original = [...priceRows,
  ...priceRows.map((row, i) => ({ ...row, id: 201 + i, metric_id: "volume_24h_usd", value: i === 0 ? 0 : row.value * 1000 })),
  ...priceRows.map((row, i) => ({ ...row, id: 401 + i, provider_id: "defillama", metric_id: "tvl_usd",
    value: i === 0 ? null : row.value * 100000, scope: "protocol", source_field: "tvl", note: null,
    observed_at: new Date(NOW.getTime() - (199 - i) * 6 * 3600000).toISOString() })),
];
const dictionaries = [metadata, { ...metadata, id: 9, note: null, scope: "protocol", source_field: "tvl" }];
const compact = original.map((row) => ({ ...row, metadata_id: row.provider_id === "defillama" ? 9 : 7,
  note: null, source_field: null, scope: null, provider_asset_id: null }));
const query = (client) => observationRead(client, (table) => client.from(table).select("*").order("id"));

test("compacted and direct history produce identical chart points, risk outputs and provenance", async () => {
  const clients = [original, compact].map((rows) => createFakeSupabase({ seed: {
    token_metric_observations: rows, observation_metadata: dictionaries, token_metric_daily_aggregates: [],
  } }).client);
  const reads = await Promise.all(clients.map((client) => readObservationWindow(client, ["bnb-chain-cake"],
    [{ providerId: "coingecko", metricId: "price_usd" }, { providerId: "coingecko", metricId: "volume_24h_usd" },
      { providerId: "defillama", metricId: "tvl_usd" }], new Date(NOW.getTime() - 37 * 86400000))));
  for (let i = 0; i < reads[0].length; i++) {
    const resolved = { ...reads[1][i] };
    delete resolved.metadata_id;
    assert.deepEqual(resolved, reads[0][i]);
  }
  const histories = reads.map((rows) => buildTokenHistory("bnb-chain-cake", rows, NOW));
  assert.deepEqual(histories[1], histories[0]);
  assert.deepEqual(riskProfile(histories[1].priceUsd.points, "21D", NOW),
    riskProfile(histories[0].priceUsd.points, "21D", NOW));
  const contracts = await Promise.all(clients.map((client) => client.rpc("metrics_series_recent_points", {
    p_token_ids: ["bnb-chain-cake"], p_providers: ["coingecko", "coingecko", "defillama"],
    p_metrics: ["price_usd", "volume_24h_usd", "tvl_usd"], p_now: NOW.toISOString(),
  })));
  const logical = (rows) => rows.map((row) => { const value = { ...row }; delete value.metadata_id; return value; });
  assert.deepEqual(logical(contracts[1].data), logical(contracts[0].data));
});

test("null metadata and unavailable numeric values remain null, never zero or a default", async () => {
  const client = createFakeSupabase({ seed: {
    token_metric_observations: [{ ...compact[0], value: null, status: "unavailable" }],
    observation_metadata: [{ id: 7, note: null, source_field: null, scope: null, provider_asset_id: null }],
  } }).client;
  const { data } = await query(client);
  assert.equal(data[0].value, null);
  for (const field of ["note", "source_field", "scope", "provider_asset_id"]) assert.equal(data[0][field], null);
});

test("pre-migration environments retain the original reader", async () => {
  const client = createFakeSupabase({ views: false, seed: { token_metric_observations: original } }).client;
  assert.equal((await query(client)).data.length, original.length);
});

test("a legacy fallback is not cached across later schema changes", async () => {
  const fake = createFakeSupabase({ views: false, seed: { token_metric_observations: original } });
  await query(fake.client);
  await query(fake.client);
  assert.equal(fake.calls.filter((call) => call.table === RESOLVED_OBSERVATIONS).length, 2);
});

for (const state of [{ enabled: true, compacted_rows: 0 }, { enabled: false, compacted_rows: 1 }]) {
  test(`missing view refuses unsafe fallback (${JSON.stringify(state)})`, async () => {
    const fake = createFakeSupabase({ views: false, seed: {
      observation_metadata_compaction_state: [{ id: true, ...state }], token_metric_observations: compact,
    } });
    await assert.rejects(query(fake.client), /refusing incomplete provenance/);
    assert.ok(!fake.calls.some((call) => call.table === "token_metric_observations"));
  });
}

test("permission errors do not silently fall back to unresolved data", async () => {
  const fake = createFakeSupabase();
  const result = await observationRead(fake.client, (table) => {
    assert.equal(table, RESOLVED_OBSERVATIONS);
    return Promise.resolve({ data: null, error: { code: "42501", message: "denied" } });
  });
  assert.equal(result.error.code, "42501");
  assert.equal(fake.calls.length, 0);
});

let failures = 0;
for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}:`, error); }
}
console.log(`${cases.length - failures}/${cases.length} observation-storage checks passed.`);
if (failures) process.exitCode = 1;
