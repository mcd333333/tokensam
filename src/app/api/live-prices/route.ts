import { coinbaseProducts } from "../../../data/coinbase-token-mappings.ts";
import { fetchCoinbaseTickers } from "../../../lib/providers/coinbase.ts";

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

const PRODUCT_IDS = Object.values(coinbaseProducts);

type Payload = { asOf: string; prices: Record<string, { p: number; c: number }> };

async function buildPayload(): Promise<Payload> {
  // fetchCoinbaseTickers shares a short per-product memo (so repeat polls and page renders inside one
  // Worker instance make one upstream call) and drops disabled, offline and non-finite products.
  const tickers = await fetchCoinbaseTickers(PRODUCT_IDS);
  const prices: Payload["prices"] = {};
  let oldest = Date.now();
  for (const [productId, ticker] of tickers) {
    prices[productId] = { p: ticker.price, c: ticker.changePct };
    oldest = Math.min(oldest, ticker.at);
  }
  // asOf is the oldest ticker's fetch time, so prices served from a failed refresh age out on the
  // client's own staleness guard instead of looking live.
  return { asOf: new Date(oldest).toISOString(), prices };
}

export async function GET(): Promise<Response> {
  try {
    return Response.json(await buildPayload(), { headers: { "cache-control": CACHE_CONTROL } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Coinbase request failed.";
    // 502 with no cache header: a failure must not be cached in front of a working upstream.
    return Response.json({ error: message }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
