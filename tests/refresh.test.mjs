import assert from "node:assert/strict";

import { canonicalTokens } from "../src/data/canonical-tokens.ts";
import { CALCULATED_METRICS } from "../src/lib/metrics/engine.ts";
import { runMetricsCalculation } from "../src/lib/metrics/run-calculation.ts";
import { readLatestObservations } from "../src/lib/data/observation-reads.ts";
import { isAuthorizedRefreshRequest } from "../src/lib/refresh/auth.ts";
import { REFRESH_POLICY } from "../src/lib/refresh/config.ts";
import { buildRefreshStatus, relativeAge } from "../src/lib/refresh/freshness.ts";
import { deadlineSleep, isProviderDue, overallStatus, runDataRefresh } from "../src/lib/refresh/orchestrator.ts";
import { SupabaseRefreshStore } from "../src/lib/refresh/store.ts";
import { CollectorDiagnostics } from "../src/lib/refresh/collector-diagnostics.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

// Tests never read .env.local: set only fake, test-local configuration.
process.env.COINGECKO_API_KEY = "test-coingecko-key-not-real";
process.env.COINGECKO_API_PLAN = "demo";
delete process.env.DEFILLAMA_WRITTEN_PERMISSION_REFERENCE;

const NOW = new Date();
const HOUR = 60 * 60 * 1000;
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const noSleep = async () => {};
const DEX_METRICS = ["price_usd", "volume_24h_usd", "liquidity_usd", "price_change_24h_pct", "transactions_24h_count", "buys_24h_count", "sells_24h_count", "fdv_usd", "market_cap_usd"];
const BTC = canonicalTokens[0];

function baseSeed(extra = {}) {
  return {
    tokens: canonicalTokens.map((token) => ({ id: token.id, name: token.name, symbol: token.symbol, chain_id: token.chainId })),
    metric_definitions: DEX_METRICS.map((id) => ({ id })),
    calculated_metric_definitions: CALCULATED_METRICS.map((metric) => ({ id: metric.id, category: metric.category })),
    provider_pairs: [],
    ...extra,
  };
}

function marketItem(id) {
  return {
    id, last_updated: NOW.toISOString(), current_price: 2, market_cap: 2_000, total_volume: 200,
    price_change_percentage_24h: 1, price_change_percentage_7d_in_currency: 2,
    circulating_supply: 1_000, total_supply: 1_000, max_supply: null,
  };
}

function tickerItem(symbol) {
  return { symbol, lastPrice: "2", priceChangePercent: "1", closeTime: NOW.getTime() };
}

/** Routes provider HTTP calls to fixtures; never touches the network. */
function providerFetch(mode, calls = []) {
  // Binance needs no key and is always enabled, so every scenario gets a working
  // ticker fixture unless it opts into a failure mode explicitly.
  mode = { binance: "ok", ...mode };
  return async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push(url.hostname);
    const behaviour = url.hostname.includes("coingecko") ? mode.coingecko
      : url.hostname.includes("binance") ? mode.binance
      : url.hostname.includes("dexscreener") ? mode.dexscreener : "unexpected";
    if (behaviour === "unexpected") throw new Error(`Unexpected provider host ${url.hostname}`);
    if (behaviour === "error") return new Response("{}", { status: 500 });
    if (behaviour === "hang") {
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    }
    if (url.hostname.includes("coingecko")) return Response.json(url.searchParams.get("ids").split(",").map(marketItem));
    if (url.hostname.includes("binance")) return Response.json(JSON.parse(url.searchParams.get("symbols")).map(tickerItem));
    return Response.json([]); // DEX Screener: mapped tokens with no pools.
  };
}

function previousObservation(id, tokenId, chainId, providerId, metricId, value, observedAt) {
  return { id, token_id: tokenId, chain_id: chainId, provider_id: providerId, metric_id: metricId, raw_record_id: null, value, status: "available", observed_at: observedAt, collected_at: observedAt, window_days: null, source_field: metricId, note: null };
}

