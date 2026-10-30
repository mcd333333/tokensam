import { recordApproxRead } from "../monitoring/quota-tracker.ts";
import { observationRead } from "./observation-storage.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

const PAGE_SIZE = 1000;
// Providers whose observations the dashboard's "latest" read serves. "binance" must stay
// listed: it supplies the preferred live price and 24h change (see livePriceRow in
// live-data.ts), so omitting it here would silently fall every token back to CoinGecko.
export const PROVIDERS = ["coingecko", "binance", "defillama", "dexscreener", "defillama_coins"];
// Dashboard latest reads only need a recent freshness window. Querying the
// append-only history without a cutoff forces PostgreSQL to consider the full
// table behind latest_token_metric_observations.
export const LATEST_READ_WINDOW_MS = 6 * 60 * 60 * 1000;
export const OBSERVATION_COLUMNS = "id,token_id,chain_id,metric_id,provider_id,raw_record_id,value,status,observed_at,collected_at,source_field,note";
/** Provenance columns added by the token-centric scope migration (read when present). */
export const SCOPE_COLUMNS = "scope,provider_asset_id,mapping_id";
const COLUMNS = `${OBSERVATION_COLUMNS},${SCOPE_COLUMNS}`;

type Row = {
  id: number;
  token_id: string;
  provider_id: string;
  metric_id: string;
  observed_at: string;
  collected_at: string;
};

type DailyAggregateRow = {
  id: number;
  token_id: string;
  chain_id: string;
  metric_id: string;
  provider_id: string;
  utc_day: string;
  value: number | string | null;
  status: string;
  source_observation_count: number;
  valid_value_count: number;
  aggregated_at: string;
  aggregation_method: "arithmetic_mean" | "daily_snapshot";
  first_source_observed_at: string;
  last_source_observed_at: string;
};

const COINGECKO_DAILY_METRICS = ["market_cap_usd", "circulating_supply", "total_supply", "maximum_supply"];

function dailyAggregateObservation(row: DailyAggregateRow, latestValue = false) {
  const snapshot = row.aggregation_method === "daily_snapshot";
  return {
    id: -Math.abs(row.id),
    token_id: row.token_id,
    chain_id: row.chain_id,
    metric_id: row.metric_id,
    provider_id: row.provider_id,
    raw_record_id: null,
    value: row.value,
    status: row.status,
    observed_at: snapshot
      ? row.first_source_observed_at
      : latestValue ? row.last_source_observed_at : new Date(`${row.utc_day}T00:00:00.000Z`).toISOString(),
    collected_at: row.aggregated_at,
    source_field: snapshot ? "daily_snapshot" : "daily_average",
    note: snapshot
      ? `UTC daily point-in-time snapshot from ${row.source_observation_count} source observation.`
      : `UTC daily arithmetic mean from ${row.valid_value_count} valid values across ${row.source_observation_count} provider observations.`,
    scope: row.provider_id === "defillama" ? "protocol" : "token",
    provider_asset_id: null,
    mapping_id: null,
    daily_sample_count: row.source_observation_count,
    daily_valid_value_count: row.valid_value_count,
  };
}

// PostgREST reports a missing relation as PGRST205 (schema cache) or 42P01 (Postgres).
function isMissingRelation(error: { code?: string } | null): boolean {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

function fail(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`Supabase ${action} failed: ${error.message}`);
}

export type PageQuery = (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string; code?: string } | null }>;
/** Offset paging, kept for the small raw-record reads where depth never grows. */
export async function readPages<T>(query: PageQuery, action: string): Promise<{ rows: T[]; missing: boolean }> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await query(offset, offset + PAGE_SIZE - 1);
    if (offset === 0 && isMissingRelation(error)) return { rows, missing: true };
    fail(error, action);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return { rows, missing: false };
  }
}

type KeysetQuery = (fromObservedAt: string | null) => PromiseLike<{ data: unknown[] | null; error: { message: string; code?: string } | null }>;

/**
 * Pages by seeking forward on `observed_at` instead of by OFFSET.
 *
 * OFFSET made PostgreSQL produce and discard every row before the window, so a scan
 * of N rows in pages of PAGE_SIZE cost O(N^2/PAGE_SIZE). For the 14-day coingecko
 * price_usd series the metrics engine reads (107,669 rows, 108 pages) the deep pages
 * blew PostgREST's statement timeout, which is what made the metrics step fail
 * repeatedly and leave calculated metrics stale.
 *
 * Seeking on observed_at -- rather than on `id`, which an earlier attempt at this fix
 * used -- is what makes it fast. provider_metric_history_lookup_idx is
 * (provider_id, metric_id, observed_at), so an observed_at range is an index condition
 * and every row the scan touches is a row the caller wants. Seeking on id instead
 * forced a primary-key scan that filtered provider/metric/observed_at per row and
 * discarded ~22,000 rows to fill the first page (1,478 ms, measured), which still timed
 * out under production load. Measured on production (2026-10-06) for the same first
 * page: 1,107 buffers and 29.6 ms via observed_at, against 6,717 buffers and 1,478 ms
 * via id, and 60,573 buffers and 113 ms for OFFSET 100000.
 *
 * The cursor is inclusive (`>= last observed_at`) because observed_at is NOT unique --
 * a provider writes one timestamp across every token in a batch -- so an exclusive
 * seek would skip the rest of the boundary group. The overlap that creates is removed
 * by id, which is why `seen` is tracked.
 *
 * This requires PAGE_SIZE to exceed the number of rows sharing a single observed_at
 * (182 at the time of writing: one per canonical token in a batch, against PAGE_SIZE
 * 1000). If that ever stops holding, a page cannot advance past the group, and the
 * guard below throws rather than looping forever.
 *
 * Rows come back in observed_at order. Callers that need another order sort for
 * themselves: latestPerMetric sorts by newestFirst, and run-calculation.ts sorts the
 * merged series by observed_at then id.
 */
