import { canonicalTokens, type CanonicalTokenDefinition } from "./canonical-tokens.ts";
import { coinbaseProducts } from "./coinbase-token-mappings.ts";
import { coingeckoTokenIds } from "./coingecko-token-mappings.ts";
import { defillamaProtocolMappings } from "./defillama-protocol-mappings.ts";
import { dexScreenerTokenMappings } from "./dexscreener-token-mappings.ts";

/**
 * Provider identity and coverage for every canonical token.
 *
 * Identity is always a provider-specific identifier (CoinGecko ID, DeFiLlama
 * coins key, chain + exact address), never a ticker. Every missing mapping
 * carries an explicit reason so the UI and AI can say *why* data is absent.
 */

export type CoverageProvider = "coingecko" | "binance" | "defillama_coins" | "defillama" | "dexscreener";
export type CoverageScope = "token" | "protocol" | "market";
export type CoverageReason =
  | "provider_does_not_support_token"
  | "native_asset_lacks_provider_identifier"
  | "wrapped_representation_only"
  | "contract_address_unavailable"
  | "requires_paid_access"
  | "token_level_metric_unavailable"
  | "requires_manual_verification"
  | "no_protocol_association"
  | "no_provider_data";

export type MappingClass =
  | "A_deterministic"
  | "B_verified_discovery"
  | "C_manual_curation"
  | "D_not_supported";

export type ProviderCoverage = {
  provider: CoverageProvider;
  label: string;
  scope: CoverageScope;
  status: "mapped" | "unavailable";
  identifier: string | null;
  mappingClass: MappingClass;
  verification: string | null;
  reason: CoverageReason | null;
  detail: string;
};

export const PROVIDER_LABELS: Record<CoverageProvider, string> = {
  coingecko: "CoinGecko",
  // The id is the live-exchange-price slot, kept from when Binance filled it; Coinbase fills it now.
  binance: "Coinbase",
  defillama_coins: "DeFiLlama (token prices)",
  defillama: "DeFiLlama (protocol)",
  dexscreener: "DEX Screener",
};

/** DeFiLlama coins-API chain slugs for canonical chains that carry contract tokens. */
const DEFILLAMA_CHAIN: Record<string, string> = {
  ethereum: "ethereum", arbitrum: "arbitrum", optimism: "optimism", base: "base", solana: "solana",
};

/**
 * DeFiLlama coins-API key: `chain:address` for contract tokens on supported
 * chains (on-chain identity, verified against CoinGecko platforms), otherwise
 * `coingecko:<id>` (the documented key form; used for natives such as BTC).
 */
export function defillamaCoinsIdentifier(token: CanonicalTokenDefinition): string | null {
  if (!token.isNative && token.contractAddress && DEFILLAMA_CHAIN[token.chainId]) return `${DEFILLAMA_CHAIN[token.chainId]}:${token.contractAddress}`;
  const coingeckoId = coingeckoTokenIds[token.id];
  return coingeckoId ? `coingecko:${coingeckoId}` : null;
}

/** Explicit DEX Screener gap classification (from the reviewed unmapped reasons, not inferred). */
const DEX_GAP: Record<string, CoverageReason> = {
  "ethereum-eth": "wrapped_representation_only",
  "solana-sol": "wrapped_representation_only",
  "bnb-bnb": "wrapped_representation_only",
  "avalanche-avax": "wrapped_representation_only",
  "polygon-pol": "no_provider_data",
  "stellar-xlm": "no_provider_data",
  "cosmos-atom": "no_provider_data",
};

/**
 * Token-level DeFi metrics DeFiLlama offers only through its paid Pro API
 * (api-docs.defillama.com, checked 2026-09-25). Not configured here.
 */
export const DEFILLAMA_PRO_TOKEN_METRICS: { metric: string; endpoint: string; detail: string }[] = [
  { metric: "Token liquidity (historical)", endpoint: "/api/historicalLiquidity/{token}", detail: "Pro-only DeFiLlama endpoint; no Pro API key is configured." },
  { metric: "Token emissions and unlocks", endpoint: "/api/emissions, /api/emission/{protocol}", detail: "Pro-only DeFiLlama endpoints; no Pro API key is configured." },
  { metric: "Token usage across protocols", endpoint: "/api/tokenProtocols/{symbol}", detail: "Pro-only, and keyed by ticker symbol, which Token Samurai never uses as identity." },
];

