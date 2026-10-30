import "server-only";

import { CACHE_TTL_MULTIPLIER, DAILY_BUDGETS, ESTIMATED_LOG_BYTES_PER_REQUEST, SUPABASE_FREE_PLAN_LIMITS, combineLevels, levelForRatio, type ThrottleLevel } from "./quota-config.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

/**
 * Fire-and-forget usage recording for the hot read paths (observation-reads.ts). Never
 * throws and never awaited by its caller's critical path: a failed or slow write to
 * quota_usage_counters must not slow down or break the read it is only trying to
 * measure. Approximates response bytes via JSON size of the rows actually returned --
 * not the wire size (gzip, headers), but consistent enough to track trend and relative
 * magnitude, which is all a same-project daily budget comparison needs.
 */
export function recordApproxRead(client: SupabaseAdminClient, rows: unknown[]): void {
  if (rows.length === 0) return;
  // Test fixtures (and any other minimal fake client) commonly implement only
  // .from(...), not .rpc(...); recording usage is optional instrumentation, so a
  // client that cannot do it is treated the same as a failed call, not an error.
  if (typeof client.rpc !== "function") return;
  const approxBytes = (() => {
    try {
      // Stringifying every row cost ~50 ms per dashboard render for a figure that is only an
      // approximation anyway, so estimate from an evenly spaced sample of up to 64 rows.
      if (rows.length <= 64) return JSON.stringify(rows).length;
      const step = rows.length / 64;
      const sample = Array.from({ length: 64 }, (_, index) => rows[Math.floor(index * step)]);
      return Math.round((JSON.stringify(sample).length / 64) * rows.length);
    } catch {
      return 0;
    }
  })();
  try {
    client.rpc("record_quota_usage", { p_requests: 1, p_bytes: approxBytes }).then(
      ({ error }: { error: { message: string } | null }) => {
        if (error) console.error("Quota usage recording failed (non-fatal):", error.message);
      },
      (error: unknown) => console.error("Quota usage recording failed (non-fatal):", error),
    );
  } catch (error) {
    console.error("Quota usage recording failed (non-fatal):", error);
  }
}

export type QuotaEvaluation = {
  level: ThrottleLevel;
  reasons: string[];
  dbSizeBytes: number | null;
  todayRequests: number;
  todayApproxBytes: number;
  todayEstimatedLogBytes: number;
};

/**
 * Evaluates today's tracked usage (plus the current database size, which Postgres can
 * report exactly) against the daily budgets derived from Supabase's free-plan limits.
 * Called once per scheduled refresh (api/cron/refresh/route.ts), not from hot paths --
 * this does the actual reads quota tracking exists to keep off the hot path.
 */
export async function evaluateQuotaLevel(client: SupabaseAdminClient, dbSizeBytes: number | null): Promise<QuotaEvaluation> {
  const { data, error } = await client
    .from("quota_usage_counters")
    .select("request_count,approx_bytes")
    .eq("usage_date", new Date().toISOString().slice(0, 10))
    .maybeSingle();
  if (error) console.error("Quota usage read failed:", error.message);

  const todayRequests = (data as { request_count?: number } | null)?.request_count ?? 0;
  const todayApproxBytes = (data as { approx_bytes?: number } | null)?.approx_bytes ?? 0;
  const todayEstimatedLogBytes = todayRequests * ESTIMATED_LOG_BYTES_PER_REQUEST;

  const dbSizeLevel = dbSizeBytes === null ? "none" : levelForRatio(dbSizeBytes / SUPABASE_FREE_PLAN_LIMITS.dbSizeBytes);
  const egressLevel = levelForRatio(todayApproxBytes / DAILY_BUDGETS.egressBytes);
  const logIngestionLevel = levelForRatio(todayEstimatedLogBytes / DAILY_BUDGETS.logIngestionBytes);
  const level = combineLevels(dbSizeLevel, egressLevel, logIngestionLevel);

  const reasons: string[] = [];
  if (dbSizeLevel !== "none") reasons.push(`db_size:${dbSizeLevel}`);
  if (egressLevel !== "none") reasons.push(`egress:${egressLevel}`);
  if (logIngestionLevel !== "none") reasons.push(`log_ingestion:${logIngestionLevel}`);

  return { level, reasons, dbSizeBytes, todayRequests, todayApproxBytes, todayEstimatedLogBytes };
}

/** Writes the evaluated level so every serverless instance (not just the one that ran the evaluation) can read it. */
export async function writeThrottleState(client: SupabaseAdminClient, evaluation: QuotaEvaluation): Promise<void> {
  const { error } = await client
    .from("quota_throttle_state")
    .upsert({ id: true, level: evaluation.level, reasons: evaluation.reasons, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) console.error("Quota throttle state write failed:", error.message);
}

let cachedLevel: { level: ThrottleLevel; at: number } | null = null;
const THROTTLE_LEVEL_CACHE_TTL_MS = 60_000;

/**
 * Read the shared throttle level, cached in-process for a minute so pages checking it
 * on every render (to decide their own cache TTL, whether to run optional reads) do
 * not themselves become a new source of read volume. A read failure or cold cache
 * fails open to "none": a monitoring mechanism must never be the reason the dashboard
 * goes down.
 */
export async function getThrottleLevel(client: SupabaseAdminClient): Promise<ThrottleLevel> {
  if (cachedLevel && Date.now() - cachedLevel.at < THROTTLE_LEVEL_CACHE_TTL_MS) return cachedLevel.level;
  try {
    const { data, error } = await client.from("quota_throttle_state").select("level").eq("id", true).maybeSingle();
    if (error) throw error;
    const level = (data as { level?: ThrottleLevel } | null)?.level ?? "none";
    cachedLevel = { level, at: Date.now() };
    return level;
  } catch (error) {
    console.error("Quota throttle state read failed (defaulting to unthrottled):", error);
    return cachedLevel?.level ?? "none";
  }
}

/**
 * Synchronous read of whatever level was last cached by getThrottleLevel, for callers
 * that need a plain value right now (e.g. ttl-cache.ts computing an effective TTL) and
 * cannot await a DB round trip inline. Defaults to "none" (unthrottled) until the first
 * background refresh completes, same fail-open reasoning as getThrottleLevel itself.
 */
export function getCachedThrottleLevelSync(): ThrottleLevel {
  return cachedLevel?.level ?? "none";
}

/**
 * Kicks off a refresh of the cached throttle level without making the caller wait for
 * it. Callers that read getCachedThrottleLevelSync() on every render should also call
 * this once per render so the in-process cache does not go stale for longer than its
 * own TTL would suggest; being fire-and-forget, it costs nothing on the critical path
 * and is itself rate-limited by THROTTLE_LEVEL_CACHE_TTL_MS inside getThrottleLevel.
 */
export function refreshThrottleLevelInBackground(client: SupabaseAdminClient): void {
  getThrottleLevel(client).catch(() => undefined);
}

/** The cache-TTL multiplier for whatever level is currently cached (see CACHE_TTL_MULTIPLIER). */
export function getCacheTtlMultiplierSync(): number {
  return CACHE_TTL_MULTIPLIER[getCachedThrottleLevelSync()];
}
