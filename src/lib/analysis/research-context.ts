import { createHash } from "node:crypto";

import { canonicalTokens } from "../../data/canonical-tokens.ts";
import { coingeckoTokenIds } from "../../data/coingecko-token-mappings.ts";
import { defillamaProtocolMappings } from "../../data/defillama-protocol-mappings.ts";
import { dexScreenerTokenMappings } from "../../data/dexscreener-token-mappings.ts";
import { readLatestObservations, readObservationWindow } from "../data/observation-reads.ts";
import { PROVIDER_STEPS, REFRESH_POLICY, type ProviderStep, type RefreshStep } from "../refresh/config.ts";
import { SupabaseRefreshStore, type StepStatus } from "../refresh/store.ts";
import { calculatedMetricPeriod, formatDuration, observationWindow, type MetricPeriod, type ObservationWindow } from "./metric-periods.ts";
import { periodCoverage } from "../data/historical-series.ts";
import type { HistoricalPeriodCoverage } from "../../types/historical-data.ts";

type SupabaseAdminClient = ReturnType<typeof import("../supabase/admin").createSupabaseAdminClient>;

/** v3: explicit economic scope on every evidence item (token / protocol / chain / market / calculated). */
export const CONTEXT_VERSION = "3";

export type EvidenceScope = "token" | "protocol" | "chain" | "market";
const PROVIDER_SCOPE: Record<string, EvidenceScope> = { coingecko: "token", binance: "market", defillama_coins: "token", defillama: "protocol", dexscreener: "market" };
/** Requested windows reported to the model (all fit inside CONTEXT_HISTORY_DAYS). */
const CONTEXT_COVERAGE_PERIODS = ["24H", "7D", "14D"] as const;
/** History supplied to the model: one point per UTC day for this many days. */
export const CONTEXT_HISTORY_DAYS = 30;
const HOUR_MS = 60 * 60 * 1000;
const PROVIDER_LABEL: Record<ProviderStep, string> = { coingecko: "CoinGecko", defillama: "DeFiLlama", dexscreener: "DEX Screener", defillama_coins: "DeFiLlama (token prices)" };
const HISTORY_SERIES = [
  { providerId: "coingecko", metricId: "price_usd" },
  { providerId: "coingecko", metricId: "market_cap_usd" },
  { providerId: "coingecko", metricId: "volume_24h_usd" },
  { providerId: "coingecko", metricId: "circulating_supply" },
  { providerId: "defillama", metricId: "tvl_usd" },
  { providerId: "defillama", metricId: "fees_24h_usd" },
  { providerId: "defillama", metricId: "revenue_24h_usd" },
];

// ---- Input rows (as read from Supabase) ----

export type ContextObservationRow = {
  id: number;
  token_id: string;
  chain_id: string;
  metric_id: string;
  provider_id: string;
  value: number | string | null;
  status: string;
  observed_at: string;
  collected_at: string;
  window_days?: number | null;
  note: string | null;
  scope?: string | null;
};

export type ContextCalculatedRow = {
  id: number;
  metric_id: string;
  metric_name: string;
  unit: string;
  value: number | string | null;
  status: string;
  formula: string;
  calculated_at: string;
  period_start_at: string | null;
  period_end_at: string | null;
  source_observation_ids: number[] | null;
  provenance: { unavailable_reason?: string | null } | null;
};

export type ContextInput = {
  now: Date;
  token: {
    id: string; name: string; symbol: string; chainId: string; chainName: string;
    contractAddress: string | null; isNative: boolean; category: string; description: string | null;
  };
  latestObservations: ContextObservationRow[];
  history: ContextObservationRow[];
  metricDefinitions: { id: string; name: string; description: string; unit: string }[];
  calculated: ContextCalculatedRow[];
  calculatedCategories: Record<string, string>;
  /** Source scopes per calculated metric (from calculated_metric_definitions.source_scopes). */
  calculatedSourceScopes?: Record<string, string>;
  lastSuccess: Partial<Record<RefreshStep, string>>;
  latestAttempts: Partial<Record<RefreshStep, { status: StepStatus; finishedAt: string }>>;
};

