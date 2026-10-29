import { CALCULATED_METRICS, calculateAllMetrics, type CalculatedMetricRow, type ObservationInput, type RawRecordInput, type TokenInput } from "./engine.ts";
import { LATEST_READ_WINDOW_MS, mergeById, readLatestRawRecords, readPages } from "../data/observation-reads.ts";
import { recordApproxRead } from "../monitoring/quota-tracker.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

const PAGE_SIZE = 1000;
// The engine compares these series over time (latest vs previous / aligned
// windows); every other input only needs its latest observation. Observation
// history is append-only and grows with each automated refresh, so reads are
// bounded: latest row per metric plus a recent window for the series below.
export const SERIES_INPUTS = [
  { providerId: "coingecko", metricId: "price_usd" },
  { providerId: "coingecko", metricId: "market_cap_usd" },
  { providerId: "defillama", metricId: "tvl_usd" },
  { providerId: "defillama", metricId: "revenue_24h_usd" },
  { providerId: "defillama", metricId: "fees_24h_usd" },
];
/**
 * Every (provider, metric) pair the engine reads as a latest value (engine.ts: chooseLatest/series).
 * Reading only these, instead of the latest row for every provider and metric, cut the per-run
 * download by about two thirds: the rest (CoinGecko supply and change percentages, DEX Screener
 * price/market cap/change/transactions, DeFiLlama Coins prices) is never consumed by the engine,
 * and several of those rows carry ~400-character notes. tests/refresh.test.mjs asserts that
 * filtering to this list leaves the engine's output unchanged.
 */
export const LATEST_INPUTS = [
  { providerId: "coingecko", metricId: "price_usd" },
  { providerId: "coingecko", metricId: "market_cap_usd" },
  { providerId: "coingecko", metricId: "volume_24h_usd" },
  { providerId: "defillama", metricId: "tvl_usd" },
  { providerId: "defillama", metricId: "revenue_24h_usd" },
  { providerId: "defillama", metricId: "fees_24h_usd" },
  { providerId: "dexscreener", metricId: "volume_24h_usd" },
  { providerId: "dexscreener", metricId: "sells_24h_count" },
  { providerId: "dexscreener", metricId: "buys_24h_count" },
  { providerId: "dexscreener", metricId: "liquidity_usd" },
  { providerId: "dexscreener", metricId: "fdv_usd" },
];

/**
 * The engine never actually looks back this far: growthCalculation (engine.ts) only
 * ever compares the two most recent distinct observations, and the cross-provider
 * divergence/cross-change calculations only look for a point ~24h earlier, within a 6h
 * tolerance (CROSS_CHANGE_HORIZON_HOURS/CROSS_CHANGE_TOLERANCE_HOURS) -- a 30-hour
 * requirement at most. 14 days was over 11x more than that for every one of the 238
 * canonical tokens x 5 series on every metrics run (which runs roughly as often as
 * CoinGecko's own 15-minute refresh cadence), and was the single largest contributor to
 * this project's Supabase egress: ~18.7MB average per recorded read in production
 * (2026-10-07), almost entirely this one unbounded-relative-to-need window. 3 days
 * keeps a comfortable margin above the real 30-hour requirement (a missed run, a
 * weekend DeFiLlama collection drift) without reading 4x more than that margin needs.
 */
export const SERIES_LOOKBACK_DAYS = 3;

function throwOnError(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`Supabase ${action} failed: ${error.message}`);
}

async function readTokens(client: SupabaseAdminClient): Promise<TokenInput[]> {
  const all: TokenInput[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client.from("tokens").select("id,chain_id,name,symbol").order("id").range(offset, offset + PAGE_SIZE - 1);
    throwOnError(error, "read tokens");
    const page = (data ?? []) as TokenInput[];
    all.push(...page);
    if (page.length < PAGE_SIZE) return all;
  }
}

