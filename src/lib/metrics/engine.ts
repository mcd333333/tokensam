import { createHash } from "node:crypto";
import { plausibleDexValue } from "../providers/dex-sanity.ts";

/** v2: source-scope enforcement and scope-explicit metric names (token-centric architecture). */
export const CALCULATION_VERSION = "7";

/**
 * The scope each provider input must have. A row with any other scope (for
 * example a DeFiLlama "chain" or "token" TVL) is never used as an input, so a
 * protocol metric cannot be fed chain data and token metrics cannot be fed
 * protocol data. Rows stored before scope existed (no scope) keep their
 * provider's historical scope.
 */
export const INPUT_SCOPES: Record<string, "token" | "protocol" | "market"> = {
  coingecko: "token",
  defillama: "protocol",
  dexpaprika: "market",
};

export function hasCompatibleScope(row: { provider_id: string; scope?: string | null }): boolean {
  const expected = INPUT_SCOPES[row.provider_id];
  return !expected || !row.scope || row.scope === expected;
}

export type ObservationInput = {
  id: number;
  token_id: string;
  chain_id: string;
  metric_id: string;
  provider_id: string;
  raw_record_id: number | null;
  value: number | string | null;
  status: string;
  observed_at: string;
  collected_at: string;
  source_field: string | null;
  note: string | null;
  scope?: string | null;
  /** Negative observation IDs are used by the metrics RPC for daily aggregate rows. */
  daily_aggregate_id?: number | null;
};

export type RawRecordInput = {
  id: number;
  provider_id: string;
  token_id: string | null;
  chain_id: string | null;
  collected_at: string;
  endpoint_label: string | null;
  payload: unknown;
};

export type TokenInput = { id: string; chain_id: string; name: string; symbol: string };

export type MetricDefinition = {
  id: string;
  name: string;
  category: "valuation" | "growth" | "market_structure" | "divergence";
  unit: "USD" | "ratio" | "percent" | "percentage_points" | "count" | "boolean";
  formula: string;
  /** Economic scopes of the inputs, e.g. "token/protocol" for market cap / associated protocol TVL. */
  sourceScopes: string;
};

export type CalculatedMetricRow = {
  token_id: string;
  chain_id: string;
  metric_id: string;
  metric_name: string;
  unit: MetricDefinition["unit"];
  value: number | null;
  status: "available" | "unavailable" | "invalid";
  formula: string;
  calculation_version: string;
  input_fingerprint: string;
  source_observation_ids: number[];
  source_raw_record_ids: number[];
  provenance: Record<string, unknown>;
  period_start_at: string | null;
  period_end_at: string | null;
  calculated_at: string;
};

