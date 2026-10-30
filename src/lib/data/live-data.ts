import "server-only";

import { createSupabaseAdminClient } from "../supabase/admin.ts";
import { latestPerMetric, mergeById, readLatestObservations, readObservationWindow } from "./observation-reads.ts";
import { binanceSymbols } from "../../data/binance-token-mappings.ts";
import { BinanceMarketDataProvider, getBinanceConfig } from "../providers/binance.ts";
import type { ProviderAsset } from "../providers/types.ts";
import { memoizeWithTtl } from "./ttl-cache.ts";
import { getCacheTtlMultiplierSync, refreshThrottleLevelInBackground } from "../monitoring/quota-tracker.ts";
import { selectMovers, type Movers } from "../ui/movers.ts";
import { buildTechnicalIndicators, INDICATOR_METHOD, withExtraIndicators } from "../indicators/build.ts";
import { buildConcentrationIndicators } from "../indicators/onchain-concentration.ts";
import type { TechnicalIndicatorsView } from "../../types/technical-indicators.ts";
import { PROVIDER_STEPS, type ProviderStep, type RefreshStep } from "../refresh/config.ts";
import { buildDatasetFreshness, buildRefreshStatus, type RefreshStatusView } from "../refresh/freshness.ts";
import { buildHistoricalSeries } from "./historical-series.ts";
import { sevenDayVolume, sevenDayVolumeBands, type VolumePoint } from "./seven-day-volume.ts";
import { canonicalTokens } from "../../data/canonical-tokens.ts";
import { defillamaProtocolMappings } from "../../data/defillama-protocol-mappings.ts";
import { tokenCoverage } from "../../data/provider-coverage.ts";
import { SupabaseRefreshStore } from "../refresh/store.ts";
import { COINGECKO_MARKETS_ENDPOINT, logosFromRecords, reportedFdvFromRecords, type LogoRecord, type MarketFieldRecord } from "./token-logos.ts";
import type { HistoricalMetric, HistoricalPoint, TokenHistoricalData } from "../../types/historical-data.ts";
import {
  DASHBOARD_CALCULATED_METRICS,
  type CalculatedMetricView,
  type DashboardCalculatedKey,
  type DashboardMetricKey,
  type DashboardToken,
  type LiveTokenProfileData,
  type MetricSource,
  type OnchainMarketsData,
} from "../../types/token.ts";

/**
 * Runs `tasks` with at most `limit` in flight at once, preserving each task's own
 * result/rejection at its original index. Used to bound how many expensive optional
 * Supabase reads the dashboard fires at PostgreSQL simultaneously (see
 * getLiveDashboardData): those reads already catch their own failures and fall back
 * to empty/null data, so this only changes how much concurrent DB work they create,
 * never whether a single failed read can fail the whole dashboard.
 */
async function withConcurrencyLimit<T>(limit: number, tasks: Array<() => Promise<T>>): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

const OBSERVED_METRICS = [
  "price_usd", "price_change_24h_pct", "price_change_7d_pct", "market_cap_usd", "volume_24h_usd",
  "tvl_usd", "fees_24h_usd", "revenue_24h_usd", "circulating_supply", "total_supply", "maximum_supply",
  // DEX Screener exact-address transaction counts (market scope), shown in Market Structure.
  "transactions_24h_count", "buys_24h_count", "sells_24h_count",
];
/** Dashboard calculated metrics that need an associated protocol / a DEX mapping to be meaningful. */
const PROTOCOL_DEPENDENT: DashboardCalculatedKey[] = ["market_cap_to_tvl", "market_cap_to_revenue_24h"];
const DEX_DEPENDENT: DashboardCalculatedKey[] = [
  "dex_aggregate_liquidity_usd", "dex_aggregate_volume_24h_usd", "dex_aggregate_liquidity_to_market_cap_pct",
  "dex_volume_to_liquidity", "dex_buy_sell_ratio",
];
/** Rows of the newest metrics run are read within this span of its newest calculated_at. */
const CALCULATION_RUN_SPAN_MS = 2 * 60 * 60 * 1000;
const HISTORY_DAYS = 90;
const TVL_CHANGE_DAYS = 30;
const TVL_BASELINE_TOLERANCE_DAYS = 3;

type DbToken = {
  id: string;
  name: string;
  symbol: string;
  chain_id: string;
  contract_address: string | null;
  is_native: boolean;
  category: string;
  description: string | null;
};
type DbChain = { id: string; name: string };
type DbObservation = {
  id: number;
  token_id: string;
  chain_id: string;
  metric_id: string;
  provider_id: "coingecko" | "binance" | "defillama" | "dexscreener" | "defillama_coins" | "geckoterminal";
  value: number | string | null;
  status: string;
  observed_at: string;
  collected_at: string;
  source_field: string | null;
  note: string | null;
  daily_sample_count?: number;
  daily_valid_value_count?: number;
};

/**
 * Live price + 24h change from Binance, fetched at render time instead of read back
 * from stored history. Binance observations were previously written to
 * token_metric_observations on every refresh cycle purely so this same "latest row"
 * read pattern could serve them -- ~13K rows/day, 100% of it falling into the
 * non-chart retention bucket (Binance has no protected chart-metric exception the way
 * CoinGecko's price_usd/volume_24h_usd do), making it the second-largest contributor
 * to the database-size pressure investigated in this session. The client-side flashing
 * ticker (src/app/api/live-prices/route.ts) already proved a live, unpersisted fetch
 * works fine for this exact data; this does the same for the server-rendered price
 * instead of reading a row the app no longer writes.
 *
 * Returns the same DbObservation shape a stored read would have produced so
 * buildDashboardTokens/buildTokenHistory/livePriceRow need no change -- only where
 * these rows come from changes, not how anything downstream consumes them. A fetch
 * failure (Binance down, geo-blocked, network error) returns [] rather than throwing:
 * the existing CoinGecko fallback in livePriceRow already covers "no current Binance
 * price available" for a stale stored row, and an empty live fetch is the same case.
 */
async function fetchLiveBinanceObservations(tokenIds: string[]): Promise<DbObservation[]> {
  const assets: ProviderAsset[] = canonicalTokens
    .filter((token) => tokenIds.includes(token.id) && binanceSymbols[token.id])
    .map((token) => ({ tokenId: token.id, chainId: token.chainId, externalAssetId: binanceSymbols[token.id] }));
  if (assets.length === 0) return [];

  try {
    const provider = new BinanceMarketDataProvider(getBinanceConfig());
    const snapshots = await provider.fetchSnapshots(assets);
    let syntheticId = -1;
    return snapshots.flatMap((snapshot) => snapshot.observations.map((observation) => ({
      id: syntheticId--,
      token_id: observation.tokenId,
      chain_id: observation.chainId,
      metric_id: observation.metricId,
      provider_id: "binance" as const,
      value: observation.value,
      status: observation.status,
      observed_at: observation.observedAt,
      collected_at: observation.collectedAt,
      source_field: observation.sourceField,
      note: observation.note,
    })));
  } catch (error) {
    console.error("Live Binance fetch failed (price falls back to CoinGecko):", error);
    return [];
  }
}

type DbCalculatedMetric = {
  id: number;
  token_id: string;
  chain_id: string;
  metric_id: string;
  metric_name: string;
  unit: CalculatedMetricView["unit"];
  value: number | string | null;
  status: CalculatedMetricView["status"];
  formula: string;
  calculated_at: string;
  period_start_at: string | null;
  period_end_at: string | null;
  unavailable_reason?: string | null;
};
type DbCalculatedMetricDefinition = { id: string; category: CalculatedMetricView["category"]; source_scopes?: string | null };

function numberValue(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function latestFirst<T extends { observed_at: string; collected_at: string; id: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at)
    || Date.parse(b.collected_at) - Date.parse(a.collected_at) || b.id - a.id);
}

