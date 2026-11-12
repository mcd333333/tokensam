import type { NormalizedObservation, ProviderAsset, ProviderSnapshot } from "./types.ts";
import { DexPoolApiError, type DexPool } from "./dexpaprika-pools.ts";

/**
 * DexPaprika token-level DEX market data: the on-chain counterpart to CoinGecko's cross-venue market data.
 *
 * `GET /networks/{network}/tokens/{address}` answers in about 3 KB with figures for the token across ALL of its
 * pools: total liquidity, pool count, and volume, buys, sells and transactions for windows from 1 minute to 24
 * hours, plus 24-hour price high and low. Only data points that CoinGecko or DeFiLlama do not already supply are
 * stored: the token's price, price change over 24 hours, FDV, market cap, supply and descriptions all overlap
 * CoinGecko and are deliberately left out.
 *
 * Auth: an optional DEXPAPRIKA_API_KEY goes in the Authorization header as the bare value, on api.dexpaprika.com
 * (see dexpaprika-pools.ts).
 */

export const DEXPAPRIKA_PROVIDER_ID = "dexpaprika";
const BASE_URL = "https://api.dexpaprika.com";
const REQUEST_TIMEOUT_MS = 15_000;
export const DEXPAPRIKA_METRIC_NOTE =
  "DexPaprika on-chain DEX data for the exact token address on one chain, aggregated across every pool it trades in. Not a cross-venue market figure.";

export type DexPaprikaAsset = ProviderAsset & {
  /** DexPaprika network id, e.g. "ethereum". */
  network: string;
  /** The token address in the form DexPaprika indexes. */
  tokenAddress: string;
};

type Window = { volume_usd?: unknown; buys?: unknown; sells?: unknown; txns?: unknown; buy_usd?: unknown; sell_usd?: unknown; last_price_usd_change?: unknown };
export type DexPaprikaTokenStats = {
  summary?: { liquidity_usd?: unknown; pools?: unknown; last_updated?: unknown; "24h"?: Window; "6h"?: Window; "1h"?: Window };
  price_stats?: { high_24h?: unknown; low_24h?: unknown };
  last_updated?: unknown;
};

