import { canonicalTokens } from "../../data/canonical-tokens.ts";
import { geckoTerminalTokenMappings } from "../../data/geckoterminal-token-mappings.ts";
import {
  configuredGeckoTerminalAssets,
  fetchGeckoTerminalSnapshotsTolerant,
  GeckoTerminalMarketDataProvider,
  getUnmappedGeckoTerminalTokens,
} from "./geckoterminal.ts";
import { geckoTerminalSyncLockTableExists, resolveGeckoTerminalStartTokenId, withGeckoTerminalSyncLock } from "./geckoterminal-sync-lock.ts";
import { persistProviderSnapshots } from "./persist-snapshots.ts";
import { MAX_GAP_REPAIR_TOKENS as GECKOTERMINAL_MAX_GAP_REPAIR_TOKENS, repairGeckoTerminalDailyGaps } from "./repair-geckoterminal-daily-gaps.ts";
import { MIN_REQUEST_INTERVAL_MS } from "./geckoterminal.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

const REQUIRED_METRICS = [
  "price_usd",
  "volume_24h_usd",
  "liquidity_usd",
  "price_change_24h_pct",
  "transactions_24h_count",
  "buys_24h_count",
  "sells_24h_count",
  "fdv_usd",
  "market_cap_usd",
];

// Longer than any realistic run (scheduled runs bound themselves to a caller-provided
// deadline well under this; a manual sync of 63 tokens is ~7 minutes with no throttling),
// short enough that a crashed run self-heals well within a day's cadence.
const LOCK_LEASE_MS = 15 * 60 * 1000;

// The gap repair's own worst case is MAX_GAP_REPAIR_TOKENS requests paced at
// MIN_REQUEST_INTERVAL_MS apart, plus per-request latency; this is that
// worst case with headroom. Scheduled collection only attempts the repair
// when at least this much of the caller's deadline remains, so it can never
// turn an on-time collection into one that blows the cron route's own budget
// (see PROCESSING_BUDGET_MS in src/app/api/cron/geckoterminal/route.ts).
const GAP_REPAIR_MIN_BUDGET_MS = GECKOTERMINAL_MAX_GAP_REPAIR_TOKENS * MIN_REQUEST_INTERVAL_MS + 10_000;

function throwOnSupabaseError(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`Supabase ${action} failed: ${error.message}`);
}

async function verifySchema(client: SupabaseAdminClient) {
  // These metrics and provider_pairs already exist from the DEX Screener migration;
  // GeckoTerminal reuses them rather than creating duplicate token-level metrics.
  const { error: pairTableError } = await client.from("provider_pairs").select("pair_address").limit(0);
  if (pairTableError) {
    throw new Error("Apply supabase/migrations/20260923120000_dexscreener_market_structure.sql in the Supabase SQL Editor before running the GeckoTerminal collector.");
  }
  const { data, error } = await client.from("metric_definitions").select("id").in("id", REQUIRED_METRICS);
  throwOnSupabaseError(error, "check GeckoTerminal metric definitions");
  const present = new Set((data ?? []).map((row: { id: string }) => row.id));
  const missing = REQUIRED_METRICS.filter((metricId) => !present.has(metricId));
  if (missing.length > 0) {
    throw new Error("The GeckoTerminal metric catalog is incomplete. Apply supabase/migrations/20260923120000_dexscreener_market_structure.sql.");
  }
  const { data: providerRow, error: providerLookupError } = await client
    .from("data_providers")
    .select("id")
    .eq("id", "geckoterminal")
    .maybeSingle();
  throwOnSupabaseError(providerLookupError, "check the GeckoTerminal data provider registration");
  if (!providerRow) {
    throw new Error("Apply supabase/migrations/20260929090000_geckoterminal_provider.sql in the Supabase SQL Editor before running the GeckoTerminal collector.");
  }
  if (!(await geckoTerminalSyncLockTableExists(client))) {
    throw new Error("Apply supabase/migrations/20260930090000_geckoterminal_scheduled_collection.sql in the Supabase SQL Editor before running the GeckoTerminal collector.");
  }
}