function observationFor(
  rows: DbObservation[],
  tokenId: string,
  providerId: DbObservation["provider_id"],
  metricId: string,
): DbObservation | undefined {
  return latestFirst(rows.filter((row) => row.token_id === tokenId && row.provider_id === providerId && row.metric_id === metricId))[0];
}

function sourceFor(row: DbObservation | undefined): MetricSource | undefined {
  return row ? { providerId: row.provider_id, collectedAt: row.collected_at, note: row.note } : undefined;
}

/**
 * How long a Binance observation may be before the live price falls back to CoinGecko.
 *
 * Binance is now fetched live at render time (see fetchLiveBinanceObservations), so a
 * fresh fetch's collected_at is always "just now" -- this is a sanity check against an
 * unusual collected_at (e.g. clock skew) rather than a real staleness gate against a
 * periodically-collected row the way it was when this provider was refresh-cron driven.
 * A failed fetch already falls back to CoinGecko on its own (fetchLiveBinanceObservations
 * returns [] rather than a stale row), so this check rarely does real work either way.
 */
export const BINANCE_PREFERRED_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * The live price and 24-hour change prefer Binance and fall back to CoinGecko.
 *
 * Binance is preferred because it is a venue's own last trade on a ~5-minute
 * refresh, where CoinGecko's /coins/markets is a cross-venue average on a
 * 15-minute one. The fallback is taken whenever Binance cannot stand behind the
 * number, which is any of:
 *
 *   - no Binance mapping for the token (USDT and halted symbols; see
 *     src/data/binance-token-mappings.ts),
 *   - a Binance row written as `unavailable`, which is what the collector does
 *     for a ticker whose last trade is too old to serve (see MAX_TICKER_AGE_MS),
 *   - a Binance row that has gone stale since it was written, for instance
 *     because the Binance refresh step has been failing while CoinGecko's keeps
 *     succeeding.
 *
 * Staleness here is measured on `collected_at`, not `observed_at`. The two
 * differ for Binance: `observed_at` is the symbol's last *trade*, which lags by
 * minutes on a thinly traded pair even though the data is current (see
 * MAX_TICKER_AGE_MS in binance.ts for the measured spread). The question this
 * function asks is whether the pipeline has refreshed recently, which is
 * `collected_at`; whether the venue's own price is frozen is already settled by
 * the collector, which writes such a row as `unavailable`.
 *
 * Returning the row rather than the value matters: the caller records which
 * provider actually supplied the number in `metricSources`, so the UI and the
 * AI layer attribute a Binance price to Binance (with its USDT-quoted,
 * single-venue note) and a fallback price to CoinGecko, and never claim one
 * provider's provenance for the other's figure.
 */
function livePriceRow(
  rows: DbObservation[],
  tokenId: string,
  metricId: "price_usd" | "price_change_24h_pct",
  now: number,
  maxAgeMs = BINANCE_PREFERRED_MAX_AGE_MS,
): DbObservation | undefined {
  const binance = observationFor(rows, tokenId, "binance", metricId);
  if (binance && binance.status === "available" && numberValue(binance.value) !== null) {
    const collectedAt = Date.parse(binance.collected_at);
    if (Number.isFinite(collectedAt) && now - collectedAt <= maxAgeMs) return binance;
  }
  return observationFor(rows, tokenId, "coingecko", metricId);
}

function observationValue(row: DbObservation | undefined): number | null {
  if (!row || row.status !== "available") return null;
  return numberValue(row.value);
}

function thirtyDayTvlChange(rows: DbObservation[], tokenId: string): number | null {
  const allTvl = latestFirst(rows.filter((row) => row.token_id === tokenId
    && row.provider_id === "defillama" && row.metric_id === "tvl_usd"));
  if (allTvl[0]?.status !== "available") return null;
  const series = latestFirst(allTvl.filter((row) => row.status === "available"))
    .map((row) => ({ row, value: numberValue(row.value), time: Date.parse(row.observed_at) }))
    .filter((point): point is { row: DbObservation; value: number; time: number } => point.value !== null)
    .sort((a, b) => a.time - b.time);
  if (series.length < 2) return null;
  const latest = series.at(-1)!;
  const target = latest.time - TVL_CHANGE_DAYS * 24 * 60 * 60 * 1000;
  const tolerance = TVL_BASELINE_TOLERANCE_DAYS * 24 * 60 * 60 * 1000;
  const baseline = series
    .filter((point) => point.time <= target && target - point.time <= tolerance)
    .at(-1);
  if (!baseline || baseline.value <= 0) return null;
  const change = ((latest.value / baseline.value) - 1) * 100;
  return Number.isFinite(change) ? change : null;
}

const CHANGE_TOLERANCE_HOURS = 3;
const HOUR_MS = 60 * 60 * 1000;
/** The latest volume_24h_usd reading is already "the past 24 hours"; comparing it against the
 *  closest reading ~24h earlier (that tick's own trailing 24h window) gives a day-over-day change
 *  in the rolling-24h figure. */
const VOLUME_CHANGE_TARGET_HOURS = 24;

/** % change in a single metric's value vs the closest stored observation `hoursAgo` before the latest one. */
function changeOverHorizon(
  rows: DbObservation[],
  tokenId: string,
  providerId: DbObservation["provider_id"],
  metricId: string,
  hoursAgo: number,
  toleranceHours = CHANGE_TOLERANCE_HOURS,
): number | null {
  const series = latestFirst(rows.filter((row) => row.token_id === tokenId && row.provider_id === providerId && row.metric_id === metricId && row.status === "available"))
    .map((row) => ({ value: numberValue(row.value), time: Date.parse(row.observed_at) }))
    .filter((point): point is { value: number; time: number } => point.value !== null)
    .sort((a, b) => a.time - b.time);
  if (series.length < 2) return null;
  const latest = series.at(-1)!;
  const target = latest.time - hoursAgo * HOUR_MS;
  const tolerance = toleranceHours * HOUR_MS;
  const baseline = series.filter((point) => point.time <= target && target - point.time <= tolerance).at(-1);
  if (!baseline || baseline.value <= 0) return null;
  const change = ((latest.value / baseline.value) - 1) * 100;
  return Number.isFinite(change) ? change : null;
}

/** Completed UTC-day values, using stored means or point-in-time snapshots after retention rolls a day up. */
function dailyAverageSeries(
  rows: DbObservation[],
  tokenId: string,
  metricId: "market_cap_usd" | "volume_24h_usd",
  aggregatesOnly = false,
  asOfMs = Date.now(),
): { day: number; value: number; collectedAt: string }[] {
  const todayUtc = Math.floor(asOfMs / DAY_MS) * DAY_MS;
  const dailyMeans = new Map<number, { sum: number; count: number; aggregate: number | null; collectedAt: string }>();
  for (const row of rows) {
    if (row.token_id !== tokenId || row.provider_id !== "coingecko" || row.metric_id !== metricId || row.status !== "available") continue;
    const value = numberValue(row.value);
    if (value === null) continue;
    const observedAt = Date.parse(row.observed_at);
    const day = Math.floor(observedAt / DAY_MS) * DAY_MS;
    if (!Number.isFinite(observedAt) || day >= todayUtc || (metricId === "market_cap_usd" ? value <= 0 : value < 0)) continue;
    const isAggregate = row.source_field === "daily_average" || row.source_field === "daily_snapshot";
    if (aggregatesOnly && !isAggregate) continue;
    const entry = dailyMeans.get(day) ?? { sum: 0, count: 0, aggregate: null, collectedAt: row.collected_at };
    if (isAggregate) {
      entry.aggregate = value;
      entry.collectedAt = row.collected_at;
    } else if (entry.aggregate === null) {
      entry.sum += value;
      entry.count += 1;
      if (Date.parse(row.collected_at) > Date.parse(entry.collectedAt)) entry.collectedAt = row.collected_at;
    }
    dailyMeans.set(day, entry);
  }
  return [...dailyMeans.entries()].map(([day, entry]) => ({
    day,
    value: entry.aggregate ?? (entry.count > 0 ? entry.sum / entry.count : NaN),
    collectedAt: entry.collectedAt,
  })).filter((point) => Number.isFinite(point.value)).sort((a, b) => a.day - b.day);
}