export const CALCULATED_METRICS: MetricDefinition[] = [
  { id: "market_cap_to_tvl", name: "Market cap / associated protocol TVL", sourceScopes: "token/protocol", category: "valuation", unit: "ratio", formula: "CoinGecko market_cap_usd / DeFiLlama protocol tvl_usd" },
  { id: "fdv_to_tvl", name: "FDV / associated protocol TVL", sourceScopes: "token/protocol", category: "valuation", unit: "ratio", formula: "CoinGecko-reported fully_diluted_valuation / DeFiLlama protocol tvl_usd" },
  { id: "market_cap_to_revenue_24h", name: "Market cap / associated protocol 24h revenue", sourceScopes: "token/protocol", category: "valuation", unit: "ratio", formula: "CoinGecko market_cap_usd / DeFiLlama revenue_24h_usd" },
  { id: "fdv_to_revenue_24h", name: "FDV / associated protocol 24h revenue", sourceScopes: "token/protocol", category: "valuation", unit: "ratio", formula: "CoinGecko-reported fully_diluted_valuation / DeFiLlama revenue_24h_usd" },
  { id: "volume_to_market_cap", name: "Volume / market cap", sourceScopes: "token", category: "valuation", unit: "ratio", formula: "CoinGecko volume_24h_usd / CoinGecko market_cap_usd" },
  { id: "tvl_growth_pct", name: "Associated protocol TVL growth", sourceScopes: "protocol", category: "growth", unit: "percent", formula: "24h-normalized change: ((latest DeFiLlama tvl_usd / nearest available value around 24h earlier) ^ (24 / measured_hours) - 1) * 100; baseline tolerance ±6h" },
  { id: "revenue_growth_pct", name: "Associated protocol revenue growth", sourceScopes: "protocol", category: "growth", unit: "percent", formula: "24h-normalized change from the latest individual DeFiLlama revenue_24h_usd observation and the closest prior individual observation within ±6h of 24h earlier; daily aggregates are excluded" },
  { id: "fees_growth_pct", name: "Associated protocol fees growth", sourceScopes: "protocol", category: "growth", unit: "percent", formula: "24h-normalized change: ((latest DeFiLlama fees_24h_usd / nearest available value around 24h earlier) ^ (24 / measured_hours) - 1) * 100; baseline tolerance ±6h" },
  { id: "price_growth_pct", name: "Price growth", sourceScopes: "token", category: "growth", unit: "percent", formula: "(latest CoinGecko price_usd / previous CoinGecko price_usd - 1) * 100" },
  { id: "market_cap_growth_pct", name: "Market cap growth", sourceScopes: "token", category: "growth", unit: "percent", formula: "(latest CoinGecko market_cap_usd / previous CoinGecko market_cap_usd - 1) * 100" },
  { id: "price_change_vs_tvl_growth_pct_points", name: "Price change vs associated protocol TVL growth", sourceScopes: "token/protocol", category: "growth", unit: "percentage_points", formula: "price 24h-normalized percent change - TVL 24h-normalized percent change; changes are compounded from latest observations within ±6h of 24h apart" },
  { id: "price_change_vs_revenue_growth_pct_points", name: "Price change vs associated protocol revenue growth", sourceScopes: "token/protocol", category: "growth", unit: "percentage_points", formula: "price 24h-normalized percent change - revenue 24h-normalized percent change; revenue uses the latest individual DeFiLlama observation and closest prior individual observation within ±6h of 24h earlier" },
  { id: "market_cap_change_vs_tvl_growth_pct_points", name: "Market-cap change vs associated protocol TVL growth", sourceScopes: "token/protocol", category: "growth", unit: "percentage_points", formula: "market-cap 24h-normalized percent change - TVL 24h-normalized percent change; changes are compounded from latest observations within ±6h of 24h apart" },
  { id: "market_cap_change_vs_revenue_growth_pct_points", name: "Market-cap change vs associated protocol revenue growth", sourceScopes: "token/protocol", category: "growth", unit: "percentage_points", formula: "market-cap 24h-normalized percent change - revenue 24h-normalized percent change; revenue uses the latest individual DeFiLlama observation and closest prior individual observation within ±6h of 24h earlier" },
  { id: "dex_aggregate_volume_24h_usd", name: "Aggregate DEX volume (24h)", sourceScopes: "market", category: "market_structure", unit: "USD", formula: "DexPaprika token-wide 24h volume across all of the token's pools" },
  { id: "dex_aggregate_liquidity_usd", name: "Aggregate DEX liquidity", sourceScopes: "market", category: "market_structure", unit: "USD", formula: "DexPaprika token-wide liquidity across all of the token's pools" },
  { id: "dex_primary_pair_liquidity_usd", name: "Primary-pair liquidity", sourceScopes: "market", category: "market_structure", unit: "USD", formula: "liquidity of the most liquid stored DexPaprika pool" },
  { id: "dex_primary_pair_volume_24h_usd", name: "Primary-pair volume (24h)", sourceScopes: "market", category: "market_structure", unit: "USD", formula: "24h volume of the most liquid stored DexPaprika pool" },
  { id: "dex_liquidity_to_market_cap_pct", name: "Primary-pair liquidity / market cap", sourceScopes: "market/token", category: "market_structure", unit: "percent", formula: "primary-pair liquidity / CoinGecko market_cap_usd * 100" },
  { id: "dex_aggregate_liquidity_to_market_cap_pct", name: "Aggregate DEX liquidity / market cap", sourceScopes: "market/token", category: "market_structure", unit: "percent", formula: "aggregate DEX liquidity / CoinGecko market_cap_usd * 100" },
  { id: "dex_volume_to_liquidity", name: "DEX volume / liquidity", sourceScopes: "market", category: "market_structure", unit: "ratio", formula: "DexPaprika token-wide 24h volume / token-wide liquidity" },
  { id: "dex_buy_sell_ratio", name: "DEX buy / sell transaction ratio", sourceScopes: "market", category: "market_structure", unit: "ratio", formula: "DexPaprika buys_24h_count / sells_24h_count" },
  { id: "divergence_price_up_tvl_down", name: "Price up, associated protocol TVL down", sourceScopes: "token/protocol", category: "divergence", unit: "boolean", formula: "24h-normalized price growth > 0 AND 24h-normalized TVL growth < 0" },
  { id: "divergence_price_down_tvl_up", name: "Price down, associated protocol TVL up", sourceScopes: "token/protocol", category: "divergence", unit: "boolean", formula: "24h-normalized price growth < 0 AND 24h-normalized TVL growth > 0" },
  { id: "divergence_market_cap_up_faster_tvl", name: "Market cap grew faster than associated protocol TVL", sourceScopes: "token/protocol", category: "divergence", unit: "boolean", formula: "24h-normalized market-cap growth > 24h-normalized TVL growth" },
  { id: "divergence_tvl_up_faster_market_cap", name: "Associated protocol TVL grew faster than market cap", sourceScopes: "token/protocol", category: "divergence", unit: "boolean", formula: "24h-normalized TVL growth > 24h-normalized market-cap growth" },
  { id: "divergence_revenue_up_market_cap_down", name: "Associated protocol revenue up, market cap down", sourceScopes: "token/protocol", category: "divergence", unit: "boolean", formula: "24h-normalized protocol revenue growth > 0 AND 24h-normalized market-cap growth < 0" },
  { id: "divergence_revenue_down_market_cap_up", name: "Associated protocol revenue down, market cap up", sourceScopes: "token/protocol", category: "divergence", unit: "boolean", formula: "24h-normalized protocol revenue growth < 0 AND 24h-normalized market-cap growth > 0" },
];