async function upsertGeckoTerminalMappings(client: SupabaseAdminClient, assets: { chainId: string; tokenId: string; externalAssetId: string; tokenAddress: string }[]): Promise<void> {
  if (assets.length === 0) return;
  const mappings = assets.map((asset) => ({
    provider_id: "geckoterminal",
    chain_id: asset.chainId,
    token_id: asset.tokenId,
    external_asset_id: asset.externalAssetId,
    external_contract_address: asset.tokenAddress,
    scope: "market",
    verification_method: "exact_chain_address",
  }));
  // onConflict targets (provider_id,token_id): see the identical fix and rationale in
  // run-coingecko-collection.ts and run-defillama-coins-collection.ts.
  const { error } = await client.from("provider_token_mappings").upsert(mappings, { onConflict: "provider_id,token_id" });
  throwOnSupabaseError(error, "upsert GeckoTerminal token mappings");
}

/**
 * Manual, all-or-nothing collection (used by `pnpm geckoterminal:sync`):
 * fetches every mapped token before writing anything, exactly as before.
 * Now also takes the shared GeckoTerminal sync lock, so it cannot run at the
 * same time as a scheduled collection (or another manual run).
 */
export async function runGeckoTerminalCollection(
  client: SupabaseAdminClient,
  options: { tokenIds?: string[]; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => Date } = {},
) {
  // Fail before provider calls if the Supabase migration has not been applied.
  await verifySchema(client);
  return withGeckoTerminalSyncLock(client, "manual", LOCK_LEASE_MS, async () => {
    const activeCanonicalTokenIds = new Set(canonicalTokens.map((token) => token.id));
    const assets = configuredGeckoTerminalAssets().filter(
      (asset) => activeCanonicalTokenIds.has(asset.tokenId) && (!options.tokenIds || options.tokenIds.includes(asset.tokenId)),
    );
    const provider = new GeckoTerminalMarketDataProvider(options);
    const snapshots = await provider.fetchSnapshots(assets);
    if (snapshots.length !== assets.length) throw new Error("GeckoTerminal returned an incomplete token collection.");

    await upsertGeckoTerminalMappings(client, assets);
    const persisted = await persistProviderSnapshots(client, snapshots);
    const unavailable = snapshots.flatMap((snapshot) =>
      snapshot.observations
        .filter((item) => item.status === "unavailable")
        .map((item) => ({ tokenId: item.tokenId, metricId: item.metricId })),
    );

    return {
      provider: "geckoterminal",
      tokensInUniverse: geckoTerminalTokenMappings.length,
      mappedTokens: assets.length,
      unmappedTokens: getUnmappedGeckoTerminalTokens(),
      returnedTokens: snapshots.length,
      ...persisted,
      unavailable,
    };
  });
}

export type GeckoTerminalScheduledResult = {
  provider: "geckoterminal";
  attempted: number;
  succeeded: string[];
  failed: { tokenId: string; error: string }[];
  skipped: string[];
  rawRecords: number;
  observations: number;
  pairMappings: number;
  unavailable: { tokenId: string; metricId: string }[];
  rateLimitEvents: number;
  retries: number;
  durationMs: number;
  /** Token id this run started its rotation from (null means index 0). */
  startTokenId: string | null;
  /**
   * Token id the *next* scheduled run should start from. The caller (the cron
   * route) persists this in `geckoterminal_sync_runs.summary` via
   * `finishGeckoTerminalSyncLock`; `resolveGeckoTerminalStartTokenId` reads it
   * back on the next run. This is what makes rotation resumable across
   * invocations without a dedicated cursor table.
   */
  nextTokenId: string | null;
  /** Present only when the gap repair actually ran (skipped when too little deadline budget remained). */
  gapRepair?: Awaited<ReturnType<typeof repairGeckoTerminalDailyGaps>>;
  gapRepairError?: string;
};

