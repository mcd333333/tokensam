import { coinbaseProducts } from "../../data/coinbase-token-mappings.ts";
import type { LivePriceEntry } from "./live-prices.ts";

/**
 * Pure helpers for the browser's direct Coinbase feed (the connection itself lives in use-live-prices.ts).
 *
 * Coinbase's Advanced Trade WebSocket is public: market-data channels need no key or signature. The
 * `ticker_batch` channel sends a snapshot for each product on subscribe and then at most one update per
 * product every 5 seconds, which is quicker than the 7 s poll it supplements and far lighter on a viewer's
 * bandwidth than the per-trade `ticker` channel.
 */
export const COINBASE_WS_URL = "wss://advanced-trade-ws.coinbase.com";
export const DIRECT_FEED_CHANNEL = "ticker_batch";

/** Product id -> every canonical token id mapped to it (one product can back more than one token row). */
const productTokens: Map<string, string[]> = (() => {
  const index = new Map<string, string[]>();
  for (const [tokenId, product] of Object.entries(coinbaseProducts)) {
    const list = index.get(product);
    if (list) list.push(tokenId);
    else index.set(product, [tokenId]);
  }
  return index;
})();

/** The products to subscribe to: every mapped product, or only those backing the given tokens (a profile page). */
function productsFor(tokenIds?: string[]): string[] {
  if (!tokenIds) return [...productTokens.keys()];
  return [...new Set(tokenIds.map((id) => coinbaseProducts[id]).filter((product): product is string => Boolean(product)))];
}

/** How many products this feed would subscribe to; zero means there is nothing to connect for. */
export function directFeedSize(tokenIds?: string[]): number {
  return productsFor(tokenIds).length;
}

/** The subscribe frame covering every mapped product, or only those backing `tokenIds`. */
export function directFeedSubscribeMessage(tokenIds?: string[]): string {
  return JSON.stringify({ type: "subscribe", product_ids: productsFor(tokenIds), channel: DIRECT_FEED_CHANNEL });
}

/**
 * Turns one WebSocket frame into live-price entries keyed by canonical token id. Anything that is not a
 * ticker frame, is malformed, or carries an unusable price comes back as an empty object rather than throwing:
 * a bad frame must never take the dashboard down.
 */
export function parseDirectFeedFrame(raw: string, at: number): Record<string, LivePriceEntry> {
  let message: { channel?: string; events?: { tickers?: { product_id?: string; price?: string; price_percent_chg_24_h?: string }[] }[] };
  try {
    message = JSON.parse(raw);
  } catch {
    return {};
  }
  if (message?.channel !== DIRECT_FEED_CHANNEL && message?.channel !== "ticker") return {};
  const out: Record<string, LivePriceEntry> = {};
  for (const event of message.events ?? []) {
    for (const ticker of event.tickers ?? []) {
      const price = Number(ticker.price);
      const change = Number(ticker.price_percent_chg_24_h);
      if (!ticker.product_id || !Number.isFinite(price) || price <= 0 || !Number.isFinite(change)) continue;
      for (const tokenId of productTokens.get(ticker.product_id) ?? []) {
        out[tokenId] = { p: price, c: change, s: "coinbase", at };
      }
    }
  }
  return out;
}
