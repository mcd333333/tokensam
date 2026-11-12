import { binanceSymbols } from "../../data/binance-token-mappings.ts";
import { coinbaseProducts } from "../../data/coinbase-token-mappings.ts";
import { fetchCoinbaseTickers } from "./coinbase.ts";

/**
 * Live exchange prices per token, for the browser ticker route and the server-rendered pages.
 *
 * Binance's and Coinbase's REST APIs throttle or block Cloudflare Workers' shared addresses, so the primary source
 * is WebSocket: a Durable Object per exchange (cloudflare/price-stream.ts) holds one connection and keeps the latest
 * price and 24-hour change for every symbol. Coinbase is preferred (USD-quoted, 117 tokens); Binance fills in the
 * tokens Coinbase does not list (USDT-quoted, a USD proxy). When the Coinbase stream is unavailable, Coinbase's REST
 * endpoint (src/lib/providers/coinbase.ts) covers its tokens. A token with no usable live price here simply keeps its
 * stored CoinGecko price.
 */

export type LiveSource = "coinbase" | "binance";
export type LivePrice = { p: number; c: number; /** ms epoch of the last trade */ at: number; source: LiveSource };
type StreamPrices = Record<string, { p: number; c: number; at: number }>;
export type StreamReader = (source: LiveSource) => Promise<StreamPrices | null>;

/** A price whose last trade is older than this is not served as live (halted or very quiet markets). */
export const LIVE_MAX_AGE_MS = 10 * 60 * 1000;
/** Shared by every page render and poll inside one Worker instance. */
const MEMO_TTL_MS = 1_000;
const STREAM_TIMEOUT_MS = 6_000;

type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(url: string): Promise<Response> };
};

/** Reads one exchange's prices from its Durable Object; null when it is not available or not connected. */
async function readFromDurableObject(source: LiveSource): Promise<StreamPrices | null> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const namespace = (getCloudflareContext().env as { PRICE_STREAM?: DurableObjectNamespaceLike }).PRICE_STREAM;
    if (!namespace) return null;
    const response = await Promise.race([
      namespace.get(namespace.idFromName(source)).fetch(`https://price-stream/ws-prices/${source}`),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), STREAM_TIMEOUT_MS)),
    ]);
    if (!response || !response.ok) return null;
    const body = (await response.json()) as { connected?: boolean; prices?: StreamPrices };
    return body.connected && body.prices ? body.prices : null;
  } catch {
    // Not running on Cloudflare (tests, local `next dev`) or the Durable Object failed: use the REST fallback.
    return null;
  }
}

let streamReader: StreamReader = readFromDurableObject;
let memo: { at: number; value: Map<string, LivePrice> } | null = null;
let inFlight: Promise<Map<string, LivePrice>> | null = null;

/** Test hooks. */
export function setStreamReaderForTests(reader: StreamReader | null): void {
  streamReader = reader ?? readFromDurableObject;
  memo = null;
  inFlight = null;
}

function usable(entry: { p: number; c: number; at: number } | undefined, now: number): entry is { p: number; c: number; at: number } {
  return Boolean(entry) && Number.isFinite(entry!.p) && entry!.p > 0 && Number.isFinite(entry!.c)
    && Number.isFinite(entry!.at) && now - entry!.at <= LIVE_MAX_AGE_MS;
}

async function build(): Promise<Map<string, LivePrice>> {
  const now = Date.now();
  const [coinbase, binance] = await Promise.all([streamReader("coinbase"), streamReader("binance")]);

  // Coinbase's REST endpoint stands in only when its stream is down; it is skipped when the stream answered.
  let restFallback = new Map<string, { price: number; changePct: number; at: number }>();
  if (!coinbase) {
    try { restFallback = await fetchCoinbaseTickers(Object.values(coinbaseProducts)); } catch { /* keep going with what we have */ }
  }

  const prices = new Map<string, LivePrice>();
  const tokenIds = new Set([...Object.keys(coinbaseProducts), ...Object.keys(binanceSymbols)]);
  for (const tokenId of tokenIds) {
    const product = coinbaseProducts[tokenId];
    const symbol = binanceSymbols[tokenId];
    const fromCoinbase = product ? coinbase?.[product] : undefined;
    if (usable(fromCoinbase, now)) {
      prices.set(tokenId, { ...fromCoinbase, source: "coinbase" });
      continue;
    }
    const rest = product ? restFallback.get(product) : undefined;
    if (rest && usable({ p: rest.price, c: rest.changePct, at: rest.at }, now)) {
      prices.set(tokenId, { p: rest.price, c: rest.changePct, at: rest.at, source: "coinbase" });
      continue;
    }
    const fromBinance = symbol ? binance?.[symbol] : undefined;
    if (usable(fromBinance, now)) prices.set(tokenId, { ...fromBinance, source: "binance" });
  }
  return prices;
}

/** Latest live price per token id, from the best available source. Never throws; may return an empty map. */
export async function readLivePrices(): Promise<Map<string, LivePrice>> {
  if (memo && Date.now() - memo.at < MEMO_TTL_MS) return memo.value;
  inFlight ??= build().finally(() => { inFlight = null; });
  const value = await inFlight;
  memo = { at: Date.now(), value };
  return value;
}
