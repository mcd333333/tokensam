import type {
  HistoricalMetric,
  HistoricalPeriod,
  HistoricalPeriodCoverage,
  HistoricalPoint,
  HistoricalSeries,
} from "../../types/historical-data.ts";
import { DAY_MS, SERIES_RULES, dailySamples, type ObservationRow } from "../indicators/series.ts";

export const HISTORICAL_PERIODS: HistoricalPeriod[] = ["24H", "7D", "21D"];
export const PERIOD_HOURS: Record<HistoricalPeriod, number> = { "24H": 24, "7D": 7 * 24, "21D": 21 * 24 };
const HOUR_MS = 60 * 60 * 1000;
const FULL_COVERAGE_RATIO = 0.9;

export function formatSpan(hours: number): string {
  const unit = (value: number, singular: string) => `${value} ${value === 1 ? singular : `${singular}s`}`;
  if (hours < 1) return unit(Math.round(hours * 60), "minute");
  if (hours < 48) return unit(Math.round(hours * 10) / 10, "hour");
  return unit(Math.round((hours / 24) * 10) / 10, "day");
}

/**
 * Coverage of one requested window, (asOf - period, asOf] inclusive of both
 * ends, using only the stored points inside it. Two or more points are needed
 * to show a trend; the window's name is never treated as achieved coverage.
 */
export function pointsInPeriod(points: HistoricalPoint[], period: HistoricalPeriod, asOf: Date): HistoricalPoint[] {
  const windowEndMs = asOf.getTime();
  const windowStartMs = windowEndMs - PERIOD_HOURS[period] * HOUR_MS;
  return points.filter((point) => {
    const time = Date.parse(point.timestamp);
    return time >= windowStartMs && time <= windowEndMs;
  });
}

export function periodCoverage(points: HistoricalPoint[], period: HistoricalPeriod, asOf: Date, seriesUnavailableReason: string | null = null): HistoricalPeriodCoverage {
  const windowEndMs = asOf.getTime();
  const windowStartMs = windowEndMs - PERIOD_HOURS[period] * HOUR_MS;
  const inWindow = pointsInPeriod(points, period, asOf);
  const first = inWindow[0];
  const last = inWindow.at(-1);
  const coverageHours = first && last ? Math.round(((Date.parse(last.timestamp) - Date.parse(first.timestamp)) / HOUR_MS) * 100) / 100 : null;
  const count = inWindow.length;
  const status: HistoricalPeriodCoverage["status"] = count >= 2 ? "available" : count === 1 ? "insufficient_history" : "unavailable";
  const unavailableReason = status === "available"
    ? null
    : seriesUnavailableReason
      ?? (count === 1
        ? `Only one stored observation (${first!.timestamp}) falls in the requested ${period} window; at least two are needed to show a trend.`
        : `No stored observations fall in the requested ${period} window.`);
  return {
    requestedPeriod: period,
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: new Date(windowEndMs).toISOString(),
    status,
    observationCount: count,
    coverageStart: first?.timestamp ?? null,
    coverageEnd: last?.timestamp ?? null,
    coverageHours,
    fullCoverage: coverageHours !== null && coverageHours >= PERIOD_HOURS[period] * FULL_COVERAGE_RATIO,
    coverageLabel: count === 0
      ? "No stored observations"
      : count === 1
        ? "1 observation"
        : `${count} observations spanning ${formatSpan(coverageHours!)}`,
    unavailableReason,
  };
}

/** Build a chart series from stored observations: points sorted, deduplicated by row, never synthesized. */
export function buildHistoricalSeries(input: {
  metric: HistoricalMetric;
  providerId: HistoricalSeries["providerId"];
  scope: HistoricalSeries["scope"];
  points: HistoricalPoint[];
  asOf: Date;
  unavailableReason?: string | null;
}): HistoricalSeries {
  const points = [...new Map(input.points.map((point) => [point.sourceId, point])).values()]
    .filter((point) => Number.isFinite(point.valueUsd) && Number.isFinite(Date.parse(point.timestamp)))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.sourceId.localeCompare(b.sourceId));
  const reason = input.unavailableReason ?? null;
  const periods = Object.fromEntries(HISTORICAL_PERIODS.map((period) => [
    period, periodCoverage(points, period, input.asOf, points.length === 0 ? reason : null),
  ])) as Record<HistoricalPeriod, HistoricalPeriodCoverage>;
  return { metric: input.metric, providerId: input.providerId, scope: input.scope, points, periods, unavailableReason: points.length === 0 ? reason : null };
}

/** Change between the first and last stored points of a window; null without two points or a zero base. */
export function coverageChangePct(points: HistoricalPoint[]): number | null {
  if (points.length < 2) return null;
  const first = points[0].valueUsd;
  const last = points[points.length - 1].valueUsd;
  return first === 0 ? null : ((last - first) / first) * 100;
}

// ---- Risk profile (Market History): granular volatility and drawdown from stored prices ----
//
// The risk profile uses the granular CoinGecko price history rather than reducing
// the series to one UTC daily close. Recent CoinGecko history is hourly, so we
// normalize the stored observations to one representative point per UTC hour,
// choosing the nearest observation within 30 minutes. Missing hours remain gaps.
//
// Volatility uses up to a rolling 7-day window of hourly log returns. During the
// initial warm-up, or after a gap, it uses the longest consecutive hourly run
// available at that endpoint; once 168 returns are available it is the full
// 7-day rolling volatility. This avoids fabricating pre-window history while
// allowing the plotted line to begin near the start of each selected window.
// Drawdown uses every normalized hourly price inside the selected chart window.