function latestConsecutiveDailyChange(points: { day: number; value: number }[]): number | null {
  const latest = points.at(-1);
  const previous = points.at(-2);
  if (!latest || !previous || latest.day - previous.day !== DAY_MS || previous.value <= 0) return null;
  const change = (latest.value / previous.value - 1) * 100;
  return Number.isFinite(change) ? change : null;
}

function volumeToMarketCapDailyAverageChange(rows: DbObservation[], tokenId: string, asOfMs: number): number | null {
  const marketCaps = new Map(dailyAverageSeries(rows, tokenId, "market_cap_usd", true, asOfMs).map((point) => [point.day, point.value]));
  const ratios = dailyAverageSeries(rows, tokenId, "volume_24h_usd", false, asOfMs)
    .filter((point) => marketCaps.has(point.day))
    .map((point) => ({ day: point.day, value: point.value / marketCaps.get(point.day)! }));
  return latestConsecutiveDailyChange(ratios);
}

export function buildDashboardTokens(
  tokens: DbToken[],
  chains: DbChain[],
  observations: DbObservation[],
  /** Injected for tests so Binance-vs-CoinGecko freshness is judged on a fixed clock. */
  now: number = Date.now(),
): DashboardToken[] {
  const chainNames = new Map(chains.map((chain) => [chain.id, chain.name]));
  return tokens.map((token) => {
    const metricSources: Partial<Record<DashboardMetricKey, MetricSource>> = {};
    const valueFor = (metricId: string, providerId: DbObservation["provider_id"], key: DashboardMetricKey) => {
      const row = observationFor(observations, token.id, providerId, metricId);
      const source = sourceFor(row);
      if (source) metricSources[key] = source;
      return observationValue(row);
    };
    /** Binance-preferred, CoinGecko-fallback value, attributed to whichever actually supplied it. */
    const liveValueFor = (metricId: "price_usd" | "price_change_24h_pct", key: DashboardMetricKey) => {
      const row = livePriceRow(observations, token.id, metricId, now);
      const source = sourceFor(row);
      if (source) metricSources[key] = source;
      return observationValue(row);
    };
    const tvlChange30dPct = thirtyDayTvlChange(observations, token.id);
    const latestTvl = observationFor(observations, token.id, "defillama", "tvl_usd");
    if (latestTvl) metricSources.tvlChange30dPct = {
      providerId: "calculated",
      collectedAt: latestTvl.collected_at,
      note: "Calculated server-side from DeFiLlama TVL observations approximately 30 days apart.",
    };
    const marketCapDailyAverages = dailyAverageSeries(observations, token.id, "market_cap_usd", true, now);
    const marketCapChangeDailyAveragePct = latestConsecutiveDailyChange(marketCapDailyAverages);
    const volumeChange24hPct = changeOverHorizon(observations, token.id, "coingecko", "volume_24h_usd", VOLUME_CHANGE_TARGET_HOURS);
    const volumeToMarketCapChangeDailyAveragePct = volumeToMarketCapDailyAverageChange(observations, token.id, now);
    if (marketCapChangeDailyAveragePct !== null) metricSources.marketCapChangeDailyAveragePct = {
      providerId: "calculated",
      collectedAt: marketCapDailyAverages.at(-1)!.collectedAt,
      note: "Calculated between consecutive completed UTC-day CoinGecko market-cap values; recent days may use a point-in-time snapshot and earlier retained days may use arithmetic means.",
    };
    const latestVolume = observationFor(observations, token.id, "coingecko", "volume_24h_usd");
    if (latestVolume) metricSources.volumeChange24hPct = {
      providerId: "calculated",
      collectedAt: latestVolume.collected_at,
      note: "The latest stored 24h volume (itself already a trailing 24-hour figure) vs. the closest stored 24h volume observation approximately 24 hours before that -- i.e. the past 24 hours' volume vs. the preceding 24 hours', a day-over-day change in the rolling-24h figure.",
    };
    if (volumeToMarketCapChangeDailyAveragePct !== null) metricSources.volumeToMarketCapChangeDailyAveragePct = {
      providerId: "calculated",
      collectedAt: marketCapDailyAverages.at(-1)!.collectedAt,
      note: "Calculated as the day-over-day change in daily-average CoinGecko 24-hour volume divided by completed UTC-day market-cap values.",
    };
    const tokenRows = observations.filter((row) => row.token_id === token.id);
    const observedAt = tokenRows.map((row) => row.collected_at).sort().at(-1) ?? "";
    return {
      id: token.id,
      name: token.name,
      symbol: token.symbol,
      chain: chainNames.get(token.chain_id) ?? token.chain_id,
      category: token.category,
      priceUsd: liveValueFor("price_usd", "priceUsd"),
      change24hPct: liveValueFor("price_change_24h_pct", "change24hPct"),
      change7dPct: valueFor("price_change_7d_pct", "coingecko", "change7dPct"),
      marketCapUsd: valueFor("market_cap_usd", "coingecko", "marketCapUsd"),
      volume24hUsd: valueFor("volume_24h_usd", "coingecko", "volume24hUsd"),
      fdvUsd: null,
      circulatingSupply: valueFor("circulating_supply", "coingecko", "circulatingSupply"),
      maximumSupply: valueFor("maximum_supply", "coingecko", "maximumSupply"),
      tvlUsd: valueFor("tvl_usd", "defillama", "tvlUsd"),
      tvlChange30dPct,
      volumeChange24hPct,
      marketCapChangeDailyAveragePct,
      volumeToMarketCapChangeDailyAveragePct,
      fees24hUsd: valueFor("fees_24h_usd", "defillama", "fees24hUsd"),
      revenue24hUsd: valueFor("revenue_24h_usd", "defillama", "revenue24hUsd"),
      observedAt,
      metricSources,
    };
  });
}

/**
 * Chart series from stored provider observations and explicitly labeled daily
 * aggregates. Each series carries
 * per-period coverage (24H/7D/30D/90D windows ending at `now`), so the UI
 * reports what exists instead of implying a full period. Nothing is
 * interpolated, zero-filled, or synthesized.
 */