test("1-2. a full refresh runs the real collectors, persists observations, then recalculates metrics", async () => {
  const db = createFakeSupabase({ seed: baseSeed() });
  const hosts = [];
  const result = await runDataRefresh(db.client, new SupabaseRefreshStore(db.client), {
    trigger: "scheduled", fetchImpl: providerFetch({ coingecko: "ok", binance: "ok", dexscreener: "ok" }, hosts), sleep: noSleep,
  });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(new Set(result.due), new Set(["coingecko", "dexscreener", "defillama", "defillama_coins"]));
  const byStep = Object.fromEntries(result.steps.map((step) => [step.step, step]));
  assert.equal(byStep.coingecko.status, "succeeded");
  assert.equal(byStep.coingecko.detail.returnedAssets, 238);
  assert.equal(byStep.dexscreener.status, "succeeded");
  assert.equal(byStep.defillama.status, "skipped", "the DeFiLlama written-permission gate is enforced, not bypassed");
  assert.match(byStep.defillama.error, /written permission/i);
  assert.ok(!hosts.some((host) => host.includes("llama")), "no DeFiLlama request without permission");
  assert.equal(byStep.metrics.status, "succeeded");
  assert.equal(result.steps.at(-1).step, "metrics", "metrics run after provider synchronization");

  const coingeckoRows = db.rows("token_metric_observations").filter((row) => row.provider_id === "coingecko");
  assert.equal(coingeckoRows.length, 238 * 8);
  assert.equal(db.rows("raw_provider_records").filter((row) => row.provider_id === "coingecko").length, 238);
  assert.ok(db.rows("calculated_metric_observations").length > 0);

  const run = db.rows("data_refresh_runs")[0];
  assert.equal(run.status, "succeeded");
  assert.ok(run.finished_at, "the lock is released when the run finishes");
  assert.equal(byStep.defillama_coins.status, "skipped", "token-level DeFiLlama prices share the written-permission gate");
  assert.equal(db.rows("data_refresh_steps").length, 5);
});

test("6. unavailable provider values and metrics stay null, never zero", async () => {
  const db = createFakeSupabase({ seed: baseSeed() });
  await runDataRefresh(db.client, new SupabaseRefreshStore(db.client), {
    trigger: "manual", fetchImpl: providerFetch({ coingecko: "ok", dexscreener: "ok" }), sleep: noSleep,
  });
  const dexRows = db.rows("token_metric_observations").filter((row) => row.provider_id === "dexscreener");
  assert.ok(dexRows.length > 0);
  assert.ok(dexRows.every((row) => row.status === "unavailable" && row.value === null), "no pools means unavailable, not zero");
  const maxSupply = db.rows("token_metric_observations").filter((row) => row.metric_id === "maximum_supply");
  assert.ok(maxSupply.every((row) => row.value === null && row.status === "unavailable"));
  const calculated = db.rows("calculated_metric_observations");
  const dexDerived = calculated.filter((row) => row.metric_id === "fdv_to_tvl" || row.metric_id === "dex_volume_to_liquidity");
  assert.ok(dexDerived.length > 0);
  assert.ok(dexDerived.every((row) => row.value === null && row.status !== "available"));
  assert.ok(calculated.every((row) => row.status === "available" ? row.value !== null : row.value === null));
});

test("3-4. a failed provider is isolated: its previous observations survive and the run is partial", async () => {
  const previous = [
    previousObservation(1, BTC.id, BTC.chainId, "coingecko", "market_cap_usd", 1_000_000, ago(2 * HOUR)),
    previousObservation(2, BTC.id, BTC.chainId, "coingecko", "volume_24h_usd", 50_000, ago(2 * HOUR)),
    previousObservation(3, BTC.id, BTC.chainId, "coingecko", "price_usd", 60_000, ago(2 * HOUR)),
  ];
  const db = createFakeSupabase({ seed: baseSeed({ token_metric_observations: previous }) });
  const result = await runDataRefresh(db.client, new SupabaseRefreshStore(db.client), {
    trigger: "scheduled", fetchImpl: providerFetch({ coingecko: "error", dexscreener: "ok" }), sleep: noSleep,
  });

  assert.equal(result.status, "partial");
  const coingecko = result.steps.find((step) => step.step === "coingecko");
  assert.equal(coingecko.status, "failed");
  assert.match(coingecko.error, /HTTP 500/);
  assert.ok(!coingecko.error.includes(process.env.COINGECKO_API_KEY), "errors never contain the API key");

  const coingeckoRows = db.rows("token_metric_observations").filter((row) => row.provider_id === "coingecko");
  assert.deepEqual(coingeckoRows, previous, "previous CoinGecko observations are untouched; nothing replaces them");
  assert.equal(db.rows("raw_provider_records").filter((row) => row.provider_id === "coingecko").length, 0);

  // Metrics still ran on the other provider's success and used the last good CoinGecko values.
  assert.equal(result.steps.find((step) => step.step === "metrics").status, "succeeded");
  const volumeToCap = db.rows("calculated_metric_observations").find((row) => row.token_id === BTC.id && row.metric_id === "volume_to_market_cap");
  assert.equal(volumeToCap.status, "available");
  assert.equal(Number(volumeToCap.value), 0.05);
});

