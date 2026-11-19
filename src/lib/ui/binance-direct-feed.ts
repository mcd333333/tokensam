import { binanceSymbols } from "../../data/binance-symbols.ts";
import { coinbaseProducts } from "../../data/coinbase-token-mappings.ts";
import type { LivePriceEntry } from "./live-prices.ts";

/**
 * Pure helpers for the browser's direct Binance feed, the counterpart of coinbase-direct-feed.ts (the
 * connection itself lives in use-live-prices.ts, which treats both feeds identically).
 *
 * Binance's market-data WebSocket (the data-only `data-stream.binance.vision` host, the same one the
 * Durable Object relay uses) is public: no key, no signature, and the stream names are in the URL, so there
 * is nothing to send after connecting. `<symbol>@miniTicker` pushes the last price and the 24-hour open about
 * once a second per symbol.
 *
 * Only tokens Coinbase does not list are covered. That mirrors the server (src/lib/providers/live-price-source.ts):
 * Coinbase is preferred where it lists a token, and Binance quotes the rest. Those prices are USDT-quoted, a USD
 * proxy rather than USD, which applyLivePrices states in the row's provenance.
 */
const BINANCE_WS_BASE = "wss://data-stream.binance.vision/stream?streams=";

/** Binance symbol -> every canonical token id mapped to it, for tokens that Coinbase does not quote. */
const symbolTokens: Map<string, string[]> = (() => {
  const index = new Map<string, string[]>();
  for (const [tokenId, symbol] of Object.entries(binanceSymbols)) {
    if (coinbaseProducts[tokenId]) continue;
    const key = symbol.toUpperCase();
    const list = index.get(key);
    if (list) list.push(tokenId);
    else index.set(key, [tokenId]);
  }
  return index;
})();

/** The symbols to stream: every covered symbol, or only those backing the given tokens (a profile page). */
function symbolsFor(tokenIds?: string[]): string[] {
  if (!tokenIds) return [...symbolTokens.keys()];
  const wanted = new Set(tokenIds);
  return [...symbolTokens.entries()].filter(([, ids]) => ids.some((id) => wanted.has(id))).map(([symbol]) => symbol);
}

/** How many symbols this feed covers; zero means there is nothing to connect for. */
export function binanceDirectFeedSize(tokenIds?: string[]): number {
  return symbolsFor(tokenIds).length;
}

/** The combined-stream URL for every covered symbol, or only those backing `tokenIds`. */
export function binanceStreamUrl(tokenIds?: string[]): string {
  return BINANCE_WS_BASE + symbolsFor(tokenIds).map((symbol) => `${symbol.toLowerCase()}@miniTicker`).join("/");
}

/**
 * Turns one combined-stream frame ({"stream":"btcusdt@miniTicker","data":{"s","c":"last","o":"24h open"}}) into
 * live-price entries keyed by canonical token id. The 24-hour change is derived from the last price and the
 * 24-hour open, exactly as the relay does it. Anything malformed or unusable yields an empty object.
 */
export function parseBinanceDirectFrame(raw: string, at: number): Record<string, LivePriceEntry> {
  let message: { data?: { s?: string; c?: string; o?: string } };
  try {
    message = JSON.parse(raw);
  } catch {
    return {};
  }
  const data = message?.data;
  if (!data?.s) return {};
  const last = Number(data.c);
  const open = Number(data.o);
  if (!Number.isFinite(last) || last <= 0 || !Number.isFinite(open) || open <= 0) return {};
  const out: Record<string, LivePriceEntry> = {};
  for (const tokenId of symbolTokens.get(data.s.toUpperCase()) ?? []) {
    out[tokenId] = { p: last, c: (last / open - 1) * 100, s: "binance", at };
  }
  return out;
}
