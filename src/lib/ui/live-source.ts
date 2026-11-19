import { binanceSymbols } from "../../data/binance-symbols.ts";
import { coinbaseProducts } from "../../data/coinbase-token-mappings.ts";

export type LiveSource = "coinbase" | "binance";

/**
 * Which exchange quotes a token live, or null when neither does. Coinbase wins where it lists the token, exactly as
 * on the server (src/lib/providers/live-price-source.ts); Binance quotes the rest in USDT.
 */
export function liveSourceFor(tokenId: string): LiveSource | null {
  if (coinbaseProducts[tokenId]) return "coinbase";
  if (binanceSymbols[tokenId]) return "binance";
  return null;
}