// ---- Context sent to the model ----

export type ContextObservation = {
  id: string;
  provider: string;
  scope: EvidenceScope;
  scopeNote: string;
  metric: string;
  name: string;
  unit: string;
  value: number | null;
  status: string;
  observedAt: string;
  collectedAt: string;
  window: ObservationWindow;
  note: string | null;
};

export type ContextCalculatedMetric = {
  id: string;
  scope: "calculated";
  /** Scopes of the inputs, e.g. "token/protocol"; a mixed-scope ratio relates different objects. */
  sourceScopes: string | null;
  metricId: string;
  name: string;
  category: string;
  unit: string;
  value: number | null;
  status: string;
  formula: string;
  calculatedAt: string;
  period: MetricPeriod;
  unavailableReason: string | null;
  sourceObservationIds: string[];
};

export type ContextHistorySeries = {
  id: string;
  provider: string;
  scope: EvidenceScope;
  scopeNote: string;
  metric: string;
  unit: string;
  sampling: string;
  points: { at: string; value: number; sourceId: string }[];
  /** Actual coverage of each requested window, from all stored observations (not the daily sample). */
  coverage: Record<(typeof CONTEXT_COVERAGE_PERIODS)[number], Omit<HistoricalPeriodCoverage, "fullCoverage"> & { coversRequestedWindow: boolean }>;
  summary: {
    firstAt: string; firstValue: number; lastAt: string; lastValue: number;
    span: string; changePct: number | null; label: string;
  } | null;
};

export type ContextFreshness = {
  id: string;
  provider: string;
  state: "current" | "stale" | "unavailable";
  tokenDataCollectedAt: string | null;
  tokenDataAge: string | null;
  staleAfter: string;
  lastSuccessfulRefreshAt: string | null;
  latestRefreshAttempt: { status: StepStatus; finishedAt: string } | null;
  note: string;
};

export type ResearchContext = {
  contextVersion: string;
  builtAt: string;
  contextAsOf: string | null;
  token: {
    id: string; name: string; symbol: string; chain: string; chainId: string; category: string;
    contractAddress: string | null; isNative: boolean; description: string | null;
  };
  scope: { id: string; provider: string; mapped: boolean; statement: string }[];
  providerFreshness: ContextFreshness[];
  observations: ContextObservation[];
  calculatedMetrics: ContextCalculatedMetric[];
  history: ContextHistorySeries[];
  unavailable: { sourceId: string | null; item: string; reason: string }[];
};

/** Provider-supplied text is data: strip control characters and bound its length. */
export function cleanText(value: string | null | undefined, max = 400): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function numeric(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : value;
}

export function isCanonicalTokenId(tokenId: unknown): tokenId is string {
  return typeof tokenId === "string" && canonicalTokens.some((token) => token.id === tokenId);
}

function scopeStatements(tokenId: string): ResearchContext["scope"] {
  const coingeckoId = coingeckoTokenIds[tokenId];
  const llama = defillamaProtocolMappings.find((mapping) => mapping.tokenId === tokenId);
  const dex = dexScreenerTokenMappings.find((mapping) => mapping.tokenId === tokenId);
  return [
    {
      id: "scope:coingecko", provider: "CoinGecko", mapped: Boolean(coingeckoId),
      statement: coingeckoId
        ? `Token-level market data as aggregated by CoinGecko across the markets it tracks (CoinGecko ID "${coingeckoId}").`
        : "No CoinGecko mapping; token market data is unavailable.",
    },
    {
      id: "scope:defillama", provider: "DeFiLlama", mapped: Boolean(llama),
      statement: llama
        ? `PROTOCOL-LEVEL data for the DeFiLlama protocol record "${llama.externalAssetId}" (${cleanText(llama.relationship, 300)}). TVL, fees, and revenue describe the protocol, not activity generated by the token itself, and are not a valuation of the token.`
        : "No curated DeFiLlama protocol mapping exists for this token, so TVL, fees, and revenue are unavailable by design. This is a coverage limitation, not evidence of zero protocol activity.",
    },
    {
      id: "scope:defillama_coins", provider: "DeFiLlama (token prices)", mapped: true,
      statement: "TOKEN-LEVEL price for this exact token from DeFiLlama's coins API, keyed by a documented identifier (chain:address for contracts, coingecko:<id> otherwise; the latter may be sourced from CoinGecko). It is separate from DeFiLlama protocol data.",
    },
    {
      id: "scope:dexscreener", provider: "DEX Screener", mapped: Boolean(dex?.tokenAddress),
      statement: dex?.tokenAddress
        ? `DEX-only data from pairs matching the exact token address on ${dex.dexChainId}. It excludes centralized exchanges and other chains, so it is not the token's whole market.`
        : `No verified DEX Screener address mapping${dex?.unmappedReason ? ` (${cleanText(dex.unmappedReason, 200)})` : ""}; DEX metrics are unavailable by design.`,
    },
  ];
}

