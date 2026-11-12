import { fetchExchangeVolumes, EXCHANGE_REQUEST_INTERVAL_MS } from "./coingecko-exchanges.ts";
import { CoinGeckoApiError } from "./coingecko.ts";
import { fetchAllExchangeLogos } from "./coingecko-exchange-logos.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

/** A token is refreshed again once its snapshot is older than this (a daily cadence with slack). */
export const EXCHANGE_REFRESH_AFTER_MS = 22 * 60 * 60 * 1000;
/**
 * Snapshots fetched before this moment predate exchange logos (added to the stored rows on 2026-11-12), so they are
 * refreshed once regardless of age. Remove after a day: by then every snapshot is newer.
 */
export const LOGO_BACKFILL_CUTOFF_MS = Date.parse("2026-11-12T08:50:00Z");
/**
 * Hard monthly ceiling on tickers calls. The Demo plan allows ~10,000 calls/month and the
 * /coins/markets refresh uses ~5,800 of them (2 calls x 96 runs x 30 days), so this leaves margin.
 * A full daily pass is one call per token (~154 -> ~4,600/month); the cap makes the collector
 * stretch some tokens past one day rather than ever starving the price refresh.
 */
export const DEFAULT_MONTHLY_CALL_CAP = 3_800;

export type ExchangeCollectionResult = {
  attempted: number;
  succeeded: number;
  failed: number;
  stoppedReason: "done" | "slice_limit" | "deadline" | "monthly_cap" | "rate_limited" | "none_due";
  callsThisMonth: number;
  monthlyCap: number;
  dueRemaining: number;
};

export async function runExchangeCollection(
  client: SupabaseAdminClient,
  options: {
    now?: Date;
    maxTokens: number;
    deadlineAt: number;
    monthlyCap?: number;
    fetchVolumes?: typeof fetchExchangeVolumes;
    sleep?: (ms: number) => Promise<void>;
    minIntervalMs?: number;
  },
): Promise<ExchangeCollectionResult> {
  const now = options.now ?? new Date();
  const monthlyCap = options.monthlyCap ?? DEFAULT_MONTHLY_CALL_CAP;
  const fetchVolumes = options.fetchVolumes ?? fetchExchangeVolumes;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const minIntervalMs = options.minIntervalMs ?? EXCHANGE_REQUEST_INTERVAL_MS;
  const month = now.toISOString().slice(0, 7);

  const [mappingsResult, snapshotsResult, usageResult] = await Promise.all([
    client.from("provider_token_mappings").select("token_id,external_asset_id").eq("provider_id", "coingecko"),
    client.from("token_exchange_volumes").select("token_id,fetched_at"),
    client.from("coingecko_exchange_call_usage").select("calls").eq("month", month).maybeSingle(),
  ]);
  if (mappingsResult.error) throw new Error(`Supabase read CoinGecko mappings failed: ${mappingsResult.error.message}`);
  if (snapshotsResult.error) throw new Error(`Supabase read exchange snapshots failed: ${snapshotsResult.error.message}`);
  if (usageResult.error) throw new Error(`Supabase read exchange call usage failed: ${usageResult.error.message}`);

  let callsThisMonth = (usageResult.data as { calls?: number } | null)?.calls ?? 0;
  const fetchedAt = new Map((snapshotsResult.data as { token_id: string; fetched_at: string }[]).map((row) => [row.token_id, Date.parse(row.fetched_at)]));
  // Never-fetched tokens first, then the stalest snapshots; anything fresher than the refresh age is skipped.
  const due = (mappingsResult.data as { token_id: string; external_asset_id: string }[])
    .filter((row) => row.external_asset_id && ((fetchedAt.get(row.token_id) ?? 0) < LOGO_BACKFILL_CUTOFF_MS || now.getTime() - (fetchedAt.get(row.token_id) ?? 0) >= EXCHANGE_REFRESH_AFTER_MS))
    .sort((a, b) => (fetchedAt.get(a.token_id) ?? 0) - (fetchedAt.get(b.token_id) ?? 0));

  const result: ExchangeCollectionResult = {
    attempted: 0, succeeded: 0, failed: 0, stoppedReason: due.length === 0 ? "none_due" : "done",
    callsThisMonth, monthlyCap, dueRemaining: due.length,
  };

  for (const row of due) {
    if (result.attempted >= options.maxTokens) { result.stoppedReason = "slice_limit"; break; }
    if (Date.now() + minIntervalMs >= options.deadlineAt) { result.stoppedReason = "deadline"; break; }
    if (callsThisMonth >= monthlyCap) { result.stoppedReason = "monthly_cap"; break; }
    if (result.attempted > 0) await sleep(minIntervalMs);
    result.attempted += 1;
    // Count the call before making it: a failed or timed-out request may still have been billed.
    const { data: bumped, error: bumpError } = await client.rpc("bump_coingecko_exchange_call_usage", { p_month: month, p_calls: 1 });
    if (bumpError) throw new Error(`Supabase record exchange call usage failed: ${bumpError.message}`);
    callsThisMonth = typeof bumped === "number" ? bumped : callsThisMonth + 1;
    try {
      const exchanges = await fetchVolumes(row.external_asset_id);
      const { error } = await client.from("token_exchange_volumes").upsert({
        token_id: row.token_id,
        fetched_at: new Date().toISOString(),
        exchanges,
        total_volume_usd: exchanges.reduce((sum, exchange) => sum + exchange.volumeUsd, 0),
      }, { onConflict: "token_id" });
      if (error) throw new Error(`Supabase write exchange volumes failed: ${error.message}`);
      result.succeeded += 1;
      result.dueRemaining -= 1;
    } catch (error) {
      result.failed += 1;
      console.error(`[exchanges] ${row.token_id} failed: ${error instanceof Error ? error.message : "unknown error"}`);
      // A 429 or auth failure means every further call this slice would fail too.
      if (error instanceof CoinGeckoApiError && (error.status === 429 || error.status === 401 || error.status === 403)) {
        result.stoppedReason = "rate_limited";
        break;
      }
    }
  }
  result.callsThisMonth = callsThisMonth;
  return result;
}

