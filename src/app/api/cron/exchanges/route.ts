import { createSupabaseAdminClient } from "../../../../lib/supabase/admin.ts";
import { isAuthorizedRefreshRequest } from "../../../../lib/refresh/auth.ts";
import { DEFAULT_MONTHLY_CALL_CAP, runExchangeCollection } from "../../../../lib/providers/run-exchange-collection.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_SLICE = 8;
const MAX_SLICE = 15;
const BUDGET_MS = 45_000;

function positiveInteger(value: string | null | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Daily exchange (centralised and decentralised) volume refresh. The Cloudflare Worker calls this on every 5-minute
 * tick; each call only picks tokens whose snapshot is older than ~22 h (oldest first), so a full
 * ~154-token pass finishes within about two hours of the day rolling over and the remaining ticks
 * are cheap no-ops (`none_due`). Requires `Authorization: Bearer <CRON_SECRET>`.
 *
 * Quota: each token costs one CoinGecko call. `COINGECKO_EXCHANGE_MONTHLY_CALL_CAP` (default
 * 3,800) is a hard ceiling on this collector's calls per UTC month, so it can never starve the
 * /coins/markets refresh. `EXCHANGE_VOLUMES_ENABLED=false` turns it off entirely.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedRefreshRequest(request.headers.get("authorization"))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (process.env.EXCHANGE_VOLUMES_ENABLED?.trim().toLowerCase() === "false") {
    return Response.json({ status: "disabled" });
  }
  const url = new URL(request.url);
  const maxTokens = Math.min(positiveInteger(url.searchParams.get("slice")) ?? DEFAULT_SLICE, MAX_SLICE);
  const monthlyCap = positiveInteger(process.env.COINGECKO_EXCHANGE_MONTHLY_CALL_CAP) ?? DEFAULT_MONTHLY_CALL_CAP;
  try {
    const result = await runExchangeCollection(createSupabaseAdminClient(), {
      maxTokens, monthlyCap, deadlineAt: Date.now() + BUDGET_MS,
    });
    console.log(`[exchanges] ${result.succeeded}/${result.attempted} ok, ${result.failed} failed, stopped: ${result.stoppedReason}, ${result.callsThisMonth}/${result.monthlyCap} calls this month, ${result.dueRemaining} due.`);
    return Response.json({ status: result.failed > 0 && result.succeeded === 0 ? "failed" : "ok", ...result }, { status: result.failed > 0 && result.succeeded === 0 ? 500 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    console.error(`[exchanges] failed: ${message}`);
    return Response.json({ status: "failed", error: message }, { status: 500 });
  }
}
