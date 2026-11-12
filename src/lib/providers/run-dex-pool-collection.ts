import { dexScreenerTokenMappings } from "../../data/dexscreener-token-mappings.ts";
import { extraOnchainMappings } from "../../data/dexpaprika-extra-mappings.ts";
import { canonicalTokens } from "../../data/canonical-tokens.ts";
import { DEX_POOL_RATE_LIMIT_COOLDOWN_MS, DEX_POOL_REQUEST_INTERVAL_MS, DexPoolApiError, dexPaprikaNetwork, fetchDexPools } from "./dexpaprika-pools.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

/**
 * A token's pool snapshot is refreshed once it is older than this. Every 90 minutes keeps the free key's 100,000-credit allowance
 * comfortable (about 95 tokens x 16 x 30 = 46,000 requests a month, if a request costs one credit).
 */
export const DEX_POOL_REFRESH_AFTER_MS = 90 * 60 * 1000;

export type DexPoolCollectionResult = {
  attempted: number;
  succeeded: number;
  failed: number;
  stoppedReason: "done" | "slice_limit" | "deadline" | "rate_limited" | "credits_exhausted" | "none_due";
  dueRemaining: number;
  /** First failure this call, as "<token> <message>" (message only, never a response body). */
  firstError?: string;
};

const canonicalIds = new Set(canonicalTokens.map((token) => token.id));

/**
 * Tokens with an exact chain/address identity (the curated DEX Screener mapping, which is also this project's on-chain identity) on a network DexPaprika indexes: the only ones that can have pools. Limited to the
 * canonical universe, because the mapping file also holds retired tokens that have no row in `tokens` to attach to.
 */
export const dexPoolAssets = [
  ...dexScreenerTokenMappings
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

/** On-chain identity (canonical chain + exact token address) for a token that has pool data, or undefined. */
export function onchainIdentityFor(tokenId: string): { chainId: string; tokenAddress: string } | undefined {
  const asset = dexPoolAssets.find((candidate) => candidate.tokenId === tokenId);
  return asset ? { chainId: asset.chainId, tokenAddress: asset.tokenAddress } : undefined;
}

/**
 * Refreshes the stalest pool snapshots first (never-fetched tokens before old ones), at most `maxTokens` per
 * call, so the Worker's 5-minute ticks walk the whole list about every 30 minutes and an idle tick is a cheap no-op.
 */
export async function runDexPoolCollection(
  client: SupabaseAdminClient,
  options: {
    now?: Date;
    maxTokens: number;
    deadlineAt: number;
    fetchPools?: typeof fetchDexPools;
    sleep?: (ms: number) => Promise<void>;
    minIntervalMs?: number;
  },
): Promise<DexPoolCollectionResult> {
  const now = options.now ?? new Date();
  const fetchPools = options.fetchPools ?? fetchDexPools;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const minIntervalMs = options.minIntervalMs ?? DEX_POOL_REQUEST_INTERVAL_MS;

  const { data, error } = await client.from("token_dex_pools").select("token_id,fetched_at");
  if (error) throw new Error(`Supabase read DEX pool snapshots failed: ${error.message}`);
  const fetchedAt = new Map((data as { token_id: string; fetched_at: string }[]).map((row) => [row.token_id, Date.parse(row.fetched_at)]));

  const due = dexPoolAssets
    .filter((asset) => now.getTime() - (fetchedAt.get(asset.tokenId) ?? 0) >= DEX_POOL_REFRESH_AFTER_MS)
    .sort((a, b) => (fetchedAt.get(a.tokenId) ?? 0) - (fetchedAt.get(b.tokenId) ?? 0));

  let consecutiveRateLimits = 0;
  const result: DexPoolCollectionResult = {
    attempted: 0, succeeded: 0, failed: 0, stoppedReason: due.length === 0 ? "none_due" : "done", dueRemaining: due.length,
  };

  for (const asset of due) {
    if (result.attempted >= options.maxTokens) { result.stoppedReason = "slice_limit"; break; }
    if (Date.now() + minIntervalMs >= options.deadlineAt) { result.stoppedReason = "deadline"; break; }
    if (result.attempted > 0) await sleep(minIntervalMs);
    result.attempted += 1;
    try {
      const pools = await fetchPools(asset.network, asset.tokenAddress);
      const { error: writeError } = await client.from("token_dex_pools")
        .upsert({ token_id: asset.tokenId, fetched_at: new Date().toISOString(), pools }, { onConflict: "token_id" });
      if (writeError) throw new Error(`Supabase write DEX pools failed: ${writeError.message}`);
      result.succeeded += 1;
      result.dueRemaining -= 1;
      consecutiveRateLimits = 0;
    } catch (caught) {
      result.failed += 1;
      const message = caught instanceof Error ? caught.message : "unknown error";
      console.error(`[dex-pools] ${asset.tokenId} failed: ${message}`);
      result.firstError ??= `${asset.tokenId} ${message}`.slice(0, 300);
      // A single 429 is skipped (that token stays due and is retried on a later tick) after a cooldown; two in a
      // row mean the address is throttled, so the slice stops rather than hammering it.
      // 402 means the plan's credits are used up; nothing more this slice (or month) will succeed, so stop at once.
      if (caught instanceof DexPoolApiError && caught.status === 402) { result.stoppedReason = "credits_exhausted"; break; }
      if (caught instanceof DexPoolApiError && caught.status === 429) {
        consecutiveRateLimits += 1;
        if (consecutiveRateLimits >= 2) { result.stoppedReason = "rate_limited"; break; }
        await sleep(DEX_POOL_RATE_LIMIT_COOLDOWN_MS);
      } else {
        consecutiveRateLimits = 0;
      }
    }
  }
  return result;
}