/** The logo list is pulled again only when it is missing or older than this. */
export const EXCHANGE_LOGO_REFRESH_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export type ExchangeLogoPullResult = { status: "skipped" | "pulled" | "failed"; stored?: number; calls?: number; error?: string };

/**
 * One pull of CoinGecko's whole exchange list (about four calls) into `exchange_logos`: when the table is empty or its
 * newest row is older than EXCHANGE_LOGO_REFRESH_AFTER_MS. Each request is counted against the same monthly call usage as
 * the tickers collector. Never throws: a failure is reported and the next tick tries again.
 */
export async function runExchangeLogoPull(
  client: SupabaseAdminClient,
  options: { now?: Date; fetchLogos?: typeof fetchAllExchangeLogos; force?: boolean } = {},
): Promise<ExchangeLogoPullResult> {
  const now = options.now ?? new Date();
  const month = now.toISOString().slice(0, 7);
  try {
    if (!options.force) {
      const { data, error } = await client.from("exchange_logos").select("fetched_at").order("fetched_at", { ascending: false }).limit(1);
      if (error) throw new Error(`Supabase read exchange logos failed: ${error.message}`);
      const newest = Date.parse((data as { fetched_at?: string }[] | null)?.[0]?.fetched_at ?? "");
      if (Number.isFinite(newest) && now.getTime() - newest < EXCHANGE_LOGO_REFRESH_AFTER_MS) return { status: "skipped" };
    }
    let calls = 0;
    const logos = await (options.fetchLogos ?? fetchAllExchangeLogos)({
      onCall: async () => {
        calls += 1;
        const { error } = await client.rpc("bump_coingecko_exchange_call_usage", { p_month: month, p_calls: 1 });
        if (error) throw new Error(`Supabase record exchange call usage failed: ${error.message}`);
      },
    });
    if (logos.length === 0) return { status: "failed", calls, error: "CoinGecko returned no exchange logos." };
    const stamp = now.toISOString();
    for (let offset = 0; offset < logos.length; offset += 500) {
      const { error } = await client.from("exchange_logos").upsert(logos.slice(offset, offset + 500).map((item) => ({ ...item, fetched_at: stamp })), { onConflict: "id" });
      if (error) throw new Error(`Supabase write exchange logos failed: ${error.message}`);
    }
    return { status: "pulled", stored: logos.length, calls };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : "Unknown error." };
  }
}
