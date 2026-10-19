import type { MetricSource } from "@/types/token";

export type HistoricalMetric = "priceUsd" | "tvlUsd" | "volumeUsd" | "marketCapUsd";
/** A Market History chart: a stored series, or the risk profile derived from `priceUsd` at page load. */
export type HistoryChartKey = HistoricalMetric | "riskProfile";
export type HistoricalPeriod = "24H" | "7D" | "21D";

/** One actual stored observation. Charts connect these; nothing is interpolated or synthesized. */
export type HistoricalPoint = {
  timestamp: string;
  valueUsd: number;
  /** Provenance: a source observation or daily aggregate row, e.g. "obs:123" or "daily-average:45". */
  sourceId: string;
  /** Present when retention compacted source observations into a derived daily mean. */
  aggregation?: { method: "arithmetic_mean"; sampleCount: number };
};

/**
 * What a requested window actually contains. The period names the requested
 * observation window ending at `windowEnd`; it does not promise coverage.
 */
export type HistoricalPeriodCoverage = {
  requestedPeriod: HistoricalPeriod;
  windowStart: string;
  windowEnd: string;
  status: "available" | "insufficient_history" | "unavailable";
  observationCount: number;
  coverageStart: string | null;
  coverageEnd: string | null;
  coverageHours: number | null;
  /** True when observations span at least 90% of the requested window. */
  fullCoverage: boolean;
  /** Human-readable coverage, e.g. "3 observations spanning 4.3 hours". */
  coverageLabel: string;
  unavailableReason: string | null;
};

/** A server-built chart series: the points plus per-period coverage, so the UI never guesses. */
export type HistoricalSeries = {
  metric: HistoricalMetric;
  providerId: "coingecko" | "defillama";
  scope: "token" | "protocol";
  points: HistoricalPoint[];
  periods: Record<HistoricalPeriod, HistoricalPeriodCoverage>;
  unavailableReason: string | null;
};

export type TokenHistoricalData = {
  tokenId: string;
  /** End of every requested window (server time when the page was built). */
  asOf: string;
  observedAt: string;
  sources?: Partial<Record<HistoricalMetric, MetricSource>>;
  priceUsd: HistoricalSeries;
  tvlUsd: HistoricalSeries;
  volumeUsd: HistoricalSeries;
  marketCapUsd: HistoricalSeries;
};