function scopeFor(provider: string): string {
  if (provider === "defillama") return "protocol-level (see scope:defillama)";
  if (provider === "defillama_coins") return "token-level DeFiLlama coins-API price (see scope:defillama_coins)";
  if (provider === "dexscreener") return "DEX pairs for the exact token address only (see scope:dexscreener)";
  return "token-level, CoinGecko aggregate (see scope:coingecko)";
}

/** Last stored observation per UTC day, capped to the history window. */
function dailySample(rows: ContextObservationRow[]): ContextObservationRow[] {
  const byDay = new Map<string, ContextObservationRow>();
  for (const row of [...rows].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at) || a.id - b.id)) {
    byDay.set(iso(row.observed_at).slice(0, 10), row);
  }
  return [...byDay.values()];
}

function freshness(input: ContextInput): ContextFreshness[] {
  return PROVIDER_STEPS.map((provider) => {
    const policy = REFRESH_POLICY[provider];
    const label = PROVIDER_LABEL[provider];
    const collected = input.latestObservations
      .filter((row) => row.provider_id === provider)
      .map((row) => iso(row.collected_at)).sort().at(-1) ?? null;
    const ageHours = collected ? (input.now.getTime() - Date.parse(collected)) / HOUR_MS : null;
    const state: ContextFreshness["state"] = ageHours === null ? "unavailable" : ageHours * HOUR_MS > policy.staleAfterMs ? "stale" : "current";
    const attempt = input.latestAttempts[provider] ?? null;
    const lastSuccess = input.lastSuccess[provider] ?? null;
    const attemptFailed = attempt && attempt.status !== "succeeded" && attempt.status !== "skipped"
      && (!lastSuccess || Date.parse(attempt.finishedAt) > Date.parse(lastSuccess));

    const notes: string[] = [];
    if (!collected) notes.push(`No ${label} observations are stored for this token.`);
    else notes.push(`${label} data for this token was last collected ${formatDuration(ageHours!)} before this context was built; it is ${state === "current" ? `within ${label}'s ${formatDuration(policy.staleAfterMs / HOUR_MS)} freshness window` : `older than ${label}'s ${formatDuration(policy.staleAfterMs / HOUR_MS)} freshness window (stale)`}.`);
    if (attemptFailed && collected) {
      notes.push(`The most recent ${label} refresh attempt (${attempt!.finishedAt}) ${attempt!.status === "timed_out" ? "timed out" : "failed"}, so the values in this context are the last successfully stored observations, not newly collected data. A failed collection is an operational issue, not evidence about the token.`);
    }
    if (attempt?.status === "skipped") notes.push(`The most recent ${label} refresh step was skipped (for example, a permission gate or no due work).`);
    return {
      id: `fresh:${provider}`,
      provider: label,
      state,
      tokenDataCollectedAt: collected,
      tokenDataAge: ageHours === null ? null : formatDuration(ageHours),
      staleAfter: formatDuration(policy.staleAfterMs / HOUR_MS),
      lastSuccessfulRefreshAt: lastSuccess ? iso(lastSuccess) : null,
      latestRefreshAttempt: attempt ? { status: attempt.status, finishedAt: iso(attempt.finishedAt) } : null,
      note: notes.join(" "),
    };
  });
}

