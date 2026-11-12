"use client";

import { useId, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { HistoricalMetric, HistoricalPeriod, HistoryChartKey, TokenHistoricalData } from "@/types/historical-data";
import { HISTORICAL_PERIODS, coverageChangePct, pointsInPeriod, riskProfile } from "@/lib/data/historical-series";
import { DIRECTION_DOWN_COLOR, DIRECTION_UP_COLOR, directionStops } from "@/lib/ui/direction-stops";
import { formatChange, formatDuration, formatUsd } from "@/lib/ui/format";

// Charts connect stored observations and derived daily means; below this count each point is drawn.
const MAX_POINTS_WITH_DOTS = 40;
const SERIES: Record<HistoricalMetric, { label: string; color: string }> = {
  priceUsd: { label: "Price", color: "#d0443b" },
  volumeUsd: { label: "Volume · 24h", color: "#c9a45c" },
  marketCapUsd: { label: "Market cap", color: "#c9c0ae" },
  tvlUsd: { label: "TVL", color: "#c9a45c" },
};
const AXIS = { fill: "#7d776c", fontSize: 11 };
const UP_COLOR = DIRECTION_UP_COLOR;
const DOWN_COLOR = DIRECTION_DOWN_COLOR;

/** SVG filter that blurs the line's own colours and lays the line over the blur, so green stretches glow green and red stretches red. */
function GlowFilter({ id }: { id: string }) {
  return (
    <filter id={id} x="-5%" y="-30%" width="110%" height="160%" colorInterpolationFilters="sRGB">
      <feGaussianBlur in="SourceGraphic" stdDeviation="2.6" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  );
}

function utcLabel(time: number, withTime = true) {
  return new Date(time).toLocaleString("en-GB", withTime
    ? { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }
    : { day: "numeric", month: "short", timeZone: "UTC" });
}

type TooltipProps = { active?: boolean; label?: number | string; payload?: { value?: number | string; payload?: { aggregation?: { method: "arithmetic_mean"; sampleCount: number } } }[]; seriesLabel: string };

/** Date/time, series name, and value only; provenance IDs are never shown here. */
function ChartTooltip({ active, label, payload, seriesLabel }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const value = Number(payload[0]?.value);
  const aggregation = payload[0]?.payload?.aggregation;
  return (
    <div className="chart-tooltip">
      <span>{utcLabel(Number(label))} UTC</span>
      <strong>{formatUsd(value)}</strong>
      <small>{aggregation
        ? `UTC daily average · ${aggregation.sampleCount} source ${aggregation.sampleCount === 1 ? "value" : "values"}`
        : seriesLabel}</small>
    </div>
  );
}

function ChartCard({ metric, data, period, wide = false }: { metric: HistoricalMetric; data: TokenHistoricalData; period: HistoricalPeriod; wide?: boolean }) {
  const series = data[metric];
  // Windows end at the server time the page was built, not at the latest observation.
  const coverage = series.periods[period];
  const points = pointsInPeriod(series.points, period, new Date(data.asOf));
  // A numeric time axis keeps spacing proportional to time when daily and hourly points are mixed.
  const chartPoints = points.map((item) => ({ time: Date.parse(item.timestamp), valueUsd: item.valueUsd, aggregation: item.aggregation }));
  const latest = points.at(-1);
  const hasTrend = coverage.status === "available";
  const change = hasTrend ? formatChange(coverageChangePct(points)) : null;
  const { label, color } = SERIES[metric];
  const gradientId = useId().replace(/:/g, "");
  const glowId = `${gradientId}glow`;
  const stops = directionStops(chartPoints);
  // Falls back to the series colour when there is no direction to show (fewer than two distinct times).
  const stroke = stops.length > 0 ? `url(#${gradientId})` : color;

  return (
    <article className={`chart-card${wide ? " chart-wide" : ""}`} aria-label={`${label} history`}>
      <header className="chart-head">
        <span className="chart-title">{label}</span>
        <div className="chart-summary">
          {latest ? <strong>{formatUsd(latest.valueUsd, true)}</strong> : null}
          {change && coverage.coverageHours !== null ? <span className={`tone-${change.tone}`}>{change.text} <small>over {formatDuration(coverage.coverageHours)}</small></span> : null}
        </div>
      </header>
      {hasTrend ? (
        <div className="chart-plot" role="img" aria-label={`${label} in USD: ${coverage.coverageLabel} within the ${period} window`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartPoints} margin={{ top: 10, right: 6, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
                  {stops.map((stop, index) => <stop key={index} offset={stop.offset} stopColor={stop.color} />)}
                </linearGradient>
                <GlowFilter id={glowId} />
              </defs>
              <CartesianGrid stroke="rgba(236, 230, 218, 0.06)" vertical={false} />
              <XAxis
                dataKey="time" type="number" scale="time" domain={["dataMin", "dataMax"]}
                tickFormatter={(value: number) => period === "24H"
                  ? new Date(value).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" })
                  : utcLabel(value, false)}
                tick={AXIS} axisLine={{ stroke: "#2f2e2b" }} tickLine={false} minTickGap={32} tickMargin={8}
              />
              <YAxis tickFormatter={(value: number) => formatUsd(value, true) ?? ""} tick={AXIS} axisLine={false} tickLine={false} width={62} domain={["auto", "auto"]} />
              <Tooltip content={<ChartTooltip seriesLabel={label} />} cursor={{ stroke: "#6d6559", strokeDasharray: "3 3" }} />
              <Line
                type="linear" dataKey="valueUsd" name={label} stroke={stroke} strokeWidth={1.75} style={stops.length > 0 ? { filter: `url(#${glowId})` } : undefined}
                dot={points.length <= MAX_POINTS_WITH_DOTS && stops.length > 0
                  ? (props: { cx?: number; cy?: number; index?: number }) => {
                    const index = props.index ?? 0;
                    const rose = index === 0 ? chartPoints[1]?.valueUsd >= chartPoints[0].valueUsd : chartPoints[index].valueUsd >= chartPoints[index - 1].valueUsd;
                    return <circle key={index} cx={props.cx} cy={props.cy} r={2} fill={rose ? UP_COLOR : DOWN_COLOR} />;
                  }
                  : points.length <= MAX_POINTS_WITH_DOTS ? { r: 2, fill: color, strokeWidth: 0 } : false}
                activeDot={{ r: 3.5, fill: color, stroke: "#0b0b0c", strokeWidth: 1.5 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="chart-empty" role="status">
          {coverage.observationCount === 1 ? `Only one stored observation in the ${period} window — a trend needs at least two.` : `No stored observations in the ${period} window.`}
        </p>
      )}
      <footer className="chart-foot">
        <span>{coverage.coverageLabel}</span>
        {hasTrend && !coverage.fullCoverage && coverage.coverageHours !== null ? <span className="chart-partial">Partial: {formatDuration(coverage.coverageHours)} of {period}</span> : null}
      </footer>
    </article>
  );
}

const RISK = {
  volatility: { label: "Volatility", color: "#cdac68" },
  drawdown: { label: "Drawdown", color: "#e2766d" },
  summary: "Historical risk profile based on price volatility and drawdown.",
  help: "Volatility measures historical price variability; drawdown measures the decline from a prior peak.",
};

/** Percent with one decimal and a typographic minus; values that round to zero show as 0.0% (never "−0.0%"). */
function pct(value: number): string {
  const text = Math.abs(value).toFixed(1);
  return `${value < 0 && Number(text) !== 0 ? "−" : ""}${text}%`;
}

type RiskRow = { time: number; volatility?: number; drawdown?: number };

function RiskTooltip({ active, label, payload }: { active?: boolean; label?: number | string; payload?: { dataKey?: unknown; value?: number | string }[] }) {
  if (!active || !payload?.length) return null;
  const value = (key: string) => payload.find((item) => item.dataKey === key)?.value;
  const volatility = value("volatility"), drawdown = value("drawdown");
  return (
    <div className="chart-tooltip">
      <span>{utcLabel(Number(label))} UTC</span>
      <strong>{RISK.volatility.label} {typeof volatility === "number" ? pct(volatility) : "—"}</strong>
      <strong>{RISK.drawdown.label} {typeof drawdown === "number" ? pct(drawdown) : "—"}</strong>
      <small>Hourly price · up to 7-day rolling volatility, annualized</small>
    </div>
  );
}

/**
 * Risk profile: two independent series from the stored price history, calculated
 * here at render time (see `riskProfile` for the formulas). Volatility is plotted
 * above zero and drawdown at or below it; they are never combined into a score.
 * The header shows the latest values; a first-to-last % change would mislead for
 * a volatility level or a drawdown, so none is shown.
 */
function RiskProfileCard({ data, period }: { data: TokenHistoricalData; period: HistoricalPeriod }) {
  const { hourly, volatility, drawdown } = riskProfile(data.priceUsd.points, period, new Date(data.asOf));
  const rows = new Map<number, RiskRow>(hourly.map((point) => [Date.parse(point.timestamp), { time: Date.parse(point.timestamp) }]));
  for (const point of volatility) rows.get(Date.parse(point.timestamp))!.volatility = point.valueUsd;
  for (const point of drawdown) rows.get(Date.parse(point.timestamp))!.drawdown = point.valueUsd;
  const chartRows = [...rows.values()];
  const baseId = useId().replace(/:/g, "");
  const glowId = `${baseId}glow`;
  const seriesStops = {
    volatility: directionStops(volatility.map((point) => ({ time: Date.parse(point.timestamp), valueUsd: point.valueUsd }))),
    drawdown: directionStops(drawdown.map((point) => ({ time: Date.parse(point.timestamp), valueUsd: point.valueUsd }))),
  };
  const latestVolatility = volatility.at(-1)?.valueUsd;
  const latestDrawdown = drawdown.at(-1)?.valueUsd;
  const hasTrend = hourly.length >= 2;
  const span = hasTrend ? formatDuration((Date.parse(hourly.at(-1)!.timestamp) - Date.parse(hourly[0].timestamp)) / 3_600_000) : null;

  return (
    <article className="chart-card" aria-label="Risk profile history">
      <header className="chart-head">
        <span className="chart-title" title={`${RISK.summary} ${RISK.help}`}>Risk profile</span>
        <div className="chart-summary">
          {latestVolatility !== undefined ? <span className="risk-key"><i className="risk-solid" aria-hidden="true" />{RISK.volatility.label} <strong>{pct(latestVolatility)}</strong></span> : null}
          {latestDrawdown !== undefined ? <span className="risk-key"><i className="risk-dashed" aria-hidden="true" />{RISK.drawdown.label} <strong>{pct(latestDrawdown)}</strong></span> : null}
        </div>
      </header>
      {hasTrend ? (
        <div className="chart-plot" role="img" aria-label={`Volatility and drawdown in percent: ${hourly.length} hourly price samples within the ${period} window`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartRows} margin={{ top: 10, right: 6, bottom: 0, left: 0 }}>
              <defs>
                {(["volatility", "drawdown"] as const).map((key) => (
                  <linearGradient key={key} id={`${baseId}${key}`} x1="0" y1="0" x2="1" y2="0">
                    {seriesStops[key].map((stop, index) => <stop key={index} offset={stop.offset} stopColor={stop.color} />)}
                  </linearGradient>
                ))}
                <GlowFilter id={glowId} />
              </defs>
              <CartesianGrid stroke="rgba(236, 230, 218, 0.06)" vertical={false} />
              <XAxis
                dataKey="time" type="number" scale="time" domain={["dataMin", "dataMax"]}
                tickFormatter={(value: number) => utcLabel(value, false)}
                tick={AXIS} axisLine={{ stroke: "#2f2e2b" }} tickLine={false} minTickGap={32} tickMargin={8}
              />
              <YAxis tickFormatter={(value: number) => pct(value)} tick={AXIS} axisLine={false} tickLine={false} width={62} domain={["auto", "auto"]} />
              <ReferenceLine y={0} stroke="#6d6559" strokeWidth={1} />
              <Tooltip content={<RiskTooltip />} cursor={{ stroke: "#6d6559", strokeDasharray: "3 3" }} />
              {(["volatility", "drawdown"] as const).map((key) => (
                <Line
                  key={key} type="linear" dataKey={key} name={RISK[key].label}
                  stroke={seriesStops[key].length > 0 ? `url(#${baseId}${key})` : RISK[key].color} strokeWidth={1.75} connectNulls
                  strokeDasharray={key === "drawdown" ? "5 3" : undefined}
                  style={seriesStops[key].length > 0 ? { filter: `url(#${glowId})` } : undefined}
                  dot={chartRows.length <= MAX_POINTS_WITH_DOTS ? { r: 2, fill: RISK[key].color, strokeWidth: 0 } : false}
                  activeDot={{ r: 3.5, fill: RISK[key].color, stroke: "#0b0b0c", strokeWidth: 1.5 }}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="chart-empty" role="status">The risk profile uses granular hourly price history; fewer than two hourly samples fall in the {period} window.</p>
      )}
      <footer className="chart-foot">
        <span>{RISK.summary}</span>
        <span>{hourly.length} hourly {hourly.length === 1 ? "sample" : "samples"}{span ? ` spanning ${span}` : ""}</span>
      </footer>
    </article>
  );
}

export function PeriodControl({ value, onChange, label }: { value: HistoricalPeriod; onChange: (period: HistoricalPeriod) => void; label: string }) {
  return (
    <div className="segmented period-control" role="group" aria-label={label}>
      {HISTORICAL_PERIODS.map((option) => (
        <button key={option} type="button" onClick={() => onChange(option)} aria-pressed={value === option}>{option}</button>
      ))}
    </div>
  );
}

/**
 * Charts of stored observations for one scope. Series and period coverage
 * come from the server; nothing is interpolated, zero-filled, or synthesized.
 */
export function HistoryCharts({ data, series, initialPeriod = "14D", label }: { data: TokenHistoricalData; series: HistoryChartKey[]; initialPeriod?: HistoricalPeriod; label: string }) {
  const [period, setPeriod] = useState<HistoricalPeriod>(initialPeriod);
  return (
    <div className="history-block">
      <div className="history-toolbar">
        <PeriodControl value={period} onChange={setPeriod} label={`${label} period`} />
      </div>
      <div className={`chart-grid charts-${series.length}`}>
        {series.map((metric, index) => metric === "riskProfile"
          ? <RiskProfileCard key={metric} data={data} period={period} />
          : <ChartCard key={metric} metric={metric} data={data} period={period} wide={index === 0 && series.length !== 2} />)}
      </div>
    </div>
  );
}
