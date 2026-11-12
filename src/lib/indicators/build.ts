import {
  INDICATOR_CATEGORIES,
  type IndicatorCategory,
  type IndicatorInput,
  type TechnicalIndicator,
  type TechnicalIndicatorsView,
} from "../../types/technical-indicators.ts";
import { INDICATOR_DEFINITIONS, type IndicatorDefinition } from "./catalog.ts";
import { DAY_MS, SERIES_RULES, alignSeries, contiguousTail, dailySamples, maxHistoryAgeDays, type DailyPoint, type ObservationRow } from "./series.ts";

/**
 * Technical indicator pipeline:
 * stored observations → daily samples → per-indicator availability check →
 * deterministic calculation → only the indicators that succeeded.
 */

export const CATEGORY_LABELS: Record<IndicatorCategory, string> = {
  trend: "Trend",
  momentum: "Momentum",
  volatility: "Volatility",
  volume: "Volume",
  market_structure: "Market structure · price action",
  derivatives: "Derivatives",
  on_chain: "On-chain",
  divergence: "Cross-metric analysis",
};

export const INDICATOR_METHOD = "Daily samples at 00:00 UTC taken from stored observations (the observation nearest each midnight, within 30 minutes; supply within 6 hours). "
  + "Each indicator uses only the run of consecutive days ending at the newest sample, needs its stated minimum number of days, and is shown as of its newest sample while that sample is at most half the indicator's window old (for example 10 days for SMA(20), 7 for RSI(14), 15 for 30D comparisons). This historical rule is separate from current-market freshness. "
  + "Nothing is interpolated, filled or substituted.";

export type OmittedIndicator = { id: string; reason: "missing_input" | "insufficient_history" | "stale_history" | "not_calculable"; detail: string };

export type IndicatorOptions = {
  asOf: Date;
  /** TVL is protocol-scope data and is used only when a curated protocol mapping exists. */
  protocolMapped: boolean;
  definitions?: IndicatorDefinition[];
};

function inputSamples(rows: ObservationRow[], input: IndicatorInput, options: IndicatorOptions): DailyPoint[] {
  if (input === "tvl" && !options.protocolMapped) return [];
  return dailySamples(rows, SERIES_RULES[input], options.asOf.getTime());
}

export function evaluateTechnicalIndicators(rows: ObservationRow[], options: IndicatorOptions): {
  view: TechnicalIndicatorsView;
  omitted: OmittedIndicator[];
} {
  const asOf = options.asOf.getTime();
  const calculatedAt = options.asOf.toISOString();
  const samples = new Map<IndicatorInput, DailyPoint[]>();
  const samplesFor = (input: IndicatorInput) => {
    if (!samples.has(input)) samples.set(input, inputSamples(rows, input, options));
    return samples.get(input)!;
  };

  const available: TechnicalIndicator[] = [];
  const omitted: OmittedIndicator[] = [];
  for (const definition of options.definitions ?? INDICATOR_DEFINITIONS) {
    const raw = definition.inputs.map(samplesFor);
    const missing = definition.inputs.filter((_, i) => raw[i].length === 0);
    if (missing.length > 0) {
      omitted.push({ id: definition.id, reason: "missing_input", detail: `No usable daily samples for ${missing.join(", ")}.` });
      continue;
    }
    const series = raw.length === 1 ? [contiguousTail(raw[0])] : alignSeries(raw);
    const days = series[0].length;
    if (days < definition.minPoints) {
      omitted.push({ id: definition.id, reason: "insufficient_history", detail: `${days} consecutive daily samples; ${definition.minPoints} required.` });
      continue;
    }
    // Historical freshness (not the current-market policy): at most half the indicator's window old.
    const ageDays = (asOf - series[0].at(-1)!.time) / DAY_MS;
    const maxAge = maxHistoryAgeDays(definition.windowDays);
    if (ageDays > maxAge) {
      omitted.push({ id: definition.id, reason: "stale_history", detail: `Newest daily sample is ${ageDays.toFixed(1)} days old; a ${definition.windowDays}-day indicator allows ${maxAge}.` });
      continue;
    }
    const result = definition.compute(series);
    if (!result || result.readings.some((reading) => typeof reading.value === "number" && !Number.isFinite(reading.value))) {
      omitted.push({ id: definition.id, reason: "not_calculable", detail: "The stored values do not support this calculation (for example, no variation)." });
      continue;
    }
    const used = result.used.flat();
    const times = used.map((point) => point.time);
    available.push({
      id: definition.id,
      name: definition.name,
      category: definition.category,
      available: true,
      parameters: definition.parameters,
      periodLabel: definition.periodLabel,
      summary: definition.summary,
      description: definition.description,
      formula: definition.formula,
      readings: result.readings,
      state: result.state,
      provenance: {
        providers: [...new Set(definition.inputs.map((input) => SERIES_RULES[input].providerId))],
        inputs: definition.inputs,
        sourceObservationIds: [...new Set(used.map((point) => point.obsId))].sort((a, b) => a - b),
        observationCount: new Set(used.map((point) => point.obsId)).size,
        observationStart: new Date(Math.min(...times)).toISOString(),
        observationEnd: new Date(Math.max(...times)).toISOString(),
        calculatedAt,
      },
    });
  }

  const groups = INDICATOR_CATEGORIES
    .map((category) => ({ category, label: CATEGORY_LABELS[category], indicators: available.filter((indicator) => indicator.category === category) }))
    .filter((group) => group.indicators.length > 0);
  return { view: { calculatedAt, method: INDICATOR_METHOD, groups }, omitted };
}

/** Only the available indicators, grouped by category (empty categories are dropped). */
export function buildTechnicalIndicators(rows: ObservationRow[], options: IndicatorOptions): TechnicalIndicatorsView {
  return evaluateTechnicalIndicators(rows, options).view;
}

/**
 * Adds indicators computed outside the daily-series pipeline above (for example
 * cross-sectional DexPaprika pool/DEX concentration, which has no daily
 * series to sample from `SERIES_RULES`) into their category group, keeping the
 * same category order. This is the smallest extension point for an indicator
 * that isn't a function of `IndicatorInput` daily samples; it does not add a
 * second indicator engine, just merges pre-built `TechnicalIndicator` objects.
 */
export function withExtraIndicators(view: TechnicalIndicatorsView, extra: TechnicalIndicator[]): TechnicalIndicatorsView {
  if (extra.length === 0) return view;
  const groups = INDICATOR_CATEGORIES
    .map((category) => ({
      category,
      label: CATEGORY_LABELS[category],
      indicators: [...(view.groups.find((group) => group.category === category)?.indicators ?? []), ...extra.filter((indicator) => indicator.category === category)],
    }))
    .filter((group) => group.indicators.length > 0);
  return { ...view, groups };
}
