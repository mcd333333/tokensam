import { canonicalTokens } from "../../data/canonical-tokens.ts";
import { dexScreenerTokenMappings } from "../../data/dexscreener-token-mappings.ts";
import { extraOnchainMappings } from "../../data/dexpaprika-extra-mappings.ts";
import { DEXPAPRIKA_PROVIDER_ID, buildDexPaprikaSnapshot, fetchTokenStats, type DexPaprikaAsset } from "./dexpaprika.ts";
import {
  DEX_POOL_RATE_LIMIT_COOLDOWN_MS, DEX_POOL_REQUEST_INTERVAL_MS, DexPoolApiError, dexPaprikaAddress, dexPaprikaNetwork, fetchDexPools,
  type DexPool,
} from "./dexpaprika-pools.ts";
import { persistProviderSnapshots } from "./persist-snapshots.ts";
import type { ProviderSnapshot } from "./types.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

/**
 * Each token needs two kinds of DexPaprika data: token-level stats (one small request, refreshed about every 90 minutes)
 * and its pool list (one larger request, refreshed about every 6 hours). With ~95 tokens that is roughly
 * 95 x 16 x 30 + 95 x 4 x 30 = 57,000 requests a month, inside the free key's 100,000 credits if a request costs one.
 */
export const DEX_STATS_REFRESH_AFTER_MS = 90 * 60 * 1000;
export const DEX_POOLS_REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;
/** Hard ceiling on requests per UTC month; the collector stops at it rather than run the key dry. */
export const DEFAULT_MONTHLY_CALL_CAP = 85_000;

export type DexPaprikaCollectionResult = {
  attempted: number;
  succeeded: number;
  failed: number;
  poolsRefreshed: number;
  unindexed: number;
  stoppedReason: "done" | "slice_limit" | "deadline" | "rate_limited" | "credits_exhausted" | "monthly_cap" | "none_due";
  dueRemaining: number;
  callsThisMonth: number;
  /** First failure this call, as "<token> <message>" (message only, never a response body). */
  firstError?: string;
};

const canonicalIds = new Set(canonicalTokens.map((token) => token.id));

/**
 * Tokens with an exact chain/address identity on a network DexPaprika indexes: the curated DEX Screener-era mapping
 * (which is also this project's on-chain identity) plus the extra DexPaprika-verified ones. Limited to the canonical
 * universe, because the mapping file also holds retired tokens that have no row in `tokens` to attach to.
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

/** On-chain identity (canonical chain + exact token address) for a token that has DEX data, or undefined. */
export function onchainIdentityFor(tokenId: string): { chainId: string; tokenAddress: string } | undefined {
  const asset = dexPoolAssets.find((candidate) => candidate.tokenId === tokenId);
  return asset ? { chainId: asset.chainId, tokenAddress: asset.tokenAddress } : undefined;
}

type Fetchers = { fetchStats: typeof fetchTokenStats; fetchPools: typeof fetchDexPools };

/**
 * Refreshes the stalest tokens first (never-fetched before old ones), at most `maxTokens` per call, so the Worker's
 * 5-minute ticks walk the whole list about every 90 minutes and an idle tick does nothing. Every request is counted
 * against the monthly cap before it is made. A single 429 is skipped after a cooldown (that token stays due); two in
 * a row stop the slice; a 402 (credits exhausted) stops it at once.
 */
