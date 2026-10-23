import { defillamaProtocolMappings } from "../../data/defillama-protocol-mappings.ts";
import { persistProviderSnapshots } from "./persist-snapshots.ts";
import { DefiLlamaFundamentalsProvider, getDefiLlamaConfig, type DefiLlamaProtocolAsset } from "./defillama.ts";

function throwOnSupabaseError(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`Supabase ${action} failed: ${error.message}`);
}

/**
 * Collects DeFiLlama protocol data for the curated mappings.
 *
 * - "current" (the scheduled refresh): current TVL plus 24-hour fees and
 *   revenue, via three small requests per protocol.
 * - "history" (explicit backfill only): dated 90-day TVL history from
 *   /protocol/{slug}, whose payloads reach tens of megabytes.
 */
export async function runDefiLlamaCollection(
  client: ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>,
  options: {
    mode?: "current" | "history";
    /** Restrict collection to these canonical tokens (representative tests); default is every curated protocol. */
    tokenIds?: string[];
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    sleep?: (durationMs: number) => Promise<void>;
    now?: () => Date;
  } = {},
) {
  // This is intentionally checked before network calls or database writes.
  const config = getDefiLlamaConfig(options.env);
  const mode = options.mode ?? "current";
  const selected = defillamaProtocolMappings.filter((mapping) => !options.tokenIds || options.tokenIds.includes(mapping.tokenId));
  const assets: DefiLlamaProtocolAsset[] = selected.map((mapping) => ({
    tokenId: mapping.tokenId,
    chainId: mapping.chainId,
    externalAssetId: mapping.externalAssetId,
    recordId: mapping.recordId,
  }));
  const provider = new DefiLlamaFundamentalsProvider({
    ...config,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    now: options.now,
  });

  // Fetch all provider responses before changing Supabase. Both fetch methods isolate
  // each asset's request in its own try/catch, so one unresolvable slug (a DeFiLlama
  // rename, a removed protocol) is recorded and skipped rather than aborting collection
  // for every other curated protocol -- see the comment on fetchSnapshots for the
  // 2026-10-14 Aerodrome incident this fixed. fetchSnapshots must keep the
  // MarketDataProvider interface's Promise<ProviderSnapshot[]> return type, so its
  // failures are read from provider.lastFetchFailures instead of its return value.
  const { snapshots, skipped, failed } = mode === "history"
    ? await provider.fetchHistorySnapshots(assets)
    : { snapshots: await provider.fetchSnapshots(assets), skipped: [] as { tokenId: string; reason: string }[], failed: provider.lastFetchFailures };
  if (snapshots.length === 0) {
    throw new Error("DeFiLlama returned no protocol records for the curated mappings.");
  }

  const { error: providerError } = await client.from("data_providers").upsert(
    { id: "defillama", name: "DeFiLlama", enabled: true },
    { onConflict: "id" },
  );
  throwOnSupabaseError(providerError, "upsert DeFiLlama provider");

  const mappings = selected.map((mapping) => ({
    provider_id: "defillama",
    chain_id: mapping.chainId,
    token_id: mapping.tokenId,
    external_asset_id: mapping.externalAssetId,
    scope: "protocol",
    verification_method: "curated_protocol_association",
    verification_evidence: { record_id: mapping.recordId, record_kind: mapping.recordKind, protocol_name: mapping.protocolName },
  }));
  // onConflict targets (provider_id,token_id): see the identical fix and rationale in
  // run-coingecko-collection.ts and run-defillama-coins-collection.ts.
  //
  // Upserted one row at a time, not as a single batch: a single-batch upsert containing a
  // mapping for a token that no longer exists in `tokens` (e.g. a retired canonical token
  // whose defillamaProtocolMappings entry was never cleaned up) violates
  // provider_token_mappings_token_id_chain_id_fkey and fails the WHOLE batch, which aborted
  // mappings (and therefore every downstream snapshot persist, since this runs before
  // persistProviderSnapshots) for every curated protocol on every scheduled run from
  // 2026-10-23 11:55 onward -- discovered when ethereum-rpl's mapping outlived RPL's removal
  // from canonical-tokens.ts. A failed mapping is recorded and skipped, the same per-asset
  // isolation already applied to fetchSnapshots/fetchHistorySnapshots for the identical
  // 2026-10-14 Aerodrome incident.
  const mappingFailures: { tokenId: string; reason: string }[] = [];
  for (const mapping of mappings) {
    const { error } = await client
      .from("provider_token_mappings")
      .upsert(mapping, { onConflict: "provider_id,token_id" });
    if (error) mappingFailures.push({ tokenId: mapping.token_id, reason: error.message });
  }

  // Never persist a snapshot for a token whose mapping upsert just failed: its
  // observations would hit the same token_id/chain_id FK the mapping did,
  // and persistProviderSnapshots' chunked insert fails its whole chunk (not
  // per-row) on any error, which would take down every other protocol
  // sharing that chunk -- the exact failure this mapping-level isolation
  // exists to prevent.
  const failedMappingTokenIds = new Set(mappingFailures.map((failure) => failure.tokenId));
  const persistableSnapshots = snapshots.filter((snapshot) => !failedMappingTokenIds.has(snapshot.asset.tokenId));

  const persisted = await persistProviderSnapshots(client, persistableSnapshots);
  const unavailable = persistableSnapshots.flatMap((snapshot) =>
    snapshot.observations
      .filter((item) => item.status === "unavailable")
      .map((item) => ({ tokenId: item.tokenId, metricId: item.metricId })),
  );
  // Scalars survive into the refresh step detail, so a slow run is attributable.
  const slowest = provider.telemetry.reduce<(typeof provider.telemetry)[number] | null>(
    (current, entry) => (!current || entry.durationMs > current.durationMs ? entry : current),
    null,
  );

  return {
    provider: "defillama",
    mode,
    mappedProtocols: defillamaProtocolMappings.length,
    returnedProtocols: persistableSnapshots.length,
    unavailable,
    skipped,
    failed: [...failed, ...mappingFailures],
    requests: provider.telemetry.length,
    retriedRequests: provider.telemetry.filter((entry) => entry.attempts > 1).length,
    slowestRequest: slowest ? `${slowest.path.replace(/excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&?/, "")} (${slowest.durationMs} ms)` : null,
    ...persisted,
  };
}