type SourceRef = Record<string, unknown> & { id: number; source_kind: "observation" | "daily_aggregate" | "raw_record"; raw_record_id?: number | null };
type Calculation = {
  value: number | null;
  status: CalculatedMetricRow["status"];
  sources: SourceRef[];
  rawRecords?: RawRecordInput[];
  reason?: string;
  startAt?: string | null;
  endAt?: string | null;
  details?: Record<string, unknown>;
};
type SeriesPoint = { observation: ObservationInput; value: number; time: number };

function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function observationRef(row: ObservationInput): SourceRef {
  const isDailyAggregate = row.source_field === "daily_average" || row.source_field === "daily_snapshot";
  const id = isDailyAggregate ? row.daily_aggregate_id ?? Math.abs(row.id) : row.id;
  return {
    id,
    source_kind: isDailyAggregate ? "daily_aggregate" : "observation",
    provider_id: row.provider_id,
    token_id: row.token_id,
    chain_id: row.chain_id,
    metric_id: row.metric_id,
    value: numeric(row.value),
    status: row.status,
    observed_at: row.observed_at,
    collected_at: row.collected_at,
    source_field: row.source_field,
    scope: row.scope ?? INPUT_SCOPES[row.provider_id] ?? null,
    note: row.note,
    raw_record_id: row.raw_record_id,
    ...(isDailyAggregate ? { daily_aggregate_id: id } : {}),
  };
}

function sourceRecord(record: RawRecordInput): Record<string, unknown> {
  return { id: record.id, provider_id: record.provider_id, collected_at: record.collected_at, endpoint_label: record.endpoint_label };
}

function compareLatest(a: ObservationInput, b: ObservationInput): number {
  return Date.parse(b.observed_at) - Date.parse(a.observed_at)
    || Date.parse(b.collected_at) - Date.parse(a.collected_at)
    || b.id - a.id;
}

function usable(row: ObservationInput | undefined): row is ObservationInput {
  return !!row && row.status === "available" && numeric(row.value) !== null;
}

function availableValue(row: ObservationInput | undefined): number | null {
  return usable(row) ? numeric(row.value) : null;
}

function ref(row: ObservationInput | undefined): SourceRef[] {
  return row ? [observationRef(row)] : [];
}

function chooseLatest(rows: ObservationInput[], provider: string, metric: string): ObservationInput | undefined {
  return rows.filter((row) => row.provider_id === provider && row.metric_id === metric).sort(compareLatest)[0];
}

function series(
  rows: ObservationInput[],
  provider: string,
  metric: string,
  options: { includeDailyAggregates?: boolean } = {},
): SeriesPoint[] {
  const includeDailyAggregates = options.includeDailyAggregates ?? true;
  const candidates = rows.filter((row) => row.provider_id === provider
    && row.metric_id === metric
    && usable(row)
    && (includeDailyAggregates || (row.source_field !== "daily_average" && row.source_field !== "daily_snapshot")));
  const byTime = new Map<string, ObservationInput>();
  for (const row of candidates.sort(compareLatest)) {
    if (!byTime.has(new Date(row.observed_at).toISOString())) byTime.set(new Date(row.observed_at).toISOString(), row);
  }
  return [...byTime.values()]
    .map((observation) => ({ observation, value: numeric(observation.value) as number, time: Date.parse(observation.observed_at) }))
    .sort((a, b) => a.time - b.time);
}

function unavailable(reason: string, sources: SourceRef[] = [], rawRecords: RawRecordInput[] = []): Calculation {
  return { value: null, status: "unavailable", sources, rawRecords, reason };
}

function invalid(reason: string, sources: SourceRef[] = [], rawRecords: RawRecordInput[] = []): Calculation {
  return { value: null, status: "invalid", sources, rawRecords, reason };
}

function valid(value: number, sources: SourceRef[], options: Omit<Calculation, "value" | "status" | "sources"> = {}): Calculation {
  if (!Number.isFinite(value)) return invalid("The formula produced a non-finite result.", sources, options.rawRecords);
  return { value, status: "available", sources, ...options };
}

