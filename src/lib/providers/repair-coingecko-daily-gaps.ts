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

type Gap = { token_id: string; metric_id: string; missing_date: string };
type IntradayGap = { token_id: string; metric_id: string; gap_start: string; gap_end: string };

function utcDateDaysAgo(days: number, now: Date): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function withinIntradayGap(metricId: string, observedAtMs: number, intradayGaps: IntradayGap[]): boolean {
  return intradayGaps.some((gap) => gap.metric_id === metricId
    && observedAtMs > Date.parse(gap.gap_start)
    && observedAtMs < Date.parse(gap.gap_end));
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
  });
  if (!snapshot) return [];
  return snapshot.observations
    .filter((row) => {
      const day = row.observedAt.slice(0, 10);
      if (missing.has(`${row.metricId}|${day}`)) return true;
      return withinIntradayGap(row.metricId, Date.parse(row.observedAt), intradayGaps);
    })
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
  const allIntradayGaps = (intradayGapsResult.data ?? []) as IntradayGap[];
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