export const RISK_VOLATILITY_WINDOW_DAYS = 7;
export const RISK_GRANULAR_TOLERANCE_MS = 30 * 60 * 1000;
export const RISK_HOUR_MS = 60 * 60 * 1000;
export const RISK_VOLATILITY_HOURS = RISK_VOLATILITY_WINDOW_DAYS * 24;

type RiskPricePoint = { time: number; value: number; obsId: number };

/** One price sample per UTC hour, choosing the nearest valid stored observation within 30 minutes. */
export function hourlyRiskSamples(points: HistoricalPoint[], asOf: Date): HistoricalPoint[] {
  const candidates = points
    .map((point, index) => ({
      time: Date.parse(point.timestamp),
      value: point.valueUsd,
      obsId: Number(point.sourceId.replace(/^obs:/, "")) || -(index + 1),
    }))
    .filter((point): point is RiskPricePoint =>
      Number.isFinite(point.time) &&
      point.time <= asOf.getTime() &&
      Number.isFinite(point.value) &&
      point.value > 0,
    );

  const byHour = new Map<number, { point: RiskPricePoint; distance: number }>();
  for (const point of candidates) {
    const boundary = Math.round(point.time / RISK_HOUR_MS) * RISK_HOUR_MS;
    const distance = Math.abs(point.time - boundary);
    if (distance > RISK_GRANULAR_TOLERANCE_MS || boundary > asOf.getTime()) continue;
    const current = byHour.get(boundary);
    if (!current || distance < current.distance || (distance === current.distance && point.obsId > current.point.obsId)) {
      byHour.set(boundary, { point, distance });
    }
  }

  return [...byHour.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, { point }]) => ({
      timestamp: new Date(time).toISOString(),
      valueUsd: point.value,
      sourceId: `obs:${point.obsId}`,
    }));
}

/**
 * Rolling annualized volatility from hourly log returns:
 *
 *   r_i = ln(price_i / price_{i-1})
 *   sigma = sample standard deviation of the available returns, capped at 168
 *           hourly returns (7 days)
 *   volatility = sigma * sqrt(24 * 365) * 100
 *
 * The warm-up uses an expanding consecutive run until 168 returns are available.
 * After a missing hour, the run resets; no gap is ever bridged or interpolated.
 */
export function rollingVolatility(hourly: HistoricalPoint[], windowHours = RISK_VOLATILITY_HOURS): HistoricalPoint[] {
  const out: HistoricalPoint[] = [];
  const times = hourly.map((point) => Date.parse(point.timestamp));
  let consecutiveReturns = 0;

  for (let t = 1; t < hourly.length; t += 1) {
    if (times[t] - times[t - 1] !== RISK_HOUR_MS) {
      consecutiveReturns = 0;
      continue;
    }

    consecutiveReturns += 1;
    const returnCount = Math.min(windowHours, consecutiveReturns);
    if (returnCount < 2) continue;

    const start = t - returnCount;
    const returns = hourly
      .slice(start, t + 1)
      .slice(1)
      .map((point, i) => Math.log(point.valueUsd / hourly[start + i].valueUsd));

    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
    const value = Math.sqrt(variance) * Math.sqrt(24 * 365) * 100;
    if (Number.isFinite(value)) {
      out.push({ timestamp: hourly[t].timestamp, valueUsd: value, sourceId: hourly[t].sourceId });
    }
  }
  return out;
}

/**
 * Drawdown from the running hourly peak inside the selected chart window:
 * drawdown_t = (price_t / max(price_first..price_t) - 1) * 100.
 */
export function drawdownSeries(granularInWindow: HistoricalPoint[]): HistoricalPoint[] {
  const sorted = [...granularInWindow].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  let peak = -Infinity;
  const out: HistoricalPoint[] = [];
  for (const point of sorted) {
    if (!Number.isFinite(point.valueUsd) || point.valueUsd <= 0) continue;
    peak = Math.max(peak, point.valueUsd);
    const value = Math.min(0, (point.valueUsd / peak - 1) * 100);
    out.push({ timestamp: point.timestamp, valueUsd: value === 0 ? 0 : value, sourceId: point.sourceId });
  }
  return out;
}

/**
 * Risk profile for one requested window. Granular hourly prices inside the
 * selected window drive drawdown, while volatility uses a 7-day hourly lookback
 * that may begin before the selected window.
 */
export function riskProfile(pricePoints: HistoricalPoint[], period: HistoricalPeriod, asOf: Date): {
  hourly: HistoricalPoint[]; volatility: HistoricalPoint[]; drawdown: HistoricalPoint[];
} {
  const allHourly = hourlyRiskSamples(pricePoints, asOf);
  const hourly = pointsInPeriod(allHourly, period, asOf);
  return {
    hourly,
    volatility: pointsInPeriod(rollingVolatility(allHourly), period, asOf),
    drawdown: drawdownSeries(hourly),
  };
}
