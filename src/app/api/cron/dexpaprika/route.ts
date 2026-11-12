import { createSupabaseAdminClient } from "../../../../lib/supabase/admin.ts";
import { isAuthorizedRefreshRequest } from "../../../../lib/refresh/auth.ts";
import { runDexPaprikaCollection } from "../../../../lib/providers/run-dexpaprika-collection.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_SLICE = 6;
const MAX_SLICE = 10;
const BUDGET_MS = 45_000;

function positiveInteger(value: string | null | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * DexPaprika collection (the only on-chain DEX data provider; it replaced DexPaprika and GeckoTerminal). The
 * Cloudflare Worker calls this on every 5-minute tick; each call refreshes the stalest of the ~95 mapped tokens
 * (token stats older than 90 minutes, pool lists older than 6 hours), paced 2.5 s apart, under a monthly request cap,
 * so an idle tick does nothing. DEXPAPRIKA_API_KEY (optional) raises the limits and
 * DEXPAPRIKA_MONTHLY_CALL_CAP overrides the cap. Requires `Authorization: Bearer <CRON_SECRET>`.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedRefreshRequest(request.headers.get("authorization"))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const maxTokens = Math.min(positiveInteger(url.searchParams.get("slice")) ?? DEFAULT_SLICE, MAX_SLICE);
  try {
    const client = createSupabaseAdminClient();
    const monthlyCap = positiveInteger(process.env.DEXPAPRIKA_MONTHLY_CALL_CAP);
    const result = await runDexPaprikaCollection(client, { maxTokens, deadlineAt: Date.now() + BUDGET_MS, ...(monthlyCap ? { monthlyCap } : {}) });
    // Persist the outcome so a failing collector can be diagnosed from the database (best effort).
    await client.from("collector_status")
      .upsert({ job: "dexpaprika", updated_at: new Date().toISOString(), result }, { onConflict: "job" })
      .then(({ error }) => { if (error) console.error(`[dexpaprika] status write failed: ${error.message}`); });
    console.log(`[dexpaprika] ${result.succeeded}/${result.attempted} ok, ${result.failed} failed, stopped: ${result.stoppedReason}, ${result.dueRemaining} due.`);
    const failed = result.failed > 0 && result.succeeded === 0;
    return Response.json({ status: failed ? "failed" : "ok", ...result }, { status: failed ? 500 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    console.error(`[dexpaprika] failed: ${message}`);
    return Response.json({ status: "failed", error: message }, { status: 500 });
  }
}
