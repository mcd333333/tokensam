/**
 * User-facing data language. Token Samurai presents datasets by what they
 * describe (token, associated protocol, on-chain DEX markets), not by the
 * external service that supplied them. Provider identity stays intact in the
 * backend, the stored provenance, and the AI evidence; it is shown to users
 * only in the optional Data provenance disclosure.
 */

/** Dataset name for each collection step, used for freshness lines. */
export const DATASET_LABELS: Record<string, string> = {
  coingecko: "Market data",
  binance: "Live exchange price",
  defillama_coins: "Reference token prices",
  defillama: "Protocol data",
  dexscreener: "DEX market data",
  geckoterminal: "On-chain DEX pools",
};

export function datasetLabel(providerId: string, fallback: string): string {
  return DATASET_LABELS[providerId] ?? fallback;
}

/** Data provenance: which external service supplies each dataset. Only rendered in that disclosure. */
export const TECHNICAL_PROVENANCE: { dataset: string; provider: string }[] = [
  { dataset: "Market data", provider: "CoinGecko" },
  { dataset: "Live exchange price", provider: "Coinbase" },
  { dataset: "Reference token prices", provider: "DeFiLlama (coins API)" },
  { dataset: "Protocol data", provider: "DeFiLlama" },
  { dataset: "DEX market data", provider: "DEX Screener" },
  { dataset: "On-chain DEX pools", provider: "GeckoTerminal" },
];

// Order matters: the scoped phrase is rewritten before the bare name.
const REPLACEMENTS: [RegExp, string][] = [
  [/\bDeFiLlama protocol\b/g, "associated-protocol"],
  [/\bDeFiLlama\b/g, "associated-protocol"],
  [/\bDEX Screener\b/g, "DEX market"],
  [/\bCoinGecko\b/g, "token"],
  // Binance appears in the stored provenance note on every live price observation
  // (see BINANCE_PRICE_NOTE); the same policy applies to it as to the other providers.
  [/\bBinance\b/g, "exchange"],
  [/\bCoinbase\b/g, "exchange"],
];

/**
 * Rewrites stored backend text (calculation formulas, unavailable reasons)
 * in scope terms for display. The stored text itself is never changed.
 */
export function plainLanguage(text: string): string {
  return REPLACEMENTS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

/** True when text names an external data provider (used by tests and the UI audit). */
export function namesProvider(text: string): boolean {
  return /coingecko|defillama|dex ?screener/i.test(text);
}
