/**
 * A small, dedicated lease-based lock for GeckoTerminal collection, mirroring
 * the proven pattern in `src/lib/refresh/store.ts` (`data_refresh_runs`): a
 * single "running" row (enforced by a partial unique index), with an
 * expiring lease so a crashed run releases itself automatically.
 *
 * GeckoTerminal deliberately does NOT share `data_refresh_runs`/
 * `data_refresh_steps`: those are typed to the automated hourly
 * `ProviderStep` set (see refresh/config.ts), and forcing GeckoTerminal's very
 * different cadence (daily, longer-running, tolerant of partial failure) into
 * that shape would mean widening the same `ProviderStep`/step-check
 * constraint the GeckoTerminal integration deliberately left untouched. This
 * lock protects both entry points — a scheduled run and a manual
 * `pnpm geckoterminal:sync` — from ever executing concurrently.
 */

import { randomUUID } from "node:crypto";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

export type GeckoTerminalSyncTrigger = "scheduled" | "manual";
export type GeckoTerminalSyncStatus = "running" | "succeeded" | "partial" | "failed";
export type GeckoTerminalRunOwnership = { runId: number; lockToken: string };

const UNIQUE_VIOLATION = "23505";
// PostgREST reports a missing relation as PGRST205 (schema cache) or 42P01 (Postgres).
const MISSING_RELATION_CODES = new Set(["PGRST205", "42P01"]);

function fail(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`Supabase ${action} failed: ${error.message}`);
}

export async function geckoTerminalSyncLockTableExists(client: SupabaseAdminClient): Promise<boolean> {
  const { error } = await client.from("geckoterminal_sync_runs").select("id").limit(0);
  return !error || !MISSING_RELATION_CODES.has((error as { code?: string }).code ?? "");
}

/** Acquires the single GeckoTerminal sync lock, or returns null when another run already holds it. */
export async function acquireGeckoTerminalSyncLock(
  client: SupabaseAdminClient,
  trigger: GeckoTerminalSyncTrigger,
  now: Date,
  leaseMs: number,
): Promise<GeckoTerminalRunOwnership | null> {
  const lockToken = randomUUID();
  const insertRun = () => client.from("geckoterminal_sync_runs")
    .insert({
      trigger, status: "running", started_at: now.toISOString(),
      lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(),
      heartbeat_at: now.toISOString(), lock_token: lockToken,
    })
    .select("id")
    .single();
  let { data, error } = await insertRun();
  // The partial unique index permits a single 'running' row: a conflict means another run holds the lock, or that a
  // run crashed, was killed mid-flight or stopped heartbeating (see renewGeckoTerminalSyncLock) and left its row behind.
  // Only then release the expired lock (its row is preserved as an auditable "abandoned" record, never deleted) and retry
  // once. Sweeping on every acquire cost an extra API call per slice for a case that is almost never true.
  if (error && (error as { code?: string }).code === UNIQUE_VIOLATION) {
    const { error: expireError } = await client.from("geckoterminal_sync_runs")
      .update({ status: "failed", finished_at: now.toISOString(), error: "Run abandoned: its lease expired before it finished." })
      .eq("status", "running")
      .lt("lease_expires_at", now.toISOString());
    fail(expireError, "expire abandoned GeckoTerminal sync runs");
    ({ data, error } = await insertRun());
  }
  if (error && (error as { code?: string }).code === UNIQUE_VIOLATION) return null;
  fail(error, "start GeckoTerminal sync run");
  return { runId: (data as { id: number }).id, lockToken };
}

/**
 * Extends the lease, but only while `lockToken` still matches the row's
 * current token and it is still 'running'. Returns false the moment another
 * invocation has already reclaimed this run; the caller must stop starting
 * new token work and must not finalize the row it no longer owns.
 */
export async function renewGeckoTerminalSyncLock(
  client: SupabaseAdminClient,
  runId: number,
  lockToken: string,
  now: Date,
  leaseMs: number,
): Promise<boolean> {
  const { data, error } = await client.from("geckoterminal_sync_runs")
    .update({ lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(), heartbeat_at: now.toISOString() })
    .eq("id", runId)
    .eq("lock_token", lockToken)
    .eq("status", "running")
    .select("id");
  fail(error, "renew GeckoTerminal sync lease");
  return (data ?? []).length > 0;
}

export async function finishGeckoTerminalSyncLock(
  client: SupabaseAdminClient,
  runId: number,
  lockToken: string,
  status: Exclude<GeckoTerminalSyncStatus, "running">,
  finishedAt: Date,
  summary: Record<string, unknown>,
  error: string | null,
): Promise<boolean> {
  const { data, error: updateError } = await client.from("geckoterminal_sync_runs")
    .update({ status, finished_at: finishedAt.toISOString(), summary, error })
    .eq("id", runId)
    .eq("lock_token", lockToken)
    .eq("status", "running")
    .select("id");
  fail(updateError, "finish GeckoTerminal sync run");
  return (data ?? []).length > 0;
}

/** Finished timestamp of the most recent successful (or partially successful) run, for a due-check. */
export async function lastSuccessfulGeckoTerminalSync(client: SupabaseAdminClient): Promise<string | null> {
  const { data, error } = await client.from("geckoterminal_sync_runs")
    .select("finished_at")
    .in("status", ["succeeded", "partial"])
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  fail(error, "read last successful GeckoTerminal sync");
  return (data as { finished_at?: string } | null)?.finished_at ?? null;
}

/**
 * Where the next scheduled collection should resume the token rotation (see
 * `fetchGeckoTerminalSnapshotsTolerant`'s `startTokenId`/`nextTokenId`).
 * Reuses this same lock table rather than a dedicated cursor table: each run's
 * `summary.nextTokenId` (written by the caller via `finishGeckoTerminalSyncLock`)
 * already records exactly where the *next* run should begin.
 *
 * Looks back through recent runs (any trigger or status) for the newest one
 * that actually recorded a `nextTokenId` — a manual sync or a run that failed
 * before making any progress writes no cursor, so its row is skipped rather
 * than resetting the rotation to the start. Returns null (start at index 0)
 * when no run has ever recorded one.
 */
export async function resolveGeckoTerminalStartTokenId(client: SupabaseAdminClient): Promise<string | null> {
  const { data, error } = await client.from("geckoterminal_sync_runs")
    .select("summary")
    .order("id", { ascending: false })
    .limit(20);
  fail(error, "read GeckoTerminal sync cursor");
  for (const row of (data ?? []) as { summary?: { nextTokenId?: unknown } | null }[]) {
    const nextTokenId = row.summary?.nextTokenId;
    if (typeof nextTokenId === "string" && nextTokenId.length > 0) return nextTokenId;
  }
  return null;
}

/**
 * Runs `work` while holding the lock, releasing it on success or failure.
 * Throws immediately (before calling `work`) if another run already holds it.
 */
export async function withGeckoTerminalSyncLock<T>(
  client: SupabaseAdminClient,
  trigger: GeckoTerminalSyncTrigger,
  leaseMs: number,
  work: () => Promise<T>,
): Promise<T> {
  const ownership = await acquireGeckoTerminalSyncLock(client, trigger, new Date(), leaseMs);
  if (ownership === null) {
    throw new Error("A GeckoTerminal collection is already running (scheduled or manual); try again once it finishes.");
  }
  const { runId, lockToken } = ownership;
  try {
    const result = await work();
    await finishGeckoTerminalSyncLock(client, runId, lockToken, "succeeded", new Date(), {}, null);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    await finishGeckoTerminalSyncLock(client, runId, lockToken, "failed", new Date(), {}, message).catch(() => undefined);
    throw error;
  }
}