export function tokenCoverage(token: CanonicalTokenDefinition): ProviderCoverage[] {
  const coingeckoId = coingeckoTokenIds[token.id] ?? null;
  const llamaKey = defillamaCoinsIdentifier(token);
  const protocol = defillamaProtocolMappings.find((mapping) => mapping.tokenId === token.id);
  const dex = dexScreenerTokenMappings.find((mapping) => mapping.tokenId === token.id);

  const coingecko: ProviderCoverage = coingeckoId
    ? {
      provider: "coingecko", label: PROVIDER_LABELS.coingecko, scope: "token", status: "mapped", identifier: coingeckoId,
      mappingClass: "C_manual_curation",
      verification: token.isNative ? "Curated CoinGecko ID for the native asset." : "Curated CoinGecko ID; canonical contract address matches CoinGecko's platform address (2026-09-25).",
      reason: null, detail: "Token-level market data (price, market cap, volume, supply, history).",
    }
    : {
      provider: "coingecko", label: PROVIDER_LABELS.coingecko, scope: "token", status: "unavailable", identifier: null,
      mappingClass: "D_not_supported", verification: null, reason: "provider_does_not_support_token", detail: "No CoinGecko ID is mapped.",
    };

  const coinbaseProduct = coinbaseProducts[token.id] ?? null;
  const binance: ProviderCoverage = coinbaseProduct
    ? {
      provider: "binance", label: PROVIDER_LABELS.binance, scope: "market", status: "mapped", identifier: coinbaseProduct,
      mappingClass: "C_manual_curation",
      verification: "Curated Coinbase spot product, confirmed online and USD-quoted in GET /api/v3/brokerage/market/products (2026-11-12); never derived from the ticker at runtime.",
      reason: null,
      detail: "Preferred live price and 24-hour price change (Coinbase spot last trade, USD-quoted). Not market cap, supply, volume, or history -- those stay CoinGecko's.",
    }
    : {
      provider: "binance", label: PROVIDER_LABELS.binance, scope: "market", status: "unavailable", identifier: null,
      mappingClass: "D_not_supported", verification: null,
      reason: "provider_does_not_support_token",
      detail: "Coinbase does not list a USD spot product for this token; the live price falls back to CoinGecko.",
    };

  const defillamaCoins: ProviderCoverage = llamaKey
    ? {
      provider: "defillama_coins", label: PROVIDER_LABELS.defillama_coins, scope: "token", status: "mapped", identifier: llamaKey,
      mappingClass: "A_deterministic",
      verification: llamaKey.startsWith("coingecko:")
        ? "Documented DeFiLlama coins key derived from the CoinGecko ID; DeFiLlama may source this price from CoinGecko."
        : "Documented DeFiLlama coins key from the verified chain and contract address.",
      reason: null, detail: "Token-level price with DeFiLlama's confidence score.",
    }
    : {
      provider: "defillama_coins", label: PROVIDER_LABELS.defillama_coins, scope: "token", status: "unavailable", identifier: null,
      mappingClass: "D_not_supported", verification: null, reason: "native_asset_lacks_provider_identifier", detail: "No DeFiLlama coins identifier can be derived.",
    };

  const defillamaProtocol: ProviderCoverage = protocol
    ? {
      provider: "defillama", label: PROVIDER_LABELS.defillama, scope: "protocol", status: "mapped", identifier: protocol.externalAssetId,
      mappingClass: "C_manual_curation", verification: "Curated protocol association reviewed by a person.", reason: null,
      detail: `Protocol-level TVL, fees, and revenue for "${protocol.externalAssetId}" (${protocol.relationship}). Not token-level data.`,
    }
    : {
      provider: "defillama", label: PROVIDER_LABELS.defillama, scope: "protocol", status: "unavailable", identifier: null,
      mappingClass: "C_manual_curation", verification: null, reason: "no_protocol_association",
      detail: token.isNative
        ? `${token.name} is a chain's native asset, not a DeFiLlama protocol; chain-level TVL is not ${token.symbol} token data and is not used.`
        : "No curated DeFiLlama protocol association exists for this token; protocol data is never inferred from a ticker.",
    };

  const dexscreener: ProviderCoverage = dex?.tokenAddress && dex.dexChainId
    ? {
      provider: "dexscreener", label: PROVIDER_LABELS.dexscreener, scope: "market", status: "mapped", identifier: `${dex.dexChainId}:${dex.tokenAddress}`,
      mappingClass: token.isNative ? "B_verified_discovery" : "A_deterministic",
      verification: dex.mappingEvidence ?? "Canonical contract address matches CoinGecko's platform address; queried by exact chain and address.",
      reason: null, detail: "DEX pair/market data for the exact token address (not the whole market).",
    }
    : {
      provider: "dexscreener", label: PROVIDER_LABELS.dexscreener, scope: "market", status: "unavailable", identifier: null,
      mappingClass: DEX_GAP[token.id] === "wrapped_representation_only" ? "D_not_supported" : "B_verified_discovery",
      verification: null,
      reason: DEX_GAP[token.id] ?? (token.isNative ? "native_asset_lacks_provider_identifier" : "contract_address_unavailable"),
      detail: dex?.unmappedReason ?? "No verified DEX Screener address mapping exists.",
    };

  return [coingecko, binance, defillamaCoins, defillamaProtocol, dexscreener];
}

export function coverageMatrix(): { tokenId: string; symbol: string; isNative: boolean; coverage: ProviderCoverage[] }[] {
  return canonicalTokens.map((token) => ({ tokenId: token.id, symbol: token.symbol, isNative: token.isNative, coverage: tokenCoverage(token) }));
}
