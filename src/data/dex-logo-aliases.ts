/**
 * DexPaprika DEX id -> CoinGecko exchange identifier, for DEXes whose ids differ between the two providers but are
 * the same exchange. Used only to borrow CoinGecko's logo for the DEX boxes: a DEX with no exact id match and no entry
 * here simply shows no logo. Every entry was checked against the stored CoinGecko exchange list (2026-11-12); nothing
 * is matched by fuzzy name.
 */
export const dexLogoAliases: Record<string, string> = {
  uniswap_v4: "uniswap-v4-ethereum",
  raydium_clmm: "raydium-clmm",
  raydium: "raydium2",
  pancakeswap_v2: "pancakeswap_new",
  pancakeswap_v3: "pancakeswap-v3-bsc",
  metric: "metric-ethereum",
  curve: "curve_ethereum",
  sushiswap_v3: "sushiswap",
};

/** The CoinGecko exchange id whose logo stands for this DexPaprika DEX id: the same id, else a listed alias. */
export function coingeckoIdForDex(dexId: string): string[] {
  return [dexId, ...(dexLogoAliases[dexId] ? [dexLogoAliases[dexId]] : [])];
}