function finite(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

/** One request with a single retry on 429/5xx. Resolves null when DexPaprika does not index the token (404). */
export async function fetchTokenStats(
  network: string,
  tokenAddress: string,
  options: { apiKey?: string | null; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DexPaprikaTokenStats | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const apiKey = options.apiKey ?? process.env.DEXPAPRIKA_API_KEY?.trim();
  const url = `${BASE_URL}/networks/${encodeURIComponent(network)}/tokens/${encodeURIComponent(tokenAddress)}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers.authorization = apiKey;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      if (attempt === 2) throw new DexPoolApiError("DexPaprika token request failed due to a network error.", null);
      await sleep(1_000);
      continue;
    }
    if (response.ok) return (await response.json()) as DexPaprikaTokenStats;
    if (response.status === 404) return null;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 2) throw new DexPoolApiError(`DexPaprika token returned HTTP ${response.status}.`, response.status);
    await sleep(response.status === 429 ? 3_000 : 1_000);
  }
  throw new DexPoolApiError("DexPaprika token request exhausted its retry limit.", null);
}

function sum(pools: DexPool[], read: (pool: DexPool) => number | null): number | null {
  const values = pools.map(read).filter((value): value is number => value !== null);
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
}

/**
 * One snapshot per token: the token-level stats plus, when the pool list was refreshed in the same pass, volumes over
 * 7 and 30 days summed across the pools it holds (the most liquid up to 100, so tokens with more pools are partial,
 * which the observation note says). `stats` null means DexPaprika did not index the token: every metric is unavailable.
 */
export function buildDexPaprikaSnapshot(
  asset: DexPaprikaAsset,
  stats: DexPaprikaTokenStats | null,
  pools: DexPool[] | null,
  collectedAt = new Date().toISOString(),
): ProviderSnapshot {
  const reported = Date.parse(String(stats?.summary?.last_updated ?? stats?.last_updated ?? ""));
  const observedAt = Number.isFinite(reported) ? new Date(reported).toISOString() : collectedAt;
  const summary = stats?.summary;
  const missing = " Provider field was absent or non-numeric.";
  const make = (metricId: string, value: unknown, sourceField: string, windowDays: number | null, note = DEXPAPRIKA_METRIC_NOTE): NormalizedObservation => {
    const normalized = finite(value);
    return {
      tokenId: asset.tokenId,
      chainId: asset.chainId,
      metricId,
      value: normalized,
      status: normalized === null ? "unavailable" : "available",
      observedAt,
      collectedAt,
      windowDays,
      // DEX market data for an exact token address.
      scope: "market",
      sourceField,
      note: normalized === null ? `${note}${missing}` : note,
    };
  };

  const observations: NormalizedObservation[] = [
    make("liquidity_usd", summary?.liquidity_usd, "summary.liquidity_usd", null),
    make("dex_pool_count", summary?.pools, "summary.pools", null),
    make("volume_24h_usd", summary?.["24h"]?.volume_usd, "summary.24h.volume_usd", 1),
    make("transactions_24h_count", summary?.["24h"]?.txns, "summary.24h.txns", 1),
    make("buys_24h_count", summary?.["24h"]?.buys, "summary.24h.buys", 1),
    make("sells_24h_count", summary?.["24h"]?.sells, "summary.24h.sells", 1),
    make("dex_buy_volume_24h_usd", summary?.["24h"]?.buy_usd, "summary.24h.buy_usd", 1),
    make("dex_sell_volume_24h_usd", summary?.["24h"]?.sell_usd, "summary.24h.sell_usd", 1),
    make("dex_volume_6h_usd", summary?.["6h"]?.volume_usd, "summary.6h.volume_usd", null),
    make("dex_volume_1h_usd", summary?.["1h"]?.volume_usd, "summary.1h.volume_usd", null),
    make("dex_transactions_6h_count", summary?.["6h"]?.txns, "summary.6h.txns", null),
    make("dex_transactions_1h_count", summary?.["1h"]?.txns, "summary.1h.txns", null),
    make("dex_price_change_6h_pct", summary?.["6h"]?.last_price_usd_change, "summary.6h.last_price_usd_change", null),
    make("dex_price_change_1h_pct", summary?.["1h"]?.last_price_usd_change, "summary.1h.last_price_usd_change", null),
    make("dex_price_high_24h_usd", stats?.price_stats?.high_24h, "price_stats.high_24h", 1),
    make("dex_price_low_24h_usd", stats?.price_stats?.low_24h, "price_stats.low_24h", 1),
  ];

  if (pools && pools.length > 0) {
    const partial = ` Summed across the ${pools.length} most liquid pool(s) only; a token with more pools has more volume than shown.`;
    observations.push(
      make("dex_volume_7d_usd", sum(pools, (pool) => pool.volume7dUsd), "sum(pools[].volume_usd_7d)", 7, `${DEXPAPRIKA_METRIC_NOTE}${partial}`),
      make("dex_volume_30d_usd", sum(pools, (pool) => pool.volume30dUsd), "sum(pools[].volume_usd_30d)", 30, `${DEXPAPRIKA_METRIC_NOTE}${partial}`),
    );
  }

  return {
    providerId: DEXPAPRIKA_PROVIDER_ID,
    endpointLabel: "GET /networks/{network}/tokens/{address}",
    asset: { tokenId: asset.tokenId, chainId: asset.chainId, externalAssetId: asset.externalAssetId },
    observedAt,
    collectedAt,
    // Small on purpose: the full pool list lives in token_dex_pools (overwritten), not in a row stored per cycle.
    rawPayload: {
      requestedNetwork: asset.network,
      requestedTokenAddress: asset.tokenAddress,
      indexed: stats !== null,
      topPool: pools?.[0] ? { pairAddress: pools[0].pairAddress, dexId: pools[0].dexId, liquidityUsd: pools[0].liquidityUsd } : null,
      poolsStored: pools?.length ?? null,
    },
    observations,
  };
}