/**
 * Recurring, partial-failure-tolerant collection for the scheduled cron route
 * (see src/app/api/cron/geckoterminal/route.ts). Unlike `runGeckoTerminalCollection`,
 * a single token failing — or the caller's `deadlineAt` passing — does not
 * discard snapshots already collected for other tokens: every successful
 * snapshot is persisted, and the run is reported as "succeeded", "partial",
 * or "failed" by the caller based on this result.
 *
 * This function does not take the sync lock itself; the caller (the cron
 * route) acquires and releases it, since it needs the run id to report a
 * precise status. It also does not decide scheduling (cadence, whether the
 * run is due, or the deadline) — that is entirely the caller's job.
 *
 * Rotation: by default, this function resolves where to resume from by
 * reading `geckoterminal_sync_runs` for the previous run's `nextTokenId` (see
 * `resolveGeckoTerminalStartTokenId`), so a run that only reaches part of the
 * universe before its deadline picks up exactly where the last one stopped
 * instead of restarting at the first token every time. Pass `startTokenId`
 * explicitly (including `null`, meaning "start at index 0") to override this,
 * which tests use to make rotation deterministic.
 */
export async function runGeckoTerminalScheduledCollection(
  client: SupabaseAdminClient,
  options: {
    tokenIds?: string[];
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
    deadlineAt?: number;
    minRequestIntervalMs?: number;
    startTokenId?: string | null;
    /** Collect only this many tokens from the rotation cursor and advance it by that many (see the slice comment below). */
    maxTokens?: number;
    /** Forwarded to fetchGeckoTerminalSnapshotsTolerant; see its own doc comment. */
    onHeartbeat?: () => Promise<boolean>;
    heartbeatIntervalMs?: number;
    /** Forwarded to persistProviderSnapshots; see its own doc comment on cancellation. */
    persistSignal?: AbortSignal;
  } = {},
): Promise<GeckoTerminalScheduledResult & { ownershipLostDuringCollection: boolean }> {
  const startedAt = Date.now();
  await verifySchema(client);
  const activeCanonicalTokenIds = new Set(canonicalTokens.map((token) => token.id));
  const assets = configuredGeckoTerminalAssets().filter(
    (asset) => activeCanonicalTokenIds.has(asset.tokenId) && (!options.tokenIds || options.tokenIds.includes(asset.tokenId)),
  );
  const startTokenId = options.startTokenId !== undefined ? options.startTokenId : await resolveGeckoTerminalStartTokenId(client);

  // Slice mode: the caller (the Cloudflare Worker) paces the requests and wants exactly `maxTokens`
  // tokens collected per call, so this invocation never sleeps between provider requests.
  // The cursor is computed here, against the full rotation, because the collector's own
  // nextTokenId is relative to the (already shortened) list it was given.
  let collected = assets;
  let sliceNextTokenId: string | null | undefined;
  if (options.maxTokens !== undefined && assets.length > 0) {
    const startIndex = startTokenId ? Math.max(0, assets.findIndex((asset) => asset.tokenId === startTokenId)) : 0;
    const rotated = [...assets.slice(startIndex), ...assets.slice(0, startIndex)];
    const count = Math.min(Math.max(1, Math.floor(options.maxTokens)), rotated.length);
    collected = rotated.slice(0, count);
    sliceNextTokenId = rotated[count % rotated.length].tokenId;
  }
  let ownershipLostDuringCollection = false;
  const onHeartbeat = options.onHeartbeat
    ? async () => {
      const stillOwner = await options.onHeartbeat!();
      if (!stillOwner) ownershipLostDuringCollection = true;
      return stillOwner;
    }
    : undefined;
  const { snapshots, outcomes, nextTokenId: collectorNextTokenId } = await fetchGeckoTerminalSnapshotsTolerant(collected, {
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    now: options.now,
    deadlineAt: options.deadlineAt,
    minRequestIntervalMs: options.minRequestIntervalMs,
    startTokenId: sliceNextTokenId !== undefined ? collected[0].tokenId : startTokenId,
    onHeartbeat,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
  });

  if (ownershipLostDuringCollection) {
    // Lost the lock lease mid-collection: every snapshot gathered up to that
    // point is still returned below and gets persisted by the caller as usual
    // (partial provider work is never discarded), but the caller must not
    // finalize this run's row — it may already belong to a new owner.
    console.error("[geckoterminal-cron] lost lease ownership mid-collection; persisting what was gathered but not finalizing this run.");
  }

  // Only tokens that actually returned a snapshot this run get their mapping refreshed;
  // a token that failed or was skipped keeps whatever mapping it already had.
  const succeededTokenIds = new Set(snapshots.map((snapshot) => snapshot.asset.tokenId));
  await upsertGeckoTerminalMappings(client, assets.filter((asset) => succeededTokenIds.has(asset.tokenId)));

  // Every successful snapshot is persisted, even if others in the same run failed or were skipped.
  const persisted = snapshots.length > 0
    ? await persistProviderSnapshots(client, snapshots, undefined, options.persistSignal)
    : { rawRecords: 0, observations: 0, pairMappings: 0 };
  const unavailable = snapshots.flatMap((snapshot) =>
    snapshot.observations
      .filter((item) => item.status === "unavailable")
      .map((item) => ({ tokenId: item.tokenId, metricId: item.metricId })),
  );

  // Historical repair is deliberately best-effort, same as the CoinGecko/DeFiLlama
  // gap repairs: a repair failure must not turn an otherwise successful live
  // collection into a failure, and it is skipped outright (not attempted) when
  // too little of the caller's deadline remains, so it can never cause this
  // route to blow its own time budget. The next successful scheduled run
  // retries the bounded repair.
  let gapRepair: GeckoTerminalScheduledResult["gapRepair"];
  let gapRepairError: string | undefined;
  const remainingMs = options.deadlineAt !== undefined ? options.deadlineAt - Date.now() : null;
  // Slice calls are short by design; the repair runs on the full-sweep path only.
  if (sliceNextTokenId === undefined && !ownershipLostDuringCollection && (remainingMs === null || remainingMs > GAP_REPAIR_MIN_BUDGET_MS)) {
    try {
      gapRepair = await repairGeckoTerminalDailyGaps(client, {
        fetchImpl: options.fetchImpl,
        sleep: options.sleep,
        now: options.now,
      });
    } catch (error) {
      gapRepairError = error instanceof Error ? error.message : "Unknown GeckoTerminal gap-repair error.";
    }
  }

  // A slice token cut off by the time budget must be retried next call, so only advance past it otherwise.
  const nextTokenId = sliceNextTokenId !== undefined && !outcomes.some((outcome) => outcome.status === "skipped_time_budget")
    ? sliceNextTokenId
    : collectorNextTokenId;

  return {
    provider: "geckoterminal",
    attempted: collected.length,
    succeeded: outcomes.filter((outcome) => outcome.status === "succeeded").map((outcome) => outcome.tokenId),
    failed: outcomes.filter((outcome) => outcome.status === "failed").map((outcome) => ({ tokenId: outcome.tokenId, error: outcome.error ?? "Unknown error." })),
    skipped: outcomes.filter((outcome) => outcome.status === "skipped_time_budget").map((outcome) => outcome.tokenId),
    rawRecords: persisted.rawRecords,
    observations: persisted.observations,
    pairMappings: persisted.pairMappings,
    unavailable,
    rateLimitEvents: outcomes.filter((outcome) => outcome.rateLimited).length,
    retries: outcomes.reduce((sum, outcome) => sum + Math.max(0, outcome.attempts - 1), 0),
    durationMs: Date.now() - startedAt,
    startTokenId: startTokenId ?? null,
    nextTokenId,
    gapRepair,
    gapRepairError,
    ownershipLostDuringCollection,
  };
}
