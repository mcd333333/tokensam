import { dexScreenerTokenMappings } from "../../data/dexscreener-token-mappings.ts";
import { DEX_POOL_REQUEST_INTERVAL_MS, DexPoolApiError, fetchDexPools } from "./dexscreener-pools.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

/** A token's pool snapshot is refreshed once it is older than this (about the old 30-minute DEX Screener cadence). */
export const DEX_POOL_REFRESH_AFTER_MS = 25 * 60 * 1000;

export type DexPoolCollectionResult = {
  attempted: number;
  succeeded: number;
  failed: number;
  stoppedReason: "done" | "slice_limit" | "deadline" | "rate_limited" | "none_due";
  dueRemaining: number;
};

/** Tokens with an exact DEX Screener chain/address identity: the only ones that can have pools. */
export const dexPoolAssets = dexScreenerTokenMappings
  .filter((mapping) => mapping.dexChainId && mapping.tokenAddress)
  .map((mapping) => ({ tokenId: mapping.tokenId, chainId: mapping.dexChainId as string, tokenAddress: mapping.tokenAddress as string }));

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

  const result: DexPoolCollectionResult = {
    attempted: 0, succeeded: 0, failed: 0, stoppedReason: due.length === 0 ? "none_due" : "done", dueRemaining: due.length,
  };

  for (const asset of due) {
    if (result.attempted >= options.maxTokens) { result.stoppedReason = "slice_limit"; break; }
    if (Date.now() + minIntervalMs >= options.deadlineAt) { result.stoppedReason = "deadline"; break; }
    if (result.attempted > 0) await sleep(minIntervalMs);
    result.attempted += 1;
    try {
      const pools = await fetchPools(asset.chainId, asset.tokenAddress);
      const { error: writeError } = await client.from("token_dex_pools")
        .upsert({ token_id: asset.tokenId, fetched_at: new Date().toISOString(), pools }, { onConflict: "token_id" });
      if (writeError) throw new Error(`Supabase write DEX pools failed: ${writeError.message}`);
      result.succeeded += 1;
      result.dueRemaining -= 1;
    } catch (caught) {
      result.failed += 1;
      console.error(`[dex-pools] ${asset.tokenId} failed: ${caught instanceof Error ? caught.message : "unknown error"}`);
      // A 429 means every further call this slice would fail too.
      if (caught instanceof DexPoolApiError && caught.status === 429) { result.stoppedReason = "rate_limited"; break; }
    }
  }
  return result;
}
