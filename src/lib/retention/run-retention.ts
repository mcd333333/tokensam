type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

const BATCH_SIZE = 1000;
const MAX_BATCHES_PER_FUNCTION = 1000;
// Daily aggregation batch_size counts token/metric/provider groups rather than
// source rows. Keeping the group limit at 80 bounds each RPC's aggregation and
// deletion work under the PostgREST statement timeout.
const DAILY_AGGREGATION_GROUP_BATCH_SIZE = 80;
// retention_expire_raw_provider_records_batch deletes rows that
// token_metric_observations.raw_record_id and provider_pairs.raw_record_id
// reference, so each deleted row fires both FK triggers. The
// token_metric_observations one alone was measured at ~10-15ms per row
// (2026-10-21, table at ~577K rows) even on a pure buffer-cache hit with no
// lock contention -- not an indexing problem, the index is 6.2MB and already
// used; this project's compute tier appears to add real per-lookup latency.
// At that rate BATCH_SIZE=1000 needs 10-15s, over PostgREST's ~8s
// statement_timeout on every call, so the function deleted 0 rows on every
// scheduled run and raw_provider_records grew unchecked. 300 rows keeps the
// FK-check cost at ~3-4.5s, leaving headroom under the 8s budget.
const RAW_PROVIDER_RECORDS_BATCH_SIZE = 300;

// Retention policy:
// - Keep granular observations for the chart-required
//   metrics only (coingecko price_usd, coingecko volume_24h_usd, defillama
//   tvl_usd -- see SERIES_RULES in src/lib/indicators/series.ts and
//   MARKET_HISTORY in src/lib/ui/profile-model.ts). Every completed UTC day is
//   represented by an arithmetic-mean aggregate before its source observations
//   are removed; the current incomplete day remains available for live snapshots.
//   Aggregate retention is metric-specific: market_cap_usd 46 days, circulating
//   supply 11 days, total/maximum supply latest day only, and other aggregates
//   up to 90 days. The live profile reads aggregates as historical indicator inputs.
// - coingecko price_usd stays fully granular through day 37, not
//   30 -- the risk profile's volatility is a rolling 7-day window of hourly
//   returns (RISK_VOLATILITY_WINDOW_DAYS in src/lib/indicators/series.ts)
//   ending at each displayed point, so a correct 30D volatility curve needs
//   hourly price data a further 7 days before the window it displays.
// - Observations and aggregates expire after their metric-specific windows;
//   non-special daily aggregates expire after 90 days. Raw provider records
//   follow the provider-record expiry function in the database.
// The database trigger trg_protect_30d_chart_observations is the final guard
// against deleting protected chart observations inside their granular window
// (30 days, or 37 for coingecko price_usd).
//
// retention_collapse_non_chart_daily_batch is NOT listed here any more: it ran through
// this route's client.rpc(...) over PostgREST, whose `authenticator` role has an ~8s
// statement_timeout (pg_roles.rolconfig) -- fine while the table was small, but by
// 2026-10-08 (647K rows) even its existence-check probe alone took ~6s under the planner
// plan Postgres was actually choosing, and the real GROUP BY/DELETE work pushed it over
// 8s on every call, so the cursor-based retry (20261007110000) never advanced: the same
// day kept getting re-probed and re-failing every ~8-12 minutes indefinitely, letting a
// full day's worth of non-chart observations accumulate ungated and pushing the database
// past the 500MB free-plan hard cap. Run directly outside PostgREST instead (pg_cron,
// 20261008000000_non_chart_collapse_pg_cron.sql), the same fix already proven for
// VACUUM FULL (20261006090000/20261007120000): a session's default statement_timeout is
// far longer, and the same query that timed out every time here completed in well under
// a second once not bound by PostgREST's connection.
const RETENTION_FUNCTIONS = [
  "retention_collapse_daily_batch",
  "retention_expire_observations_batch",
  "retention_expire_daily_aggregates_batch",
  "retention_expire_raw_provider_records_batch",
] as const;

export type RetentionFunctionName = (typeof RETENTION_FUNCTIONS)[number];

export type RetentionRunResult = {
  deleted: Record<RetentionFunctionName, number>;
  batches: Record<RetentionFunctionName, number>;
  stoppedEarly: RetentionFunctionName[];
  failed: Record<RetentionFunctionName, string>;
  totalDeleted: number;
};

export async function runRetentionBatches(client: SupabaseAdminClient, deadlineAt: number): Promise<RetentionRunResult> {
  const deleted = {} as Record<RetentionFunctionName, number>;
  const batches = {} as Record<RetentionFunctionName, number>;
  const stoppedEarly: RetentionFunctionName[] = [];
  const failed = {} as Record<RetentionFunctionName, string>;

  for (const fn of RETENTION_FUNCTIONS) {
    deleted[fn] = 0;
    batches[fn] = 0;
    for (let i = 0; i < MAX_BATCHES_PER_FUNCTION; i++) {
      if (Date.now() >= deadlineAt) {
        stoppedEarly.push(fn);
        break;
      }
      const batchSize = fn === "retention_collapse_daily_batch"
        ? DAILY_AGGREGATION_GROUP_BATCH_SIZE
        : fn === "retention_expire_raw_provider_records_batch"
          ? RAW_PROVIDER_RECORDS_BATCH_SIZE
          : BATCH_SIZE;
      const { data, error } = await client.rpc(fn, { batch_size: batchSize });
      if (error) {
        failed[fn] = error.message;
        break;
      }
      const count = typeof data === "number" ? data : 0;
      deleted[fn] += count;
      batches[fn] += 1;
      if (count === 0) break;
    }
  }

  const totalDeleted = Object.values(deleted).reduce((sum, n) => sum + n, 0);
  return { deleted, batches, stoppedEarly, failed, totalDeleted };
}
