import { canonicalTokens } from "./canonical-tokens.ts";
import { onchainTokenMappings } from "./onchain-token-mappings.ts";
import { extraOnchainMappings } from "./onchain-extra-mappings.ts";
import { dexPaprikaNetwork } from "../lib/providers/dexpaprika-pools.ts";

const canonicalIds = new Set(canonicalTokens.map((token) => token.id));

export type OnchainAsset = { tokenId: string; chainId: string; network: string; tokenAddress: string };

/**
 * Tokens with an exact chain/address identity on a network DexPaprika indexes: the primary curated mapping plus the
 * extra DexPaprika-verified ones. Limited to the canonical universe, because the mapping file also holds retired
 * tokens that have no row in `tokens` to attach to.
 */
export const dexPoolAssets: OnchainAsset[] = [
  ...onchainTokenMappings
    .filter((mapping) => mapping.dexChainId && mapping.tokenAddress && canonicalIds.has(mapping.tokenId) && dexPaprikaNetwork(mapping.dexChainId))
    .map((mapping) => ({
      tokenId: mapping.tokenId,
      chainId: mapping.canonicalChainId,
      network: dexPaprikaNetwork(mapping.dexChainId as string) as string,
      tokenAddress: mapping.tokenAddress as string,
    })),
  ...extraOnchainMappings
    .filter((mapping) => canonicalIds.has(mapping.tokenId))
    .map((mapping) => ({ tokenId: mapping.tokenId, chainId: mapping.canonicalChainId, network: mapping.network, tokenAddress: mapping.tokenAddress })),
];

/** On-chain identity (canonical chain + exact token address) for a token that has DEX data, or undefined. */
export function onchainIdentityFor(tokenId: string): { chainId: string; tokenAddress: string; network: string } | undefined {
  const asset = dexPoolAssets.find((candidate) => candidate.tokenId === tokenId);
  return asset ? { chainId: asset.chainId, tokenAddress: asset.tokenAddress, network: asset.network } : undefined;
}
