import assert from "node:assert/strict";

import { createFakeSupabase } from "./support/fake-supabase.mjs";
import { readLatestObservations, readObservationWindow } from "../src/lib/data/observation-reads.ts";

const cases = [];
function test(name, run) {
  cases.push({ name, run });
}

/**
 * These cover the keyset (seek) paging that replaced OFFSET paging in
 * observation-reads.ts. OFFSET made the metrics engine's 14-day coingecko
 * price_usd read cost O(n^2/page) and exceed PostgREST's statement timeout in
 * production. The paging loop is the risky part of that change: it must return
 * every row, never skip or duplicate across page boundaries, and terminate.
 */
const PAGE_SIZE = 1000;

function observation(id, tokenId, providerId, metricId, observedAt) {
  return {
    id,
    token_id: tokenId,
    chain_id: "chain-a",
    metric_id: metricId,
    provider_id: providerId,
    raw_record_id: null,
    value: id,
    status: "available",
    observed_at: observedAt,
    collected_at: observedAt,
    window_days: null,
    source_field: metricId,
    note: null,
    excluded_reason: null,
  };
}

/** Rows spanning several pages, with ids deliberately non-contiguous. */
function seedRows(count) {
  const base = Date.parse("2026-10-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => observation(
    // Gaps in the id sequence: a seek of "id > last" must not assume id == offset.
    (index + 1) * 3,
    `token-${index % 7}`,
    "coingecko",
    "price_usd",
    new Date(base + index * 60_000).toISOString(),
  ));
}

test("readObservationWindow returns every row across multiple keyset pages", async () => {
  const count = PAGE_SIZE * 2 + 137; // two full pages plus a partial one
  const rows = seedRows(count);
  const db = createFakeSupabase({ seed: { token_metric_observations: rows } });

  const read = await readObservationWindow(
    db.client,
    [...new Set(rows.map((row) => row.token_id))],
    [{ providerId: "coingecko", metricId: "price_usd" }],
    new Date("2026-09-01T00:00:00.000Z"),
  );

  assert.equal(read.length, count, "every row must come back");
  const ids = read.map((row) => row.id);
  assert.equal(new Set(ids).size, count, "no row may be returned twice across page boundaries");
  assert.deepEqual([...ids].sort((a, b) => a - b), rows.map((row) => row.id), "no row may be skipped");
});

test("readObservationWindow stops at the cutoff and does not loop forever", async () => {
  const rows = seedRows(PAGE_SIZE + 10);
  const db = createFakeSupabase({ seed: { token_metric_observations: rows } });

  // A cutoff past every seeded row: the first page comes back empty and paging ends.
  const none = await readObservationWindow(
    db.client,
    ["token-0"],
    [{ providerId: "coingecko", metricId: "price_usd" }],
    new Date("2027-01-01T00:00:00.000Z"),
  );
  assert.deepEqual(none, []);

  // An exact page-size result set must also terminate rather than spin on a full page.
  const exact = createFakeSupabase({ seed: { token_metric_observations: seedRows(PAGE_SIZE) } });
  const all = await readObservationWindow(
    exact.client,
    [...new Set(seedRows(PAGE_SIZE).map((row) => row.token_id))],
    [{ providerId: "coingecko", metricId: "price_usd" }],
    new Date("2026-09-01T00:00:00.000Z"),
  );
  assert.equal(all.length, PAGE_SIZE);
});

test("rows sharing one observed_at are not skipped or duplicated across page boundaries", async () => {
  // Production shape: a provider writes ONE observed_at across every token in a batch
  // (182 rows share a timestamp on this deployment). The cursor is inclusive (>=) because
  // an exclusive seek would drop the rest of a boundary group, so the overlap it creates
  // has to be removed by id. Group size here is chosen so groups straddle page edges.
  const GROUP = 182;
  const groups = 14; // 2548 rows: boundaries land mid-group, not on a page edge
  const base = Date.parse("2026-10-01T00:00:00.000Z");
  const rows = [];
  let id = 1;
  for (let g = 0; g < groups; g += 1) {
    const observedAt = new Date(base + g * 900_000).toISOString();
    for (let t = 0; t < GROUP; t += 1) {
      rows.push(observation(id++, `token-${t}`, "coingecko", "price_usd", observedAt));
    }
  }
  const db = createFakeSupabase({ seed: { token_metric_observations: rows } });

  const read = await readObservationWindow(
    db.client,
    [...new Set(rows.map((row) => row.token_id))],
    [{ providerId: "coingecko", metricId: "price_usd" }],
    new Date("2026-09-01T00:00:00.000Z"),
  );

  assert.equal(read.length, rows.length, "every row across every timestamp group must come back");
  assert.equal(new Set(read.map((row) => row.id)).size, rows.length, "the inclusive cursor must not duplicate the boundary group");
  assert.deepEqual(
    read.map((row) => row.id).sort((a, b) => a - b),
    rows.map((row) => row.id),
    "no row may be skipped at a group that straddles a page boundary",
  );
});