export function buildTokenHistory(
  tokenId: string,
  observations: DbObservation[],
  now = new Date(),
  options: { defiLlamaMapped?: boolean } = {},
): TokenHistoricalData {
  const cutoff = now.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const definitions: { key: HistoricalMetric; metricId: string; providerId: "coingecko" | "defillama"; scope: "token" | "protocol"; unmappedReason?: string }[] = [
    { key: "priceUsd", metricId: "price_usd", providerId: "coingecko", scope: "token" },
    {
      key: "tvlUsd", metricId: "tvl_usd", providerId: "defillama", scope: "protocol",
      unmappedReason: "No curated DeFiLlama protocol mapping exists for this token, so protocol TVL is unavailable by design.",
    },
    { key: "volumeUsd", metricId: "volume_24h_usd", providerId: "coingecko", scope: "token" },
    { key: "marketCapUsd", metricId: "market_cap_usd", providerId: "coingecko", scope: "token" },
  ];
  const sources: TokenHistoricalData["sources"] = {};
  const series = Object.fromEntries(definitions.map(({ key, metricId, providerId, scope, unmappedReason }) => {
    const rows = observations.filter((row) => row.token_id === tokenId && row.metric_id === metricId
      && row.provider_id === providerId && row.status === "available" && Date.parse(row.observed_at) >= cutoff)
      .sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at) || a.id - b.id);
    const source = sourceFor(rows.at(-1));
    if (source) sources[key] = source;
    const points = rows.flatMap((row): HistoricalPoint[] => {
      const valueUsd = numberValue(row.value);
      if (valueUsd === null) return [];
      const point: HistoricalPoint = {
        timestamp: new Date(row.observed_at).toISOString(),
        valueUsd,
        sourceId: row.source_field === "daily_average" ? `daily-average:${Math.abs(row.id)}` : `obs:${row.id}`,
      };
      if (row.source_field === "daily_average") {
        point.aggregation = {
          method: "arithmetic_mean",
          sampleCount: row.daily_valid_value_count ?? row.daily_sample_count ?? 0,
        };
      }
      return [point];
    });
    const reason = providerId === "defillama" && options.defiLlamaMapped === false && unmappedReason
      ? unmappedReason
      : `No stored ${providerId === "coingecko" ? "CoinGecko" : "DeFiLlama"} observations in the last ${HISTORY_DAYS} days.`;
    return [key, buildHistoricalSeries({ metric: key, providerId, scope, points, asOf: now, unavailableReason: reason })];
  })) as Pick<TokenHistoricalData, "priceUsd" | "tvlUsd" | "volumeUsd" | "marketCapUsd">;
  const observedAt = observations.filter((row) => row.token_id === tokenId)
    .map((row) => row.observed_at).sort().at(-1) ?? now.toISOString();
  return { tokenId, asOf: now.toISOString(), observedAt, sources, ...series };
}

export function buildCalculatedMetrics(rows: DbCalculatedMetric[], definitions: DbCalculatedMetricDefinition[]): CalculatedMetricView[] {
  const scopes = new Map(definitions.map((definition) => [definition.id, definition.source_scopes ?? null]));
  const categories = new Map(definitions.map((definition) => [definition.id, definition.category]));
  const latest = new Map<string, DbCalculatedMetric>();
  for (const row of [...rows].sort((a, b) => Date.parse(b.calculated_at) - Date.parse(a.calculated_at) || b.id - a.id)) {
    if (!latest.has(row.metric_id)) latest.set(row.metric_id, row);
  }
  const categoryOrder = ["valuation", "growth", "market_structure", "divergence"];
  return [...latest.values()]
    .filter((row) => categories.has(row.metric_id))
    .map((row) => ({ row, category: categories.get(row.metric_id)! }))
    .sort((a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category) || a.row.metric_name.localeCompare(b.row.metric_name))
    .map(({ row, category }) => ({
      id: row.metric_id,
      name: row.metric_name,
      category,
      unit: row.unit,
      value: row.status === "available" ? numberValue(row.value) : null,
      status: row.status,
      formula: row.formula,
      calculatedAt: row.calculated_at,
      periodStartAt: row.period_start_at,
      periodEndAt: row.period_end_at,
      unavailableReason: row.status === "available" ? null : row.unavailable_reason ?? null,
      sourceScopes: scopes.get(row.metric_id) ?? null,
    }));
}

type SupabaseAdminClient = ReturnType<typeof createSupabaseAdminClient>;
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_SERIES = [
  { providerId: "coingecko", metricId: "price_usd" },
  { providerId: "defillama", metricId: "tvl_usd" },
  { providerId: "coingecko", metricId: "volume_24h_usd" },
  { providerId: "coingecko", metricId: "market_cap_usd" },
];
/** Extra history read only for technical indicators (price, volume, market cap and TVL come from HISTORY_SERIES). */
const INDICATOR_EXTRA_SERIES = [{ providerId: "coingecko", metricId: "circulating_supply" }];
/**
 * GeckoTerminal's own normalized aggregates (market scope, exact-address only):
 * liquidity_usd is its most liquid pool's reserve, volume_24h_usd is summed
 * across every matched pool, mirroring the DEX Screener normalizer's semantics
 * but from GeckoTerminal's own pool coverage and snapshot time.
 */
const GECKO_TERMINAL_SERIES = [
  { providerId: "geckoterminal", metricId: "liquidity_usd" },
  { providerId: "geckoterminal", metricId: "volume_24h_usd" },
  { providerId: "geckoterminal", metricId: "price_change_24h_pct" },
  { providerId: "geckoterminal", metricId: "fdv_usd" },
  { providerId: "geckoterminal", metricId: "market_cap_usd" },
];

type DbCalculatedValue = {
  id: number;
  token_id: string;
  metric_id: string;
  value: number | string | null;
  status: CalculatedMetricView["status"];
  calculated_at: string;
};

/** Latest stored value per token for each dashboard calculated metric; unavailable/invalid stay null. */
export function latestCalculatedValues(rows: DbCalculatedValue[]): Map<string, Partial<Record<DashboardCalculatedKey, number | null>>> {
  const known = new Set<string>(DASHBOARD_CALCULATED_METRICS);
  const seen = new Set<string>();
  const byToken = new Map<string, Partial<Record<DashboardCalculatedKey, number | null>>>();
  for (const row of [...rows].sort((a, b) => Date.parse(b.calculated_at) - Date.parse(a.calculated_at) || b.id - a.id)) {
    const key = `${row.token_id}|${row.metric_id}`;
    if (!known.has(row.metric_id) || seen.has(key)) continue;
    seen.add(key);
    const values = byToken.get(row.token_id) ?? {};
    values[row.metric_id as DashboardCalculatedKey] = row.status === "available" ? numberValue(row.value) : null;
    byToken.set(row.token_id, values);
  }
  return byToken;
}

/**
 * Presentation extras for dashboard rows: logo, stored calculated values, and
 * coverage. Protocol- and DEX-dependent values are kept only when the curated
 * mapping exists, so no unmapped (e.g. wrapped-proxy) value can surface.
 */
export function attachDashboardExtras(
  tokens: DashboardToken[],
  extras: {
    logos: Record<string, string>;
    calculated: Map<string, Partial<Record<DashboardCalculatedKey, number | null>>>;
    fdv?: Record<string, { value: number; supply: number | null; collectedAt: string }>;
    /** 7D volume (sum of seven non-overlapping 24-hour observations); absent = unavailable. */
    volume7d?: Record<string, number>;
  },
): DashboardToken[] {
  return tokens.map((token) => {
    const canonical = canonicalTokens.find((candidate) => candidate.id === token.id);
    const coverage = canonical ? tokenCoverage(canonical) : [];
    const protocolMapped = coverage.some((item) => item.provider === "defillama" && item.status === "mapped");
    const dexMapped = coverage.some((item) => item.provider === "dexscreener" && item.status === "mapped");
    const stored = extras.calculated.get(token.id) ?? {};
    const calculated: Partial<Record<DashboardCalculatedKey, number | null>> = {};
    for (const key of DASHBOARD_CALCULATED_METRICS) {
      const allowed = (!PROTOCOL_DEPENDENT.includes(key) || protocolMapped) && (!DEX_DEPENDENT.includes(key) || dexMapped);
      calculated[key] = allowed ? stored[key] ?? null : null;
    }
    const valid = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value);
    const fdv = extras.fdv?.[token.id] ?? null;
    return {
      ...token,
      fdvUsd: fdv?.value ?? null,
      fdvSupply: fdv?.supply ?? null,
      volume7dUsd: extras.volume7d?.[token.id] ?? null,
      metricSources: fdv
        ? { ...token.metricSources, fdvUsd: { providerId: "coingecko", collectedAt: fdv.collectedAt, note: "Token-level FDV as reported in the stored market-data record." } }
        : token.metricSources,
      logoUrl: extras.logos[token.id] ?? null,
      calculated,
      coverage: {
        isNative: canonical?.isNative ?? false,
        protocolMapped,
        dexMapped,
        hasProtocolData: protocolMapped && [token.tvlUsd, token.fees24hUsd, token.revenue24hUsd].some(valid),
        hasDexData: dexMapped && DEX_DEPENDENT.some((key) => valid(calculated[key])),
      },
    };
  });
}