function ratio(numerator: ObservationInput | undefined, denominator: ObservationInput | undefined, numeratorLabel: string, denominatorLabel: string): Calculation {
  const sources = [...ref(numerator), ...ref(denominator)];
  const top = availableValue(numerator);
  const bottom = availableValue(denominator);
  if (top === null || bottom === null) return unavailable(`Required input unavailable: ${top === null ? numeratorLabel : denominatorLabel}.`, sources);
  if (top < 0 || bottom < 0) return invalid("Negative values are not valid inputs for this valuation ratio.", sources);
  if (bottom === 0) return unavailable(`Denominator is zero (${denominatorLabel}).`, sources);
  return valid(top / bottom, sources, { startAt: earlier(numerator?.observed_at, denominator?.observed_at), endAt: later(numerator?.observed_at, denominator?.observed_at) });
}

function earlier(a?: string, b?: string): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function later(a?: string, b?: string): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function growthCalculation(points: SeriesPoint[], label: string): Calculation {
  if (points.length < 2) return unavailable(`Insufficient history for ${label}; at least two distinct available observation times are required.`, points.map((point) => observationRef(point.observation)));
  const previous = points.at(-2) as SeriesPoint;
  const current = points.at(-1) as SeriesPoint;
  const sources = [observationRef(previous.observation), observationRef(current.observation)];
  if (previous.value < 0 || current.value < 0) return invalid(`${label} history includes a negative value.`, sources);
  if (previous.value === 0) return unavailable(`Previous ${label} value is zero, so percentage growth is undefined.`, sources);
  return valid(((current.value / previous.value) - 1) * 100, sources, { startAt: previous.observation.observed_at, endAt: current.observation.observed_at });
}

const FUNDAMENTAL_CHANGE_HORIZON_HOURS = 24;
const FUNDAMENTAL_CHANGE_TOLERANCE_HOURS = 6;

/**
 * Normalize protocol TVL, fees, and revenue changes to a 24-hour equivalent.
 * DeFiLlama collection times can drift and TVL may arrive several times a day,
 * so use the nearest available baseline within ±6h of the 24h target.
 */
function fundamentalGrowthCalculation(points: SeriesPoint[], label: string): Calculation {
  const current = points.at(-1);
  if (!current) return unavailable(`No available history for ${label}.`);
  const targetTime = current.time - FUNDAMENTAL_CHANGE_HORIZON_HOURS * 60 * 60 * 1000;
  const toleranceMs = FUNDAMENTAL_CHANGE_TOLERANCE_HOURS * 60 * 60 * 1000;
  const previous = nearestBefore(points.filter((point) => point.time < current.time), targetTime, toleranceMs);
  if (!previous) {
    return unavailable(`Insufficient history for ${label}; no observation is available within ±${FUNDAMENTAL_CHANGE_TOLERANCE_HOURS}h of 24h before the latest value.`, points.map((point) => observationRef(point.observation)));
  }
  const sources = [observationRef(previous.observation), observationRef(current.observation)];
  if (previous.value < 0 || current.value < 0) return invalid(`${label} history includes a negative value.`, sources);
  if (previous.value === 0) return unavailable(`Previous ${label} value is zero, so percentage change is undefined.`, sources);
  const measuredHours = (current.time - previous.time) / (60 * 60 * 1000);
  if (!(measuredHours > 0)) return unavailable(`A previous ${label} observation is not earlier than its current value.`, sources);
  const change = (Math.pow(current.value / previous.value, FUNDAMENTAL_CHANGE_HORIZON_HOURS / measuredHours) - 1) * 100;
  if (!Number.isFinite(change)) return invalid(`24h normalization produced a non-finite ${label} change.`, sources);
  return valid(change, sources, {
    startAt: new Date(current.time - FUNDAMENTAL_CHANGE_HORIZON_HOURS * 60 * 60 * 1000).toISOString(),
    endAt: current.observation.observed_at,
    details: {
      comparison_window: "24h normalized",
      normalization: "((current / previous) ^ (24 / measured_hours) - 1) * 100",
      measured_hours: measuredHours,
      baseline_tolerance_hours: FUNDAMENTAL_CHANGE_TOLERANCE_HOURS,
      observation_times: [previous.observation.observed_at, current.observation.observed_at],
    },
  });
}

type CrossChange = { a: number; b: number; sources: SourceRef[]; startAt: string; endAt: string; details: Record<string, unknown> };

const CROSS_CHANGE_HORIZON_HOURS = 24;
// Once-daily DeFiLlama values have collection-time drift, so accept the closest
// baseline within six hours and normalize the resulting change to a 24h rate.
const CROSS_CHANGE_TOLERANCE_HOURS = 6;

function nearestBefore(points: SeriesPoint[], targetTime: number, toleranceMs: number): SeriesPoint | undefined {
  return points
    .filter((point) => Math.abs(point.time - targetTime) <= toleranceMs)
    .sort((a, b) => Math.abs(a.time - targetTime) - Math.abs(b.time - targetTime))[0];
}