test("3-4. when every provider fails, metrics are skipped and stored results are unchanged", async () => {
  const calculated = [{ id: 1, token_id: BTC.id, chain_id: BTC.chainId, metric_id: "volume_to_market_cap", value: 0.05, status: "available", calculated_at: ago(HOUR), input_fingerprint: "x" }];
  const db = createFakeSupabase({ seed: baseSeed({ calculated_metric_observations: calculated }) });
  const result = await runDataRefresh(db.client, new SupabaseRefreshStore(db.client), {
    trigger: "scheduled", fetchImpl: providerFetch({ coingecko: "error", binance: "error", dexscreener: "error" }), sleep: noSleep,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.steps.find((step) => step.step === "metrics").status, "skipped");
  assert.deepEqual(db.rows("calculated_metric_observations"), calculated);
  assert.equal(db.rows("token_metric_observations").length, 0);
  assert.equal(db.rows("data_refresh_runs")[0].status, "failed");
});

test("timeouts: a hanging provider is aborted before writing while others complete", async () => {
  const db = createFakeSupabase({ seed: baseSeed() });
  const started = Date.now();
  const result = await runDataRefresh(db.client, new SupabaseRefreshStore(db.client), {
    trigger: "scheduled", fetchImpl: providerFetch({ coingecko: "hang", dexscreener: "ok" }), sleep: noSleep,
    timeouts: { coingecko: 50 },
  });
  assert.ok(Date.now() - started < 5_000, "the run is bounded by the provider budget");
  const coingecko = result.steps.find((step) => step.step === "coingecko");
  assert.equal(coingecko.status, "timed_out");
  assert.equal(result.steps.find((step) => step.step === "dexscreener").status, "succeeded");
  assert.equal(result.status, "partial");
  assert.equal(db.rows("token_metric_observations").filter((row) => row.provider_id === "coingecko").length, 0);

  // Diagnostic-only stage timing survives the abort even though runCoinGeckoCollection's own
  // promise never resolved: the orchestrator read it back from the same CollectorDiagnostics
  // instance it handed the collector, not from the collector's (never-returned) result.
  const diagnostics = coingecko.detail.diagnostics;
  assert.ok(diagnostics, "a timed-out CoinGecko step records partial diagnostics instead of an empty detail");
  assert.equal(diagnostics.lastStage, "coingecko.fetchSnapshots", "the hang never leaves the HTTP fetch stage");
  assert.equal(diagnostics.lastStageStatus, "running", "the entered stage was aborted mid-flight, not completed");
  assert.equal(diagnostics.stages["coingecko.fetchSnapshots"].status, "running");
  assert.equal(diagnostics.stages["coingecko.prepareDatabase"].status, "not_started", "a later stage never reached is distinguishable from one that ran");
  assert.equal(diagnostics.stages["coingecko.persistProviderSnapshots"].status, "not_started");
  assert.ok(diagnostics.httpAttempts.length >= 1, "at least one HTTP attempt was recorded before the abort");
  assert.equal(diagnostics.httpAttempts[0].httpStatus, null, "the hang never produced a response");

  // Other providers' timeout/error detail is unchanged: they never write to diagnostics.
  const dexscreenerResult = await runDataRefresh(
    createFakeSupabase({ seed: baseSeed() }).client,
    new SupabaseRefreshStore(createFakeSupabase({ seed: baseSeed() }).client),
    { trigger: "scheduled", fetchImpl: providerFetch({ coingecko: "ok", dexscreener: "hang" }), sleep: noSleep, timeouts: { dexscreener: 50 } },
  );
  const dexscreenerStep = dexscreenerResult.steps.find((step) => step.step === "dexscreener");
  assert.equal(dexscreenerStep.status, "timed_out");
  assert.deepEqual(dexscreenerStep.detail, {}, "a provider that never writes to diagnostics keeps the original empty timeout detail");
});

test("CollectorDiagnostics: partial state distinguishes not_started, running, and completed stages", () => {
  const diagnostics = new CollectorDiagnostics();
  diagnostics.declareStages(["fetch", "prepare", "persist"]);

  // Nothing has started yet.
  let snapshot = diagnostics.snapshot();
  assert.equal(snapshot.lastStage, null);
  assert.equal(snapshot.lastStageStatus, "not_started");
  assert.deepEqual(snapshot.stages, {
    fetch: { status: "not_started" }, prepare: { status: "not_started" }, persist: { status: "not_started" },
  });

  diagnostics.start("fetch");
  snapshot = diagnostics.snapshot();
  assert.equal(snapshot.lastStage, "fetch");
  assert.equal(snapshot.lastStageStatus, "running");
  assert.equal(snapshot.stages.prepare.status, "not_started", "a later stage is not implicitly started");

  diagnostics.end("fetch");
  diagnostics.start("prepare");
  snapshot = diagnostics.snapshot();
  assert.equal(snapshot.stages.fetch.status, "completed");
  assert.ok(typeof snapshot.stages.fetch.durationMs === "number" && snapshot.stages.fetch.durationMs >= 0);
  assert.equal(snapshot.lastStage, "prepare");
  assert.equal(snapshot.lastStageStatus, "running");
  assert.equal(snapshot.stages.persist.status, "not_started", "the final declared stage was never reached");

  diagnostics.recordHttpAttempt({ batch: 0, attempt: 1, outcome: "retry", durationMs: 12, httpStatus: 429 });
  assert.deepEqual(diagnostics.snapshot().httpAttempts, [{ batch: 0, attempt: 1, outcome: "retry", durationMs: 12, httpStatus: 429 }]);
});

test("5. metrics run once after providers and are skipped when nothing is due", async () => {
  const order = [];
  const collectors = {
    coingecko: { collect: async () => { order.push("coingecko"); return { observations: 1 }; } },
    dexscreener: { collect: async () => { order.push("dexscreener"); return { observations: 1 }; } },
    defillama: { collect: async () => { order.push("defillama"); return { observations: 1 }; } },
  };
  const db = createFakeSupabase({ seed: baseSeed() });
  const store = new SupabaseRefreshStore(db.client);
  const calculateMetrics = async () => { order.push("metrics"); return { calculatedMetrics: 3 }; };
  const first = await runDataRefresh(db.client, store, { trigger: "scheduled", collectors, calculateMetrics });
  assert.equal(first.status, "succeeded");
  assert.equal(order.at(-1), "metrics");
  assert.equal(order.filter((step) => step === "metrics").length, 1);

  // Immediately afterwards nothing is due, so no provider or metrics work happens.
  order.length = 0;
  const second = await runDataRefresh(db.client, store, { trigger: "scheduled", collectors, calculateMetrics });
  assert.equal(second.status, "skipped");
  assert.deepEqual(order, []);
});

test("cadence: providers are due by their own interval, with tolerance for cron jitter", () => {
  const now = new Date("2026-09-25T12:00:00.000Z");
  const at = (minutes) => new Date(now.getTime() - minutes * 60_000).toISOString();
  assert.equal(isProviderDue("coingecko", undefined, now), true, "first-ever refresh with no lastSuccessAt remains due");
  assert.equal(isProviderDue("coingecko", at(12), now), false, "15-minute provider is not due before 13 minutes");
  assert.equal(isProviderDue("coingecko", at(13), now), true, "15-minute provider is due at 13 minutes");
  assert.equal(isProviderDue("coingecko", at(15), now), true);
  assert.equal(isProviderDue("dexscreener", at(12), now), false);
  assert.equal(isProviderDue("dexscreener", at(13), now), true);
  assert.equal(isProviderDue("defillama_coins", at(27), now), false, "30-minute provider is not due before 28 minutes");
  assert.equal(isProviderDue("defillama_coins", at(28), now), true, "30-minute provider is due at 28 minutes");
  assert.equal(isProviderDue("defillama", at(357), now), false, "6-hour provider is not due before 5h58m");
  assert.equal(isProviderDue("defillama", at(358), now), true, "DeFiLlama refreshes every 6 hours, due at 5h58m");
});

test("cadence: force refresh behavior remains unchanged", async () => {
  const order = [];
  const collectors = {
    coingecko: { collect: async () => { order.push("coingecko"); return { observations: 1 }; } },
    dexscreener: { collect: async () => { order.push("dexscreener"); return { observations: 1 }; } },
    defillama: { collect: async () => { order.push("defillama"); return { observations: 1 }; } },
  };
  const db = createFakeSupabase({ seed: baseSeed() });
  const store = new SupabaseRefreshStore(db.client);
  const calculateMetrics = async () => { order.push("metrics"); return { calculatedMetrics: 3 }; };
  const first = await runDataRefresh(db.client, store, { trigger: "scheduled", collectors, calculateMetrics });
  assert.equal(first.status, "succeeded");

  // Immediately afterwards nothing is due naturally, but force still runs every provider.
  order.length = 0;
  const forced = await runDataRefresh(db.client, store, { trigger: "manual", collectors, calculateMetrics, force: true });
  assert.equal(forced.status, "succeeded");
  assert.deepEqual(new Set(order), new Set(["coingecko", "dexscreener", "defillama", "metrics"]));
});

test("overall status distinguishes succeeded, partial, failed, and skipped", () => {
  const step = (name, status) => ({ step: name, status, startedAt: "", finishedAt: "", detail: {}, error: null });
  assert.equal(overallStatus([step("coingecko", "succeeded"), step("defillama", "skipped"), step("metrics", "succeeded")]), "succeeded");
  assert.equal(overallStatus([step("coingecko", "succeeded"), step("dexscreener", "failed"), step("metrics", "succeeded")]), "partial");
  assert.equal(overallStatus([step("coingecko", "succeeded"), step("metrics", "failed")]), "partial");
  assert.equal(overallStatus([step("coingecko", "timed_out"), step("metrics", "skipped")]), "failed");
  assert.equal(overallStatus([step("defillama", "skipped")]), "skipped");
});

test("9. overlapping runs are prevented and abandoned locks expire", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const collectors = {
    coingecko: { collect: async () => { calls.push("coingecko"); await gate; return {}; } },
    binance: { collect: async () => ({}) },
    dexscreener: { collect: async () => ({}) },
    defillama: { collect: async () => ({}) },
  };
  const db = createFakeSupabase({ seed: baseSeed() });
  const store = new SupabaseRefreshStore(db.client);
  const options = { trigger: "scheduled", collectors, calculateMetrics: async () => ({}) };
  const first = runDataRefresh(db.client, store, options);
  const second = await runDataRefresh(db.client, store, options);
  assert.equal(second.status, "busy");
  release();
  assert.equal((await first).status, "succeeded");
  assert.equal(calls.length, 1, "the busy run did not collect anything");

  const stale = createFakeSupabase({ seed: baseSeed({
    data_refresh_runs: [{ id: 1, trigger: "scheduled", status: "running", started_at: ago(HOUR), lease_expires_at: ago(HOUR / 2), finished_at: null }],
  }) });
  const recovered = await runDataRefresh(stale.client, new SupabaseRefreshStore(stale.client), options);
  assert.equal(recovered.status, "succeeded");
  assert.equal(stale.rows("data_refresh_runs")[0].status, "failed");
  assert.match(stale.rows("data_refresh_runs")[0].error, /lease expired/);

  const live = createFakeSupabase({ seed: baseSeed({
    data_refresh_runs: [{ id: 1, trigger: "scheduled", status: "running", started_at: ago(60_000), lease_expires_at: new Date(NOW.getTime() + HOUR).toISOString(), finished_at: null }],
  }) });
  assert.equal((await runDataRefresh(live.client, new SupabaseRefreshStore(live.client), options)).status, "busy");
});

