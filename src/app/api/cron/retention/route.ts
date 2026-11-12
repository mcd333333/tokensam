import { createSupabaseAdminClient } from "../../../../lib/supabase/admin.ts";
import { isAuthorizedRefreshRequest } from "../../../../lib/refresh/auth.ts";
import { acquireRetentionLock, finishRetentionLock, lastSuccessfulRetentionRun, type RetentionTrigger } from "../../../../lib/retention/lock.ts";
import { runRetentionBatches } from "../../../../lib/retention/run-retention.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// The Cloudflare Worker ticks every 5 minutes like the other cron routes. Per-metric daily-average
// retention windows are defined in the current Supabase migration and applied on each due pass.
const DEFAULT_RUN_INTERVAL_MS = 5 * 60 * 1000;
// Leaves headroom below maxDuration for lock finalization + response construction.
const PROCESSING_BUDGET_MS = 280_000;
const LOCK_LEASE_MS = 320_000;

function positiveNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Scheduled data-retention pass. Requires `Authorization: Bearer <CRON_SECRET>`, the
 * same convention as /api/cron/refresh. Deletes/downsamples
 * token_metric_observations and raw_provider_records per the windows documented in
 * the current Supabase retention migrations — without this route
 * running regularly, token_metric_observations alone regrows past the Supabase Free
 * Plan's 0.5 GB quota within about two weeks at the current refresh cadence.
 *
 * `force=1` bypasses the five-minute due-check for manual testing.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedRefreshRequest(request.headers.get("authorization"))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const client = createSupabaseAdminClient();
  const now = new Date();
  const trigger: RetentionTrigger = request.headers.get("x-vercel-cron-schedule") || request.headers.get("x-scheduled-by")
    ? "scheduled"
    : "manual";
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";

  if (!force) {
    const intervalMs = positiveNumber(process.env.RETENTION_RUN_INTERVAL_MS) ?? DEFAULT_RUN_INTERVAL_MS;
    const lastSuccess = await lastSuccessfulRetentionRun(client);
    if (lastSuccess && now.getTime() - Date.parse(lastSuccess) < intervalMs) {
      return Response.json({ status: "skipped", reason: "not_due", lastSuccess, intervalMs });
    }
  }

  const ownership = await acquireRetentionLock(client, trigger, now, LOCK_LEASE_MS);
  if (ownership === null) {
    return Response.json({ status: "busy", message: "A retention run is already in progress." }, { status: 409 });
  }
  const { runId, lockToken } = ownership;

  const routeStart = Date.now();
  console.log(`[retention-cron] started (${trigger}), run ${runId}, at ${now.toISOString()}.`);
  try {
    const result = await runRetentionBatches(client, routeStart + PROCESSING_BUDGET_MS);
    const { data: vacuumMaintenance, error: vacuumMaintenanceError } = await client.rpc("manage_retention_full_vacuum");
    if (vacuumMaintenanceError) {
      console.error(
        `[retention-cron] vacuum maintenance check failed: ${vacuumMaintenanceError.message}`,
      );
    } else {
      console.log(`[retention-cron] vacuum maintenance: ${JSON.stringify(vacuumMaintenance)}`);
    }
    const failedFns = Object.keys(result.failed);
    // A function's own RPC error (e.g. a timeout) no longer aborts the run -- see run-retention.ts --
    // so it surfaces here as "partial" alongside stoppedEarly, never as the route's own "failed" status.
    const status = result.stoppedEarly.length > 0 || failedFns.length > 0 ? "partial" : "succeeded";
    const finalized = await finishRetentionLock(client, runId, lockToken, status, new Date(), result, null);
    console.log(
      `[retention-cron] ${status}: ${result.totalDeleted} rows deleted across `
      + `${Object.values(result.batches).reduce((sum, n) => sum + n, 0)} batches`
      + `${result.stoppedEarly.length > 0 ? ` (stopped early on: ${result.stoppedEarly.join(", ")})` : ""}`
      + `${failedFns.length > 0 ? ` (errored on: ${failedFns.map((fn) => `${fn}: ${result.failed[fn as keyof typeof result.failed]}`).join("; ")})` : ""}.`,
    );
    if (!finalized) {
      console.error(`[retention-cron] run ${runId} lost lease ownership before finalization; its deletes are already committed.`);
      return Response.json({ status: "lost_ownership", runId, ...result }, { status: 500 });
    }
    return Response.json({ status, runId, ...result, vacuumMaintenance, vacuumMaintenanceError: vacuumMaintenanceError?.message ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    await finishRetentionLock(client, runId, lockToken, "failed", new Date(), {}, message).catch(() => undefined);
    console.error(`[retention-cron] failed: ${message}`);
    return Response.json({ status: "failed", runId, error: message }, { status: 500 });
  }
}
