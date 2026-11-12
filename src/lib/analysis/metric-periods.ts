/**
 * Explicit observation periods for the research context.
 *
 * Periods are derived from what is stored (window_days, metric definitions,
 * calculated period_start_at/period_end_at), never from a metric's name. With
 * hourly collection, "latest vs previous" growth metrics usually span about an
 * hour, so every interval is labelled with its actual start, end, and duration,
 * and nothing is described as 24-hour/7-day/30-day unless a provider defines it.
 */

export type ObservationWindow = {
  kind: "provider_rolling_window" | "point_in_time";
  days: number | null;
  label: string;
};

export type MetricPeriod = {
  kind: "interval_between_latest_observations" | "aligned_interval" | "point_in_time" | "unavailable";
  startAt: string | null;
  endAt: string | null;
  durationHours: number | null;
  label: string;
  providerWindows: string[];
};

const HOUR_MS = 60 * 60 * 1000;
const NOT_A_NAMED_PERIOD = "It is not a fixed 24-hour, 7-day, or 30-day period and must not be described as one.";

export function formatDuration(hours: number): string {
  const unit = (value: number, singular: string) => `${value} ${value === 1 ? singular : `${singular}s`}`;
  if (hours < 1) return unit(Math.round(hours * 60), "minute");
  if (hours < 48) return unit(Math.round(hours * 10) / 10, "hour");
  return unit(Math.round((hours / 24) * 10) / 10, "day");
}

function hoursBetween(startAt: string | null, endAt: string | null): number | null {
  if (!startAt || !endAt) return null;
  const hours = (Date.parse(endAt) - Date.parse(startAt)) / HOUR_MS;
  return Number.isFinite(hours) && hours >= 0 ? Math.round(hours * 100) / 100 : null;
}

/** Window of a provider observation: window_days first, then the metric definition text. */
export function observationWindow(input: { windowDays: number | null; definitionName?: string | null; definitionDescription?: string | null; observedAt: string }): ObservationWindow {
  if (input.windowDays !== null && input.windowDays > 0) {
    const span = input.windowDays === 1 ? "24-hour" : `${input.windowDays}-day`;
    return { kind: "provider_rolling_window", days: input.windowDays, label: `Provider-reported rolling ${span} window ending at ${input.observedAt}.` };
  }
  const definition = `${input.definitionName ?? ""} ${input.definitionDescription ?? ""}`;
  if (/24-hour/i.test(definition)) {
    return { kind: "provider_rolling_window", days: 1, label: `Provider-defined 24-hour window per the metric definition ("${(input.definitionDescription ?? input.definitionName ?? "").trim()}"), as of ${input.observedAt}.` };
  }
  return { kind: "point_in_time", days: null, label: `Point-in-time value as of ${input.observedAt}.` };
}

/** Provider-defined rolling windows embedded in a calculated metric's inputs, taken from its formula. */
function providerWindowsFromFormula(formula: string): string[] {
  const windows: string[] = [];
  if (/volume_24h_usd|volume\.h24/.test(formula)) windows.push("Uses a provider-reported rolling 24-hour trading volume.");
  if (/revenue_24h_usd/.test(formula)) windows.push("Uses DeFiLlama's source-reported 24-hour protocol revenue total.");
  if (/fees_24h_usd/.test(formula)) windows.push("Uses DeFiLlama's source-reported 24-hour protocol fees total.");
  if (/buys_24h_count|sells_24h_count/.test(formula)) windows.push("Uses DexPaprika's rolling 24-hour buy/sell transaction counts.");
  return windows;
}

export function calculatedMetricPeriod(metric: { category: string; unit: string; formula: string; periodStartAt: string | null; periodEndAt: string | null }): MetricPeriod {
  const { periodStartAt: startAt, periodEndAt: endAt } = metric;
  const durationHours = hoursBetween(startAt, endAt);
  const providerWindows = providerWindowsFromFormula(metric.formula);
  const span = durationHours === null ? "" : ` (${formatDuration(durationHours)})`;

  if (metric.category === "growth" || metric.category === "divergence") {
    if (!startAt || !endAt || durationHours === null) {
      return { kind: "unavailable", startAt, endAt, durationHours: null, providerWindows, label: "The observation period for this change could not be established; do not attribute any time period to it." };
    }
    if (metric.category === "growth" && metric.unit === "percent") {
      return {
        kind: "interval_between_latest_observations", startAt, endAt, durationHours, providerWindows,
        label: `Change between the two most recent distinct stored observations, ${startAt} to ${endAt}${span}. ${NOT_A_NAMED_PERIOD}`,
      };
    }
    return {
      kind: "aligned_interval", startAt, endAt, durationHours, providerWindows,
      label: `Compares changes over timestamp-aligned intervals from ${startAt} to ${endAt}${span}. ${NOT_A_NAMED_PERIOD}`,
    };
  }

  if (!startAt && !endAt) {
    return { kind: "point_in_time", startAt: null, endAt: null, durationHours: null, providerWindows, label: "Point-in-time value from the latest stored inputs; input observation times were not recorded for this metric." };
  }
  if (startAt === endAt || durationHours === 0) {
    return { kind: "point_in_time", startAt, endAt, durationHours: 0, providerWindows, label: `Point-in-time value; inputs observed at ${endAt ?? startAt}.` };
  }
  return {
    kind: "point_in_time", startAt, endAt, durationHours, providerWindows,
    label: `Point-in-time ratio; its inputs were observed at different times, ${startAt} and ${endAt} (${formatDuration(durationHours ?? 0)} apart).`,
  };
}
