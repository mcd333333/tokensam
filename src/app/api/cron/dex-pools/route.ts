import { createSupabaseAdminClient } from "../../../../lib/supabase/admin.ts";
import { isAuthorizedRefreshRequest } from "../../../../lib/refresh/auth.ts";
import { runDexPoolCollection } from "../../../../lib/providers/run-dex-pool-collection.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_SLICE = 12;
const MAX_SLICE = 30;
const BUDGET_MS = 45_000;

function positiveInteger(value: string | null | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * On-chain DEX pool refresh (DEX Screener), replacing the GeckoTerminal slices. The Cloudflare Worker calls this
 * on every 5-minute tick; each call refreshes the stalest of the ~55 mapped tokens (those older than 25 minutes),
 * so the whole list turns over about every 30 minutes and an idle tick does nothing. Requires
 * `Authorization: Bearer <CRON_SECRET>`.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedRefreshRequest(request.headers.get("authorization"))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const maxTokens = Math.min(positiveInteger(url.searchParams.get("slice")) ?? DEFAULT_SLICE, MAX_SLICE);
  try {
    const client = createSupabaseAdminClient();
    const result = await runDexPoolCollection(client, { maxTokens, deadlineAt: Date.now() + BUDGET_MS });
    // Persist the outcome so a failing collector can be diagnosed from the database (best effort).
    await client.from("collector_status")
      .upsert({ job: "dex-pools", updated_at: new Date().toISOString(), result }, { onConflict: "job" })
      .then(({ error }) => { if (error) console.error(`[dex-pools] status write failed: ${error.message}`); });
    console.log(`[dex-pools] ${result.succeeded}/${result.attempted} ok, ${result.failed} failed, stopped: ${result.stoppedReason}, ${result.dueRemaining} due.`);
    const failed = result.failed > 0 && result.succeeded === 0;
    return Response.json({ status: failed ? "failed" : "ok", ...result }, { status: failed ? 500 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    console.error(`[dex-pools] failed: ${message}`);
    return Response.json({ status: "failed", error: message }, { status: 500 });
  }
}
