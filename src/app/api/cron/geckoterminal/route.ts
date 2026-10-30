import { createSupabaseAdminClient } from "../../../../lib/supabase/admin.ts";
import { isAuthorizedRefreshRequest } from "../../../../lib/refresh/auth.ts";
import {
  acquireGeckoTerminalSyncLock,
  finishGeckoTerminalSyncLock,
  lastSuccessfulGeckoTerminalSync,
  renewGeckoTerminalSyncLock,
  type GeckoTerminalSyncTrigger,
} from "../../../../lib/providers/geckoterminal-sync-lock.ts";
import { runGeckoTerminalScheduledCollection } from "../../../../lib/providers/run-geckoterminal-collection.ts";

export const dynamic = "force-dynamic";
// Same ceiling as /api/cron/refresh on this deployment. A full 63-token sync
// can exceed this even without throttling (~7 min unthrottled, more with 429
// cooldowns), so PROCESSING_BUDGET_MS below leaves the collector time to stop
// early and persist whatever it collected rather than being hard-killed. With
// the current 63 mapped tokens, 6.5 s pacing fits ~30-40 tokens in this
// budget, so rotation (not a single run) is what covers the full universe.
export const maxDuration = 300;

// Budget math (maxDuration 300s total):
//   255s  token collection (stops starting new tokens here)
//  + ~15s worst-case tail of one in-flight request + its retries
//  + ~15s persistProviderSnapshots + upsertGeckoTerminalMappings
//  +  ~5s lock finalization + response construction
//  = 290s, leaving a 10s margin against the 300s platform kill.
// Supabase's postgrest-js client does not offer true server-side statement
// cancellation from here; persistProviderSnapshots is instead given an
// AbortSignal (see PERSIST_DEADLINE_MARGIN_MS below) that aborts its
// underlying HTTP requests once we get close to maxDuration, so a stuck write
// stops blocking the response even though Postgres may keep executing briefly
// after the connection drops (best-effort, not a guarantee).
const PROCESSING_BUDGET_MS = 255_000;
// How much of maxDuration is reserved, after PROCESSING_BUDGET_MS, for
// persistence + finalization; persistence's AbortSignal fires when this much
// time is left before the platform's own 300s kill.
const PERSIST_DEADLINE_MARGIN_MS = 10_000;
// A slice call (one token, plus a 429 cooldown or retry at worst) must end well inside this.
const SLICE_BUDGET_MS = 60_000;
// Just above maxDuration (300s) so a genuinely running invocation is never
// stolen. Ownership is renewed by a heartbeat during token collection (see
// onHeartbeat below), not just asserted once at acquire time: a live
// invocation keeps extending this deadline, while a killed one stops
// heartbeating and becomes reclaimable ~30s after the kill, not 15 minutes
// later.
const LOCK_LEASE_MS = 330_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
// Vercel Hobby cannot run a cron more often than once a day, so this route is
// no longer invoked by a */15 * * * * Vercel Cron (see vercel.json). Instead
// the existing Cloudflare Worker (cloudflare/refresh-scheduler/) invokes this
// route on every one of its 5-minute ticks, the same way it already invokes
// /api/cron/refresh, and this due-check is what turns that into an effective
// ~15-minute GeckoTerminal cadence: two out of every three 5-minute ticks are
// a cheap no-op ({"status":"skipped"}), and the third actually collects.
// 13 minutes is 15 minutes minus a 2-minute tolerance for tick jitter, the
// same interval-minus-tolerance pattern REFRESH_POLICY/DUE_TOLERANCE_MS uses.
const DEFAULT_SYNC_INTERVAL_MS = 13 * 60 * 1000;

function positiveNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Scheduled GeckoTerminal collection. Invoked by the Cloudflare Worker
 * (cloudflare/refresh-scheduler/) on every 5-minute tick — not by Vercel
 * Cron, which on the Hobby plan cannot fire more often than once a day; see
 * "Recurring scheduled collection" in docs/geckoterminal-integration.md.
 * Requires `Authorization: Bearer <CRON_SECRET>`, the same secret and header
 * convention as /api/cron/refresh.
 *
 * Gated behind `GECKOTERMINAL_SYNC_ENABLED=true` (unset/false: no-op, so
 * deploying this route never silently starts spending GeckoTerminal's rate
 * limit). `GECKOTERMINAL_SYNC_INTERVAL` (ms) controls the due-check —
 * default 13 min — independent of how often the caller fires, mirroring
 * the existing refresh's due-check pattern; this is what turns frequent
 * 5-minute ticks into an effective ~15-minute GeckoTerminal cadence. Each
 * invocation processes only as many tokens as fit the time budget (rotation,
 * not a full-universe sync), so the ~15-minute cadence is the collection
 * tick, not the freshness of every mapped token; see
 * docs/geckoterminal-integration.md for rotation timing.
 * `GECKOTERMINAL_BATCH_DELAY_MS` may only raise pacing above the collector's
 * own conservative floor, never lower it. `force=1` bypasses the due-check
 * for manual testing.
 *
 * GeckoTerminal is entirely independent of the main refresh: it never calls
 * CoinGecko's /onchain endpoints, never spends CoinGecko quota, and this
 * route does not touch data_refresh_runs/data_refresh_steps or any
 * CoinGecko/DeFiLlama/DEX Screener collector.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedRefreshRequest(request.headers.get("authorization"))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (process.env.GECKOTERMINAL_SYNC_ENABLED?.trim().toLowerCase() !== "true") {
    return Response.json({ status: "disabled", message: "Set GECKOTERMINAL_SYNC_ENABLED=true to enable scheduled GeckoTerminal collection." });
  }

  const client = createSupabaseAdminClient();
  const now = new Date();
  // "x-vercel-cron-schedule" covers the rare direct Vercel Cron invocation (see vercel.json's
  // daily entry for /api/cron/refresh); "x-scheduled-by" covers the Cloudflare Worker, which
  // is not Vercel Cron and so cannot set the former header itself.
  const trigger: GeckoTerminalSyncTrigger = request.headers.get("x-vercel-cron-schedule") || request.headers.get("x-scheduled-by")
    ? "scheduled"
    : "manual";
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";
  // Slice mode (?slice=N): the Cloudflare Worker paces the requests and calls this route once per
  // N tokens (normally 1), so this invocation lasts a couple of seconds instead of ~260 s of
  // billed sleeping. No due-check: the Worker's 5-minute tick is the cadence.
  const sliceParam = Number(url.searchParams.get("slice"));
  const slice = Number.isInteger(sliceParam) && sliceParam > 0 ? Math.min(sliceParam, 10) : null;

  if (!force && slice === null) {
    const intervalMs = positiveNumber(process.env.GECKOTERMINAL_SYNC_INTERVAL) ?? DEFAULT_SYNC_INTERVAL_MS;
    const lastSuccess = await lastSuccessfulGeckoTerminalSync(client);
    if (lastSuccess && now.getTime() - Date.parse(lastSuccess) < intervalMs) {
      return Response.json({ status: "skipped", reason: "not_due", lastSuccess, intervalMs });
    }
  }

  const ownership = await acquireGeckoTerminalSyncLock(client, trigger, now, LOCK_LEASE_MS);
  if (ownership === null) {
    return Response.json({ status: "busy", message: "A GeckoTerminal collection is already running." }, { status: 409 });
  }
  const { runId, lockToken } = ownership;

  const routeStart = Date.now();
  const startedAtIso = now.toISOString();
  console.log(`[geckoterminal-cron] started (${trigger}), run ${runId}, at ${startedAtIso}.`);
  // Aborts persistProviderSnapshots' underlying Supabase requests if we get
  // this close to maxDuration; see the PERSIST_DEADLINE_MARGIN_MS comment above.
  const persistDeadlineController = new AbortController();
  const persistDeadlineTimer = setTimeout(
    () => persistDeadlineController.abort(new Error("GeckoTerminal persistence exceeded its remaining budget before maxDuration.")),
    Math.max(0, maxDuration * 1000 - PERSIST_DEADLINE_MARGIN_MS - (Date.now() - routeStart)),
  );
  try {
    const result = await runGeckoTerminalScheduledCollection(client, {
      deadlineAt: routeStart + (slice === null ? PROCESSING_BUDGET_MS : SLICE_BUDGET_MS),
      maxTokens: slice ?? undefined,
      minRequestIntervalMs: positiveNumber(process.env.GECKOTERMINAL_BATCH_DELAY_MS) ?? undefined,
      onHeartbeat: () => renewGeckoTerminalSyncLock(client, runId, lockToken, new Date(), LOCK_LEASE_MS),
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      persistSignal: persistDeadlineController.signal,
    });
    if (result.ownershipLostDuringCollection) {
      // Lost the lease mid-run: the snapshots collected before that point were
      // still persisted above (partial provider work is never discarded), but
      // this invocation no longer owns the row, so it must not finalize it —
      // finishGeckoTerminalSyncLock's ownership check makes that a safe no-op,
      // and whichever run now holds the lease is the one that finalizes.
      console.error(`[geckoterminal-cron] run ${runId} lost lease ownership mid-collection; not finalizing.`);
      return Response.json({ status: "lost_ownership", runId, ...result }, { status: 500 });
    }
    const status = result.failed.length === 0 && result.skipped.length === 0
      ? "succeeded"
      : result.succeeded.length > 0
        ? "partial"
        : "failed";
    const finalized = await finishGeckoTerminalSyncLock(client, runId, lockToken, status, new Date(), result as unknown as Record<string, unknown>, null);
    console.log(
      `[geckoterminal-cron] ${status} in ${result.durationMs}ms: ${result.succeeded.length}/${result.attempted} succeeded, `
      + `${result.failed.length} failed, ${result.skipped.length} skipped, ${result.observations} observations written, `
      + `${result.unavailable.length} unavailable, ${result.rateLimitEvents} rate-limit events, ${result.retries} retries.`,
    );
    if (!finalized) {
      // Ownership was reclaimed between the collection loop ending and this
      // finalization call (e.g. a slow response path racing an expiring
      // lease). The observations above are already committed regardless.
      console.error(`[geckoterminal-cron] run ${runId} lost lease ownership before finalization; its data is persisted but its status was not recorded.`);
      return Response.json({ status: "lost_ownership", runId, ...result }, { status: 500 });
    }
    return Response.json({ status, runId, ...result }, { status: status === "failed" ? 500 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    await finishGeckoTerminalSyncLock(client, runId, lockToken, "failed", new Date(), {}, message).catch(() => undefined);
    console.error(`[geckoterminal-cron] failed: ${message}`);
    return Response.json({ status: "failed", runId, error: message }, { status: 500 });
  } finally {
    clearTimeout(persistDeadlineTimer);
  }
}