async function readKeyset<T extends { id: number; observed_at: string }>(
  query: KeysetQuery,
  action: string,
): Promise<{ rows: T[]; missing: boolean }> {
  const rows: T[] = [];
  const seen = new Set<number>();
  let cursor: string | null = null;

  for (;;) {
    const { data, error } = await query(cursor);
    if (cursor === null && isMissingRelation(error)) return { rows, missing: true };
    fail(error, action);
    const page = (data ?? []) as T[];

    let added = 0;
    for (const row of page) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
      added += 1;
    }
    if (page.length < PAGE_SIZE) return { rows, missing: false };

    const nextCursor = page[page.length - 1].observed_at;
    if (added === 0 && nextCursor === cursor) {
      throw new Error(
        `Supabase ${action} failed: more than ${PAGE_SIZE} rows share observed_at ${cursor}, so keyset paging cannot advance.`,
      );
    }
    cursor = nextCursor;
  }
}

function newestFirst(a: Row, b: Row): number {
  return Date.parse(b.observed_at) - Date.parse(a.observed_at)
    || Date.parse(b.collected_at) - Date.parse(a.collected_at)
    || b.id - a.id;
}

/** Keep only the newest row per token/provider/metric (the view's DISTINCT ON rule). */
export function latestPerMetric<T extends Row>(rows: T[]): T[] {
  // One pass keeping the newest row per key, instead of sorting every row with Date.parse in the
  // comparator: this runs over ~40k rows per dashboard render. Same ordering as newestFirst.
  const latest = new Map<string, { row: T; observedMs: number; collectedMs: number }>();
  for (const row of rows) {
    const key = `${row.token_id}|${row.provider_id}|${row.metric_id}`;
    const observedMs = Date.parse(row.observed_at);
    const collectedMs = Date.parse(row.collected_at);
    const held = latest.get(key);
    if (held) {
      const newer = observedMs - held.observedMs || collectedMs - held.collectedMs || row.id - held.row.id;
      if (!(newer > 0)) continue;
    }
    latest.set(key, { row, observedMs, collectedMs });
  }
  return [...latest.values()].map((entry) => entry.row);
}

/** Merge row sets that may overlap (latest rows are usually also inside a history window). */
export function mergeById<T extends { id: number }>(...sets: T[][]): T[] {
  return [...new Map(sets.flat().map((row) => [row.id, row])).values()];
}

/**
 * Read from a recent indexed window instead of the historical latest-observations RPC.
 * The RPC's ranking query timed out in production as the observations table grew.
 * Daily CoinGecko aggregates fill values whose source rows have rolled out of that
 * recent window.
 */
