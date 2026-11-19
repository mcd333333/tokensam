import { createSupabaseAdminClient } from "../../../../lib/supabase/admin.ts";
import { isAuthorizedRefreshRequest } from "../../../../lib/refresh/auth.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ROOTDATA_BASE_URL = "https://api.rootdata.com/open";
const FINANCIAL_REFRESH_INTERVAL_DAYS = 14;
const MIN_CREDITS_AFTER_RUN = 25;
const REQUEST_INTERVAL_MS = 1_050;

type ProfileDueRow = {
  token_id: string;
  rootdata_project_id: number;
  financial_collected_at: string | null;
};

type RootDataProject = {
  project_id?: number;
  total_funding?: number | string | null;
  investors?: Array<{ name?: string; logo?: string }>;
};

type RootDataResponse<T> = { data?: T; result?: number };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rootdataPost<T>(apiKey: string, endpoint: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${ROOTDATA_BASE_URL}/${endpoint}`, {
    method: "POST",
    headers: {
      apikey: apiKey,
      language: "en",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({})) as RootDataResponse<T>;
  if (!response.ok || body.result !== 200 || body.data === undefined) {
    throw new Error(`RootData ${endpoint} returned HTTP ${response.status}.`);
  }
  return body.data;
}

async function remainingCredits(apiKey: string): Promise<number> {
  const quota = await rootdataPost<{ credits?: number }>(apiKey, "quotacredits");
  const credits = Number(quota.credits);
  if (!Number.isFinite(credits) || credits < 0) throw new Error("RootData quota response was invalid.");
  return credits;
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedRefreshRequest(request.headers.get("authorization"))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.ROOTDATA_API_KEY?.trim();
  if (!apiKey) return Response.json({ error: "RootData API key is not configured." }, { status: 503 });

  try {
    const client = createSupabaseAdminClient();
    const { data, error } = await client
      .from("rootdata_project_profiles")
      .select("token_id,rootdata_project_id,financial_collected_at")
      .order("financial_collected_at", { ascending: true })
      .limit(200);

    if (error) throw new Error("RootData profiles could not be read from Supabase.");
    const rows = (data ?? []) as ProfileDueRow[];
    if (rows.length === 0) {
      return Response.json({ status: "not_initialized", refreshed: 0, detail: "Import the initial RootData profiles first." });
    }

    const cutoff = new Date();
    cutoff.setUTCHours(0, 0, 0, 0);
    // Compare calendar days so one batch's completion time cannot push the next run back a day.
    cutoff.setUTCDate(cutoff.getUTCDate() - FINANCIAL_REFRESH_INTERVAL_DAYS + 1);
    const force = new URL(request.url).searchParams.get("force") === "1";
    const due = rows.filter((row) => {
      if (force || !row.financial_collected_at) return true;
      const last = Date.parse(row.financial_collected_at);
      return !Number.isFinite(last) || last < cutoff.getTime();
    });
    if (due.length === 0) {
      return Response.json({ status: "not_due", profile_count: rows.length, refreshed: 0, interval_days: FINANCIAL_REFRESH_INTERVAL_DAYS });
    }

    const creditsBefore = await remainingCredits(apiKey);
    const expectedCredits = due.length * 2;
    if (creditsBefore < expectedCredits + MIN_CREDITS_AFTER_RUN) {
      console.warn("rootdata: skipped due to insufficient API credit buffer", {
        due: due.length,
        creditsAvailable: creditsBefore,
        creditsRequired: expectedCredits,
      });
      return Response.json({
        status: "skipped_low_credits",
        due: due.length,
        credits_available: creditsBefore,
        credits_required: expectedCredits,
      });
    }

    let refreshed = 0;
    const failed: string[] = [];
    let lastRequestAt = 0;
    for (const row of due) {
      const waitMs = Math.max(0, lastRequestAt + REQUEST_INTERVAL_MS - Date.now());
      if (waitMs > 0) await sleep(waitMs);
      lastRequestAt = Date.now();

      try {
        const project = await rootdataPost<RootDataProject>(apiKey, "get_item", {
          project_id: Number(row.rootdata_project_id),
          include_investors: true,
        });
        if (Number(project.project_id) !== Number(row.rootdata_project_id)) {
          throw new Error("RootData returned a mismatched project ID.");
        }

        const update: Record<string, unknown> = {
          financial_collected_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        if (Object.hasOwn(project, "total_funding")) update.total_funding = project.total_funding ?? null;
        if (Array.isArray(project.investors)) update.investors = project.investors;
        if (Object.keys(update).length === 2) throw new Error("RootData returned no financial summary fields.");

        const { error: updateError } = await client
          .from("rootdata_project_profiles")
          .update(update)
          .eq("token_id", row.token_id)
          .eq("rootdata_project_id", row.rootdata_project_id);
        if (updateError) throw new Error("Supabase financial summary update failed.");
        refreshed += 1;
      } catch (error) {
        console.error("rootdata: profile refresh failed", {
          tokenId: row.token_id,
          reason: error instanceof Error ? error.message : "request error",
        });
        failed.push(row.token_id);
      }
    }

    const creditsAfter = await remainingCredits(apiKey).catch(() => null);
    return Response.json({
      status: failed.length === 0 ? "succeeded" : "partial",
      profile_count: rows.length,
      due: due.length,
      refreshed,
      failed,
      interval_days: FINANCIAL_REFRESH_INTERVAL_DAYS,
      credits_used: creditsAfter === null ? null : creditsBefore - creditsAfter,
    });
  } catch (error) {
    console.error("rootdata: scheduled refresh failed", error);
    return Response.json({ status: "failed", error: "RootData refresh failed; see Worker logs." }, { status: 500 });
  }
}