/** Build the bounded, provenance-labelled research context for one token. */
export function buildResearchContext(input: ContextInput): ResearchContext {
  const definitions = new Map(input.metricDefinitions.map((definition) => [definition.id, definition]));
  const tokenRows = (rows: ContextObservationRow[]) => rows.filter((row) => row.token_id === input.token.id);

  const observations: ContextObservation[] = tokenRows(input.latestObservations)
    .sort((a, b) => a.provider_id.localeCompare(b.provider_id) || a.metric_id.localeCompare(b.metric_id))
    .map((row) => {
      const definition = definitions.get(row.metric_id);
      const observedAt = iso(row.observed_at);
      const value = row.status === "available" ? numeric(row.value) : null;
      return {
        id: `obs:${row.id}`,
        provider: PROVIDER_LABEL[row.provider_id as ProviderStep] ?? row.provider_id,
        scope: ((row.scope as EvidenceScope | null | undefined) ?? PROVIDER_SCOPE[row.provider_id] ?? "token"),
        scopeNote: scopeFor(row.provider_id),
        metric: row.metric_id,
        name: definition?.name ?? row.metric_id,
        unit: definition?.unit ?? "unknown",
        value,
        status: value === null ? "unavailable" : "available",
        observedAt,
        collectedAt: iso(row.collected_at),
        window: observationWindow({ windowDays: row.window_days ?? null, definitionName: definition?.name, definitionDescription: definition?.description, observedAt }),
        note: cleanText(row.note),
      };
    });

  const latestCalculated = new Map<string, ContextCalculatedRow>();
  for (const row of [...input.calculated].sort((a, b) => Date.parse(b.calculated_at) - Date.parse(a.calculated_at) || b.id - a.id)) {
    if (!latestCalculated.has(row.metric_id)) latestCalculated.set(row.metric_id, row);
  }
  const knownObservationIds = new Set(observations.map((observation) => observation.id));
  const calculatedMetrics: ContextCalculatedMetric[] = [...latestCalculated.values()]
    .filter((row) => input.calculatedCategories[row.metric_id])
    .sort((a, b) => a.metric_id.localeCompare(b.metric_id))
    .map((row) => {
      const category = input.calculatedCategories[row.metric_id];
      const value = row.status === "available" ? numeric(row.value) : null;
      return {
        id: `calc:${row.id}`,
        scope: "calculated" as const,
        sourceScopes: input.calculatedSourceScopes?.[row.metric_id] ?? null,
        metricId: row.metric_id,
        name: row.metric_name,
        category,
        unit: row.unit,
        value,
        status: value === null && row.status === "available" ? "unavailable" : row.status,
        formula: row.formula,
        calculatedAt: iso(row.calculated_at),
        period: calculatedMetricPeriod({ category, unit: row.unit, formula: row.formula, periodStartAt: row.period_start_at ? iso(row.period_start_at) : null, periodEndAt: row.period_end_at ? iso(row.period_end_at) : null }),
        unavailableReason: row.status === "available" ? null : cleanText(row.provenance?.unavailable_reason ?? null, 300),
        // Inputs are cited only when they are part of this context (older inputs are summarized by the period).
        sourceObservationIds: (row.source_observation_ids ?? []).map((id) => `obs:${id}`).filter((id) => knownObservationIds.has(id)),
      };
    });

  const history: ContextHistorySeries[] = HISTORY_SERIES.map(({ providerId, metricId }) => {
    const allRows = tokenRows(input.history).filter((row) => row.provider_id === providerId && row.metric_id === metricId && row.status === "available" && numeric(row.value) !== null);
    const fullResolution = [...allRows].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at) || a.id - b.id)
      .map((row) => ({ timestamp: iso(row.observed_at), valueUsd: numeric(row.value) as number, sourceId: `obs:${row.id}` }));
    const coverage = Object.fromEntries(CONTEXT_COVERAGE_PERIODS.map((period) => {
      const { fullCoverage, ...rest } = periodCoverage(fullResolution, period, input.now);
      return [period, { ...rest, coversRequestedWindow: fullCoverage }];
    })) as ContextHistorySeries["coverage"];
    const rows = dailySample(allRows);
    const points = rows.map((row) => ({ at: iso(row.observed_at), value: numeric(row.value) as number, sourceId: `obs:${row.id}` }));
    const first = points[0];
    const last = points.at(-1);
    const spanHours = first && last ? (Date.parse(last.at) - Date.parse(first.at)) / HOUR_MS : 0;
    const changePct = first && last && points.length >= 2 && first.value > 0 ? Math.round(((last.value / first.value) - 1) * 10000) / 100 : null;
    return {
      id: `hist:${providerId}:${metricId}`,
      provider: PROVIDER_LABEL[providerId as ProviderStep],
      scope: PROVIDER_SCOPE[providerId] ?? "token",
      scopeNote: scopeFor(providerId),
      metric: metricId,
      unit: definitions.get(metricId)?.unit ?? "unknown",
      sampling: `Last stored observation of each UTC day within the ${CONTEXT_HISTORY_DAYS} days before this context; days without stored data are absent (no interpolation).`,
      points,
      coverage,
      summary: first && last && points.length >= 2 ? {
        firstAt: first.at, firstValue: first.value, lastAt: last.at, lastValue: last.value,
        span: formatDuration(spanHours),
        changePct,
        label: `Change from the first to the last stored daily point: ${first.at} to ${last.at} (${formatDuration(spanHours)}, ${points.length} points). This spans exactly these timestamps, not a named period.`,
      } : null,
    };
  });

  const unavailable: ResearchContext["unavailable"] = [
    ...observations.filter((observation) => observation.status !== "available")
      .map((observation) => ({ sourceId: observation.id, item: `${observation.provider} ${observation.name}`, reason: observation.note ?? "Provider returned no numeric value." })),
    ...calculatedMetrics.filter((metric) => metric.status !== "available")
      .map((metric) => ({ sourceId: metric.id, item: `Calculated: ${metric.name}`, reason: metric.unavailableReason ?? (metric.status === "invalid" ? "Invalid inputs." : "Required inputs unavailable.") })),
    ...history.filter((series) => series.points.length < 2)
      .map((series) => ({ sourceId: series.id, item: `${series.provider} ${series.metric} history`, reason: series.points.length === 0 ? "No stored observations in the history window." : "Only one stored daily point; no trend can be derived." })),
  ];

  const times = [
    ...observations.map((observation) => observation.collectedAt),
    ...calculatedMetrics.map((metric) => metric.calculatedAt),
  ].filter((value) => Number.isFinite(Date.parse(value))).sort();

  return {
    contextVersion: CONTEXT_VERSION,
    builtAt: input.now.toISOString(),
    contextAsOf: times.at(-1) ?? null,
    token: {
      id: input.token.id,
      name: cleanText(input.token.name, 120) ?? input.token.id,
      symbol: cleanText(input.token.symbol, 20) ?? "",
      chain: input.token.chainName,
      chainId: input.token.chainId,
      category: input.token.category,
      contractAddress: input.token.contractAddress,
      isNative: input.token.isNative,
      description: cleanText(input.token.description, 400),
    },
    scope: scopeStatements(input.token.id),
    providerFreshness: freshness(input),
    observations,
    calculatedMetrics,
    history,
    unavailable,
  };
}

