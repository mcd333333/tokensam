import type {
  MarketDataProvider,
  NormalizedObservation,
  ProviderAsset,
  ProviderSnapshot,
} from "./types.ts";
import type { CollectorDiagnostics } from "../refresh/collector-diagnostics.ts";

const PROVIDER_ID = "binance";
const ENDPOINT_LABEL = "GET /api/v3/ticker/24hr";

/**
 * Binance's public market-data mirror. This is deliberately NOT
 * api.binance.com: that host answers HTTP 451 ("Service unavailable from a
 * restricted location") for US-originating requests, which includes this
 * project's Vercel functions, and no API key changes that. The mirror serves
 * the identical /api/v3 market-data endpoints, requires no key, and is not
 * geo-restricted -- verified against both hosts on 2026-10-06, where
 * api.binance.com returned 451 and this host returned 200 for the same path.
 *
 * Override with BINANCE_API_BASE_URL only to point at another Binance-
 * compatible market-data host (for example a proxy, as COINGECKO_PROXY_URL
 * does for CoinGecko).
 */
const DEFAULT_BASE_URL = "https://data-api.binance.vision/api/v3";

/**
 * Symbols per request. Binance's /ticker/24hr request weight is tiered by
 * symbol count (2 for <=20, 40 for <=100, 80 above that) against a 6,000/min
 * IP budget, so the whole universe costs 80 either way. Batching at 100 keeps
 * each URL short and the per-request weight at the lower 40 tier.
 */
const MAX_SYMBOLS_PER_REQUEST = 100;
const MAX_ATTEMPTS = 3;

/** Binance publishes 6,000 request-weight/min per IP; this pacing is for politeness, not need. */
export const MIN_REQUEST_INTERVAL_MS = 250;

/**
 * A ticker whose last trade is older than this is not served as a live price.
 *
 * This guards against one specific failure: Binance keeps returning a symbol's
 * last trade after trading halts, so a symbol in `status: BREAK` reports a
 * price frozen at the moment of the halt (STG was frozen this way when the
 * mappings were verified). Such a price must not reach the UI as live.
 *
 * The threshold is an hour rather than a few minutes because `closeTime` is
 * the symbol's last trade, not the time Binance assembled the response, so on
 * a thinly traded pair it lags simply because nobody traded. Measured across
 * all 180 mapped symbols on 2026-10-06: median 3 s, p95 40 s, but DGBUSDT at
 * 645 s and XNOUSDT at 519 s -- correctly priced, just quiet. A ten-minute
 * threshold rejected those two; nothing in that sample sat between 11 minutes
 * and the multi-day staleness of an actually halted symbol, so an hour
 * separates "quiet" from "frozen" with room on both sides.
 *
 * Note this is NOT the bound on how current the *stored* price is -- the
 * refresh cadence and the read layer's own check (livePriceRow in
 * live-data.ts, which uses collected_at) cover that.
 */
export const MAX_TICKER_AGE_MS = 60 * 60 * 1000;

type BinanceTicker = {
  symbol: string;
  lastPrice?: string | null;
  priceChangePercent?: string | null;
  closeTime?: number | null;
};

export class BinanceApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "BinanceApiError";
    this.status = status;
  }
}

/** Market-data path every Binance-compatible host serves these endpoints under. */
const API_PATH = "/api/v3";

export function getBinanceConfig(
  env: Record<string, string | undefined> = process.env,
): { baseUrl: string } {
  const override = env.BINANCE_API_BASE_URL?.trim().replace(/\/+$/, "");
  if (!override) return { baseUrl: DEFAULT_BASE_URL };

  // A bare origin ("https://data-api.binance.vision") is accepted and gets the standard
  // /api/v3 prefix appended. Without this, such a value silently builds requests against
  // the host root ("/ticker/24hr") and Binance answers 404 on every run -- which is exactly
  // what the first deployment of this collector did. Anything with a path of its own is
  // left untouched, so a proxy mounted under a custom prefix still works as given.
  let pathname: string;
  try {
    pathname = new URL(override).pathname;
  } catch {
    // Not a parseable URL; pass it through and let the request surface the error.
    return { baseUrl: override };
  }
  return { baseUrl: pathname === "/" || pathname === "" ? `${override}${API_PATH}` : override };
}

function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }
  return batches;
}

export function retryAfterMs(value: string | null, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), 30_000);
  const dateMs = Date.parse(value) - Date.now();
  return Number.isFinite(dateMs) ? Math.min(Math.max(dateMs, 0), 30_000) : fallbackMs;
}

