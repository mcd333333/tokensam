import { coinbaseProducts } from "../../../data/coinbase-token-mappings.ts";

/**
 * Live exchange prices for the dashboard's polling, from Coinbase's public market-data API.
 *
 * Coinbase replaced Binance here when the app moved from Vercel to Cloudflare Workers: Binance answers
 * HTTP 403 to every Cloudflare Workers address (a different batch failing on each call, whatever the
 * request shape or host, data-api.binance.vision included), while Coinbase's public product endpoint is
 * keyless and takes a list of product ids. One request per batch returns the last price and 24-hour change.
 *
 * The 7-day change is not sent: Coinbase's product listing has no 7-day figure and a candle request per
 * product would cost one call per token. A row without `c7` keeps its stored 7-day change (see
 * applyLivePrices), exactly as before for any token without an opening price.
 *
 * The route reads and writes nothing. No Supabase, no persistence: it is a thin, cached pass-through, and
 * the stored history remains the collector's job.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/** Cache-Control for any CDN or browser in front. */
const CACHE_CONTROL = "public, s-maxage=5, stale-while-revalidate=25";

/**
 * A Cloudflare Worker's response is not edge-cached automatically, so every poll would otherwise reach
 * Coinbase. This memo, per Worker instance, serves repeat polls inside the window from memory and shares one
 * in-flight request between concurrent callers. A failure is never memoised.
 */
const MEMO_TTL_MS = 5_000;

/** Products per request: keeps the repeated `product_ids` query string short. */
const PRODUCTS_PER_REQUEST = 60;

const PRODUCT_IDS = Object.values(coinbaseProducts);
const MARKET_PRODUCTS_URL = "https://api.coinbase.com/api/v3/brokerage/market/products";

type CoinbaseProduct = {
  product_id?: string;
  price?: string;
  price_percentage_change_24h?: string;
  status?: string;
  trading_disabled?: boolean;
  is_disabled?: boolean;
};

type Payload = { asOf: string; prices: Record<string, { p: number; c: number }> };

let memo: { at: number; payload: Payload } | null = null;
let inFlight: Promise<Payload> | null = null;

function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

async function fetchPrices(): Promise<Payload> {
  const responses = await Promise.all(batches(PRODUCT_IDS, PRODUCTS_PER_REQUEST).map(async (batch) => {
    const url = new URL(MARKET_PRODUCTS_URL);
    for (const id of batch) url.searchParams.append("product_ids", id);
    const result = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
      // Next would otherwise cache this upstream response and defeat the point of the route.
      cache: "no-store",
    });
    // Never surface Coinbase's body; the status is all the client needs to back off.
    if (!result.ok) throw new Error(`Coinbase returned HTTP ${result.status}.`);
    const payload = (await result.json()) as { products?: unknown };
    if (!Array.isArray(payload?.products)) throw new Error("Coinbase returned an unexpected products response.");
    return payload.products as CoinbaseProduct[];
  }));

  const prices: Payload["prices"] = {};
  for (const product of responses.flat()) {
    if (!product?.product_id || product.status !== "online" || product.trading_disabled || product.is_disabled) continue;
    const price = Number(product.price);
    const change = Number(product.price_percentage_change_24h);
    // A non-finite or non-positive field is omitted rather than sent as 0, so the client keeps the
    // server-rendered value for that token instead of showing a fabricated price.
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(change)) continue;
    prices[product.product_id] = { p: price, c: change };
  }
  return { asOf: new Date().toISOString(), prices };
}

export async function GET(): Promise<Response> {
  try {
    let payload: Payload;
    if (memo && Date.now() - memo.at < MEMO_TTL_MS) {
      payload = memo.payload;
    } else {
      inFlight ??= fetchPrices().finally(() => { inFlight = null; });
      payload = await inFlight;
      memo = { at: Date.now(), payload };
    }
    return Response.json(payload, { headers: { "cache-control": CACHE_CONTROL } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Coinbase request failed.";
    // 502 with no cache header: a failure must not be cached in front of a working upstream.
    return Response.json({ error: message }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