/**
 * Both reads below call dedicated RPCs (20261007160000_metrics_calc_server_side_collapse)
 * instead of observation-reads.ts's readLatestObservations/readObservationWindow: those
 * fetch every row in a bounded window over the wire and collapse to the few rows actually
 * needed in application memory, which was measured as this project's single largest
 * Supabase-egress contributor (~25MB/run; metrics runs ~96 times/day). The RPCs do the
 * identical collapse server side (latest-per-group; two-most-recent-points-per-series,
 * including retained daily aggregates, plus the one ~24h-prior point alignedCrossChange needs), so only the rows the engine
 * actually reads cross the wire -- measured live at ~947KB/run for the same data, a ~97%
 * reduction with no change to which rows feed the calculation.
 *
 * Both calls are paged with readPages/.range(): PostgREST applies a default row limit to
 * RPC calls returning sets, same as an ordinary table select, and an unpaginated call
 * silently truncates past it with no error. At 154 tracked tokens this project crossed that
 * limit (latest_observations_bounded: 1,950 rows; metrics_series_recent_points: 1,087 rows,
 * both over the ~1000-row default) and every token whose id sorted alphabetically past the
 * cutoff (observed live: everything from "ethereum-spk" onward) silently lost its
 * volume_24h_usd row from this read, surfacing as "Required input unavailable: CoinGecko
 * 24-hour volume" for volume_to_market_cap on those tokens specifically -- reproducible
 * across multiple calculation runs, not a one-off timing race. Every other read in this
 * codebase already pages through readPages/readLatestObservations for exactly this reason;
 * these two RPC calls were the only ones left unpaginated.
 */
async function readObservations(client: SupabaseAdminClient, tokenIds: string[], now: Date): Promise<ObservationInput[]> {
  const since = new Date(now.getTime() - LATEST_READ_WINDOW_MS).toISOString();
  const [{ rows: latest }, { rows: history }] = await Promise.all([
    readPages<ObservationInput>((from, to) => client.rpc("metrics_latest_inputs", {
      p_token_ids: tokenIds,
      p_providers: LATEST_INPUTS.map((input) => input.providerId),
      p_metrics: LATEST_INPUTS.map((input) => input.metricId),
      p_since: since,
    }).range(from, to), "read latest metric inputs (rpc)"),
    readPages<ObservationInput>((from, to) => client.rpc("metrics_series_inputs", {
      p_token_ids: tokenIds,
      p_providers: SERIES_INPUTS.map((series) => series.providerId),
      p_metrics: SERIES_INPUTS.map((series) => series.metricId),
      p_now: now.toISOString(),
      p_horizon_hours: 24,
      p_tolerance_hours: 6,
      p_max_lookback_days: SERIES_LOOKBACK_DAYS,
    }).range(from, to), "read metric series inputs (rpc)"),
  ]);
  recordApproxRead(client, latest);
  recordApproxRead(client, history);
  return mergeById(latest, history).sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at) || a.id - b.id);
}

type ExistingCalculatedRow = { id: number; token_id: string; chain_id: string; metric_id: string; input_fingerprint: string; calculation_version: string };

const TOUCH_BATCH_SIZE = 1000;

/**
 * Splits freshly calculated rows into those that differ from what is stored and those that are
 * identical apart from calculated_at. input_fingerprint hashes every input (source observation ids
 * and values, raw record ids, result, status, reason, details) plus the calculation version, so an
 * equal fingerprint and version means the stored row is already correct. A failed read of the
 * stored fingerprints just treats every row as changed (the previous full-upsert behaviour).
 */
async function splitUnchangedRows(client: SupabaseAdminClient, rows: CalculatedMetricRow[]) {
  const changed: CalculatedMetricRow[] = [];
  const unchangedIds: number[] = [];
  const unchangedRows: CalculatedMetricRow[] = [];
  let existing: Map<string, ExistingCalculatedRow> | null = null;
  try {
    const { rows: stored, missing } = await readPages<ExistingCalculatedRow>(
      (from, to) => client.from("calculated_metric_observations")
        .select("id,token_id,chain_id,metric_id,input_fingerprint,calculation_version").order("id").range(from, to),
      "read stored calculated metric fingerprints",
    );
    if (!missing) existing = new Map(stored.map((row) => [`${row.token_id}|${row.chain_id}|${row.metric_id}`, row]));
  } catch {
    existing = null;
  }
  for (const row of rows) {
    const previous = existing?.get(`${row.token_id}|${row.chain_id}|${row.metric_id}`);
    if (previous && previous.input_fingerprint === row.input_fingerprint && previous.calculation_version === row.calculation_version) {
      unchangedIds.push(previous.id);
      unchangedRows.push(row);
    } else {
      changed.push(row);
    }
  }
  return { changed, unchangedIds, unchangedRows };
}

