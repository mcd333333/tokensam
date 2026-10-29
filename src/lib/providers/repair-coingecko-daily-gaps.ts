import { canonicalTokens } from "../../data/canonical-tokens.ts";
import { coingeckoTokenIds } from "../../data/coingecko-token-mappings.ts";
import { fetchMarketChart, normalizeMarketChartHistory } from "./coingecko-history.ts";
import { getCoinGeckoConfig, MIN_REQUEST_INTERVAL_MS } from "./coingecko.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

export const COINGECKO_GAP_DAYS = 30;
// price_usd alone stays granular through day 37, not 30 (see
// 20261004140000_extend_price_usd_granular_window_for_risk_profile.sql): the risk
// profile's volatility is a rolling 7-day window of hourly returns, so a correct 30D
// volatility curve needs price data a further 7 days before the window it displays.
// market_cap_usd/volume_24h_usd need no such extension -- neither is read with any
// lookback beyond its own 30-day display window.
export const PRICE_GAP_DAYS = 37;
export const MAX_GAP_REPAIR_TOKENS = 10;
// A real outage (e.g. the Cloudflare Worker scheduler going down for hours) leaves a
// partial-day hole that get_coingecko_daily_gaps cannot see: as long as some data
// exists on both the day the outage started and the day it ended, neither day reads
// as "missing". This threshold is well above CoinGecko's normal ~1h observation
// cadence, so only a genuine multi-hour outage trips it, not ordinary polling jitter.
export const INTRADAY_GAP_HOURS = 6;

const PRICE_METRIC = "price_usd";
const OTHER_METRICS = ["market_cap_usd", "volume_24h_usd"];
// market_cap_usd is deliberately excluded here: retention collapses it to one
// observation/day beyond 48h (see run-retention.ts), so every daily collapse point
// would otherwise look like a ~24h "intraday gap" forever, even with no real
// outage. price_usd and volume_24h_usd are the only metrics retained continuously
// granular, so they're the only ones an intraday gap check is meaningful for.
const INTRADAY_METRICS = [PRICE_METRIC, "volume_24h_usd"];
// A price/volume outage is an outage of every CoinGecko series (one request feeds all three), so the
// midnight repair also fills market_cap_usd, which the indicators read at midnight as well.

type Gap = { token_id: string; metric_id: string; missing_date: string };
type IntradayGap = { token_id: string; metric_id: string; gap_start: string; gap_end: string };

function utcDateDaysAgo(days: number, now: Date): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Matches the indicator pipeline's own tolerance (SERIES_RULES in src/lib/indicators/series.ts):
// a daily sample counts for a UTC midnight only when it is within 30 minutes of it.
const MIDNIGHT_TOLERANCE_MS = 30 * 60 * 1000;

/**
 * UTC midnights a gap swallows entirely: no stored observation lies within the indicator
 * tolerance of them. A gap whose edges are themselves midnight samples (the one-point-per-day
 * shape retention collapses old data into) contains none, which is what stops the audit from
 * flagging every collapsed day as an outage, and a repaired gap stops being flagged once its
 * midnight point exists.
 */
