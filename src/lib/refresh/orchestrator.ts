import { getDefiLlamaConfig } from "../providers/defillama.ts";
import { runCoinGeckoCollection } from "../providers/run-coingecko-collection.ts";
import { repairCoinGeckoDailyGaps } from "../providers/repair-coingecko-daily-gaps.ts";
import { repairDefiLlamaDailyGaps } from "../providers/repair-defillama-daily-gaps.ts";
import { runDefiLlamaCollection } from "../providers/run-defillama-collection.ts";
import { runDexScreenerCollection } from "../providers/run-dexscreener-collection.ts";
import { runDefiLlamaCoinsCollection } from "../providers/run-defillama-coins-collection.ts";
import { runMetricsCalculation } from "../metrics/run-calculation.ts";
import { getThrottleLevel } from "../monitoring/quota-tracker.ts";
import {
  DUE_TOLERANCE_MS,
  METRICS_TIMEOUT_MS,
  PROVIDER_STEPS,
  REFRESH_POLICY,
  RUN_LEASE_MS,
  type ProviderStep,
  type RefreshStep,
} from "./config.ts";
import type { RefreshStore, RefreshTrigger, RunStatus, StepRecord } from "./store.ts";
import { CollectorDiagnostics } from "./collector-diagnostics.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;
type Sleep = (durationMs: number) => Promise<void>;

/**
 * `diagnostics`, when a collector chooses to write to it, is diagnostic-only
 * stage timing (see collector-diagnostics.ts) that survives a timeout even
 * though the collector's own return value does not. Collectors that never
 * touch it (every provider except CoinGecko, for now) are unaffected.
 */
export type CollectorOptions = { fetchImpl: typeof fetch; sleep: Sleep; diagnostics: CollectorDiagnostics };
export type CollectorDefinition = {
  /** Returns a reason to skip (for example, an unmet permission gate), or null to run. */
  skipReason?: () => string | null;
  collect: (client: SupabaseAdminClient, options: CollectorOptions) => Promise<Record<string, unknown>>;
};

export const defaultCollectors: Record<ProviderStep, CollectorDefinition> = {
  coingecko: {
    collect: async (client, options) => {
      const collected = await runCoinGeckoCollection(client, options);
      // At "critical" quota throttle (see quota-tracker.ts) the CoinGecko gap repair does not stop: it
      // runs midnight-only, writing at most one point per metric per day (about 3 rows per affected
      // token, well under 1 MB in total). Skipping it entirely left real outages unrepaired for days,
      // and the technical indicators need an unbroken run of midnight samples. The CoinGecko requests
      // it makes do not count against Supabase egress. Other repairs below stay gated.
      const midnightOnly = (await getThrottleLevel(client)) === "critical";
      // Historical repair is deliberately best-effort: a repair failure must not turn an
      // otherwise successful live refresh into a provider failure. The next successful
      // CoinGecko refresh will retry the bounded repair.
      try {
        const repaired = await repairCoinGeckoDailyGaps(client, {
          fetchImpl: options.fetchImpl,
          sleep: options.sleep,
          midnightOnly,
        });
        return { ...collected, gapRepair: repaired, ...(midnightOnly ? { gapRepairMode: "midnight-only (quota throttle: critical)" } : {}) };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown CoinGecko gap-repair error.";
        return { ...collected, gapRepairError: message };
      }
    },
  },
  dexscreener: { collect: (client, options) => runDexScreenerCollection(client, options) },
  defillama: {
    // The written-permission gate is enforced, never bypassed: without it the step is skipped.
    skipReason: () => {
      try {
        getDefiLlamaConfig();
        return null;
      } catch (error) {
        return errorMessage(error);
      }
    },
    collect: async (client, options) => {
      const collected = await runDefiLlamaCollection(client, options);
      if (await getThrottleLevel(client) === "critical") {
        return { ...collected, gapRepairSkipped: "quota throttle: critical" };
      }
      // Historical repair is best-effort. A repair failure cannot turn a successful
      // live DeFiLlama refresh into a provider failure; the next successful run retries it.
      try {
        const repaired = await repairDefiLlamaDailyGaps(client, {
          fetchImpl: options.fetchImpl,
          sleep: options.sleep,
          scope: "protocol",
        });
        return { ...collected, gapRepair: repaired };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown DeFiLlama gap-repair error.";
        return { ...collected, gapRepairError: message };
      }
    },
  },
  defillama_coins: {
    // Token-level DeFiLlama prices use the same written-permission gate.
    skipReason: () => {
      try {
        getDefiLlamaConfig();
        return null;
      } catch (error) {
        return errorMessage(error);
      }
    },
    collect: async (client, options) => {
      const collected = await runDefiLlamaCoinsCollection(client, options);
      if (await getThrottleLevel(client) === "critical") {
        return { ...collected, gapRepairSkipped: "quota throttle: critical" };
      }
      try {
        const repaired = await repairDefiLlamaDailyGaps(client, {
          fetchImpl: options.fetchImpl,
          sleep: options.sleep,
          scope: "coins",
        });
        return { ...collected, gapRepair: repaired };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown DeFiLlama coins gap-repair error.";
        return { ...collected, gapRepairError: message };
      }
    },
  },
};