/**
 * 7D volume per token from stored CoinGecko 24-hour volume observations (see
 * seven-day-volume.ts). Reads only the seven narrow bands around each token's
 * latest volume observation; optional, so a failed read leaves 7D volume
 * unavailable rather than failing the dashboard.
 */
async function readSevenDayVolumes(client: SupabaseAdminClient, latest: DbObservation[]): Promise<Record<string, number>> {
  try {
    const anchors = latest
      .filter((row) => row.provider_id === "coingecko" && row.metric_id === "volume_24h_usd")
      .map((row) => ({ tokenId: row.token_id, observedAt: row.observed_at }));
    const bandRows = await Promise.all(sevenDayVolumeBands(anchors).map(async (band) => {
      const rows: (VolumePoint & { id: number; token_id: string })[] = [];
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await client.from("token_metric_observations")
          .select("id,token_id,value,status,observed_at")
          .eq("provider_id", "coingecko").eq("metric_id", "volume_24h_usd").in("token_id", band.tokenIds)
          .is("excluded_reason", null).gte("observed_at", band.from).lte("observed_at", band.to)
          .order("id", { ascending: true }).range(offset, offset + 999);
        if (error) throw error;
        rows.push(...((data ?? []) as (VolumePoint & { id: number; token_id: string })[]));
        if ((data ?? []).length < 1000) return rows;
      }
    }));
    const byToken = new Map<string, VolumePoint[]>();
    for (const row of mergeById(...bandRows)) byToken.set(row.token_id, [...(byToken.get(row.token_id) ?? []), row]);
    const result: Record<string, number> = {};
    for (const [tokenId, points] of byToken) {
      const volume = sevenDayVolume(points);
      if (volume) result[tokenId] = volume.valueUsd;
    }
    return result;
  } catch (error) {
    console.error("7D volume read failed (shown as unavailable):", error);
    return {};
  }
}

/** Token-level FDV from the latest stored /coins/markets payloads; optional, so a failed read leaves FDV unavailable. */
async function readReportedFdv(client: SupabaseAdminClient, tokenIds: string[]): Promise<Record<string, { value: number; supply: number | null; collectedAt: string }>> {
  // Read directly from the indexed CoinGecko markets history instead of the latest_raw
  // view (same fix as readTokenLogos below, for the same reason): that view's DISTINCT ON
  // over the full raw_provider_records table has no matching index and was intermittently
  // hitting the 2-minute statement_timeout under concurrent load (dashboard reads racing
  // the refresh/GeckoTerminal/retention cron ticks), which surfaced as FDV silently going
  // blank. This query can use the same provider/endpoint/token/collected_at index the logo
  // read already relies on.
  try {
    // Bounded to the newest 5000 rows (descending), same as readTokenLogos below — with
    // hundreds of tokens and a retention window on raw_provider_records, the full match
    // set can exceed that. reportedFdvFromRecords() then overwrites on every matching
    // record without sorting itself (unlike logosFromRecords, which re-sorts and takes
    // the first hit), so within that bounded set the array is reversed to oldest-first:
    // the newest record for each token is then the last write and wins.
    const result = await client.from("raw_provider_records")
      .select("token_id,collected_at,endpoint_label,payload_id:payload->>id,fdv:payload->fully_diluted_valuation,price:payload->current_price")
      .eq("provider_id", "coingecko")
      .eq("endpoint_label", COINGECKO_MARKETS_ENDPOINT)
      .in("token_id", tokenIds)
      .is("excluded_reason", null)
      .order("collected_at", { ascending: false })
      .limit(5000);
    if (result.error) throw result.error;
    const records = ((result.data ?? []) as unknown as MarketFieldRecord[]).slice().reverse();
    return reportedFdvFromRecords(records);
  } catch (error) {
    console.error("Reported FDV read failed (FDV shown as unavailable):", error);
    return {};
  }
}

/** Logos from stored CoinGecko /coins/markets payloads; cosmetic, so failures yield no logos. */
async function readTokenLogos(client: SupabaseAdminClient, tokenIds: string[]): Promise<Record<string, string>> {
  // Logos are persistent metadata. Read them directly from the indexed
  // CoinGecko markets history instead of the latest_raw view: that view can
  // become expensive under database load, while this query can use the
  // provider/endpoint/token/collected_at index.
  const columns = "token_id,collected_at,endpoint_label,image:payload->>image,payload_id:payload->>id";

  try {
    const result = await client.from("raw_provider_records").select(columns)
      .eq("provider_id", "coingecko")
      .eq("endpoint_label", COINGECKO_MARKETS_ENDPOINT)
      .in("token_id", tokenIds)
      .is("excluded_reason", null)
      .order("collected_at", { ascending: false })
      .limit(5000);

    if (result.error) {
      console.error("Token logo read failed; logos fall back to monograms:", result.error);
      return {};
    }

    return logosFromRecords((result.data ?? []) as unknown as LogoRecord[]);
  } catch (error) {
    console.error("Token logo read threw; logos fall back to monograms:", error);
    return {};
  }
}

type GeckoTerminalRawPool = {
  attributes?: {
    address?: string;
    pool_created_at?: string | null;
    reserve_in_usd?: string | number | null;
    volume_usd?: { h24?: string | number | null };
    token_price_usd?: string | number | null;
  };
};

/**
 * GeckoTerminal on-chain pools for this token's exact network/address identity.
 * `provider_pairs` holds the indexed pool identity (address, DEX, creation
 * time); per-pool liquidity/volume are not separate columns (avoiding
 * duplicate metric storage), so they are read back from the same raw payload
 * already preserved in `raw_provider_records` and matched by pool address.
 * Optional: a failed read leaves pools empty rather than failing the profile.
 */
async function readGeckoTerminalPools(
  client: SupabaseAdminClient,
  tokenId: string,
): Promise<{ dexes: string[]; pools: OnchainMarketsData["pools"]; collectedAt: string | null }> {
  try {
    const [pairsResult, rawResult] = await Promise.all([
      client.from("provider_pairs")
        .select("pair_address,dex_id,pair_created_at")
        .eq("provider_id", "geckoterminal").eq("token_id", tokenId),
      client.from("latest_raw_provider_records")
        .select("collected_at,payload")
        .eq("provider_id", "geckoterminal").eq("token_id", tokenId).maybeSingle(),
    ]);
    if (pairsResult.error) throw pairsResult.error;
    if (rawResult.error) throw rawResult.error;
    const pairRows = (pairsResult.data ?? []) as { pair_address: string; dex_id: string | null; pair_created_at: string | null }[];
    const rawRecord = rawResult.data as { collected_at?: string; payload?: { providerPools?: GeckoTerminalRawPool[] } } | null;
    const rawPools = rawRecord?.payload?.providerPools ?? [];
    const poolByAddress = new Map(rawPools
      .filter((pool) => pool.attributes?.address)
      .map((pool) => [pool.attributes!.address!.toLowerCase(), pool]));
    const pools = pairRows.map((row) => {
      const raw = poolByAddress.get(row.pair_address.toLowerCase());
      return {
        pairAddress: row.pair_address,
        dexId: row.dex_id,
        createdAt: row.pair_created_at,
        liquidityUsd: numberValue(raw?.attributes?.reserve_in_usd),
        volume24hUsd: numberValue(raw?.attributes?.volume_usd?.h24),
        priceUsd: numberValue(raw?.attributes?.token_price_usd),
      };
    });
    return {
      pools,
      dexes: [...new Set(pools.map((pool) => pool.dexId).filter((id): id is string => Boolean(id)))],
      collectedAt: rawRecord?.collected_at ?? null,
    };
  } catch (error) {
    console.error(`GeckoTerminal pool read failed for ${tokenId} (shown as unavailable):`, error);
    return { pools: [], dexes: [], collectedAt: null };
  }
}

