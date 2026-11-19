/**
 * Display formatting. Every formatter takes `number | null` and returns null
 * for a missing value, so callers hide the metric instead of printing zero.
 * A legitimate numeric zero always formats as a value.
 */

export type Tone = "positive" | "negative" | "flat" | "neutral";
export type Formatted = { text: string; tone: Tone };

const HOUR_MS = 60 * 60 * 1000;

export function isValidNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function formatUsd(value: number | null | undefined, compact = false): string | null {
  if (!isValidNumber(value)) return null;
  const abs = Math.abs(value);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 2 : abs === 0 ? 2 : abs < 0.0001 ? 8 : abs < 1 ? 6 : 2,
    minimumFractionDigits: compact ? 0 : 2,
  }).format(value);
}

export function historyPriceFormatters(ticks: readonly number[], latestPrice?: number) {
  const compactLabels = new Set(ticks.map((tick) => formatUsd(tick, true)));
  let fractionDigits = 2;
  let tickFormatter: Intl.NumberFormat | undefined;

  if (compactLabels.size < ticks.length) {
    // Keep the full tick interval legible, including steps like $0.00005.
    while (fractionDigits < 20 && ticks.some((tick) => Number(tick.toFixed(fractionDigits)) !== tick)) {
      fractionDigits++;
    }
    tickFormatter = new Intl.NumberFormat("en-US", {
      style: "currency", currency: "USD", minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits,
    });
  }

  const valueFormatter = tickFormatter || formatUsd(latestPrice, true) === "$1"
    ? new Intl.NumberFormat("en-US", {
      style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: Math.max(6, fractionDigits),
    })
    : undefined;

  return { tick: tickFormatter?.format, value: valueFormatter?.format };
}

/** Directional change (price move, growth over a stated interval). */
export function formatChange(value: number | null | undefined): Formatted | null {
  if (!isValidNumber(value)) return null;
  // Keep small non-zero values from rounding to a misleading "+0%".
  const options = value !== 0 && Math.abs(value) < 0.01 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 2, minimumFractionDigits: 2 };
  const text = `${value > 0 ? "+" : ""}${new Intl.NumberFormat("en-US", options).format(value)}%`;
  return { text, tone: value > 0 ? "positive" : value < 0 ? "negative" : "flat" };
}

/** A share of something (e.g. liquidity as % of market cap): no sign, no direction. */
export function formatShare(value: number | null | undefined): string | null {
  if (!isValidNumber(value)) return null;
  const options = value !== 0 && Math.abs(value) < 0.01 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 2 };
  return `${new Intl.NumberFormat("en-US", options).format(value)}%`;
}

/** A ratio between two values, e.g. market cap / TVL = 0.116×. */
export function formatRatio(value: number | null | undefined): string | null {
  if (!isValidNumber(value)) return null;
  const abs = Math.abs(value);
  const options = abs === 0 ? { maximumFractionDigits: 0 } : abs >= 100 ? { maximumFractionDigits: 0 } : abs >= 1 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 3 };
  return `${new Intl.NumberFormat("en-US", options).format(value)}×`;
}

/** Difference between two percentage changes, in percentage points. */
export function formatPoints(value: number | null | undefined): string | null {
  if (!isValidNumber(value)) return null;
  const options = value !== 0 && Math.abs(value) < 0.01 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 2 };
  return `${value > 0 ? "+" : ""}${new Intl.NumberFormat("en-US", options).format(value)} pp`;
}

export function formatCount(value: number | null | undefined): string | null {
  if (!isValidNumber(value)) return null;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export function formatSupply(value: number | null | undefined): string | null {
  if (!isValidNumber(value)) return null;
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

export function formatDuration(hours: number): string {
  const unit = (value: number, singular: string) => `${value} ${value === 1 ? singular : `${singular}s`}`;
  if (hours < 1) return unit(Math.max(1, Math.round(hours * 60)), "minute");
  if (hours < 48) return unit(Math.round(hours * 10) / 10, "hour");
  return unit(Math.round((hours / 24) * 10) / 10, "day");
}

export function formatUtc(value: string | null | undefined, withTime = true): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  const options: Intl.DateTimeFormatOptions = withTime
    ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }
    : { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" };
  return `${new Date(value).toLocaleString("en-GB", options)}${withTime ? " UTC" : ""}`;
}

/** Shortened contract / mint / canister address for display; the full value stays copyable. */
export function shortAddress(address: string): string {
  return address.length > 16 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export type Interval = { hours: number; label: string; range: string; isShort: boolean };

export type Horizon = "24H" | "7D" | "30D" | "Snapshot";

/**
 * Horizon label from an actual observation interval. A fixed label is used only when the interval
 * matches it (24H ± 1 hour; 7D and 30D ± 12 hours); anything else, e.g. 8.9 hours, is a "Snapshot".
 */
export function horizonLabel(hours: number | null | undefined): Horizon {
  if (!isValidNumber(hours)) return "Snapshot";
  if (Math.abs(hours - 30 * 24) <= 12) return "30D";
  if (Math.abs(hours - 7 * 24) <= 12) return "7D";
  if (Math.abs(hours - 24) <= 1) return "24H";
  return "Snapshot";
}

/** Actual observation interval of a metric; "short" intervals (< 24h) are snapshot-to-snapshot changes. */
export function intervalBetween(startAt: string | null | undefined, endAt: string | null | undefined): Interval | null {
  if (!startAt || !endAt) return null;
  const hours = (Date.parse(endAt) - Date.parse(startAt)) / HOUR_MS;
  if (!Number.isFinite(hours) || hours < 0) return null;
  return {
    hours,
    label: `over ${formatDuration(hours)}`,
    range: `${formatUtc(startAt)} → ${formatUtc(endAt)}`,
    isShort: hours < 24,
  };
}