export class RefreshTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} exceeded its ${Math.round(timeoutMs / 1000)} s refresh budget.`);
    this.name = "RefreshTimeoutError";
  }
}

export type RefreshOptions = {
  trigger: RefreshTrigger;
  /** Collect providers even if they are not yet due. */
  force?: boolean;
  /** Restrict the run to these providers. */
  only?: ProviderStep[];
  now?: () => Date;
  collectors?: Partial<Record<ProviderStep, CollectorDefinition>>;
  calculateMetrics?: (client: SupabaseAdminClient) => Promise<Record<string, unknown>>;
  timeouts?: Partial<Record<RefreshStep, number>>;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
};

export type RefreshResult = {
  /**
   * "lost_ownership" is a TS-level-only outcome (never written to
   * data_refresh_runs.status, whose check constraint is unchanged): it means
   * this invocation's lease was reclaimed by another run partway through, so
   * it stopped starting new work and never finalized the row it no longer owns.
   */
  status: RunStatus | "busy" | "lost_ownership";
  runId: number | null;
  due: ProviderStep[];
  steps: StepRecord[];
};

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error.";
  // Collector errors are already sanitized (no URLs or keys); bound their size.
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

/** Wrap fetch so every request also aborts when the step deadline passes. */
export function deadlineFetch(deadline: AbortSignal, base: typeof fetch = fetch): typeof fetch {
  return (input, init = {}) => base(input, {
    ...init,
    signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
}

/** Wrap sleep so retry/pacing waits stop (and throw) once the step deadline passes. */
export function deadlineSleep(deadline: AbortSignal, base: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Sleep {
  return async (durationMs) => {
    if (deadline.aborted) throw deadline.reason;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(deadline.reason);
      deadline.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([base(durationMs), aborted]);
    } finally {
      deadline.removeEventListener("abort", onAbort!);
    }
  };
}

/** Hard ceiling for work that cannot be aborted (for example, database writes). */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RefreshTimeoutError(label, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Keep step detail small: arrays (missing IDs, unavailable metrics) are stored as counts. */
function summarize(result: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, Array.isArray(value) ? value.length : value]));
}

export function isProviderDue(step: ProviderStep, lastSuccessAt: string | undefined, now: Date): boolean {
  if (!lastSuccessAt) return true;
  return now.getTime() - Date.parse(lastSuccessAt) >= REFRESH_POLICY[step].intervalMs - DUE_TOLERANCE_MS;
}

export function overallStatus(steps: StepRecord[]): Exclude<RunStatus, "running"> {
  const providers = steps.filter((step) => step.step !== "metrics");
  const attempted = providers.filter((step) => step.status !== "skipped");
  const succeeded = attempted.filter((step) => step.status === "succeeded");
  const metrics = steps.find((step) => step.step === "metrics");
  if (attempted.length === 0) return "skipped";
  if (succeeded.length === 0) return "failed";
  if (succeeded.length === attempted.length && metrics?.status === "succeeded") return "succeeded";
  return "partial";
}

/**
 * Refresh every due provider, then recalculate metrics, recording each step.
 *
 * Providers are isolated: each runs with its own deadline, and a failure or
 * timeout leaves that provider's previously stored observations untouched
 * (collectors fetch and validate before writing, and history is append-only).
 */
export async function runDataRefresh(client: SupabaseAdminClient, store: RefreshStore, options: RefreshOptions): Promise<RefreshResult> {
  const now = options.now ?? (() => new Date());
  const collectors = { ...defaultCollectors, ...options.collectors };
  const calculateMetrics = options.calculateMetrics ?? ((db: SupabaseAdminClient) => runMetricsCalculation(db));
  const timeoutFor = (step: RefreshStep) => options.timeouts?.[step]
    ?? (step === "metrics" ? METRICS_TIMEOUT_MS : REFRESH_POLICY[step].timeoutMs);

  const ownership = await store.acquireRun(options.trigger, now(), RUN_LEASE_MS);
  if (ownership === null) return { status: "busy", runId: null, due: [], steps: [] };
  const { runId, lockToken } = ownership;

  const steps: StepRecord[] = [];
  const record = async (step: StepRecord) => {
    steps.push(step);
    await store.recordStep(runId, step);
  };

  try {
    const lastSuccess = await store.lastSuccessfulSteps();
    const candidates = PROVIDER_STEPS.filter((step) => !options.only || options.only.includes(step));
    const due = candidates.filter((step) => options.force || isProviderDue(step, lastSuccess[step], now()));

    // Providers run one at a time, in PROVIDER_STEPS order: each collector fetches
    // then persists internally (see persist-snapshots.ts), so running them
    // concurrently would mean up to four heavy Supabase writes landing on
    // PostgreSQL at once. Sequential execution means only one provider's
    // persistence is ever in flight, which is what actually reduces statement-
    // timeout (57014) pressure; provider correctness and independent rate
    // limits are unaffected; a provider's own collector still serializes and
    // paces its own HTTP requests exactly as before.
    for (const step of due) {
      // Heartbeat before each provider step, not just once after the whole loop: each
      // step's own timeout (REFRESH_POLICY[step].timeoutMs) is well under RUN_LEASE_MS,
      // so this keeps the lease alive through however many steps are due. Without it, a
      // step that stalls (a Postgres statement timeout, a slow upstream gateway) burns
      // wall-clock/CPU time with the lease never renewed, so the run just sits until some
      // LATER invocation's acquireRun sweep notices the expired lease and marks it
      // "Run abandoned" -- sometimes tens of minutes later. Bailing out here the moment
      // ownership is lost means this invocation stops immediately instead of continuing
      // to burn CPU on steps a newer run may already own.
      const stillOwnsBeforeStep = await store.renewLease(runId, lockToken, now(), RUN_LEASE_MS);
      if (!stillOwnsBeforeStep) {
        console.error(`[refresh] run ${runId} lost lease ownership before step "${step}"; stopping.`);
        return { status: "lost_ownership", runId, due, steps };
      }
      const startedAt = now().toISOString();
      const definition = collectors[step];
      const skipReason = definition.skipReason?.() ?? null;
      if (skipReason) {
        await record({ step, status: "skipped", startedAt, finishedAt: now().toISOString(), detail: {}, error: skipReason });
        continue;
      }
      const timeoutMs = timeoutFor(step);
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new RefreshTimeoutError(REFRESH_POLICY[step].label, timeoutMs)), timeoutMs);
      // Same instance is handed to the collector and read back below, so any
      // stage it records before an abort is still visible after the timeout.
      const diagnostics = new CollectorDiagnostics();
      try {
        const result = await withTimeout(
          definition.collect(client, {
            fetchImpl: deadlineFetch(deadline.signal, options.fetchImpl),
            sleep: deadlineSleep(deadline.signal, options.sleep),
            diagnostics,
          }),
          // Small grace period so an in-flight abort surfaces as the collector's own error first.
          timeoutMs + 5_000,
          REFRESH_POLICY[step].label,
        );
        await record({ step, status: "succeeded", startedAt, finishedAt: now().toISOString(), detail: summarize(result), error: null });
      } catch (error) {
        const timedOut = deadline.signal.aborted || error instanceof RefreshTimeoutError;
        // Only populated when the collector actually wrote to `diagnostics` (currently CoinGecko);
        // other providers' timeout/error detail is unchanged (still `{}`).
        const diagnosticsSnapshot = diagnostics.snapshot();
        const detail = Object.keys(diagnosticsSnapshot.stages).length > 0 ? { diagnostics: diagnosticsSnapshot } : {};
        await record({
          step,
          status: timedOut ? "timed_out" : "failed",
          startedAt,
          finishedAt: now().toISOString(),
          detail,
          error: timedOut ? new RefreshTimeoutError(REFRESH_POLICY[step].label, timeoutMs).message : errorMessage(error),
        });
      } finally {
        clearTimeout(timer);
      }
    }

    // Renewal boundary between the providers phase and metrics: a run that is
    // still genuinely in progress extends its own lease here so it is never
    // stolen mid-flight; a run whose lease already expired (the invocation was
    // killed and this call is somehow still executing, e.g. a slow network path
    // racing the platform's own termination) learns it no longer owns this run
    // and must not start metrics or finalize the row a newer run now owns.
    const stillOwnsAfterProviders = await store.renewLease(runId, lockToken, now(), RUN_LEASE_MS);
    if (!stillOwnsAfterProviders) {
      console.error(`[refresh] run ${runId} lost lease ownership after the providers phase; skipping metrics and finalization.`);
      return { status: "lost_ownership", runId, due, steps };
    }

    const refreshed = steps.filter((step) => step.status === "succeeded").map((step) => step.step);
    if (due.length > 0) {
      const startedAt = now().toISOString();
      if (refreshed.length === 0) {
        await record({
          step: "metrics", status: "skipped", startedAt, finishedAt: now().toISOString(), detail: {},
          error: "No provider refreshed successfully; previously calculated metrics are unchanged.",
        });
      } else {
        // Metrics read whatever is stored, so a failed provider contributes its last
        // successful observations and missing inputs stay unavailable, never zero.
        try {
          const result = await withTimeout(calculateMetrics(client), timeoutFor("metrics"), "Metrics calculation");
          await record({ step: "metrics", status: "succeeded", startedAt, finishedAt: now().toISOString(), detail: summarize(result), error: null });
        } catch (error) {
          await record({
            step: "metrics",
            status: error instanceof RefreshTimeoutError ? "timed_out" : "failed",
            startedAt,
            finishedAt: now().toISOString(),
            detail: {},
            error: errorMessage(error),
          });
        }
      }
    }

    const status = overallStatus(steps);
    const summary = {
      due,
      steps: Object.fromEntries(steps.map((step) => [step.step, step.status])),
    };
    const finalized = await store.finishRun(runId, lockToken, status, now(), summary, null);
    if (!finalized) {
      // Ownership was reclaimed between the providers phase and here (a slow
      // finalization racing an expiring lease). The steps recorded above are
      // already committed and untouched; only this run's own status row is not
      // ours to set anymore, so report that explicitly rather than claiming a
      // status this invocation was not actually allowed to record.
      console.error(`[refresh] run ${runId} lost lease ownership before finalization; its steps are recorded but its status was not.`);
      return { status: "lost_ownership", runId, due, steps };
    }
    return { status, runId, due, steps };
  } catch (error) {
    // Status bookkeeping failed; release the lock and surface the error.
    // Ownership may already be lost here too; that failure is intentionally
    // swallowed (the invocation cannot do anything more useful with it) rather
    // than masking the original error being re-thrown below.
    await store.finishRun(runId, lockToken, "failed", now(), { steps: Object.fromEntries(steps.map((step) => [step.step, step.status])) }, errorMessage(error))
      .catch(() => undefined);
    throw error;
  }
}