export async function readLatestObservations<T extends Row>(client: SupabaseAdminClient, tokenIds: string[]): Promise<T[]> {
  if (tokenIds.length === 0) return [];
  const TOKEN_BATCH_SIZE = 50;
  const batches = Array.from({ length: Math.ceil(tokenIds.length / TOKEN_BATCH_SIZE) }, (_, index) =>
    tokenIds.slice(index * TOKEN_BATCH_SIZE, (index + 1) * TOKEN_BATCH_SIZE));

  const readBatch = async (batch: string[]): Promise<T[]> => {
    const since = new Date(Date.now() - LATEST_READ_WINDOW_MS).toISOString();
    const utcToday = new Date();
    utcToday.setUTCHours(0, 0, 0, 0);
    const tomorrow = new Date(utcToday.getTime() + 24 * 60 * 60 * 1000);
    const [recent, todaySnapshots, aggregates] = await Promise.all([
      readPages<T>((from, to) => observationRead(client, (relation) => client.from(relation)
        .select(COLUMNS).in("token_id", batch).in("provider_id", PROVIDERS).is("excluded_reason", null)
        .gte("observed_at", since)
        .order("token_id").order("provider_id").order("metric_id")
        .order("observed_at", { ascending: false }).order("collected_at", { ascending: false }).order("id", { ascending: false })
        .range(from, to)), "read recent observations"),
      readPages<T>((from, to) => observationRead(client, (relation) => client.from(relation)
        .select(COLUMNS).in("token_id", batch).eq("provider_id", "coingecko").in("metric_id", COINGECKO_DAILY_METRICS)
        .is("excluded_reason", null).gte("observed_at", utcToday.toISOString()).lt("observed_at", tomorrow.toISOString())
        .order("token_id").order("metric_id").order("observed_at", { ascending: false }).order("id", { ascending: false })
        .range(from, to)), "read today's CoinGecko daily snapshots"),
      readPages<DailyAggregateRow>((from, to) => client.from("latest_token_metric_daily_aggregates")
        .select("id,token_id,chain_id,metric_id,provider_id,utc_day,value,status,source_observation_count,valid_value_count,aggregated_at,aggregation_method,first_source_observed_at,last_source_observed_at")
        .in("token_id", batch).eq("provider_id", "coingecko").in("metric_id", COINGECKO_DAILY_METRICS)
        .order("utc_day", { ascending: false }).order("token_id").order("metric_id")
        .range(from, to), "read latest daily CoinGecko values"),
    ]);

    const directRows = [...recent.rows, ...todaySnapshots.rows];
    if (aggregates.missing) return latestPerMetric(directRows);
    const aggregateRows = aggregates.rows.map((row) => dailyAggregateObservation(row, true)) as unknown as T[];
    return latestPerMetric([...directRows, ...aggregateRows]);
  };

  const results = await Promise.allSettled(batches.map(readBatch));
  const successful: T[][] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") successful.push(result.value);
    else console.error(`Latest observation batch ${index + 1}/${batches.length} failed:`, result.reason);
  }
  const rows = mergeById(...successful);
  recordApproxRead(client, rows);
  return rows;
}
/** Observations for specific provider metrics since a cutoff (bounded history for series). */
export async function readObservationWindow<T extends Row>(
  client: SupabaseAdminClient,
  tokenIds: string[],
  series: { providerId: string; metricId: string }[],
  since: Date,
): Promise<T[]> {
  if (tokenIds.length === 0) return [];
  const results = await Promise.all(series.map(async ({ providerId, metricId }) => {
    const [observations, aggregates] = await Promise.all([
      readKeyset<T>((fromObservedAt) => observationRead(client, (relation) => client.from(relation)
        .select(COLUMNS).in("token_id", tokenIds).eq("provider_id", providerId).eq("metric_id", metricId)
        .is("excluded_reason", null)
        .gte("observed_at", fromObservedAt ?? since.toISOString())
        .order("observed_at", { ascending: true }).order("id", { ascending: true })
        .limit(PAGE_SIZE)), `read ${providerId} ${metricId} history`),
      readPages<DailyAggregateRow>((from, to) => client.from("token_metric_daily_aggregates")
        .select("id,token_id,chain_id,metric_id,provider_id,utc_day,value,status,source_observation_count,valid_value_count,aggregated_at,aggregation_method,first_source_observed_at,last_source_observed_at")
        .in("token_id", tokenIds).eq("provider_id", providerId).eq("metric_id", metricId)
        .gte("utc_day", since.toISOString().slice(0, 10))
        .order("utc_day", { ascending: true }).order("id", { ascending: true })
        .range(from, to), `read ${providerId} ${metricId} daily averages`),
    ]);

    // Keep the live app compatible with environments where the migration has
    // not been applied yet; the original observation history remains readable.
    if (aggregates.missing) return observations.rows;
    const dailyRows = aggregates.rows.map((row) => dailyAggregateObservation(row)) as unknown as T[];
    return [...observations.rows, ...dailyRows];
  }));
  const rows = results.flat();
  recordApproxRead(client, rows);
  return rows;
}

/**
 * Newest raw record per token for one provider (the view from the Phase 11B
 * migration), with the original full scan as a fallback.
 */
export async function readLatestRawRecords<T extends { id: number; token_id: string | null; chain_id: string | null; collected_at: string }>(
  client: SupabaseAdminClient,
  providerId: string,
  columns: string,
): Promise<T[]> {
  const fromView = await readPages<T>((from, to) => client.from("latest_raw_provider_records")
    .select(columns).eq("provider_id", providerId).order("token_id").order("chain_id").range(from, to), `read latest ${providerId} raw records`);
  if (!fromView.missing) {
    recordApproxRead(client, fromView.rows);
    return fromView.rows;
  }

  const all = await readPages<T>((from, to) => client.from("raw_provider_records")
    .select(columns).eq("provider_id", providerId).is("excluded_reason", null)
    .order("collected_at", { ascending: false }).order("id", { ascending: false })
    .range(from, to), `read ${providerId} raw records`);
  const latest = new Map<string, T>();
  for (const record of all.rows) {
    const key = `${record.token_id}:${record.chain_id}`;
    if (record.token_id && record.chain_id && !latest.has(key)) latest.set(key, record);
  }
  const rows = [...latest.values()];
  recordApproxRead(client, rows);
  return rows;
}