/**
 * Compute each series' compounded 24-hour-equivalent change from its latest value
 * and a point closest to 24 hours earlier (within ±6h). Normalize for the actual
 * elapsed time so collection-time drift does not create a misleading 29–34 hour
 * display window. Source timestamps and measured intervals remain in provenance.
 */
function alignedCrossChange(
  aPoints: SeriesPoint[],
  bPoints: SeriesPoint[],
  aName: string,
  bName: string,
  horizonHours = CROSS_CHANGE_HORIZON_HOURS,
  toleranceHours = CROSS_CHANGE_TOLERANCE_HOURS,
): CrossChange | Calculation {
  if (aPoints.length === 0 || bPoints.length === 0) return unavailable(`No ${aName}/${bName} observations available.`);
  const aEnd = aPoints.at(-1)!;
  const bEnd = bPoints.at(-1)!;
  const horizonMs = horizonHours * 60 * 60 * 1000;
  const toleranceMs = toleranceHours * 60 * 60 * 1000;
  const aPrior = nearestBefore(aPoints.filter((point) => point.time < aEnd.time), aEnd.time - horizonMs, toleranceMs);
  const bPrior = nearestBefore(bPoints.filter((point) => point.time < bEnd.time), bEnd.time - horizonMs, toleranceMs);
  if (!aPrior || !bPrior) return unavailable(`Insufficient ~${horizonHours}h-apart history for ${aName} and ${bName}.`);

  const sources = [aPrior, aEnd, bPrior, bEnd].map((point) => observationRef(point.observation));
  if ([aPrior.value, aEnd.value, bPrior.value, bEnd.value].some((value) => value < 0)) {
    return invalid("Aligned history includes a negative value.", sources);
  }
  if (aPrior.value === 0 || bPrior.value === 0) return unavailable("A previous aligned value is zero, so percentage change is undefined.", sources);
  const aElapsedHours = (aEnd.time - aPrior.time) / (60 * 60 * 1000);
  const bElapsedHours = (bEnd.time - bPrior.time) / (60 * 60 * 1000);
  if (aElapsedHours <= 0 || bElapsedHours <= 0) return unavailable("A previous observation is not earlier than its current value.", sources);
  const normalizeTo24h = (previous: number, current: number, elapsedHours: number) =>
    (Math.pow(current / previous, horizonHours / elapsedHours) - 1) * 100;
  const aChange = normalizeTo24h(aPrior.value, aEnd.value, aElapsedHours);
  const bChange = normalizeTo24h(bPrior.value, bEnd.value, bElapsedHours);
  if (!Number.isFinite(aChange) || !Number.isFinite(bChange)) return invalid("24h normalization produced a non-finite result.", sources);
  const endTime = Math.max(aEnd.time, bEnd.time);
  return {
    a: aChange,
    b: bChange,
    sources,
    startAt: new Date(endTime - horizonMs).toISOString(),
    endAt: new Date(endTime).toISOString(),
    details: {
      comparison_window: "24h normalized",
      normalization: "((current / previous) ^ (24 / measured_hours) - 1) * 100",
      first_series_measured_hours: aElapsedHours,
      second_series_measured_hours: bElapsedHours,
      first_series_observation_times: [aPrior.observation.observed_at, aEnd.observation.observed_at],
      second_series_observation_times: [bPrior.observation.observed_at, bEnd.observation.observed_at],
    },
  };
}

/** A stored DexPaprika pool, most liquid first (see token_dex_pools). */
export type DexPoolInput = { pairAddress: string; dexId?: string | null; liquidityUsd?: number | null; volume24hUsd?: number | null };
/**
 * Inputs that do not live in token_metric_observations: the stored pool list for each token (token_dex_pools,
 * written by the DexPaprika collector) and CoinGecko's reported fully diluted valuation (from its stored
 * /coins/markets payload).
 */
export type EngineExternalInputs = {
  pools?: Record<string, { poolsAt: string; pools: DexPoolInput[] }>;
  fdv?: Record<string, { value: number; collectedAt: string }>;
};

function numberField(value: unknown): number | null { return numeric(value); }

function divideValues(numerator: number | null, denominator: number | null, sources: SourceRef[], rawRecords: RawRecordInput[], multiplier = 1): Calculation {
  if (numerator === null || denominator === null) return unavailable("Required numeric source value is unavailable.", sources, rawRecords);
  if (numerator < 0 || denominator < 0) return invalid("Negative inputs are not valid for this ratio.", sources, rawRecords);
  if (denominator === 0) return unavailable("Denominator is zero.", sources, rawRecords);
  return valid((numerator / denominator) * multiplier, sources, { rawRecords });
}