export function gapMidnights(gap: { gap_start: string; gap_end: string }): number[] {
  const start = Date.parse(gap.gap_start);
  const end = Date.parse(gap.gap_end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const midnights: number[] = [];
  for (let midnight = Math.ceil(start / DAY_MS) * DAY_MS; midnight < end; midnight += DAY_MS) {
    if (midnight - start > MIDNIGHT_TOLERANCE_MS && end - midnight > MIDNIGHT_TOLERANCE_MS) midnights.push(midnight);
  }
  return midnights;
}

function toObservationRows(
  tokenId: string,
  chainId: string,
  externalAssetId: string,
  missing: Set<string>,
  intradayGaps: IntradayGap[],
  payload: Awaited<ReturnType<typeof fetchMarketChart>>,
  collectedAt: string,
) {
  const snapshot = normalizeMarketChartHistory({
    asset: { tokenId, chainId, externalAssetId },
    daily: payload,
    collectedAt,
    notAfter: {},
    existing: new Set(),
    granularDays: PRICE_GAP_DAYS,
  });
  if (!snapshot) return [];
  // One point per metric per swallowed midnight -- the nearest provider timestamp within tolerance --
  // not every hourly point of the outage: the indicators only ever read midnight samples, and
  // retention would collapse the rest to one point per day again (insert/delete churn).
  const midnights = [...new Set(intradayGaps.flatMap(gapMidnights))];
  const midnightRows = new Set<(typeof snapshot.observations)[number]>();
  for (const metricId of new Set(snapshot.observations.map((row) => row.metricId))) {
    const candidates = snapshot.observations.filter((row) => row.metricId === metricId);
    for (const midnight of midnights) {
      let best: (typeof candidates)[number] | null = null;
      for (const row of candidates) {
        const distance = Math.abs(Date.parse(row.observedAt) - midnight);
        if (distance <= MIDNIGHT_TOLERANCE_MS && (!best || distance < Math.abs(Date.parse(best.observedAt) - midnight))) best = row;
      }
      if (best) midnightRows.add(best);
    }
  }
  return snapshot.observations
    .filter((row) => missing.has(`${row.metricId}|${row.observedAt.slice(0, 10)}`) || midnightRows.has(row))
    .map((row) => ({
      token_id: row.tokenId,
      chain_id: row.chainId,
      metric_id: row.metricId,
      provider_id: "coingecko",
      raw_record_id: null,
      value: row.value,
      window_days: row.windowDays,
      status: row.status,
      observed_at: row.observedAt,
      collected_at: row.collectedAt,
      source_field: row.sourceField,
      note: "CoinGecko automatic gap repair; one real provider point per missing UTC day; no values were interpolated or synthesized.",
      scope: row.scope,
      provider_asset_id: externalAssetId,
      mapping_id: null as number | null,
    }));
}

/**
 * Repairs only missing daily CoinGecko observations: price_usd over the last 37
 * completed UTC days, market_cap_usd/volume_24h_usd over the last 30 -- each metric's
 * own granular retention window (see PRICE_GAP_DAYS above). It deliberately does not
 * write raw market_chart payloads and does not run a 90-day backfill, keeping
 * automatic recovery bounded in both storage and API usage.
 */
export async function repairCoinGeckoDailyGaps(
  client: SupabaseAdminClient,
  options: {
    now?: () => Date;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    env?: Record<string, string | undefined>;
  } = {},
) {
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const config = getCoinGeckoConfig(options.env);
  const endDate = utcDateDaysAgo(1, now());

  // Sequential on purpose: each audit takes 2-4s on its own, and run concurrently they
  // contend and exceed the API role's 8s statement_timeout, failing the whole repair.
  const priceGapsResult = await client.rpc("get_coingecko_daily_gaps", {
    p_start_date: utcDateDaysAgo(PRICE_GAP_DAYS, now()),
    p_end_date: endDate,
    p_metric_ids: [PRICE_METRIC],
  });
  const otherGapsResult = await client.rpc("get_coingecko_daily_gaps", {
    p_start_date: utcDateDaysAgo(COINGECKO_GAP_DAYS, now()),
    p_end_date: endDate,
    p_metric_ids: OTHER_METRICS,
  });
  // Covers through "today" (not just completed days): an intraday gap can still be
  // closing out right now, unlike the whole-day checks above which only look at
  // fully completed UTC days.
  const intradayGapsResult = await client.rpc("get_coingecko_intraday_gaps", {
    p_start_date: utcDateDaysAgo(PRICE_GAP_DAYS, now()),
    p_end_date: utcDateDaysAgo(0, now()),
    p_min_gap_hours: INTRADAY_GAP_HOURS,
    p_metric_ids: INTRADAY_METRICS,
  });
  if (priceGapsResult.error) throw new Error(`Supabase CoinGecko price_usd daily gap audit failed: ${priceGapsResult.error.message}`);
  if (otherGapsResult.error) throw new Error(`Supabase CoinGecko daily gap audit failed: ${otherGapsResult.error.message}`);
  if (intradayGapsResult.error) throw new Error(`Supabase CoinGecko intraday gap audit failed: ${intradayGapsResult.error.message}`);

  const allGaps = [...(priceGapsResult.data ?? []), ...(otherGapsResult.data ?? [])] as Gap[];
  const allIntradayGaps = ((intradayGapsResult.data ?? []) as IntradayGap[]).filter((gap) => gapMidnights(gap).length > 0);
  const tokenIds = [...new Set([
    ...allGaps.map((gap) => gap.token_id),
    ...allIntradayGaps.map((gap) => gap.token_id),
  ])].slice(0, MAX_GAP_REPAIR_TOKENS);
  if (tokenIds.length === 0) {
    return { checkedDays: PRICE_GAP_DAYS, affectedTokens: 0, requests: 0, observations: 0, remainingTokens: 0 };
  }

  const sleepBetweenRequests = async () => {
    await sleep(MIN_REQUEST_INTERVAL_MS);
  };

  let requests = 0;
  let observations = 0;
  for (const tokenId of tokenIds) {
    const token = canonicalTokens.find((item) => item.id === tokenId);
    const externalAssetId = token ? coingeckoTokenIds[token.id] : undefined;
    if (!token || !externalAssetId) continue;

    if (requests > 0) await sleepBetweenRequests();
    requests += 1;
    // One request covers both windows: days must span the wider of the two
    // (price_usd's 37) so a price_usd gap near day 37 is still in range.
    const payload = await fetchMarketChart(externalAssetId, { days: PRICE_GAP_DAYS + 1 }, {
      ...config,
      fetchImpl,
      sleep,
    });

    const missing = new Set(
      allGaps
        .filter((gap) => gap.token_id === tokenId)
        .map((gap) => `${gap.metric_id}|${gap.missing_date}`),
    );
    const intradayGaps = allIntradayGaps.filter((gap) => gap.token_id === tokenId);
    const rows = toObservationRows(token.id, token.chainId, externalAssetId, missing, intradayGaps, payload, now().toISOString());
    if (rows.length === 0) continue;

    const { data: mapping } = await client.from("provider_token_mappings")
      .select("id")
      .eq("provider_id", "coingecko")
      .eq("token_id", token.id)
      .maybeSingle();
    const mappingId = (mapping as { id: number } | null)?.id ?? null;
    for (const row of rows) row.mapping_id = mappingId;

    const { error } = await client.from("token_metric_observations").insert(rows);
    if (error) throw new Error(`Supabase CoinGecko daily gap repair insert failed: ${error.message}`);
    observations += rows.length;
  }

  const allAffectedTokens = new Set([
    ...allGaps.map((gap) => gap.token_id),
    ...allIntradayGaps.map((gap) => gap.token_id),
  ]);
  return {
    checkedDays: PRICE_GAP_DAYS,
    intradayGapHours: INTRADAY_GAP_HOURS,
    affectedTokens: tokenIds.length,
    requests,
    observations,
    remainingTokens: Math.max(0, allAffectedTokens.size - tokenIds.length),
  };
}