test("ownership: acquireRun issues a lock token, and a stale token cannot renew or finalize a reclaimed run", async () => {
  const db = createFakeSupabase({ seed: baseSeed() });
  const store = new SupabaseRefreshStore(db.client);
  const start = new Date("2026-09-30T00:00:00Z");
  const ownerA = await store.acquireRun("scheduled", start, 1_000); // 1s lease
  assert.equal(typeof ownerA.runId, "number");
  assert.equal(typeof ownerA.lockToken, "string");

  const muchLater = new Date(start.getTime() + 60_000);
  const ownerB = await store.acquireRun("scheduled", muchLater, 60_000);
  assert.notEqual(ownerB.runId, ownerA.runId, "the reclaimed lease must produce a new run row, not reuse the abandoned one");
  assert.notEqual(ownerB.lockToken, ownerA.lockToken);

  assert.equal(await store.renewLease(ownerA.runId, ownerA.lockToken, muchLater, 60_000), false, "run A's stale token cannot renew its own already-reclaimed lease");
  assert.equal(await store.finishRun(ownerA.runId, ownerA.lockToken, "succeeded", muchLater, {}, null), false, "run A cannot finalize a run whose lease was already reclaimed");
  assert.equal(db.rows("data_refresh_runs").find((row) => row.id === ownerA.runId).status, "failed", "run A's row stays failed/abandoned, never flipped to succeeded by the stale owner");

  assert.equal(await store.renewLease(ownerB.runId, ownerB.lockToken, muchLater, 60_000), true, "run B, the genuine owner, can renew");
  assert.equal(await store.finishRun(ownerB.runId, ownerB.lockToken, "succeeded", muchLater, {}, null), true, "run B can finalize normally");
  assert.equal(db.rows("data_refresh_runs").find((row) => row.id === ownerB.runId).status, "succeeded");
});

