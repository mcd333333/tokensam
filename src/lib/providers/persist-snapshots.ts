import type { ProviderSnapshot } from "./types";
import type { CollectorDiagnostics } from "../refresh/collector-diagnostics.ts";

type SupabaseAdminClient = ReturnType<
  typeof import("../supabase/admin").createSupabaseAdminClient
>;

const CHUNK_SIZE = 500;
const RAW_RECORD_MAX_BATCH_BYTES = 200_000;
const RAW_RECORD_MAX_BATCH_ROWS = 25;

function chunkRawRows(rows: Record<string, unknown>[]): Record<string, unknown>[][] {
  const chunks: Record<string, unknown>[][] = [];
  let current: Record<string, unknown>[] = [];
  let currentBytes = 2;
  for (const row of rows) {
    const rowBytes = new TextEncoder().encode(JSON.stringify(row)).length + 1;
    if (current.length > 0 && (currentBytes + rowBytes > RAW_RECORD_MAX_BATCH_BYTES || current.length >= RAW_RECORD_MAX_BATCH_ROWS)) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += rowBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function assertNoError(error: { message: string } | null, operation: string): void {
  if (error) throw new Error(`Supabase ${operation} failed: ${error.message}`);
}

/** Chunks are independent inserts (no shared state or ordering requirement), so they run concurrently
 *  instead of one at a time — the wall-clock cost here is per-round-trip network latency, not server work. */
async function writeInChunks(
  client: SupabaseAdminClient,
  table: "token_metric_observations",
  rows: Record<string, unknown>[],
  signal?: AbortSignal,
): Promise<void> {
  const chunks: Record<string, unknown>[][] = [];
  for (let index = 0; index < rows.length; index += CHUNK_SIZE) chunks.push(rows.slice(index, index + CHUNK_SIZE));
  await Promise.all(chunks.map(async (chunk) => {
    const query = client.from(table).insert(chunk);
    const { error } = await (signal ? query.abortSignal(signal) : query);
    assertNoError(error, `insert into ${table}`);
  }));
}

function observationKey(row: {
  token_id: string;
  chain_id: string;
  metric_id: string;
  observed_at: string;
  window_days: number | null;
}): string {
  return [
    row.token_id,
    row.chain_id,
    row.metric_id,
    new Date(row.observed_at).toISOString(),
    row.window_days ?? "null",
  ].join("|");
}

/**
 * Persist generic normalized provider snapshots and their source JSON.
 * `diagnostics` is optional, diagnostic-only stage timing (see
 * collector-diagnostics.ts); only the CoinGecko caller currently passes it,
 * so every other provider's behavior here is unchanged.
 *
 * `signal`, when passed (a collector may tie it to its own end-to-end deadline), is attached to every
 * Supabase call via `.abortSignal()`. This is real cancellation of the
 * client-side request: aborting closes the underlying HTTP connection to
 * PostgREST immediately, so this function stops waiting *and* stops sending
 * more of that request. It is not a guarantee that Postgres itself stops
 * executing an already-dispatched statement the instant the socket closes —
 * that depends on Postgres noticing the closed connection, which is
 * best-effort and not immediate. No caller relies on the query having
 * actually stopped server-side; they only rely on not being blocked by it.
 * Omitted (the CoinGecko/DexPaprika/DeFiLlama path), behavior is identical
 * to before this parameter existed.
 */
export async function persistProviderSnapshots(
  client: SupabaseAdminClient,
  snapshots: ProviderSnapshot[],
  diagnostics?: CollectorDiagnostics,
  signal?: AbortSignal,
  /**
   * `persistRawRecords: false` skips the raw_provider_records insert entirely and leaves
   * each observation's raw_record_id null (the column is nullable and already written as
   * `?? null`). Use it for a provider whose raw payload carries nothing the observations
   * do not already hold, where the rows are pure storage cost -- see
   * run-binance-collection.ts, where 180 tokens every refresh dominated a 500 MB plan.
   */
  options: { persistRawRecords?: boolean } = {},
): Promise<{ rawRecords: number; observations: number; pairMappings: number; timingMs: Record<string, number> }> {
  const persistRawRecords = options.persistRawRecords ?? true;
  if (snapshots.length === 0) return { rawRecords: 0, observations: 0, pairMappings: 0, timingMs: {} };
  const withSignal = <T extends { abortSignal(signal: AbortSignal): T }>(query: T): T => (signal ? query.abortSignal(signal) : query);

  const rawRows = snapshots.map((snapshot) => ({
    provider_id: snapshot.providerId,
    chain_id: snapshot.asset.chainId,
    token_id: snapshot.asset.tokenId,
    external_asset_id: snapshot.asset.externalAssetId,
    collected_at: snapshot.collectedAt,
    endpoint_label: snapshot.endpointLabel,
    response_status: "success",
    payload: snapshot.rawPayload,
  }));

  const providers = [...new Set(snapshots.map((snapshot) => snapshot.providerId))];
  const tokenIdsForMapping = [...new Set(snapshots.map((snapshot) => snapshot.asset.tokenId))];

  // Raw-record chunk inserts and the mapping-ID lookup are independent of each other
  // (mapping lookup needs no raw-record IDs), so run them concurrently rather than
  // paying for each Supabase round trip's network latency one at a time.
  const rawInsertStart = Date.now();
  const mappingLookupStart = rawInsertStart;
  diagnostics?.start("coingecko.persist.rawRecordsInsert");
  diagnostics?.start("coingecko.persist.mappingLookup");
  const [insertedRawRows, mappingRows] = await Promise.all([
    (async () => {
      if (!persistRawRecords) {
        diagnostics?.end("coingecko.persist.rawRecordsInsert");
        return [] as { id: number; token_id: string; chain_id: string }[];
      }
      const chunks = chunkRawRows(rawRows);
      const results = await Promise.all(chunks.map(async (rawBatch) => {
        const { data, error } = await withSignal(client
          .from("raw_provider_records")
          .insert(rawBatch)
          .select("id, token_id, chain_id"));
        assertNoError(error, "insert into raw_provider_records");
        return (data ?? []) as { id: number; token_id: string; chain_id: string }[];
      }));
      diagnostics?.end("coingecko.persist.rawRecordsInsert");
      return results.flat();
    })(),
    (async () => {
      const { data, error } = await withSignal(client.from("provider_token_mappings")
        .select("id,provider_id,token_id").in("provider_id", providers).in("token_id", tokenIdsForMapping));
      assertNoError(error, "read provider mapping IDs");
      diagnostics?.end("coingecko.persist.mappingLookup");
      return (data ?? []) as { id: number; provider_id: string; token_id: string }[];
    })(),
  ]);
  const rawInsertMs = Date.now() - rawInsertStart;
  const mappingLookupMs = Date.now() - mappingLookupStart;

  const rawIdByTokenAndChain = new Map(
    insertedRawRows.map((row) => [`${row.token_id}:${row.chain_id}`, row.id]),
  );
  const pairRows = snapshots.flatMap((snapshot) =>
    (snapshot.providerPairs ?? []).map((pair) => ({
      provider_id: snapshot.providerId,
      token_id: pair.tokenId,
      chain_id: pair.chainId,
      dex_chain_id: pair.providerChainId,
      token_address: pair.tokenAddress,
      pair_address: pair.pairAddress,
      dex_id: pair.dexId,
      pair_url: pair.pairUrl,
      base_token_address: pair.baseTokenAddress,
      quote_token_address: pair.quoteTokenAddress,
      pair_created_at: pair.pairCreatedAt,
      last_seen_at: pair.lastSeenAt,
      raw_record_id: rawIdByTokenAndChain.get(`${pair.tokenId}:${pair.chainId}`) ?? null,
    })),
  );
  if (pairRows.length > 0) {
    const { error: pairError } = await withSignal(client
      .from("provider_pairs")
      .upsert(pairRows, { onConflict: "provider_id,chain_id,token_id,pair_address" }));
    assertNoError(pairError, "upsert into provider_pairs");
  }
  // Mapping IDs identify the provider mapping each observation was collected under.
  const mappingIds = new Map<string, number>();
  for (const row of mappingRows) mappingIds.set(`${row.provider_id}:${row.token_id}`, row.id);
  const observationRows = snapshots.flatMap((snapshot) =>
    snapshot.observations.map((observation) => ({
      token_id: observation.tokenId,
      chain_id: observation.chainId,
      metric_id: observation.metricId,
      provider_id: snapshot.providerId,
      raw_record_id: rawIdByTokenAndChain.get(`${observation.tokenId}:${observation.chainId}`) ?? null,
      value: observation.value,
      window_days: observation.windowDays,
      status: observation.status,
      observed_at: observation.observedAt,
      collected_at: observation.collectedAt,
      source_field: observation.sourceField,
      note: observation.note,
      scope: observation.scope,
      provider_asset_id: snapshot.asset.externalAssetId,
      mapping_id: mappingIds.get(`${snapshot.providerId}:${observation.tokenId}`) ?? null,
    })),
  );

  const providerIds = [...new Set(snapshots.map((snapshot) => snapshot.providerId))];
  const tokenIds = [...new Set(snapshots.map((snapshot) => snapshot.asset.tokenId))];
  const observedTimes = observationRows.map((row) => Date.parse(String(row.observed_at)));
  const startAt = new Date(Math.min(...observedTimes)).toISOString();
  const endAt = new Date(Math.max(...observedTimes)).toISOString();
  const existingKeys = new Set<string>();
  const existingKeysStart = Date.now();
  diagnostics?.start("coingecko.persist.existingKeysLookup");

  // Keyset pagination on `id` (this table's primary key, monotonically increasing on every
  // insert) instead of OFFSET-based `.range()`: OFFSET makes Postgres re-scan and discard every
  // row up to the current page's offset on *each* request, so cost grows with page depth across
  // the loop. `id > cursor` lets each page pick up exactly where the previous one left off, so
  // total cost stays close to one pass over the matching rows regardless of how many pages this
  // takes (fixed in 2935c37).
  //
  // Two further costs remained even after that fix, both confirmed against production:
  //  1. `id > 0` on the first page still forces Postgres to scan (and discard) every row from the
  //     start of this table's whole history before reaching the recent rows this query actually
  //     wants, because nothing bounds the scan by `observed_at` before `id` takes over as the sort
  //     key. That cost grows every day as the table grows, independent of how much data this one
  //     run touches — this is what was still consuming the entire 90s budget in production run 674
  //     (data_refresh_steps id 515), after the keyset fix was already live.
  //  2. Evaluating `token_id = ANY(<230-ish item array>)` as a per-row Postgres filter is
  //     comparatively expensive CPU work (an EXPLAIN ANALYZE on production measured ~4.2s of added
  //     execution time from this alone, against ~15k candidate rows) for a condition that, for a
  //     full-universe CoinGecko refresh, passes for the vast majority of rows anyway.
  // token_metric_observations_provider_observed_id_idx (see the matching migration) directly
  // covers (provider_id, observed_at, id), so the DB-side WHERE now only needs provider_id and the
  // observed_at window — both genuinely selective and index-bound regardless of table size — and
  // `token_id` membership (unchanged semantics: still every one of `tokenIds`) is instead checked
  // in JS against a Set, which is O(1) per row instead of Postgres's O(m) linear array scan.
  const tokenIdSet = new Set(tokenIds);
  let cursorId = 0;
  for (;;) {
    const { data, error } = await withSignal(client
      .from("token_metric_observations")
      .select("id, token_id, chain_id, metric_id, observed_at, window_days")
      .in("provider_id", providerIds)
      .gte("observed_at", startAt)
      .lte("observed_at", endAt)
      .gt("id", cursorId)
      .order("id", { ascending: true })
      .limit(1000));
    assertNoError(error, "check existing observations");
    const page = (data ?? []) as {
      id: number; token_id: string; chain_id: string; metric_id: string; observed_at: string; window_days: number | null;
    }[];
    for (const row of page) if (tokenIdSet.has(row.token_id)) existingKeys.add(observationKey(row));
    if (page.length < 1000) break;
    cursorId = page[page.length - 1].id;
  }
  diagnostics?.end("coingecko.persist.existingKeysLookup");
  const existingKeysMs = Date.now() - existingKeysStart;

  const newObservationRows = observationRows.filter(
    (row) => !existingKeys.has(observationKey(row as {
      token_id: string;
      chain_id: string;
      metric_id: string;
      observed_at: string;
      window_days: number | null;
    })),
  );
  const observationInsertStart = Date.now();
  diagnostics?.start("coingecko.persist.observationInsert");
  await writeInChunks(client, "token_metric_observations", newObservationRows, signal);
  diagnostics?.end("coingecko.persist.observationInsert");
  const observationInsertMs = Date.now() - observationInsertStart;
  return {
    rawRecords: persistRawRecords ? rawRows.length : 0,
    observations: newObservationRows.length,
    pairMappings: pairRows.length,
    timingMs: { rawInsertMs, mappingLookupMs, existingKeysMs, observationInsertMs },
  };
}