function metricSource(rows: ObservationInput[], provider: string, metric: string): ObservationInput | undefined {
  return chooseLatest(rows, provider, metric);
}

function valueOf(row: ObservationInput | undefined): number | null { return availableValue(row); }

function divFlag(condition: boolean, sources: SourceRef[], startAt?: string, endAt?: string, details: Record<string, unknown> = {}): Calculation {
  return valid(condition ? 1 : 0, sources, { startAt, endAt, details: { ...details, interpretation: condition ? "observed" : "not_observed_for_comparable_period" } });
}

function hashInput(token: TokenInput, metricId: string, calc: Calculation): string {
  const input = {
    version: CALCULATION_VERSION,
    token: `${token.id}:${token.chain_id}`,
    metricId,
    sources: calc.sources.map((source) => ({ kind: source.source_kind, id: source.id, value: source.value, status: source.status })).sort((a, b) => a.kind.localeCompare(b.kind) || a.id - b.id),
    rawRecordIds: (calc.rawRecords ?? []).map((record) => record.id).sort((a, b) => a - b),
    result: calc.value,
    status: calc.status,
    reason: calc.reason ?? null,
    details: calc.details ?? null,
  };
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function buildCalculation(token: TokenInput, definition: MetricDefinition, calc: Calculation, calculatedAt: string): CalculatedMetricRow {
  const sourceIds = [...new Set(calc.sources.filter((source) => source.source_kind === "observation").map((source) => source.id))].sort((a, b) => a - b);
  const rawRecords = [...new Map((calc.rawRecords ?? []).map((record) => [record.id, record])).values()];
  const rawIds = rawRecords.map((record) => record.id).sort((a, b) => a - b);
  return {
    token_id: token.id,
    chain_id: token.chain_id,
    metric_id: definition.id,
    metric_name: definition.name,
    unit: definition.unit,
    value: calc.value,
    status: calc.status,
    formula: definition.formula,
    calculation_version: CALCULATION_VERSION,
    input_fingerprint: hashInput(token, definition.id, calc),
    source_observation_ids: sourceIds,
    source_raw_record_ids: [...new Set([...rawIds, ...calc.sources.filter((source) => source.source_kind === "observation" && typeof source.raw_record_id === "number").map((source) => source.raw_record_id as number)])].sort((a, b) => a - b),
    provenance: {
      metric_name: definition.name,
      unit: definition.unit,
      source_scopes: definition.sourceScopes,
      calculation_version: CALCULATION_VERSION,
      sources: calc.sources,
      raw_records: rawRecords.map(sourceRecord),
      unavailable_reason: calc.reason ?? null,
      calculation_details: calc.details ?? {},
    },
    period_start_at: calc.startAt ?? null,
    period_end_at: calc.endAt ?? null,
    calculated_at: calculatedAt,
  };
}

export function calculateTokenMetrics(
  token: TokenInput,
  observations: ObservationInput[],
  external: EngineExternalInputs,
  calculatedAt = new Date().toISOString(),
): CalculatedMetricRow[] {
  const tokenRows = observations.filter((row) => row.token_id === token.id && row.chain_id === token.chain_id && hasCompatibleScope(row));
  const cgMarketCap = metricSource(tokenRows, "coingecko", "market_cap_usd");
  const cgVolume = metricSource(tokenRows, "coingecko", "volume_24h_usd");
  const llamaTvl = metricSource(tokenRows, "defillama", "tvl_usd");
  const llamaRevenue = metricSource(tokenRows, "defillama", "revenue_24h_usd");
  const dexBuys = metricSource(tokenRows, "dexpaprika", "buys_24h_count");
  const dexSells = metricSource(tokenRows, "dexpaprika", "sells_24h_count");
  const poolList = external.pools?.[token.id] ?? null;
  const reportedFdv = external.fdv?.[token.id] ?? null;
  const fdvRef: SourceRef[] = reportedFdv
    ? [{ id: 0, source_kind: "raw_record", provider_id: "coingecko", token_id: token.id, collected_at: reportedFdv.collectedAt, endpoint_label: "fully_diluted_valuation", value: reportedFdv.value }]
    : [];
  const poolRef: SourceRef[] = poolList
    ? [{ id: 0, source_kind: "raw_record", provider_id: "dexpaprika", token_id: token.id, collected_at: poolList.poolsAt, endpoint_label: "token_dex_pools" }]
    : [];

  const priceSeries = series(tokenRows, "coingecko", "price_usd");
  const marketCapSeries = series(tokenRows, "coingecko", "market_cap_usd");
  const tvlSeries = series(tokenRows, "defillama", "tvl_usd");
  // Revenue comparisons must use actual provider observations. Retained daily
  // averages are useful history, but are not point-in-time endpoints for a 24h change.
  const revenueSeries = series(tokenRows, "defillama", "revenue_24h_usd", { includeDailyAggregates: false });
  const feesSeries = series(tokenRows, "defillama", "fees_24h_usd");

  // Token-wide figures come from DexPaprika's token endpoint (all of the token's pools); the primary pair is the
  // most liquid stored pool.
  const aggregateLiquidityObs = metricSource(tokenRows, "dexpaprika", "liquidity_usd");
  const aggregateVolumeObs = metricSource(tokenRows, "dexpaprika", "volume_24h_usd");
  // Figures outside the plausibility bounds (see dex-sanity.ts), possibly stored before those bounds existed, are unavailable.
  const rawLiquidity = plausibleDexValue("usd", valueOf(aggregateLiquidityObs));
  const rawVolume = plausibleDexValue("usd", valueOf(aggregateVolumeObs));
  const primary = poolList?.pools[0];
  const primaryLiquidity = plausibleDexValue("usd", numberField(primary?.liquidityUsd));
  const primaryVolume = plausibleDexValue("usd", numberField(primary?.volume24hUsd));
  const poolCount = numeric(valueOf(metricSource(tokenRows, "dexpaprika", "dex_pool_count")));
  const aggregateLiquidityCalc = rawLiquidity === null
    ? unavailable("DexPaprika reported no token-wide liquidity.", ref(aggregateLiquidityObs))
    : valid(rawLiquidity, ref(aggregateLiquidityObs), { startAt: aggregateLiquidityObs?.observed_at, endAt: aggregateLiquidityObs?.observed_at, details: { pool_count: poolCount } });
  const aggregateVolumeCalc = rawVolume === null
    ? unavailable("DexPaprika reported no token-wide 24-hour volume.", ref(aggregateVolumeObs))
    : valid(rawVolume, ref(aggregateVolumeObs), { startAt: aggregateVolumeObs?.observed_at, endAt: aggregateVolumeObs?.observed_at, details: { pool_count: poolCount } });
  const primaryDetails = { primary_pair_address: primary?.pairAddress ?? null, primary_pair_dex: primary?.dexId ?? null };
  const primaryLiquidityCalc = primaryLiquidity === null
    ? unavailable("Primary pool liquidity is unavailable.", poolRef)
    : valid(primaryLiquidity, poolRef, { startAt: poolList?.poolsAt, endAt: poolList?.poolsAt, details: primaryDetails });
  const primaryVolumeCalc = primaryVolume === null
    ? unavailable("Primary pool 24-hour volume is unavailable.", poolRef)
    : valid(primaryVolume, poolRef, { startAt: poolList?.poolsAt, endAt: poolList?.poolsAt, details: primaryDetails });

  const historicalGrowth = {
    price: growthCalculation(priceSeries, "CoinGecko price"),
    marketCap: growthCalculation(marketCapSeries, "CoinGecko market capitalization"),
    tvl: fundamentalGrowthCalculation(tvlSeries, "DeFiLlama protocol TVL"),
    revenue: fundamentalGrowthCalculation(revenueSeries, "DeFiLlama protocol revenue"),
    fees: fundamentalGrowthCalculation(feesSeries, "DeFiLlama protocol fees"),
  };
  const priceVsTvl = alignedCrossChange(priceSeries, tvlSeries, "price", "TVL");
  const priceVsRevenue = alignedCrossChange(priceSeries, revenueSeries, "price", "protocol revenue");
  const capVsTvl = alignedCrossChange(marketCapSeries, tvlSeries, "market cap", "TVL");
  const capVsRevenue = alignedCrossChange(marketCapSeries, revenueSeries, "market cap", "protocol revenue");
  const spread = (cross: CrossChange | Calculation): Calculation => {
    if (!("a" in cross)) return cross;
    return valid(cross.a - cross.b, cross.sources, { startAt: cross.startAt, endAt: cross.endAt, details: { ...cross.details, first_series_change_pct: cross.a, second_series_change_pct: cross.b } });
  };
  const crossSpread = { priceVsTvl: spread(priceVsTvl), priceVsRevenue: spread(priceVsRevenue), capVsTvl: spread(capVsTvl), capVsRevenue: spread(capVsRevenue) };

  const marketCapToTvl = ratio(cgMarketCap, llamaTvl, "CoinGecko market cap", "DeFiLlama protocol TVL");
  const fdvRatio = (denominator: ObservationInput | undefined, label: string): Calculation => {
    const bottom = availableValue(denominator);
    const sources = [...fdvRef, ...ref(denominator)];
    if (!reportedFdv) return unavailable("Required input unavailable: CoinGecko fully diluted valuation.", sources);
    if (bottom === null) return unavailable(`Required input unavailable: ${label}.`, sources);
    if (reportedFdv.value < 0 || bottom < 0) return invalid("Negative values are not valid inputs for this valuation ratio.", sources);
    if (bottom === 0) return unavailable(`Denominator is zero (${label}).`, sources);
    return valid(reportedFdv.value / bottom, sources, { startAt: earlier(reportedFdv.collectedAt, denominator?.observed_at), endAt: later(reportedFdv.collectedAt, denominator?.observed_at) });
  };
  const fdvToTvl = fdvRatio(llamaTvl, "DeFiLlama protocol TVL");
  const marketCapToRevenue = ratio(cgMarketCap, llamaRevenue, "CoinGecko market cap", "DeFiLlama protocol 24-hour revenue");
  const fdvToRevenue = fdvRatio(llamaRevenue, "DeFiLlama protocol 24-hour revenue");
  const volumeToMarketCap = ratio(cgVolume, cgMarketCap, "CoinGecko 24-hour volume", "CoinGecko market cap");
  const dexVolumeToLiquidity = divideValues(rawVolume, rawLiquidity, [...ref(aggregateVolumeObs), ...ref(aggregateLiquidityObs)], []);
  const buySell = ratio(dexBuys, dexSells, "DEX buys", "DEX sells");
  const market = valueOf(cgMarketCap);
  const primaryLiqToCap = divideValues(primaryLiquidity, market, [...poolRef, ...ref(cgMarketCap)], [], 100);
  const aggregateLiqToCap = divideValues(rawLiquidity, market, [...ref(aggregateLiquidityObs), ...ref(cgMarketCap)], [], 100);

  const flag = (cross: CrossChange | Calculation, condition: (a: number, b: number) => boolean): Calculation => {
    if (!("a" in cross)) return cross;
    return divFlag(condition(cross.a, cross.b), cross.sources, cross.startAt, cross.endAt, "details" in cross ? cross.details : {});
  };

  const calculations: Record<string, Calculation> = {
    market_cap_to_tvl: marketCapToTvl,
    fdv_to_tvl: fdvToTvl,
    market_cap_to_revenue_24h: marketCapToRevenue,
    fdv_to_revenue_24h: fdvToRevenue,
    volume_to_market_cap: volumeToMarketCap,
    tvl_growth_pct: historicalGrowth.tvl,
    revenue_growth_pct: historicalGrowth.revenue,
    fees_growth_pct: historicalGrowth.fees,
    price_growth_pct: historicalGrowth.price,
    market_cap_growth_pct: historicalGrowth.marketCap,
    price_change_vs_tvl_growth_pct_points: crossSpread.priceVsTvl,
    price_change_vs_revenue_growth_pct_points: crossSpread.priceVsRevenue,
    market_cap_change_vs_tvl_growth_pct_points: crossSpread.capVsTvl,
    market_cap_change_vs_revenue_growth_pct_points: crossSpread.capVsRevenue,
    dex_aggregate_volume_24h_usd: aggregateVolumeCalc,
    dex_aggregate_liquidity_usd: aggregateLiquidityCalc,
    dex_primary_pair_liquidity_usd: primaryLiquidityCalc,
    dex_primary_pair_volume_24h_usd: primaryVolumeCalc,
    dex_liquidity_to_market_cap_pct: primaryLiqToCap,
    dex_aggregate_liquidity_to_market_cap_pct: aggregateLiqToCap,
    dex_volume_to_liquidity: dexVolumeToLiquidity,
    dex_buy_sell_ratio: buySell,
    divergence_price_up_tvl_down: flag(priceVsTvl, (price, tvl) => price > 0 && tvl < 0),
    divergence_price_down_tvl_up: flag(priceVsTvl, (price, tvl) => price < 0 && tvl > 0),
    divergence_market_cap_up_faster_tvl: flag(capVsTvl, (cap, tvl) => cap > tvl),
    divergence_tvl_up_faster_market_cap: flag(capVsTvl, (cap, tvl) => tvl > cap),
    divergence_revenue_up_market_cap_down: flag(capVsRevenue, (cap, revenue) => revenue > 0 && cap < 0),
    divergence_revenue_down_market_cap_up: flag(capVsRevenue, (cap, revenue) => revenue < 0 && cap > 0),
  };

  // The DeFiLlama observations intentionally retain their protocol-level scope in provenance.
  for (const calculation of Object.values(calculations)) {
    for (const source of calculation.sources) {
      if (source.provider_id === "defillama" && typeof source.note === "string") {
        calculation.details = { ...calculation.details, source_scope: source.note };
      }
    }
  }

  return CALCULATED_METRICS.map((definition) => buildCalculation(token, definition, calculations[definition.id] ?? unavailable("Metric calculation is not configured."), calculatedAt));
}

export function calculateAllMetrics(tokens: TokenInput[], observations: ObservationInput[], external: EngineExternalInputs, calculatedAt = new Date().toISOString()): CalculatedMetricRow[] {
  return tokens.flatMap((token) => calculateTokenMetrics(token, observations, external, calculatedAt));
}
