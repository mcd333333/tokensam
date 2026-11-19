import { canonicalTokens } from "./canonical-tokens.ts";
import type { CoverageReason } from "./provider-coverage.ts";
import { binanceSymbols } from "./binance-symbols.ts";

/**
 * Curated Binance spot-symbol mappings, used for the *live* price and 24-hour
 * price change only (see src/lib/providers/binance.ts).
 *
 * Identity, as everywhere else in this project, is an explicit per-token
 * decision rather than anything derived from a ticker at runtime. That
 * matters more here than for any other provider, because a Binance symbol
 * *is* a ticker pair: Binance lists the fungible asset, not a chain-scoped
 * contract. Two consequences are deliberate:
 *
 * 1. Every entry below was generated against Binance's own
 *    GET /api/v3/exchangeInfo (permissions=SPOT) on 2026-10-06 and kept only
 *    when the symbol's `status` was `TRADING` and `isSpotTradingAllowed` was
 *    true -- never inferred by concatenating `symbol + "USDT"`. The canonical
 *    universe currently has no two tokens sharing a ticker, which is asserted
 *    in tests/binance.test.mjs so a future addition cannot silently make one
 *    canonical token adopt another's Binance price.
 * 2. For a canonical token that is one chain's deployment of a multi-chain
 *    asset (for example `ethereum-usdc`), Binance's price is the asset's
 *    venue price, not that specific deployment's. Prices are arbitraged across
 *    deployments, so this is acceptable for a live price and is recorded in
 *    the observation note; it is NOT acceptable for supply, market cap, or
 *    anything else, which is why this provider writes no such metric.
 *
 * All mapped symbols are USDT-quoted. USDT is a USD *proxy*, not USD: the
 * stored metric keeps the `price_usd` id so it is a drop-in for CoinGecko's,
 * but every Binance observation says so in its note, and no code treats the
 * two as having identical provenance.
 */
export { binanceSymbols };

/**
 * Canonical tokens deliberately left unmapped, with the reason the UI and the
 * AI layer are allowed to state. Each of these falls back to CoinGecko for
 * price, which is exactly what the fallback exists for.
 */
export const binanceUnmapped: Record<string, { reason: CoverageReason; detail: string }> = {
  "ethereum-usdt": {
    reason: "provider_does_not_support_token",
    detail: "USDT is the quote currency of every symbol used here, so Binance lists no USDTUSDT spot market to price it against.",
  },
  "solana-hnt": {
    reason: "no_provider_data",
    detail: "HNTUSDT exists on Binance but its status was BREAK (trading halted) when this mapping was verified on 2026-10-19, so its last price is stale and must not be served as live.",
  },
  "ethereum-mnt": {
    reason: "provider_does_not_support_token",
    detail: "No MNTUSDT (or any MNT) spot market exists on Binance, verified against /api/v3/exchangeInfo on 2026-10-17; an earlier mapping added without live verification was incorrect and broke the whole live-price batch.",
  },
  "akash-akt": {
    reason: "provider_does_not_support_token",
    detail: "No AKTUSDT (or any AKT) spot market exists on Binance, verified against /api/v3/exchangeInfo on 2026-10-17; an earlier mapping added without live verification was incorrect and broke the whole live-price batch.",
  },
};

/** Canonical token ids that have a Binance symbol, for collection and coverage. */
export const binanceMappedTokenIds: string[] = canonicalTokens
  .filter((token) => Boolean(binanceSymbols[token.id]))
  .map((token) => token.id);
