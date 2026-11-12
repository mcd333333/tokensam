import { FRESHNESS_PROVIDERS, REFRESH_POLICY, type FreshnessProvider, type RefreshStep } from "./config.ts";

export type FreshnessState = "current" | "stale" | "unavailable";

export type ProviderFreshness = {
  id: FreshnessProvider;
  label: string;
  refreshedAt: string | null;
  ageLabel: string | null;
  state: FreshnessState;
};

export type RefreshStatusView = {
  providers: ProviderFreshness[];
  metricsCalculatedAt: string | null;
  latestRunStatus: string | null;
};

export function relativeAge(fromIso: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(fromIso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function newest(...values: (string | null | undefined)[]): string | null {
  return values.filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value as string)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

/**
 * Provider freshness uses each provider's own threshold (REFRESH_POLICY), not
 * a universal one. The refresh time is the newer of the last successful
 * automated refresh and the latest stored collection time, so manual
 * collector runs are reflected too.
 */
export function buildRefreshStatus(input: {
  lastSuccess: Partial<Record<RefreshStep, string>>;
  latestCollected: Partial<Record<FreshnessProvider, string>>;
  latestRunStatus: string | null;
  now: Date;
}): RefreshStatusView {
  const providers = FRESHNESS_PROVIDERS.map((id) => {
    const policy = REFRESH_POLICY[id];
    const refreshedAt = newest(input.lastSuccess[id as RefreshStep], input.latestCollected[id]);
    const state: FreshnessState = !refreshedAt
      ? "unavailable"
      : input.now.getTime() - Date.parse(refreshedAt) > policy.staleAfterMs ? "stale" : "current";
    return { id, label: policy.label, refreshedAt, ageLabel: refreshedAt ? relativeAge(refreshedAt, input.now) : null, state };
  });
  return { providers, metricsCalculatedAt: input.lastSuccess.metrics ?? null, latestRunStatus: input.latestRunStatus };
}

/** Freshness of one dataset for one token: its own latest collection, never a global refresh time. */
export type DatasetFreshness = {
  id: FreshnessProvider | "metrics";
  label: string;
  /** When the latest available observation (or calculation) for this token was stored. */
  collectedAt: string;
  /** Provider-reported time of that observation; null for calculations. */
  observedAt: string | null;
  ageLabel: string;
  /** Null when the application defines no freshness threshold (calculated metrics). */
  state: Exclude<FreshnessState, "unavailable"> | null;
};

type FreshnessRow = { provider_id: string; status: string; observed_at: string; collected_at: string };

/**
 * Per-token dataset freshness for the Token Profile. `rows` must already be
 * the latest row per token/provider/metric (backfilled history is collected
 * later but is older data, so it must not count). Only datasets with an
 * available observation for this token and listed in `relevant` are returned;
 * stale/current uses the provider's own REFRESH_POLICY threshold.
 */
export function buildDatasetFreshness(input: {
  rows: FreshnessRow[];
  relevant: FreshnessProvider[];
  calculatedAt: string | null;
  now: Date;
}): DatasetFreshness[] {
  const datasets: DatasetFreshness[] = [];
  for (const id of FRESHNESS_PROVIDERS) {
    if (!input.relevant.includes(id)) continue;
    const rows = input.rows.filter((row) => row.provider_id === id && row.status === "available");
    const collectedAt = newest(...rows.map((row) => row.collected_at));
    if (!collectedAt) continue;
    const stale = input.now.getTime() - Date.parse(collectedAt) > REFRESH_POLICY[id].staleAfterMs;
    datasets.push({
      id,
      label: REFRESH_POLICY[id].label,
      collectedAt,
      observedAt: newest(...rows.map((row) => row.observed_at)),
      ageLabel: relativeAge(collectedAt, input.now),
      state: stale ? "stale" : "current",
    });
  }
  if (input.calculatedAt && Number.isFinite(Date.parse(input.calculatedAt))) {
    datasets.push({
      id: "metrics", label: "Calculated metrics", collectedAt: input.calculatedAt, observedAt: null,
      ageLabel: relativeAge(input.calculatedAt, input.now), state: null,
    });
  }
  return datasets;
}