/** Latest rows of the newest metrics run for the dashboard's calculated metrics (read-only). */
async function readDashboardCalculated(client: SupabaseAdminClient, tokenIds: string[]): Promise<DbCalculatedValue[]> {
  const metricIds = [...DASHBOARD_CALCULATED_METRICS];
  const newest = await client.from("calculated_metric_observations").select("calculated_at")
    .in("metric_id", metricIds).order("calculated_at", { ascending: false }).limit(1);
  if (newest.error) throw newest.error;
  const newestAt = (newest.data?.[0] as { calculated_at?: string } | undefined)?.calculated_at;
  if (!newestAt) return [];
  const since = new Date(Date.parse(newestAt) - CALCULATION_RUN_SPAN_MS).toISOString();
  const rows: DbCalculatedValue[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await client.from("calculated_metric_observations")
      .select("id,token_id,metric_id,value,status,calculated_at")
      .in("metric_id", metricIds).in("token_id", tokenIds).gte("calculated_at", since)
      .order("id", { ascending: true }).range(offset, offset + 999);
    if (page.error) throw page.error;
    rows.push(...((page.data ?? []) as DbCalculatedValue[]));
    if ((page.data ?? []).length < 1000) return rows;
  }
}

/** Latest value per displayed metric; history only where a view needs it. */
async function readLatest(client: SupabaseAdminClient, tokenIds: string[]): Promise<DbObservation[]> {
  const rows = await readLatestObservations<DbObservation>(client, tokenIds, { metricIds: OBSERVED_METRICS });
  return rows.filter((row) => OBSERVED_METRICS.includes(row.metric_id));
}

async function readRefreshStatus(client: SupabaseAdminClient, latestRows: DbObservation[], now = new Date()): Promise<RefreshStatusView> {
  const latestCollected: Partial<Record<ProviderStep, string>> = {};
  for (const row of latestRows) {
    const provider = row.provider_id as ProviderStep;
    if (PROVIDER_STEPS.includes(provider) && (!latestCollected[provider] || row.collected_at > latestCollected[provider]!)) {
      latestCollected[provider] = row.collected_at;
    }
  }
  let lastSuccess: Partial<Record<RefreshStep, string>> = {};
  let latestRunStatus: string | null = null;
  try {
    const store = new SupabaseRefreshStore(client);
    const [steps, run] = await Promise.all([store.lastSuccessfulSteps(), store.latestRun()]);
    lastSuccess = steps;
    latestRunStatus = run?.status ?? null;
  } catch {
    // Refresh-status tables arrive with the Phase 11B migration; until then,
    // freshness falls back to stored collection times.
  }
  return buildRefreshStatus({ lastSuccess, latestCollected, latestRunStatus, now });
}

// Collectors only refresh data every 5-15 minutes (see REFRESH_POLICY), so caching
// for up to a minute here costs no meaningful freshness but coalesces repeat page
// views, crawlers, and concurrent requests on the same warm instance into one
// Supabase read instead of one each (see ttl-cache.ts). Raised from 20s: Log
// Ingestion/Egress are dominated by exactly this kind of duplicate read (see the
// request-volume investigation this cache was built from), so the TTL is set as high
// as the data's own refresh cadence allows rather than just high enough to deduplicate
// bursts.
const DASHBOARD_CACHE_TTL_MS = 60_000;

async function getLiveDashboardDataUncached(): Promise<{ tokens: DashboardToken[]; error: string | null; refreshStatus: RefreshStatusView | null }> {
  try {
    const client = createSupabaseAdminClient();
    refreshThrottleLevelInBackground(client);
    const [tokenResult, chainResult] = await Promise.all([
      client.from("tokens").select("id,name,symbol,chain_id,contract_address,is_native,category,description").order("name"),
      client.from("chains").select("id,name"),
    ]);
    if (tokenResult.error) throw tokenResult.error;
    if (chainResult.error) throw chainResult.error;
    const tokens = (tokenResult.data ?? []) as DbToken[];
    if (tokens.length === 0) throw new Error("Canonical token registry is empty.");
    const tokenIds = tokens.map((token) => token.id);
    // 30-day TVL change needs DeFiLlama TVL around 30 days ago (plus baseline tolerance).
    const tvlSince = new Date(Date.now() - (TVL_CHANGE_DAYS + TVL_BASELINE_TOLERANCE_DAYS + 1) * DAY_MS);
    const latestRead = readLatest(client, tokenIds);
    // Binance is fetched live (not read from Supabase) -- see fetchLiveBinanceObservations.
    // Runs alongside the Supabase reads below rather than counting against their
    // concurrency limit, since it is a direct Binance HTTP call, not another
    // statement-timeout-sensitive Postgres query.
    const binanceLiveRead = fetchLiveBinanceObservations(tokenIds);
    // Bounded to 2 concurrent Supabase reads at a time: these six each hit PostgreSQL
    // independently (latest observations, TVL history, logos, FDV, calculated metrics,
    // 7D volume), and firing all of them at once was adding to the statement-timeout
    // (57014) pressure seen under load. Each read already handles its own optional
    // failure (falls back to empty/null data below) — only the concurrency changes.
    const [latest, tvlHistory, logos, fdv, calculatedRows, volume7d] = await withConcurrencyLimit(2, [
      () => latestRead,
      () => readObservationWindow<DbObservation>(client, tokenIds, [{ providerId: "defillama", metricId: "tvl_usd" }], tvlSince).catch((error) => {
        console.error("Dashboard TVL history read failed (30D TVL change shown as unavailable):", error);
        return [] as DbObservation[];
      }),
      () => readTokenLogos(client, tokenIds),
      () => readReportedFdv(client, tokenIds),
      // Calculated columns are optional context: a failed read hides them instead of failing the page.
      () => readDashboardCalculated(client, tokenIds).catch((error) => {
        console.error("Dashboard calculated-metric read failed:", error);
        return [] as DbCalculatedValue[];
      }),
      () => latestRead.then((rows) => readSevenDayVolumes(client, rows)),
    ] satisfies Array<() => Promise<unknown>>) as [
      DbObservation[], DbObservation[], Record<string, string>, Record<string, { value: number; supply: number | null; collectedAt: string }>, DbCalculatedValue[], Record<string, number>,
    ];
    const binanceLive = await binanceLiveRead;
    const refreshStatus = await readRefreshStatus(client, latest);
    const baseTokens = buildDashboardTokens(tokens, (chainResult.data ?? []) as DbChain[], mergeById(latest, tvlHistory, binanceLive));
    return {
      tokens: attachDashboardExtras(baseTokens, { logos, calculated: latestCalculatedValues(calculatedRows), fdv, volume7d }),
      error: null,
      refreshStatus,
    };
  } catch (error) {
    console.error("Live dashboard data load failed:", error);
    return { tokens: [], error: "Live data is temporarily unavailable. No demo data is being shown.", refreshStatus: null };
  }
}

export const getLiveDashboardData = memoizeWithTtl(
  getLiveDashboardDataUncached,
  () => DASHBOARD_CACHE_TTL_MS * getCacheTtlMultiplierSync(),
  () => "dashboard",
);

const PROFILE_CACHE_TTL_MS = 60_000;

