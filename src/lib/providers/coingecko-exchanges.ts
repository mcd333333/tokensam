import { CoinGeckoApiError, MIN_REQUEST_INTERVAL_MS, getCoinGeckoConfig, retryAfterMs } from "./coingecko.ts";

/**
 * Exchange 24h trading volume (centralised and decentralised) for one coin, from CoinGecko's
 * `GET /coins/{id}/tickers`. Costs one API call per coin (the first page, sorted by USD volume,
 * is enough for the top exchanges), so it is refreshed once a day under a hard monthly call cap
 * (see run-exchange-collection.ts), never on the 15-minute market refresh.
 */

export type ExchangeKind = "cex" | "dex";
export type ExchangeVolume = { id: string; name: string; kind: ExchangeKind; volumeUsd: number; pairs: number };

type RawTicker = {
  base?: unknown;
  target?: unknown;
  market?: { name?: unknown; identifier?: unknown } | null;
  converted_volume?: { usd?: unknown } | null;
  is_anomaly?: unknown;
  is_stale?: unknown;
  token_info_url?: unknown;
};

/** Exchanges kept per token, per kind. */
export const MAX_CEX_PER_TOKEN = 15;
export const MAX_DEX_PER_TOKEN = 10;

// CoinGecko's tickers endpoint returns CEX and DEX markets together and documents no flag that
// separates them. DEX tickers identify their pair by contract address (0x... on EVM chains, long
// base58 strings on Solana, etc.) and usually carry a token_info_url; centralised venues use
// plain symbols like BTC/USDT. A ticker is classified as decentralised when either side looks
// like a contract address or it has a token_info_url, and as centralised otherwise.
function looksLikeContractAddress(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^0x[0-9a-fA-F]{20,}$/.test(value) || value.length > 24;
}

export function isCentralisedTicker(ticker: RawTicker): boolean {
  if (typeof ticker.token_info_url === "string" && ticker.token_info_url.length > 0) return false;
  return !looksLikeContractAddress(ticker.base) && !looksLikeContractAddress(ticker.target);
}

/**
 * Sums USD volume per exchange across that exchange's tickers, tagging each exchange as
 * centralised or decentralised. Anomalous or stale tickers and tickers without a finite positive
 * USD volume are ignored.
 */
export function aggregateExchangeVolumes(tickers: unknown): ExchangeVolume[] {
  if (!Array.isArray(tickers)) return [];
  const byExchange = new Map<string, ExchangeVolume>();
  for (const raw of tickers as RawTicker[]) {
    if (!raw || raw.is_anomaly === true || raw.is_stale === true) continue;
    const id = raw.market?.identifier;
    const name = raw.market?.name;
    const volume = raw.converted_volume?.usd;
    if (typeof id !== "string" || typeof name !== "string" || typeof volume !== "number" || !Number.isFinite(volume) || volume <= 0) continue;
    const kind: ExchangeKind = isCentralisedTicker(raw) ? "cex" : "dex";
    const key = `${kind}:${id}`;
    const entry = byExchange.get(key) ?? { id, name, kind, volumeUsd: 0, pairs: 0 };
    entry.volumeUsd += volume;
    entry.pairs += 1;
    byExchange.set(key, entry);
  }
  const top = (kind: ExchangeKind, limit: number) => [...byExchange.values()]
    .filter((entry) => entry.kind === kind)
    .sort((a, b) => b.volumeUsd - a.volumeUsd)
    .slice(0, limit);
  return [...top("cex", MAX_CEX_PER_TOKEN), ...top("dex", MAX_DEX_PER_TOKEN)]
    .map((entry) => ({ ...entry, volumeUsd: Math.round(entry.volumeUsd) }));
}

export { MIN_REQUEST_INTERVAL_MS as EXCHANGE_REQUEST_INTERVAL_MS };

/** One tickers call (first page, volume-sorted) with a single retry on 429/5xx. Throws CoinGeckoApiError. */
export async function fetchExchangeVolumes(
  coinId: string,
  options: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; env?: Record<string, string | undefined> } = {},
): Promise<ExchangeVolume[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const config = getCoinGeckoConfig(options.env);
  const url = new URL(`${config.baseUrl}/coins/${encodeURIComponent(coinId)}/tickers`);
  url.searchParams.set("order", "volume_desc");
  url.searchParams.set("page", "1");
  url.searchParams.set("include_exchange_logo", "false");

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { [config.keyHeader]: config.apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      if (attempt === 2) throw new CoinGeckoApiError("CoinGecko tickers request failed due to a network error.", null);
      await sleep(1_000);
      continue;
    }
    if (response.ok) {
      const payload = (await response.json()) as { tickers?: unknown };
      return aggregateExchangeVolumes(payload?.tickers);
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 2) {
      throw new CoinGeckoApiError(`CoinGecko tickers returned HTTP ${response.status}.`, response.status);
    }
    await sleep(response.status === 429 ? retryAfterMs(response.headers.get("retry-after"), 2_000) : 1_000);
  }
  throw new CoinGeckoApiError("CoinGecko tickers request exhausted its retry limit.", null);
}