/** Numbers arrive as decimal strings; anything non-finite is treated as absent, never as 0. */
function parseDecimal(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchTickerBatch(
  symbols: string[],
  options: {
    baseUrl: string;
    fetchImpl: typeof fetch;
    sleep: (durationMs: number) => Promise<void>;
  },
  // Diagnostic-only: records attempt count/timing/status, never the request/response itself.
  diagnostics?: { batchIndex: number; recorder: CollectorDiagnostics },
): Promise<BinanceTicker[]> {
  const url = new URL(`${options.baseUrl}/ticker/24hr`);
  // Binance expects a JSON array literal for the multi-symbol form, not a comma list.
  url.searchParams.set("symbols", JSON.stringify(symbols));

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const attemptStart = Date.now();
    let response: Response;
    try {
      response = await options.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      const willRetry = attempt !== MAX_ATTEMPTS;
      diagnostics?.recorder.recordHttpAttempt({
        batch: diagnostics.batchIndex, attempt, outcome: willRetry ? "retry" : "error",
        durationMs: Date.now() - attemptStart, httpStatus: null,
      });
      if (!willRetry) {
        throw new BinanceApiError("Binance request failed due to a network error.", null);
      }
      await options.sleep(500 * 2 ** (attempt - 1));
      continue;
    }

    if (response.ok) {
      const payload: unknown = await response.json();
      diagnostics?.recorder.recordHttpAttempt({
        batch: diagnostics.batchIndex, attempt, outcome: "ok",
        durationMs: Date.now() - attemptStart, httpStatus: response.status,
      });
      if (!Array.isArray(payload)) {
        throw new BinanceApiError("Binance returned an unexpected ticker response.", response.status);
      }
      return payload as BinanceTicker[];
    }

    // 451 is a geo block on the host, not a transient fault: retrying cannot clear it.
    // Surface it with the fix rather than burning attempts (see DEFAULT_BASE_URL).
    if (response.status === 451) {
      diagnostics?.recorder.recordHttpAttempt({
        batch: diagnostics.batchIndex, attempt, outcome: "error",
        durationMs: Date.now() - attemptStart, httpStatus: response.status,
      });
      throw new BinanceApiError(
        "Binance returned HTTP 451 (restricted location) for this host. Point BINANCE_API_BASE_URL at an unrestricted Binance-compatible market-data host; api.binance.com is geo-blocked from this deployment's egress.",
        response.status,
      );
    }

    // 418 is Binance's "IP auto-banned after repeated 429s"; it carries Retry-After like 429.
    const retryable = response.status === 429 || response.status === 418 || response.status >= 500;
    const willRetry = retryable && attempt !== MAX_ATTEMPTS;
    diagnostics?.recorder.recordHttpAttempt({
      batch: diagnostics.batchIndex, attempt, outcome: willRetry ? "retry" : "error",
      durationMs: Date.now() - attemptStart, httpStatus: response.status,
    });
    if (!willRetry) {
      // Avoid including request URLs or response bodies in errors and logs.
      throw new BinanceApiError(
        `Binance returned HTTP ${response.status}. Check the configured base URL and request-weight usage.`,
        response.status,
      );
    }

    const fallbackMs = 500 * 2 ** (attempt - 1);
    await options.sleep(
      response.status === 429 || response.status === 418
        ? retryAfterMs(response.headers.get("retry-after"), fallbackMs)
        : fallbackMs,
    );
  }

  throw new BinanceApiError("Binance request exhausted its retry limit.", null);
}

/**
 * The provenance note carried by every Binance observation.
 *
 * It states the two things a reader must not have to infer: the price is a
 * single venue's USDT-quoted last trade, not a cross-venue USD average like
 * CoinGecko's, and the symbol prices the fungible asset rather than this
 * canonical token's specific chain deployment.
 */
export const BINANCE_PRICE_NOTE =
  "Binance spot last trade, USDT-quoted (a USD proxy, not USD). Single-venue price for the fungible asset, not a cross-venue average and not specific to this token's chain deployment.";

export const BINANCE_CHANGE_NOTE =
  "Binance spot 24-hour price change for this symbol's rolling window, from the same ticker as the live price. Single-venue, USDT-quoted.";

function observation(
  asset: ProviderAsset,
  metricId: string,
  value: number | null,
  sourceField: string,
  observedAt: string,
  collectedAt: string,
  note: string,
  windowDays: number | null = null,
  unavailableNote?: string,
): NormalizedObservation {
  const available = value !== null;
  return {
    tokenId: asset.tokenId,
    chainId: asset.chainId,
    metricId,
    value: available ? value : null,
    status: available ? "available" : "unavailable",
    observedAt,
    collectedAt,
    windowDays,
    scope: "token",
    sourceField,
    note: available ? note : unavailableNote ?? "Binance did not return a numeric value for this field.",
  };
}