/** Every identifier the model may cite. */
export function contextSourceIds(context: ResearchContext): Set<string> {
  return new Set([
    "token",
    ...context.scope.map((item) => item.id),
    ...context.providerFreshness.map((item) => item.id),
    ...context.observations.map((item) => item.id),
    ...context.calculatedMetrics.map((item) => item.id),
    ...context.history.flatMap((series) => [series.id, ...series.points.map((point) => point.sourceId)]),
  ]);
}

/** Stable hash of the evidence (excluding build time), used to label stored analyses. */
export function contextHash(context: ResearchContext): string {
  // builtAt and age/note wording change with the clock, not with the evidence.
  const evidence = {
    ...context,
    builtAt: null,
    providerFreshness: context.providerFreshness.map((item) => ({ ...item, tokenDataAge: null, note: null })),
  };
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

function fail(error: { message: string } | null, action: string): void {
  if (error) throw new Error(`Supabase ${action} failed: ${error.message}`);
}

/**
 * Load the research context for one canonical token. The token ID must be in
 * the application's canonical universe; nothing outside that token's rows is read.
 */
export async function loadResearchContext(client: SupabaseAdminClient, tokenId: string, now = new Date()): Promise<ResearchContext | null> {
  if (!isCanonicalTokenId(tokenId)) return null;
  const { data: tokenRow, error: tokenError } = await client.from("tokens")
    .select("id,name,symbol,chain_id,contract_address,is_native,category,description").eq("id", tokenId).maybeSingle();
  fail(tokenError, "read token");
  if (!tokenRow) return null;
  const token = tokenRow as { id: string; name: string; symbol: string; chain_id: string; contract_address: string | null; is_native: boolean; category: string; description: string | null };

  const since = new Date(now.getTime() - CONTEXT_HISTORY_DAYS * 24 * HOUR_MS);
  const store = new SupabaseRefreshStore(client);
  const [chain, latest, history, metricDefinitions, calculated, calculatedDefinitions, lastSuccess, latestAttempts] = await Promise.all([
    client.from("chains").select("id,name").eq("id", token.chain_id).maybeSingle(),
    readLatestObservations<ContextObservationRow>(client, [tokenId]),
    readObservationWindow<ContextObservationRow>(client, [tokenId], HISTORY_SERIES, since),
    client.from("metric_definitions").select("id,name,description,unit"),
    client.from("calculated_metric_observations")
      .select("id,metric_id,metric_name,unit,value,status,formula,calculated_at,period_start_at,period_end_at,source_observation_ids,provenance")
      .eq("token_id", tokenId).order("calculated_at", { ascending: false }).order("id", { ascending: false }).range(0, 199),
    client.from("calculated_metric_definitions").select("id,category,source_scopes"),
    // Refresh status is supplementary: without it, freshness falls back to collection times.
    store.lastSuccessfulSteps().catch(() => ({})),
    store.latestAttempts().catch(() => ({})),
  ]);
  fail(chain.error, "read chain");
  fail(metricDefinitions.error, "read metric definitions");
  fail(calculated.error, "read calculated metrics");
  fail(calculatedDefinitions.error, "read calculated metric definitions");

  // window_days is not exposed by the latest-observation view; read it for these rows only.
  const windowDays = new Map<number, number | null>();
  const ids = latest.map((row) => row.id);
  if (ids.length > 0) {
    const { data, error } = await client.from("token_metric_observations").select("id,window_days").in("id", ids);
    fail(error, "read observation windows");
    for (const row of (data ?? []) as { id: number; window_days: number | null }[]) windowDays.set(row.id, row.window_days);
  }

  return buildResearchContext({
    now,
    token: {
      id: token.id, name: token.name, symbol: token.symbol, chainId: token.chain_id,
      chainName: (chain.data as { name: string } | null)?.name ?? token.chain_id,
      contractAddress: token.contract_address, isNative: token.is_native, category: token.category, description: token.description,
    },
    latestObservations: latest.map((row) => ({ ...row, window_days: windowDays.get(row.id) ?? null })),
    history,
    metricDefinitions: (metricDefinitions.data ?? []) as ContextInput["metricDefinitions"],
    calculated: (calculated.data ?? []) as ContextCalculatedRow[],
    calculatedCategories: Object.fromEntries(((calculatedDefinitions.data ?? []) as { id: string; category: string }[]).map((row) => [row.id, row.category])),
    calculatedSourceScopes: Object.fromEntries(((calculatedDefinitions.data ?? []) as { id: string; source_scopes: string | null }[]).flatMap((row) => row.source_scopes ? [[row.id, row.source_scopes]] : [])),
    lastSuccess,
    latestAttempts,
  });
}