test("ownership: concurrent acquireRun yields exactly one owner", async () => {
  const db = createFakeSupabase({ seed: baseSeed() });
  const store = new SupabaseRefreshStore(db.client);
  const now = new Date();
  const [a, b, c] = await Promise.all([
    store.acquireRun("scheduled", now, 60_000),
    store.acquireRun("scheduled", now, 60_000),
    store.acquireRun("scheduled", now, 60_000),
  ]);
  const owners = [a, b, c].filter((result) => result !== null);
  assert.equal(owners.length, 1, "exactly one of the concurrent acquisitions must succeed");
});

test("ownership: a run that loses its lease mid-refresh stops before metrics and does not finalize", async () => {
  const db = createFakeSupabase({ seed: baseSeed() });
  const store = new SupabaseRefreshStore(db.client);
  let metricsRan = false;
  const collectors = {
    // Simulates a concurrent invocation's acquireRun reclaiming this run's lease
    // (its expire-abandoned-runs UPDATE flips status to 'failed') while this
    // provider phase is still in flight — exactly what happens in production
    // when a killed invocation's lease finally expires mid-run elsewhere.
    coingecko: {
      collect: async () => {
        const run = db.rows("data_refresh_runs")[0];
        run.status = "failed";
        run.error = "Run abandoned: its lease expired before it finished.";
        return { observations: 1 };
      },
    },
    dexscreener: { collect: async () => ({ observations: 1 }) },
    defillama: { collect: async () => ({ observations: 1 }) },
  };
  const result = await runDataRefresh(db.client, store, {
    trigger: "scheduled",
    collectors,
    calculateMetrics: async () => { metricsRan = true; return {}; },
  });
  assert.equal(result.status, "lost_ownership");
  assert.equal(metricsRan, false, "metrics must never start once ownership is lost");
  const run = db.rows("data_refresh_runs")[0];
  assert.equal(run.status, "failed", "the reclaiming invocation's abandonment marker is never overwritten back to succeeded by the stale invocation");
});

