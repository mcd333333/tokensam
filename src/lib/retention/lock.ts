/**
 * Lease-based lock for the retention job, a single "running" row
 * (enforced by a partial unique index), with an expiring lease so a crashed
 * run releases itself automatically. No heartbeat renewal is needed here —
 * a retention run completes synchronously
 * within one route invocation (<= maxDuration), so the lease acquired at
 * start already covers the whole run.
 */

import { randomUUID } from "node:crypto";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

export type RetentionTrigger = "scheduled" | "manual";
export type RetentionStatus = "running" | "succeeded" | "partial" | "failed";
export type RetentionRunOwnership = { runId: number; lockToken: string };

const UNIQUE_VIOLATION = "23505";

function fail(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`Supabase ${action} failed: ${error.message}`);
}

/** Acquires the single retention lock, or returns null when another run already holds it. */
export async function acquireRetentionLock(
  client: SupabaseAdminClient,
  trigger: RetentionTrigger,
  now: Date,
  leaseMs: number,
): Promise<RetentionRunOwnership | null> {
  const { error: expireError } = await client.from("retention_runs")
    .update({ status: "failed", finished_at: now.toISOString(), error: "Run abandoned: its lease expired before it finished." })
    .eq("status", "running")
    .lt("lease_expires_at", now.toISOString());
  fail(expireError, "expire abandoned retention runs");

  const lockToken = randomUUID();
  const { data, error } = await client.from("retention_runs")
    .insert({
      trigger, status: "running", started_at: now.toISOString(),
      lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(),
      lock_token: lockToken,
    })
    .select("id")
    .single();
  if (error && (error as { code?: string }).code === UNIQUE_VIOLATION) return null;
  fail(error, "start retention run");
  return { runId: (data as { id: number }).id, lockToken };
}

export async function finishRetentionLock(
  client: SupabaseAdminClient,
  runId: number,
  lockToken: string,
  status: Exclude<RetentionStatus, "running">,
  finishedAt: Date,
  summary: Record<string, unknown>,
  error: string | null,
): Promise<boolean> {
  const { data, error: updateError } = await client.from("retention_runs")
    .update({ status, finished_at: finishedAt.toISOString(), summary, error })
    .eq("id", runId)
    .eq("lock_token", lockToken)
    .eq("status", "running")
    .select("id");
  fail(updateError, "finish retention run");
  return (data ?? []).length > 0;
}

/** Finished timestamp of the most recent successful (or partially successful) run, for a due-check. */
export async function lastSuccessfulRetentionRun(client: SupabaseAdminClient): Promise<string | null> {
  const { data, error } = await client.from("retention_runs")
    .select("finished_at")
    .in("status", ["succeeded", "partial"])
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  fail(error, "read last successful retention run");
  return (data as { finished_at?: string } | null)?.finished_at ?? null;
}