export function normalizeBinanceTicker(
  asset: ProviderAsset,
  ticker: BinanceTicker,
  collectedAt = new Date().toISOString(),
  maxAgeMs = MAX_TICKER_AGE_MS,
): ProviderSnapshot {
  const closeTime = typeof ticker.closeTime === "number" && Number.isFinite(ticker.closeTime)
    ? ticker.closeTime
    : null;
  const observedAt = closeTime !== null ? new Date(closeTime).toISOString() : collectedAt;

  // Staleness is judged against the ticker's own closeTime relative to this run's
  // collectedAt, so a replayed or fixture-driven run is judged on the same clock.
  const ageMs = closeTime !== null ? Date.parse(collectedAt) - closeTime : null;
  const stale = ageMs !== null && ageMs > maxAgeMs;
  const staleNote = stale
    ? `Binance's last trade for this symbol is ${Math.round((ageMs as number) / 60_000)} minutes old (limit ${Math.round(maxAgeMs / 60_000)}), so it is not served as a live price. Trading for the symbol may be halted.`
    : undefined;

  const price = stale ? null : parseDecimal(ticker.lastPrice);
  const change = stale ? null : parseDecimal(ticker.priceChangePercent);

  return {
    providerId: PROVIDER_ID,
    endpointLabel: ENDPOINT_LABEL,
    asset,
    observedAt,
    collectedAt,
    rawPayload: ticker,
    observations: [
      observation(asset, "price_usd", price, "lastPrice", observedAt, collectedAt, BINANCE_PRICE_NOTE, null, staleNote),
      observation(asset, "price_change_24h_pct", change, "priceChangePercent", observedAt, collectedAt, BINANCE_CHANGE_NOTE, 1, staleNote),
    ],
  };
}

/**
 * Live price and 24-hour change from Binance spot tickers.
 *
 * This provider deliberately writes only those two metrics. Binance's
 * `quoteVolume` is one venue's 24-hour volume, which is not the same economic
 * quantity as CoinGecko's cross-venue `total_volume`, and Binance publishes no
 * market cap, supply, or 7-day change at all. Writing a venue figure into a
 * global metric would make the dashboard's volume and market-cap values
 * incomparable with their own history, so those metrics stay CoinGecko's.
 */
export class BinanceMarketDataProvider implements MarketDataProvider {
  readonly providerId = PROVIDER_ID;
  private readonly options: {
    baseUrl: string;
    fetchImpl?: typeof fetch;
    sleep?: (durationMs: number) => Promise<void>;
    now?: () => Date;
    maxAgeMs?: number;
  };

  constructor(options: {
    baseUrl: string;
    fetchImpl?: typeof fetch;
    sleep?: (durationMs: number) => Promise<void>;
    now?: () => Date;
    maxAgeMs?: number;
  }) {
    this.options = options;
  }

  /** `diagnostics`, if supplied, only records stage timing/HTTP-attempt metadata (see
   *  collector-diagnostics.ts) — it never changes the returned snapshots or this method's
   *  Promise<ProviderSnapshot[]> contract, so implementing MarketDataProvider still holds. */
  async fetchSnapshots(assets: ProviderAsset[], diagnostics?: CollectorDiagnostics): Promise<ProviderSnapshot[]> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const sleep = this.options.sleep
      ?? ((durationMs: number) => new Promise((resolve) => setTimeout(resolve, durationMs)));
    const now = this.options.now ?? (() => new Date());
    const maxAgeMs = this.options.maxAgeMs ?? MAX_TICKER_AGE_MS;
    const uniqueAssets = [...new Map(assets.map((asset) => [asset.externalAssetId, asset])).values()];
    const batches = splitIntoBatches(uniqueAssets, MAX_SYMBOLS_PER_REQUEST);
    const snapshots: ProviderSnapshot[] = [];

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      if (batchIndex > 0) await sleep(MIN_REQUEST_INTERVAL_MS);
      const batch = batches[batchIndex];
      const tickers = await fetchTickerBatch(
        batch.map((asset) => asset.externalAssetId),
        { baseUrl: this.options.baseUrl, fetchImpl, sleep },
        diagnostics ? { batchIndex, recorder: diagnostics } : undefined,
      );
      const assetsBySymbol = new Map(batch.map((asset) => [asset.externalAssetId, asset]));
      const collectedAt = now().toISOString();
      diagnostics?.start("binance.parseTransform");
      for (const ticker of tickers) {
        const asset = assetsBySymbol.get(ticker.symbol);
        if (asset) snapshots.push(normalizeBinanceTicker(asset, ticker, collectedAt, maxAgeMs));
      }
      diagnostics?.end("binance.parseTransform");
    }

    return snapshots;
  }
}