test("7. refresh status reports per-provider last success and provider-specific staleness", async () => {
  const db = createFakeSupabase({ seed: {
    data_refresh_steps: [
      { id: 1, run_id: 1, step: "coingecko", status: "succeeded", finished_at: ago(3 * HOUR) },
      { id: 2, run_id: 2, step: "coingecko", status: "succeeded", finished_at: ago(HOUR / 4) },
      { id: 3, run_id: 3, step: "coingecko", status: "failed", finished_at: ago(60_000) },
      { id: 4, run_id: 2, step: "metrics", status: "succeeded", finished_at: ago(HOUR / 5) },
    ],
  } });
  const lastSuccess = await new SupabaseRefreshStore(db.client).lastSuccessfulSteps();
  assert.equal(lastSuccess.coingecko, ago(HOUR / 4), "failed attempts do not count as refreshes");
  assert.equal(lastSuccess.metrics, ago(HOUR / 5));
  assert.equal(lastSuccess.dexscreener, undefined);

  const status = buildRefreshStatus({
    lastSuccess,
    latestCollected: { defillama: ago(12 * HOUR), dexscreener: ago(4 * HOUR) },
    latestRunStatus: "partial",
    now: NOW,
  });
  const byId = Object.fromEntries(status.providers.map((provider) => [provider.id, provider]));
  assert.equal(byId.coingecko.state, "current");
  assert.equal(byId.coingecko.ageLabel, "15 min ago");
  assert.equal(byId.dexscreener.state, "stale", "4 hours exceeds the hourly providers' 3-hour threshold");
  assert.equal(byId.defillama.state, "current", "12 hours is within DeFiLlama's daily threshold");
  assert.equal(status.metricsCalculatedAt, ago(HOUR / 5));
  assert.equal(buildRefreshStatus({ lastSuccess: {}, latestCollected: {}, latestRunStatus: null, now: NOW }).providers[0].state, "unavailable");
  assert.ok(REFRESH_POLICY.defillama.staleAfterMs > REFRESH_POLICY.coingecko.staleAfterMs);
  assert.equal(relativeAge(ago(3 * 24 * HOUR), NOW), "3 days ago");
});

