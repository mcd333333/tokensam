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
  const { error: mappingsError } = await client
    .from("provider_token_mappings")
    .upsert(mappings, { onConflict: "provider_id,token_id" });
  throwOnSupabaseError(mappingsError, "upsert DeFiLlama protocol mappings");

  const persisted = await persistProviderSnapshots(client, snapshots);
  const unavailable = snapshots.flatMap((snapshot) =>
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
    returnedProtocols: snapshots.length,
    unavailable,
    skipped,
    failed,
    requests: provider.telemetry.length,
    retriedRequests: provider.telemetry.filter((entry) => entry.attempts > 1).length,
    slowestRequest: slowest ? `${slowest.path.replace(/excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&?/, "")} (${slowest.durationMs} ms)` : null,
    ...persisted,
  };
}