test("a timestamp group larger than one page throws instead of looping forever", async () => {
  // The seek is only safe while PAGE_SIZE exceeds the rows sharing one observed_at.
  // If the token universe ever grew past a page, the cursor could not advance.
  const sameTime = "2026-10-01T00:00:00.000Z";
  const rows = Array.from({ length: PAGE_SIZE + 50 }, (_, index) =>
    observation(index + 1, `token-${index}`, "coingecko", "price_usd", sameTime));
  const db = createFakeSupabase({ seed: { token_metric_observations: rows } });

  await assert.rejects(
    readObservationWindow(
      db.client,
      rows.map((row) => row.token_id),
      [{ providerId: "coingecko", metricId: "price_usd" }],
      new Date("2026-09-01T00:00:00.000Z"),
    ),
    /share observed_at/,
    "must fail loudly rather than spin",
  );
});

test("a provider or metric outside the requested series is never returned", async () => {
  const rows = [
    ...seedRows(5),
    observation(9001, "token-0", "binance", "price_usd", "2026-10-01T00:00:00.000Z"),
    observation(9002, "token-0", "coingecko", "market_cap_usd", "2026-10-01T00:00:00.000Z"),
  ];
  const db = createFakeSupabase({ seed: { token_metric_observations: rows } });

  const read = await readObservationWindow(
    db.client,
    ["token-0"],
    [{ providerId: "coingecko", metricId: "price_usd" }],
    new Date("2026-09-01T00:00:00.000Z"),
  );
  for (const row of read) {
    assert.equal(row.provider_id, "coingecko");
    assert.equal(row.metric_id, "price_usd");
  }
});

test("readLatestObservations still collapses to the newest row per token/provider/metric", async () => {
  // Row order from the database is now id order, not newest-first, so the
  // newest-per-metric collapse must come from latestPerMetric rather than the query.
  // Relative to now, NOT fixed dates: readLatestObservations only reads a 6-hour window
  // (LATEST_READ_WINDOW_MS), so fixed timestamps silently fall out of range as wall-clock
  // time passes and the test starts returning nothing.
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const rows = [
    observation(1, "token-a", "coingecko", "price_usd", minutesAgo(180)),
    observation(2, "token-a", "coingecko", "price_usd", minutesAgo(60)),
    observation(3, "token-a", "coingecko", "price_usd", minutesAgo(120)),
  ];
  const db = createFakeSupabase({ seed: { token_metric_observations: rows }, views: false });

  const read = await readLatestObservations(db.client, ["token-a"]);
  const prices = read.filter((row) => row.metric_id === "price_usd");
  assert.equal(prices.length, 1, "one row per token/provider/metric");
  assert.ok(Math.abs(Date.parse(prices[0].observed_at) - Date.parse(minutesAgo(60))) < 5_000, "the newest observation wins, not the highest id");
});

// ---- dashboard_latest_observations RPC path (see its migration) ----

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const DISPLAYED = ["price_usd", "volume_24h_usd"];

function latestFixture() {
  return [
    observation(1, "token-a", "coingecko", "price_usd", minutesAgo(180)),
    observation(2, "token-a", "coingecko", "price_usd", minutesAgo(60)),
    observation(3, "token-a", "coingecko", "price_usd", minutesAgo(120)),
    observation(4, "token-a", "binance", "price_usd", minutesAgo(5)),
    observation(5, "token-b", "coingecko", "volume_24h_usd", minutesAgo(30)),
    observation(6, "token-b", "coingecko", "market_cap_usd", minutesAgo(30)), // not a displayed metric
  ];
}

