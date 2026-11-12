import { readLivePrices } from "../../../lib/providers/live-price-source.ts";

/**
 * Live exchange prices for the dashboard's polling, keyed by canonical token id.
 *
 * Binance's and Coinbase's REST APIs throttle or block Cloudflare Workers' shared addresses, so prices come from
 * WebSocket feeds held by Durable Objects (see src/lib/providers/live-price-source.ts): Coinbase where it lists the
 * token, Binance for the rest, with Coinbase's REST endpoint as the fallback. Each entry says which source it came
 * from (`s`). The 7-day change is not sent, so a row keeps its stored 7-day change (see applyLivePrices).
 *
 * The route reads and writes nothing in Supabase: it is a thin pass-through, and the stored history remains the
 * collector's job.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/** Cache-Control for any CDN or browser in front. */
const CACHE_CONTROL = "public, s-maxage=2, stale-while-revalidate=10";

export async function GET(): Promise<Response> {
  const live = await readLivePrices();
  if (live.size === 0) {
    // 502 with no cache header: a failure must not be cached in front of a working upstream.
    return Response.json({ error: "No live prices are available." }, { status: 502, headers: { "cache-control": "no-store" } });
  }
  const prices: Record<string, { p: number; c: number; s: string }> = {};
  let newest = 0;
  for (const [tokenId, price] of live) {
    prices[tokenId] = { p: price.p, c: price.c, s: price.source };
    newest = Math.max(newest, price.at);
  }
  // asOf is the newest trade, so a feed that has gone quiet ages out on the client's staleness guard.
  return Response.json({ asOf: new Date(newest).toISOString(), prices }, { headers: { "cache-control": CACHE_CONTROL } });
}