/** `client` is injectable so the AI analysis reads the same profile data through the caller's client. */
async function getLiveTokenProfileUncached(
  tokenId: string,
  client: SupabaseAdminClient = createSupabaseAdminClient(),
  options: { includeLiveBinance?: boolean } = {},
): Promise<LiveTokenProfileData | null> {
  // The deterministic AI analysis engine (deterministic-service.ts, analysis/service.ts)
  // reuses this same profile read and must never make an external network call of any
  // kind -- that is a hard invariant enforced by its own tests, for reproducibility.
  // Those callers pass includeLiveBinance: false to skip the live Binance fetch below;
  // every other caller (the profile page itself) wants it, so it defaults on.
  const includeLiveBinance = options.includeLiveBinance ?? true;
  refreshThrottleLevelInBackground(client);
  const { data: tokenData, error: tokenError } = await client.from("tokens")
    .select("id,name,symbol,chain_id,contract_address,is_native,category,description")
    .eq("id", tokenId).maybeSingle();
  if (tokenError) throw tokenError;
  if (!tokenData) return null;
  const tokenRow = tokenData as DbToken;
  const [chainResult, observations, calculatedResult, definitionResult, mappingResult, logos, supplyHistory, reportedFdv, gtPools] = await Promise.all([
    client.from("chains").select("id,name").eq("id", tokenRow.chain_id).maybeSingle(),
    readLatest(client, [tokenId]).then(async (latest) => mergeById(
      latest,
      await readObservationWindow<DbObservation>(client, [tokenId], HISTORY_SERIES, new Date(Date.now() - HISTORY_DAYS * DAY_MS)),
      // GeckoTerminal's own aggregates (market scope); a separate provider, read the same way as history series.
      await readObservationWindow<DbObservation>(client, [tokenId], GECKO_TERMINAL_SERIES, new Date(Date.now() - HISTORY_DAYS * DAY_MS)),
      // Binance's live price + 24h change (see fetchLiveBinanceObservations) -- fetched
      // live, not read from Supabase.
      includeLiveBinance ? await fetchLiveBinanceObservations([tokenId]) : [],
    )),
    client.from("calculated_metric_observations")
      .select("id,token_id,chain_id,metric_id,metric_name,unit,value,status,formula,calculated_at,period_start_at,period_end_at,unavailable_reason:provenance->>unavailable_reason")
      .eq("token_id", tokenId).order("calculated_at", { ascending: false }).order("id", { ascending: false }).range(0, 999),
    client.from("calculated_metric_definitions").select("id,category,source_scopes"),
    client.from("provider_token_mappings").select("provider_id,chain_id,external_asset_id,external_contract_address").eq("token_id", tokenId),
    readTokenLogos(client, [tokenId]),
    // Supply history is read only for technical indicators; a failed read just omits them.
    readObservationWindow<DbObservation>(client, [tokenId], INDICATOR_EXTRA_SERIES, new Date(Date.now() - HISTORY_DAYS * DAY_MS))
      .catch((error) => { console.error(`Indicator supply history read failed for ${tokenId}:`, error); return [] as DbObservation[]; }),
    // Token-level FDV from the stored market-data record (Tokenomics); failures leave it unavailable.
    readReportedFdv(client, [tokenId]),
    // GeckoTerminal pool identity (DEX, address, creation time); optional, so a failed read leaves it empty.
    readGeckoTerminalPools(client, tokenId),
  ]);
  if (chainResult.error) throw chainResult.error;
  if (calculatedResult.error) throw calculatedResult.error;
  if (definitionResult.error) throw definitionResult.error;
  if (mappingResult.error) throw mappingResult.error;
  const chain = chainResult.data as DbChain | null;
  const baseToken = buildDashboardTokens([tokenRow], chain ? [chain] : [], observations)[0];
  const fdv = reportedFdv[tokenId] ?? null;
  const token = fdv
    ? { ...baseToken, fdvUsd: fdv.value, metricSources: { ...baseToken.metricSources, fdvUsd: { providerId: "coingecko" as const, collectedAt: fdv.collectedAt, note: "Token-level FDV as reported in the stored market-data record." } } }
    : baseToken;
  const metricSources: Record<string, MetricSource> = {};
  const sourceMetric = (metricId: string, provider: DbObservation["provider_id"]) => {
    const source = sourceFor(observationFor(observations, tokenId, provider, metricId));
    if (source) metricSources[metricId] = source;
    return observationValue(observationFor(observations, tokenId, provider, metricId));
  };
  const notes = [...new Set(observations
    .filter((row) => row.token_id === tokenId && row.note)
    .sort((a, b) => Date.parse(b.collected_at) - Date.parse(a.collected_at))
    .slice(0, 8)
    .map((row) => row.note as string))];
  const mappings = (mappingResult.data ?? []) as { provider_id: string; chain_id: string; external_asset_id: string; external_contract_address: string | null }[];
  const calc = buildCalculatedMetrics(
    (calculatedResult.data ?? []) as DbCalculatedMetric[],
    (definitionResult.data ?? []) as DbCalculatedMetricDefinition[],
  );
  // Freshness comes from the latest row per metric; backfilled history is collected later but is older data.
  const latestCollection = latestPerMetric(observations).map((row) => row.collected_at).sort().at(-1);
  if (latestCollection) metricSources.snapshot = { providerId: "calculated", collectedAt: latestCollection };
  // Per-token freshness uses the latest row per metric only: history-window rows (e.g. a backfill) are
  // collected later but hold older data, and a global refresh time would overstate this token's freshness.
  const latestTokenRows = latestPerMetric(observations.filter((row) => row.token_id === tokenId));
  const canonicalToken = canonicalTokens.find((candidate) => candidate.id === tokenId);
  const coverage = canonicalToken ? tokenCoverage(canonicalToken) : [];
  const tokenLevelPriceRow = observationFor(observations, tokenId, "defillama_coins", "price_usd");
  const protocolMapping = defillamaProtocolMappings.find((mapping) => mapping.tokenId === tokenId);
  const dexMapped = coverage.some((item) => item.provider === "dexscreener" && item.status === "mapped");
  // Market-scope counts only for a curated exact-address mapping; never from a wrapped proxy.
  const dexCount = (metricId: string) => dexMapped ? observationValue(observationFor(observations, tokenId, "dexscreener", metricId)) : null;
  const protocolMapped = coverage.some((item) => item.provider === "defillama" && item.status === "mapped");
  // GeckoTerminal identity: network + exact contract address, from its own curated mapping (never a
  // wrapped or ticker-matched substitute). The chain name reuses this token's own chain lookup, since the
  // canonical chain the mapping is keyed to is always this token's own chain in the current mapping data.
  const gtMapping = mappings.find((mapping) => mapping.provider_id === "geckoterminal");
  const onchainMarkets: OnchainMarketsData | null = gtMapping
    ? {
      network: gtMapping.chain_id === tokenRow.chain_id ? (chain?.name ?? gtMapping.chain_id) : gtMapping.chain_id,
      contractAddress: gtMapping.external_contract_address,
      liquidityUsd: observationValue(observationFor(observations, tokenId, "geckoterminal", "liquidity_usd")),
      volume24hUsd: observationValue(observationFor(observations, tokenId, "geckoterminal", "volume_24h_usd")),
      priceChange24hPct: observationValue(observationFor(observations, tokenId, "geckoterminal", "price_change_24h_pct")),
      fdvUsd: observationValue(observationFor(observations, tokenId, "geckoterminal", "fdv_usd")),
      marketCapUsd: observationValue(observationFor(observations, tokenId, "geckoterminal", "market_cap_usd")),
      dexes: gtPools.dexes,
      pools: gtPools.pools,
    }
    : null;
  let technicalIndicators: TechnicalIndicatorsView | null = null;
  const nowIso = new Date().toISOString();
  try {
    technicalIndicators = buildTechnicalIndicators(mergeById(observations, supplyHistory), { asOf: new Date(), protocolMapped });
  } catch (error) {
    // Indicators are optional context: a calculation failure hides the section, never the profile.
    console.error(`Technical indicator calculation failed for ${tokenId}:`, error);
  }
  // On-chain concentration (Pool/DEX HHI): cross-sectional, from the latest GeckoTerminal
  // snapshot only. Merged in even if the daily-series indicators above found nothing.
  const concentrationIndicators = onchainMarkets
    ? buildConcentrationIndicators(onchainMarkets.pools, { collectedAt: gtPools.collectedAt, calculatedAt: nowIso })
    : [];
  if (concentrationIndicators.length > 0) {
    technicalIndicators = withExtraIndicators(technicalIndicators ?? { calculatedAt: nowIso, method: INDICATOR_METHOD, groups: [] }, concentrationIndicators);
  }
  return {
    token,
    technicalIndicators,
    description: tokenRow.description,
    contractAddress: tokenRow.contract_address,
    isNative: tokenRow.is_native,
    circulatingSupply: sourceMetric("circulating_supply", "coingecko"),
    totalSupply: sourceMetric("total_supply", "coingecko"),
    maximumSupply: sourceMetric("maximum_supply", "coingecko"),
    metricSources,
    calculatedMetrics: calc,
    history: buildTokenHistory(tokenId, observations, new Date(), { defiLlamaMapped: mappings.some((mapping) => mapping.provider_id === "defillama") }),
    dataNotes: notes,
    dexMapped: mappings.some((mapping) => mapping.provider_id === "dexscreener"),
    defiLlamaMapped: mappings.some((mapping) => mapping.provider_id === "defillama"),
    datasetFreshness: buildDatasetFreshness({
      rows: latestTokenRows,
      // Only datasets this token's profile actually shows; unmapped DEX/protocol rows never count.
      relevant: ["coingecko", "defillama_coins", ...(dexMapped ? ["dexscreener" as const] : []), ...(protocolMapped && protocolMapping ? ["defillama" as const] : [])],
      calculatedAt: calc.map((item) => item.calculatedAt).sort().at(-1) ?? null,
      now: new Date(),
    }),
    coverage,
    tokenLevelPrice: tokenLevelPriceRow && tokenLevelPriceRow.status === "available" && numberValue(tokenLevelPriceRow.value) !== null
      ? { value: numberValue(tokenLevelPriceRow.value) as number, observedAt: tokenLevelPriceRow.observed_at, identifier: (tokenLevelPriceRow as { provider_asset_id?: string | null }).provider_asset_id ?? null, note: tokenLevelPriceRow.note }
      : null,
    logoUrl: logos[tokenId] ?? null,
    protocol: protocolMapping
      ? { name: protocolMapping.protocolName.replace(/\s*\(parent record\)\s*$/i, ""), aggregatesVersions: protocolMapping.recordKind === "parent" }
      : null,
    dexActivity: {
      transactions24h: dexCount("transactions_24h_count"),
      buys24h: dexCount("buys_24h_count"),
      sells24h: dexCount("sells_24h_count"),
    },
    onchainMarkets,
  };
}