/** Stands in for the SQL function: newest row per token/provider/metric in the window, displayed metrics only. */
function fakeLatestRpc(rows, seen) {
  return (name, params) => {
    // recordApproxRead also calls client.rpc("record_quota_usage"); only the latest-read function is under test.
    if (name !== "dashboard_latest_observations") return Promise.resolve({ data: null, error: null });
    seen.push({ name, params });
    const newest = new Map();
    for (const row of rows) {
      if (!params.p_token_ids.includes(row.token_id) || !params.p_providers.includes(row.provider_id) || !params.p_metrics.includes(row.metric_id)) continue;
      if (row.observed_at < params.p_since) continue;
      const key = `${row.token_id}|${row.provider_id}|${row.metric_id}`;
      const held = newest.get(key);
      if (!held || row.observed_at > held.observed_at) newest.set(key, row);
    }
    const data = [...newest.values()];
    const response = Promise.resolve({ data, error: null });
    response.range = (from, to) => Promise.resolve({ data: data.slice(from, to + 1), error: null });
    return response;
  };
}

test("RPC path returns the same rows as the paged read for the displayed metrics", async () => {
  const rows = latestFixture();
  const paged = createFakeSupabase({ seed: { token_metric_observations: rows }, views: false });
  const viaRpc = createFakeSupabase({ seed: { token_metric_observations: rows }, views: false });
  const seen = [];
  viaRpc.client.rpc = fakeLatestRpc(rows, seen);

  const expected = (await readLatestObservations(paged.client, ["token-a", "token-b"]))
    .filter((row) => DISPLAYED.includes(row.metric_id)).map((row) => row.id).sort((a, b) => a - b);
  // Today's CoinGecko snapshot rows (market cap etc.) are still read separately, as before; live-data's
  // readLatest filters to the displayed metrics afterwards, which is what is compared here.
  const actual = (await readLatestObservations(viaRpc.client, ["token-a", "token-b"], { metricIds: DISPLAYED }))
    .filter((row) => DISPLAYED.includes(row.metric_id)).map((row) => row.id).sort((a, b) => a - b);

  assert.deepEqual(actual, expected);
  assert.deepEqual(actual, [2, 4, 5], "newest per key, not the highest id");
  assert.equal(seen.length, 1, "one RPC call for a batch of tokens");
  assert.equal(seen[0].name, "dashboard_latest_observations");
  assert.deepEqual(seen[0].params.p_metrics, DISPLAYED);
});

test("RPC path falls back to the paged read when the function errors", async () => {
  const rows = latestFixture();
  const db = createFakeSupabase({ seed: { token_metric_observations: rows }, views: false });
  db.client.rpc = () => {
    const response = Promise.resolve({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    response.range = () => response;
    return response;
  };

  const read = await readLatestObservations(db.client, ["token-a", "token-b"], { metricIds: DISPLAYED });
  assert.deepEqual(read.filter((row) => DISPLAYED.includes(row.metric_id)).map((row) => row.id).sort((a, b) => a - b), [2, 4, 5]);
});

test("without metricIds the RPC is never used, so other callers keep every metric", async () => {
  const rows = latestFixture();
  const db = createFakeSupabase({ seed: { token_metric_observations: rows }, views: false });
  const seen = [];
  db.client.rpc = fakeLatestRpc(rows, seen);

  const read = await readLatestObservations(db.client, ["token-a", "token-b"]);
  assert.equal(seen.length, 0);
  assert.ok(read.some((row) => row.metric_id === "market_cap_usd"), "non-displayed metrics are still returned");
});

test("RPC path pages past PostgREST's 1,000-row response cap instead of truncating", async () => {
  const metrics = Array.from({ length: 1_500 }, (_, index) => `metric-${index}`);
  const rows = metrics.map((metric, index) => observation(index + 1, "token-a", "coingecko", metric, minutesAgo(10)));
  const db = createFakeSupabase({ seed: { token_metric_observations: [] }, views: false });
  db.client.rpc = fakeLatestRpc(rows, []);

  const read = await readLatestObservations(db.client, ["token-a"], { metricIds: metrics });
  assert.equal(read.length, 1_500);
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

console.log(`${cases.length - failures}/${cases.length} observation-read checks passed.`);
if (failures > 0) process.exitCode = 1;
