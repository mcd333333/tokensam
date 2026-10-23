import { createSupabaseAdminClient } from "../../../../lib/supabase/admin.ts";
import { isAuthorizedRefreshRequest } from "../../../../lib/refresh/auth.ts";
import { PROVIDER_STEPS, type ProviderStep } from "../../../../lib/refresh/config.ts";
import { runDataRefresh } from "../../../../lib/refresh/orchestrator.ts";
import { SupabaseRefreshStore } from "../../../../lib/refresh/store.ts";
import { evaluateQuotaLevel, writeThrottleState } from "../../../../lib/monitoring/quota-tracker.ts";

export const dynamic = "force-dynamic";
// Providers run concurrently within their own budgets (<= 120 s), then metrics (<= 90 s).
export const maxDuration = 300;

/**
 * Scheduled data refresh. Requires `Authorization: Bearer <CRON_SECRET>`.
 * Optional query parameters for development: `force=1` and `providers=coingecko,dexscreener`.
 *
 * Primarily invoked every 5 minutes by the Cloudflare Worker
 * (cloudflare/refresh-scheduler/), which is what makes REFRESH_POLICY's
 * per-provider intervals (CoinGecko/DEX Screener 15 min, DeFiLlama Coins
 * 30 min, DeFiLlama 6 h — see src/lib/refresh/config.ts) effective; each tick
 * is cheap when nothing is due, since isProviderDue() gates the actual work.
 * vercel.json also declares a once-daily Vercel Cron entry as a fallback
 * (Vercel Hobby cannot run cron more often than daily), so the route still
 * runs even if the Cloudflare Worker is ever down.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedRefreshRequest(request.headers.get("authorization"))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const requested = url.searchParams.get("providers")?.split(",").map((value) => value.trim()).filter(Boolean);
  if (requested?.some((value) => !PROVIDER_STEPS.includes(value as ProviderStep))) {
    return Response.json({ error: `providers must be a comma-separated subset of ${PROVIDER_STEPS.join(", ")}.` }, { status: 400 });
  }

  try {
    const client = createSupabaseAdminClient();
    // "x-vercel-cron-schedule" covers the daily Vercel Cron fallback; "x-scheduled-by" covers
    // the Cloudflare Worker, which is not Vercel Cron and so cannot set the former header.
    const trigger = request.headers.get("x-vercel-cron-schedule") || request.headers.get("x-scheduled-by") ? "scheduled" : "manual";
    const result = await runDataRefresh(client, new SupabaseRefreshStore(client), {
      trigger,
      force: url.searchParams.get("force") === "1",
      only: requested as ProviderStep[] | undefined,
    });

    // Database size and quota don't move meaningfully within one 5-minute Cloudflare
    // Worker tick, so this whole monitoring block -- ~5-6 Supabase round trips, all pure
    // overhead on top of whatever runDataRefresh itself did -- only runs when something
    // was actually due this tick (or on a forced/manual call, which wants full detail).
    // The shortest REFRESH_POLICY interval is 15 minutes (coingecko/dexscreener), so this
    // still checks at least that often: "every ~15 min" instead of every 5, cutting this
    // block's own invocation count by roughly two-thirds without widening how long a real
    // threshold crossing could go unnoticed by more than one due-cycle.
    let databaseSizeBytes: number | null = null;
    let databaseAlert = false;
    let databaseSizeMb: number | null = null;
    let quotaAlert = false;
    let quota: Awaited<ReturnType<typeof evaluateQuotaLevel>> | null = null;

    if (result.due.length > 0 || trigger === "manual") {
      // Check storage after every due refresh so the Cloudflare scheduler can alert before
      // the Supabase Free-plan limit is reached. The alert is edge-triggered: once 450 MiB
      // is crossed, it fires once and stays quiet until usage falls back below the
      // threshold and crosses it again.
      const { data: sizeData, error: databaseSizeError } = await client.rpc("get_database_size_bytes");
      if (databaseSizeError) {
        console.error("Database size check failed:", databaseSizeError);
      }
      databaseSizeBytes = typeof sizeData === "number" ? sizeData : null;
      databaseSizeMb = databaseSizeBytes !== null ? databaseSizeBytes / (1024 * 1024) : null;

      if (databaseSizeBytes !== null) {
        const thresholdBytes = 450 * 1024 * 1024;
        const { data: monitorState, error: monitorStateError } = await client
          .from("database_monitor_state")
          .select("alert_active")
          .eq("id", true)
          .maybeSingle();

        if (monitorStateError) {
          console.error("Database monitor state read failed:", monitorStateError);
        } else {
          const isOverThreshold = databaseSizeBytes >= thresholdBytes;
          if (isOverThreshold && !monitorState?.alert_active) {
            databaseAlert = true;
          }

          const { error: monitorStateWriteError } = await client
            .from("database_monitor_state")
            .upsert({
              id: true,
              alert_active: isOverThreshold,
              updated_at: new Date().toISOString(),
            }, { onConflict: "id" });

          if (monitorStateWriteError) {
            console.error("Database monitor state write failed:", monitorStateWriteError);
          }
        }
      }

      // Egress and the two log metrics (Log Ingestion, Log Query) have no SQL-visible
      // number the way database size does: evaluateQuotaLevel compares this app's own
      // approximate daily request/byte tracking (quota-tracker.ts) plus the database
      // size just read above against the free-plan budgets in quota-config.ts.
      // Edge-triggered the same way as the database alert above: previousLevel is read
      // before writeThrottleState overwrites it, so quotaAlert only fires on the
      // transition into a worse level, not on every tick already at that level.
      try {
        const { data: previousState } = await client.from("quota_throttle_state").select("level").eq("id", true).maybeSingle();
        const previousLevel = (previousState as { level?: string } | null)?.level ?? "none";
        quota = await evaluateQuotaLevel(client, databaseSizeBytes);
        await writeThrottleState(client, quota);
        const severity = { none: 0, warn: 1, critical: 2 } as const;
        if (quota.level !== "none" && severity[quota.level] > severity[previousLevel as keyof typeof severity]) {
          quotaAlert = true;
        }
      } catch (error) {
        console.error("Quota level evaluation failed:", error);
      }
      // Keeps quota_usage_counters from becoming an unbounded-growth contributor in its
      // own right; cheap and a no-op on every call except the first one past midnight.
      client.rpc("prune_quota_usage_counters").then(
        ({ error }) => { if (error) console.error("Quota usage counter pruning failed:", error.message); },
        (error: unknown) => console.error("Quota usage counter pruning failed:", error),
      );
    }

    // "lost_ownership" means this invocation's lease was reclaimed mid-run (see
    // runDataRefresh): its recorded steps are still committed, but it could not
    // finalize the run's own status row, so it is reported distinctly rather
    // than as an ordinary failure or success.
    const status = result.status === "busy" ? 409 : result.status === "failed" || result.status === "lost_ownership" ? 500 : 200;
    return Response.json({
      status: result.status,
      runId: result.runId,
      due: result.due,
      succeeded: result.steps.filter((step) => step.status === "succeeded").map((step) => step.step),
      failed: result.steps.filter((step) => step.status === "failed").map((step) => step.step),
      timedOut: result.steps.filter((step) => step.status === "timed_out").map((step) => step.step),
      metrics: result.steps.find((step) => step.step === "metrics")?.status ?? null,
      databaseSizeBytes,
      databaseSizeMb,
      databaseAlert,
      quotaLevel: quota?.level ?? null,
      quotaReasons: quota?.reasons ?? [],
      quotaAlert,
      quotaUsage: quota ? { todayRequests: quota.todayRequests, todayApproxBytes: quota.todayApproxBytes } : null,
      steps: result.steps.map(({ step, status: stepStatus, finishedAt, error }) => ({ step, status: stepStatus, finishedAt, error })),
    }, { status });
  } catch (error) {
    console.error("Data refresh failed:", error);
    return Response.json({ status: "failed", error: "Refresh failed; see server logs." }, { status: 500 });
  }
}