/**
 * `client` is intentionally left out of the cache key: the token profile page is this
 * function's only caller (see getLiveTokenProfileForAnalysis below for the AI
 * services' own, deliberately uncached, path), and every page request passes an
 * interchangeable connection to the same real database, so caching only on `tokenId`
 * is correct and lets concurrent/repeat page views share one read.
 */
export const getLiveTokenProfile = memoizeWithTtl<[tokenId: string, client?: SupabaseAdminClient], LiveTokenProfileData | null>(
  getLiveTokenProfileUncached,
  () => PROFILE_CACHE_TTL_MS * getCacheTtlMultiplierSync(),
  (tokenId) => tokenId,
);

/**
 * Uncached entry point for the AI analysis services (deterministic-service.ts,
 * analysis/service.ts). Two reasons this bypasses getLiveTokenProfile's cache rather
 * than reusing it with a different cache key (an earlier version of this code tried
 * exactly that):
 *
 *  1. deterministic-service.ts's generation path is deliberately stateless and
 *     uncached by design (each request recomputes a fresh report scoped to that one
 *     browser, never shared or persisted), so there is no concurrent/duplicate-request
 *     problem for a cache to solve here the way there is for page views.
 *  2. A shared cache keyed only by tokenId (client ignored, matching
 *     getLiveTokenProfile's own reasoning above) is unsafe whenever two callers with
 *     the SAME tokenId point at genuinely DIFFERENT underlying data -- which the
 *     production AI services never do (same real database as the page), but their own
 *     tests do, every time: many test cases in tests/analysis.test.mjs reuse one
 *     constant token id across fresh, independently-seeded fake Supabase clients, and
 *     were silently all served the first test's cached profile, because the fetch was
 *     a Promise the memoizer would return again, uncalled, for every id+includeLiveBinance
 *     combination that collided. The result: unrelated test scenarios validating
 *     against stale, wrong profile data, until the evidence-contract and provider-
 *     routing assertions downstream started failing for reasons that had nothing to do
 *     with what each test actually changed.
 *
 * includeLiveBinance is always false here: see getLiveTokenProfileUncached's own doc
 * comment for why the AI services must never make a live network call.
 */
export function getLiveTokenProfileForAnalysis(tokenId: string, client: SupabaseAdminClient): Promise<LiveTokenProfileData | null> {
  return getLiveTokenProfileUncached(tokenId, client, { includeLiveBinance: false });
}

/**
 * Sidebar 24H Movers for pages without dashboard rows. Reads only stored data:
 * the latest CoinGecko 24h change per tracked token and stored logos. The
 * sidebar is optional, so any failure hides it instead of failing the page.
 */
const MOVERS_CACHE_TTL_MS = 60_000;

async function getSidebarMoversUncached(): Promise<Movers | null> {
  try {
    const client = createSupabaseAdminClient();
    refreshThrottleLevelInBackground(client);
    const tokenResult = await client.from("tokens").select("id,name,symbol,chain_id,contract_address,is_native,category,description");
    if (tokenResult.error) throw tokenResult.error;
    const tokens = (tokenResult.data ?? []) as DbToken[];
    const tokenIds = tokens.map((token) => token.id);
    if (tokenIds.length === 0) return selectMovers([]);

    // Avoid latest_token_metric_observations here: its DISTINCT ON view can
    // scan the full append-only history under production load. CoinGecko refreshes
    // every 15 minutes, so a six-hour window spans many refresh cycles while
    // keeping this optional sidebar query bounded. The base-table index serves
    // the token/provider/metric/time filters; selectMovers needs only these fields.
    const sidebarSince = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const recentRows: DbObservation[] = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const result = await client.from("token_metric_observations")
        .select("id,token_id,provider_id,metric_id,value,status,observed_at,collected_at")
        .in("token_id", tokenIds)
        .eq("provider_id", "coingecko")
        .in("metric_id", ["price_change_24h_pct", "volume_24h_usd"])
        .is("excluded_reason", null)
        .gte("observed_at", sidebarSince)
        .order("token_id").order("provider_id").order("metric_id")
        .order("observed_at", { ascending: false }).order("collected_at", { ascending: false }).order("id", { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (result.error) throw result.error;
      const page = (result.data ?? []) as unknown as DbObservation[];
      recentRows.push(...page);
      if (page.length < pageSize) break;
    }

    const logos = await readTokenLogos(client, tokenIds);
    const rows = buildDashboardTokens(tokens, [], latestPerMetric(recentRows));
    return selectMovers(rows.map((token) => ({ ...token, logoUrl: logos[token.id] ?? null })));
  } catch (error) {
    console.error("Sidebar movers read failed (section hidden):", error);
    return null;
  }
}

export const getSidebarMovers = memoizeWithTtl(
  getSidebarMoversUncached,
  () => MOVERS_CACHE_TTL_MS * getCacheTtlMultiplierSync(),
  () => "movers",
);

export function latestDashboardUpdate(tokens: DashboardToken[]): string | null {
  return tokens.flatMap((token) => Object.values(token.metricSources ?? {}).map((source) => source?.collectedAt ?? ""))
    .filter(Boolean).sort().at(-1) ?? null;
}