test("8. the refresh endpoint rejects unauthenticated requests before any work", async () => {
  assert.equal(isAuthorizedRefreshRequest("Bearer anything", {}), false, "no secret configured means no access");
  assert.equal(isAuthorizedRefreshRequest("Bearer short", { CRON_SECRET: "short" }), false, "weak secrets are refused");
  const secret = "test-cron-secret-0123456789";
  assert.equal(isAuthorizedRefreshRequest(null, { CRON_SECRET: secret }), false);
  assert.equal(isAuthorizedRefreshRequest(`Bearer ${secret}x`, { CRON_SECRET: secret }), false);
  assert.equal(isAuthorizedRefreshRequest(secret, { CRON_SECRET: secret }), false, "the Bearer scheme is required");
  assert.equal(isAuthorizedRefreshRequest(`Bearer ${secret}`, { CRON_SECRET: secret }), true);

  const { GET } = await import("../src/app/api/cron/refresh/route.ts");
  const savedUrl = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL; // Any database access would throw; 401 proves it never started.
  process.env.CRON_SECRET = secret;
  try {
    const anonymous = await GET(new Request("http://localhost/api/cron/refresh"));
    assert.equal(anonymous.status, 401);
    const wrong = await GET(new Request("http://localhost/api/cron/refresh", { headers: { authorization: "Bearer wrong-secret-value-000" } }));
    assert.equal(wrong.status, 401);
    const badProviders = await GET(new Request("http://localhost/api/cron/refresh?providers=coinmarketcap", { headers: { authorization: `Bearer ${secret}` } }));
    assert.equal(badProviders.status, 400);
  } finally {
    delete process.env.CRON_SECRET;
    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
  }
});

test("bounded reads match the pre-migration full scan", async () => {
  const rows = [
    previousObservation(1, BTC.id, BTC.chainId, "coingecko", "price_usd", 50_000, ago(30 * 24 * HOUR)),
    previousObservation(2, BTC.id, BTC.chainId, "coingecko", "price_usd", 60_000, ago(2 * HOUR)),
    previousObservation(3, BTC.id, BTC.chainId, "coingecko", "price_usd", 61_000, ago(HOUR)),
    previousObservation(4, BTC.id, BTC.chainId, "coingecko", "market_cap_usd", 1_000_000, ago(HOUR)),
    previousObservation(5, BTC.id, BTC.chainId, "coingecko", "volume_24h_usd", 40_000, ago(HOUR)),
    { ...previousObservation(6, BTC.id, BTC.chainId, "coingecko", "volume_24h_usd", null, ago(HOUR / 2)), status: "unavailable" },
  ];
  const withViews = createFakeSupabase({ seed: baseSeed({ token_metric_observations: rows }) });
  const withoutViews = createFakeSupabase({ seed: baseSeed({ token_metric_observations: rows }), views: false });
  const sortKey = (row) => `${row.provider_id}|${row.metric_id}`;
  const latestA = (await readLatestObservations(withViews.client, [BTC.id])).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const latestB = (await readLatestObservations(withoutViews.client, [BTC.id])).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  assert.deepEqual(latestA, latestB);
  assert.equal(latestA.find((row) => row.metric_id === "volume_24h_usd").status, "unavailable", "the newest row wins even when unavailable");

  await runMetricsCalculation(withViews.client, NOW);
  await runMetricsCalculation(withoutViews.client, NOW);
  const project = (db) => db.rows("calculated_metric_observations")
    .map((row) => `${row.token_id}|${row.metric_id}|${row.status}|${row.value}`).sort();
  assert.deepEqual(project(withViews), project(withoutViews));
  assert.ok(withViews.calls.some((call) => call.table === "latest_token_metric_observations"));
});

