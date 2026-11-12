/**
 * Coinbase's public market-data API, used for the live exchange price and 24-hour change.
 *
 * It replaced Binance for this slot when the app moved to Cloudflare Workers, because Binance answers
 * HTTP 403 to every Workers address. The product endpoint is keyless and takes a list of product ids, so
 * one request per batch covers many tokens. Both the browser ticker route (src/app/api/live-prices/route.ts)
 * and the server-rendered pages (src/lib/data/live-data.ts) read through this module, which keeps a short
 * per-product memo so a burst of page renders and ticker polls inside one Worker instance makes one upstream
 * call, not one per request. A failure is never memoised.
 */

const MARKET_PRODUCTS_URL = "https://api.coinbase.com/api/v3/brokerage/market/products";

/** Products per request: keeps the repeated `product_ids` query string short. */
export const PRODUCTS_PER_REQUEST = 60;
/** How long a fetched ticker is reused. */
export const COINBASE_MEMO_TTL_MS = 5_000;
/** When a refresh fails, tickers up to this old are still served (each carries its own `at`). */
export const COINBASE_STALE_IF_ERROR_MS = 120_000;
/** Coinbase answers 429 to requests with no User-Agent more eagerly; identify the app. */
const USER_AGENT = "tokensam/1.0 (live price; +https://github.com/dm999999-ctrl/tokensam)";
const REQUEST_TIMEOUT_MS = 8_000;

export type CoinbaseTicker = { price: number; changePct: number; at: number };

type CoinbaseProduct = {
  product_id?: string;
  price?: string;
  price_percentage_change_24h?: string;
  status?: string;
  trading_disabled?: boolean;
  is_disabled?: boolean;
};

/** `ticker: null` records a product that was requested but is offline, disabled or unpriced, so it is not refetched on every poll. */
const memo = new Map<string, { at: number; ticker: CoinbaseTicker | null }>();
const inFlight = new Map<string, Promise<void>>();

/** Test hook: forget memoised tickers and in-flight requests. */
export function resetCoinbaseMemo(): void {
  memo.clear();
  inFlight.clear();
}

function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

async function fetchBatch(batch: string[]): Promise<void> {
  const url = new URL(MARKET_PRODUCTS_URL);
  for (const id of batch) url.searchParams.append("product_ids", id);
  let result: Response | null = null;
  // One retry after a short pause on 429/5xx: Coinbase throttles per address, and Workers share addresses.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    result = await fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // Next would otherwise cache this upstream response and defeat the point of a live price.
      cache: "no-store",
    });
    if (result.ok || (result.status !== 429 && result.status < 500)) break;
    if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 400));
  }
  // Never surface Coinbase's body; the status is all a caller needs to back off.
  if (!result || !result.ok) throw new Error(`Coinbase returned HTTP ${result?.status ?? 0}.`);
  const payload = (await result.json()) as { products?: unknown };
  if (!Array.isArray(payload?.products)) throw new Error("Coinbase returned an unexpected products response.");
  const now = Date.now();
  for (const id of batch) memo.set(id, { at: now, ticker: null });
  for (const product of payload.products as CoinbaseProduct[]) {
    if (!product?.product_id || product.status !== "online" || product.trading_disabled || product.is_disabled) continue;
    const price = Number(product.price);
    const changePct = Number(product.price_percentage_change_24h);
    // A non-finite or non-positive field is dropped rather than reported as 0, so a caller keeps its
    // stored value for that token instead of showing a fabricated price.
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(changePct)) continue;
    memo.set(product.product_id, { at: now, ticker: { price, changePct, at: now } });
  }
}

/**
 * Last price and 24-hour change for each requested product that is online and quoting a valid price,
 * each with the time it was fetched. When an upstream request fails, tickers already held that are not
 * older than COINBASE_STALE_IF_ERROR_MS are still returned (callers judge freshness from `at`); it
 * rejects only when nothing usable is held for a failed batch.
 */
export async function fetchCoinbaseTickers(productIds: string[]): Promise<Map<string, CoinbaseTicker>> {
  const now = Date.now();
  const missing = [...new Set(productIds)].filter((id) => {
    const cached = memo.get(id);
    return !cached || now - cached.at >= COINBASE_MEMO_TTL_MS;
  });
  let failure: unknown = null;
  await Promise.all(batches(missing, PRODUCTS_PER_REQUEST).map(async (batch) => {
    const key = batch.join(",");
    let request = inFlight.get(key);
    if (!request) {
      request = fetchBatch(batch).finally(() => inFlight.delete(key));
      inFlight.set(key, request);
    }
    try { await request; } catch (error) { failure = error; }
  }));
  const result = new Map<string, CoinbaseTicker>();
  const fresh = Date.now();
  for (const id of productIds) {
    const cached = memo.get(id);
    if (cached?.ticker && fresh - cached.at < COINBASE_STALE_IF_ERROR_MS) result.set(id, cached.ticker);
  }
  if (failure && result.size === 0) throw failure;
  return result;
}

export const COINBASE_PRICE_NOTE =
  "Coinbase spot last trade, USD-quoted. Single-venue price for the fungible asset, not a cross-venue average and not specific to this token's chain deployment.";
export const COINBASE_CHANGE_NOTE =
  "Coinbase spot 24-hour price change for this product's rolling window, from the same ticker as the live price. Single-venue, USD-quoted.";