export async function runDexPaprikaCollection(
  client: SupabaseAdminClient,
  options: {
    now?: Date;
    maxTokens: number;
    deadlineAt: number;
    monthlyCap?: number;
    fetchers?: Partial<Fetchers>;
    sleep?: (ms: number) => Promise<void>;
    minIntervalMs?: number;
    persist?: typeof persistProviderSnapshots;
  },
): Promise<DexPaprikaCollectionResult> {
  const now = options.now ?? new Date();
  const fetchStats = options.fetchers?.fetchStats ?? fetchTokenStats;
  const fetchPools = options.fetchers?.fetchPools ?? fetchDexPools;
  const persist = options.persist ?? persistProviderSnapshots;
  const monthlyCap = options.monthlyCap ?? DEFAULT_MONTHLY_CALL_CAP;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const minIntervalMs = options.minIntervalMs ?? DEX_POOL_REQUEST_INTERVAL_MS;
  const month = now.toISOString().slice(0, 7);

  const [rowsResult, usageResult] = await Promise.all([
    client.from("token_dex_pools").select("token_id,pools_at,stats_at"),
    client.from("provider_call_usage").select("calls").eq("provider", DEXPAPRIKA_PROVIDER_ID).eq("month", month).maybeSingle(),
  ]);
  if (rowsResult.error) throw new Error(`Supabase read DEX snapshots failed: ${rowsResult.error.message}`);
  if (usageResult.error) throw new Error(`Supabase read DexPaprika call usage failed: ${usageResult.error.message}`);
  let calls = (usageResult.data as { calls?: number } | null)?.calls ?? 0;
  const stamps = new Map((rowsResult.data as { token_id: string; pools_at: string | null; stats_at: string | null }[])
    .map((row) => [row.token_id, { poolsAt: row.pools_at ? Date.parse(row.pools_at) : 0, statsAt: row.stats_at ? Date.parse(row.stats_at) : 0 }]));

  const due = dexPoolAssets
    .filter((asset) => now.getTime() - (stamps.get(asset.tokenId)?.statsAt ?? 0) >= DEX_STATS_REFRESH_AFTER_MS)
    .sort((a, b) => (stamps.get(a.tokenId)?.statsAt ?? 0) - (stamps.get(b.tokenId)?.statsAt ?? 0));

  const result: DexPaprikaCollectionResult = {
    attempted: 0, succeeded: 0, failed: 0, poolsRefreshed: 0, unindexed: 0,
    stoppedReason: due.length === 0 ? "none_due" : "done", dueRemaining: due.length, callsThisMonth: calls,
  };
  const snapshots: ProviderSnapshot[] = [];
  const statsOnly: { token_id: string; stats_at: string }[] = [];
  const withPools: { token_id: string; stats_at: string; pools_at: string; pools: DexPool[] }[] = [];
  const mappings: Record<string, unknown>[] = [];
  let consecutiveRateLimits = 0;
  let first = true;

  /** Counts the request, spaces it from the previous one, then makes it. */
  const request = async <T>(make: () => Promise<T>): Promise<T> => {
    if (!first) await sleep(minIntervalMs);
    first = false;
    calls += 1;
    const { error } = await client.rpc("bump_provider_call_usage", { p_provider: DEXPAPRIKA_PROVIDER_ID, p_month: month, p_calls: 1 });
    if (error) throw new Error(`Supabase record DexPaprika call usage failed: ${error.message}`);
    return make();
  };

  for (const asset of due) {
    if (result.attempted >= options.maxTokens) { result.stoppedReason = "slice_limit"; break; }
    if (Date.now() + 2 * minIntervalMs >= options.deadlineAt) { result.stoppedReason = "deadline"; break; }
    if (calls >= monthlyCap) { result.stoppedReason = "monthly_cap"; break; }
    result.attempted += 1;
    const address = dexPaprikaAddress(asset.network, asset.tokenAddress);
    const external: DexPaprikaAsset = { tokenId: asset.tokenId, chainId: asset.chainId, externalAssetId: `${asset.network}:${asset.tokenAddress}`, network: asset.network, tokenAddress: address };
    try {
      const stats = await request(() => fetchStats(asset.network, address));
      let pools: DexPool[] | null = null;
      const poolsDue = now.getTime() - (stamps.get(asset.tokenId)?.poolsAt ?? 0) >= DEX_POOLS_REFRESH_AFTER_MS;
      if (stats !== null && poolsDue && calls < monthlyCap) pools = await request(() => fetchPools(asset.network, address));
      const stamp = new Date().toISOString();
      snapshots.push(buildDexPaprikaSnapshot(external, stats, pools, stamp));
      if (pools) { withPools.push({ token_id: asset.tokenId, stats_at: stamp, pools_at: stamp, pools }); result.poolsRefreshed += 1; }
      else statsOnly.push({ token_id: asset.tokenId, stats_at: stamp });
      mappings.push({
        provider_id: DEXPAPRIKA_PROVIDER_ID, chain_id: asset.chainId, token_id: asset.tokenId,
        external_asset_id: external.externalAssetId, external_contract_address: asset.tokenAddress, scope: "market", verification_method: "exact_chain_address",
      });
      if (stats === null) result.unindexed += 1;
      result.succeeded += 1;
      result.dueRemaining -= 1;
      consecutiveRateLimits = 0;
    } catch (caught) {
      result.failed += 1;
      const message = caught instanceof Error ? caught.message : "unknown error";
      console.error(`[dexpaprika] ${asset.tokenId} failed: ${message}`);
      result.firstError ??= `${asset.tokenId} ${message}`.slice(0, 300);
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

  // Persist what was fetched even when the slice stopped early: partial progress is never discarded.
  if (snapshots.length > 0) {
    const { error: mappingsError } = await client.from("provider_token_mappings").upsert(mappings, { onConflict: "provider_id,token_id" });
    if (mappingsError) throw new Error(`Supabase upsert DexPaprika token mappings failed: ${mappingsError.message}`);
    await persist(client, snapshots);
    if (statsOnly.length > 0) {
      const { error } = await client.from("token_dex_pools").upsert(statsOnly, { onConflict: "token_id" });
      if (error) throw new Error(`Supabase write DEX stats stamps failed: ${error.message}`);
    }
    if (withPools.length > 0) {
      const { error } = await client.from("token_dex_pools").upsert(withPools, { onConflict: "token_id" });
      if (error) throw new Error(`Supabase write DEX pools failed: ${error.message}`);
    }
  }
  result.callsThisMonth = calls;
  return result;
}