test("metrics: unchanged rows are touched by id instead of rewritten, changed rows are upserted", async () => {
  const rows = [
    previousObservation(1, BTC.id, BTC.chainId, "coingecko", "price_usd", 60_000, ago(2 * HOUR)),
    previousObservation(2, BTC.id, BTC.chainId, "coingecko", "price_usd", 61_000, ago(HOUR)),
    previousObservation(3, BTC.id, BTC.chainId, "coingecko", "market_cap_usd", 1_000_000, ago(HOUR)),
    previousObservation(4, BTC.id, BTC.chainId, "coingecko", "volume_24h_usd", 40_000, ago(HOUR)),
  ];
  const db = createFakeSupabase({ seed: baseSeed({ token_metric_observations: rows }) });
  const upserts = () => db.calls.filter((call) => call.table === "calculated_metric_observations" && call.op === "upsert").length;
  const touches = () => db.calls.filter((call) => call.table === "touch_calculated_metric_observations").length;

  const first = await runMetricsCalculation(db.client, NOW);
  assert.ok(first.calculatedMetrics > 0);
  assert.equal(first.touchedUnchangedMetrics, 0, "the first run has nothing stored to compare against");
  const upsertsAfterFirst = upserts();
  const snapshot = (table) => JSON.stringify(db.rows(table).map(({ calculated_at, ...rest }) => rest));
  const storedBefore = snapshot("calculated_metric_observations");

  const later = new Date(NOW.getTime() + 15 * 60 * 1000);
  const second = await runMetricsCalculation(db.client, later);
  assert.equal(second.rewrittenMetrics, 0, "identical inputs rewrite nothing");
  assert.equal(second.touchedUnchangedMetrics, second.calculatedMetrics);
  assert.equal(upserts(), upsertsAfterFirst, "no upsert is sent when every row is unchanged");
  assert.ok(touches() > 0);
  assert.equal(snapshot("calculated_metric_observations"), storedBefore, "stored results are untouched");
  assert.ok(db.rows("calculated_metric_observations").every((row) => row.calculated_at === later.toISOString()), "calculated_at still advances on every row");

  db.rows("token_metric_observations").push(previousObservation(5, BTC.id, BTC.chainId, "coingecko", "price_usd", 62_000, ago(1000)));
  const third = await runMetricsCalculation(db.client, new Date(later.getTime() + 15 * 60 * 1000));
  assert.ok(third.rewrittenMetrics > 0 && third.rewrittenMetrics < third.calculatedMetrics, "only rows fed by the new price are rewritten");
  assert.equal(third.rewrittenMetrics + third.touchedUnchangedMetrics, third.calculatedMetrics);
});

test("metrics: reading only LATEST_INPUTS leaves every calculated row unchanged", async () => {
  const pairs = [];
  for (const provider of ["coingecko", "defillama", "defillama_coins", "dexscreener", "geckoterminal", "binance"]) {
    for (const metric of ["price_usd", "market_cap_usd", "volume_24h_usd", "tvl_usd", "revenue_24h_usd", "fees_24h_usd", "sells_24h_count",
      "buys_24h_count", "transactions_24h_count", "liquidity_usd", "fdv_usd", "price_change_24h_pct", "price_change_7d_pct",
      "circulating_supply", "total_supply", "maximum_supply"]) pairs.push([provider, metric]);
  }
  const rows = pairs.flatMap(([provider, metric], index) => [
    previousObservation(index * 2 + 1, BTC.id, BTC.chainId, provider, metric, 1_000 + index, ago(26 * HOUR)),
    previousObservation(index * 2 + 2, BTC.id, BTC.chainId, provider, metric, 2_000 + index, ago(HOUR)),
  ]);
  const seed = () => createFakeSupabase({ seed: baseSeed({ token_metric_observations: rows }) });
  const filtered = seed();
  await runMetricsCalculation(filtered.client, NOW);

  // Same run, but the "latest" read returns every provider and metric (the pre-slimming behaviour).
  const unfiltered = seed();
  const slim = unfiltered.client.rpc;
  unfiltered.client.rpc = (name, params) => name === "metrics_latest_inputs"
    ? slim("metrics_latest_inputs", {
      ...params,
      p_providers: pairs.map(([provider]) => provider),
      p_metrics: pairs.map(([, metric]) => metric),
    })
    : slim(name, params);
  await runMetricsCalculation(unfiltered.client, NOW);

  const project = (db) => db.rows("calculated_metric_observations")
    .map(({ id, calculated_at, ...rest }) => JSON.stringify(rest)).sort();
  assert.ok(project(filtered).length > 0);
  assert.deepEqual(project(filtered), project(unfiltered), "no metric depends on a (provider, metric) pair outside LATEST_INPUTS");
});

test("deadline sleep stops waiting once the step budget is spent", async () => {
  const controller = new AbortController();
  const sleep = deadlineSleep(controller.signal, () => new Promise(() => {}));
  const pending = sleep(10_000);
  controller.abort(new Error("budget spent"));
  await assert.rejects(pending, /budget spent/);
  await assert.rejects(sleep(1), /budget spent/);
  await deadlineSleep(new AbortController().signal, noSleep)(5);
});

let failures = 0;
for (const { name, run } of cases) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : "unknown error"}`);
  }
}
console.log(`${cases.length - failures}/${cases.length} refresh checks passed.`);
if (failures > 0) process.exitCode = 1;