export async function runMetricsCalculation(client: SupabaseAdminClient, now = new Date()) {
  const { data: schemaProbe, error: schemaError } = await client
    .from("calculated_metric_observations")
    .select("metric_id")
    .limit(0);
  if (schemaError || schemaProbe === null) {
    throw new Error("Apply supabase/migrations/20260924100000_metrics_engine.sql in the Supabase SQL Editor before calculating metrics.");
  }

  const { data: definitions, error: definitionsError } = await client
    .from("calculated_metric_definitions")
    .select("id");
  throwOnError(definitionsError, "read calculated metric definitions");
  const known = new Set((definitions ?? []).map((row: { id: string }) => row.id));
  const missing = CALCULATED_METRICS.filter((metric) => !known.has(metric.id)).map((metric) => metric.id);
  if (missing.length) throw new Error("The calculated-metric catalog is incomplete; reapply the Phase 9 migration.");

  const tokens = await readTokens(client);
  const tokenIds = tokens.map((token) => token.id);
  const observations = await readObservations(client, tokenIds, now);
  const latestDexRaw = await readLatestRawRecords<RawRecordInput>(client, "dexscreener", "id,provider_id,token_id,chain_id,collected_at,endpoint_label,payload");

  const calculatedAt = now.toISOString();
  const rows = calculateAllMetrics(tokens, observations, latestDexRaw, calculatedAt);

  const { changed, unchangedIds, unchangedRows } = await splitUnchangedRows(client, rows);
  // calculated_at is what the dashboard's "newest run" read keys on (readDashboardCalculated), so
  // rows whose result did not change must still advance it. A touch sends only ids; rewriting the
  // whole ~900-byte row (formula, provenance, ...) for every unchanged metric was ~2/3 of each run's
  // upload, since most unavailable metrics (no DeFiLlama/DEX source) never change between runs.
  const touchFailed: CalculatedMetricRow[] = [];
  for (let offset = 0; offset < unchangedIds.length; offset += TOUCH_BATCH_SIZE) {
    const { error } = await client.rpc("touch_calculated_metric_observations", {
      p_ids: unchangedIds.slice(offset, offset + TOUCH_BATCH_SIZE),
      p_calculated_at: calculatedAt,
    });
    if (error) touchFailed.push(...unchangedRows.slice(offset, offset + TOUCH_BATCH_SIZE));
  }
  const toUpsert = touchFailed.length ? [...changed, ...touchFailed] : changed;
  // onConflict is (token_id,chain_id,metric_id) only — NOT input_fingerprint. Each run
  // recomputes input_fingerprint from that run's inputs, so including it in the conflict
  // target made every run insert a new row instead of updating the existing one for that
  // metric, growing this table unboundedly (218k rows / 374MB within 6 days in production).
  // The unique constraint on the table still includes input_fingerprint for data integrity,
  // but the upsert target intentionally collapses to "one row per token+chain+metric".
  for (let offset = 0; offset < toUpsert.length; offset += 500) {
    const { error } = await client
      .from("calculated_metric_observations")
      .upsert(toUpsert.slice(offset, offset + 500), { onConflict: "token_id,chain_id,metric_id" });
    throwOnError(error, "upsert calculated metric observations");
  }

  return {
    tokens: tokens.length,
    providerObservationsRead: observations.length,
    latestDexPairRecords: latestDexRaw.length,
    rewrittenMetrics: toUpsert.length,
    touchedUnchangedMetrics: unchangedIds.length - touchFailed.length,
    calculatedMetrics: rows.length,
    available: rows.filter((row) => row.status === "available").length,
    unavailable: rows.filter((row) => row.status === "unavailable").length,
    invalid: rows.filter((row) => row.status === "invalid").length,
  };
}
