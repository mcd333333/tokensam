/**
 * Token Samurai profile payload: the one canonical, compact representation of
 * what the Token Profile page shows. It is built from the same
 * LiveTokenProfileData and the same display functions the page renders with
 * (buildProfileModel, the history-chart helpers, the indicator formatter), so
 * the page, the "Copy data" text, and the AI analysis input cannot disagree.
 *
 * Pure and deterministic: the same profile data always yields the same payload
 * (no clock, no randomness, no provider-specific content). Values that are not
 * shown because no valid value is stored are listed as "Not reported", never
 * as zero; a legitimate zero is a value.
 *
 * Every field carries an evidence ID for the existing evidence contract:
 * obs: (a displayed observation), calc: (a displayed calculation), hist: (a
 * displayed history window), scope: (a displayed scope/availability note),
 * fresh: (a displayed data-freshness row), and token (identity).
 */

import type { LiveTokenProfileData } from "../../types/token.ts";
import type { HistoricalMetric } from "../../types/historical-data.ts";
import type { TechnicalIndicator } from "../../types/technical-indicators.ts";
import { buildProfileModel, type Card } from "../ui/profile-model.ts";
import { formatChange, formatDuration, formatUsd, formatUtc, isValidNumber } from "../ui/format.ts";
import { formatReading } from "../ui/indicator-format.ts";
import { presentMetric } from "../ui/calculated.ts";
import { HISTORICAL_PERIODS, coverageChangePct, pointsInPeriod, riskProfile } from "../data/historical-series.ts";

export const PROFILE_PAYLOAD_VERSION = "profile-1";

export type PayloadScope = "token" | "protocol" | "market" | "calculated";

export type PayloadField = {
  /** Evidence ID cited by the AI report (see module comment). */
  id: string;
  section: string;
  label: string;
  /** The value exactly as displayed. */
  value: string;
  /** The stored number behind the displayed value (null when not reported). */
  raw: number | null;
  status: "shown" | "not_reported";
  scope: PayloadScope;
  /** Exact period label; a statement citing this field must copy it when periodRequired. */
  period: string | null;
  periodRequired: boolean;
  note: string | null;
  asOf: string | null;
  /**
   * The real measured duration (hours) of a calculated metric's own aligned interval, when known —
   * the same number already computed for display (see ui/format.ts's `intervalBetween`), never
   * inferred from a label string. Distinguishes a genuine multi-day comparison from a
   * snapshot-to-snapshot one (e.g. ~1 hour) for the deterministic engine's horizon classification.
   * `null` when the interval could not be established (never treated as "known to be short").
   */
  intervalHours: number | null;
  /**
   * A technical indicator's own neutral, rule-defined state string (e.g. "At or above the 70
   * level", "MACD line above signal line" — see types/technical-indicators.ts's `TechnicalIndicator.state`),
   * carried verbatim rather than re-parsed from the field's formatted `note` text. `null` for every
   * field that isn't a `calc:ind_*` technical-indicator reading, and for one whose indicator has no
   * categorical state (e.g. Bollinger Bands, whose position is read from `technicalReadings` instead).
   */
  technicalState: string | null;
  /**
   * A technical indicator's own numeric readings, keyed by their own label (e.g. `{"RSI": 61.4}`,
   * `{"%B": 0.82, "Band width": 6.1}`) — the same numbers the card displays, never recomputed. Lets
   * findings.ts read a specific named reading (not just "the first numeric one") without parsing the
   * field's joined display string. `null` for every non-technical-indicator field.
   */
  technicalReadings: Record<string, number> | null;
};

export type ScopeNote = {
  id: string;
  provider: "CoinGecko" | "DeFiLlama" | "DexPaprika";
  /** Curated mapping status for this token (from the profile's coverage record). */
  mapped: boolean;
  statement: string;
};

export type ProfilePayload = {
  version: string;
  token: { id: string; name: string; symbol: string; chain: string; category: string; isNative: boolean; contractAddress: string | null };
  /** The profile's "Data as of" time. */
  dataAsOf: string | null;
  scope: ScopeNote[];
  fields: PayloadField[];
};

const PERIOD_24H = "24H (rolling 24 hours, as reported by the provider)";
const PERIOD_7D = "7D (rolling 7 days, as reported by the provider)";
const PERIOD_30D_TVL = "30D (TVL observations about 30 days apart)";
const PERIOD_MARKET_CAP_CHANGE_DAILY_AVERAGE = "Consecutive completed UTC days (daily-average market cap)";
const PERIOD_VOLUME_CHANGE_24H = "24H (the past 24h volume vs. the preceding 24h volume)";
const PERIOD_VOLUME_TO_MARKET_CAP_CHANGE_DAILY_AVERAGE = "Consecutive completed UTC days (daily-average 24h volume / daily-average market cap)";

function field(input: Omit<PayloadField, "status" | "period" | "periodRequired" | "note" | "asOf" | "raw" | "intervalHours" | "technicalState" | "technicalReadings"> & Partial<Pick<PayloadField, "period" | "note" | "asOf" | "raw" | "intervalHours" | "technicalState" | "technicalReadings">>): PayloadField {
  const period = input.period ?? null;
  return { raw: null, note: null, asOf: null, intervalHours: null, technicalState: null, technicalReadings: null, ...input, period, periodRequired: period !== null, status: "shown" };
}

function notReported(id: string, section: string, label: string, scope: PayloadScope, asOf: string | null = null): PayloadField {
  return { id, section, label, value: "Not reported", raw: null, status: "not_reported", scope, period: null, periodRequired: false, note: "No valid stored value, so the profile does not show one.", asOf, intervalHours: null, technicalState: null, technicalReadings: null };
}

/** Risk-profile percentages exactly as the history chart header formats them. */
function riskPct(value: number): string {
  const text = Math.abs(value).toFixed(1);
  return `${value < 0 && Number(text) !== 0 ? "−" : ""}${text}%`;
}

const SERIES_LABEL: Record<HistoricalMetric, string> = { priceUsd: "Price", volumeUsd: "Volume · 24h", marketCapUsd: "Market cap", tvlUsd: "TVL" };
const SERIES_ID: Record<HistoricalMetric, string> = { priceUsd: "price", volumeUsd: "volume", marketCapUsd: "market_cap", tvlUsd: "tvl" };

/** Build the canonical payload from the data the Token Profile renders. */
export function buildProfilePayload(data: LiveTokenProfileData): ProfilePayload {
  const { token } = data;
  const model = buildProfileModel(data);
  const calculated = new Map(data.calculatedMetrics.map((metric) => [metric.id, metric]));
  const sourceAt = (key: string) => data.metricSources[key]?.collectedAt ?? token.metricSources?.[key as keyof NonNullable<typeof token.metricSources>]?.collectedAt ?? null;
  const fields: PayloadField[] = [];

  // ---- Overview (header): price and provider-reported changes ----
  const overview = "Overview";
  const price = formatUsd(token.priceUsd);
  fields.push(price ? field({ id: "obs:price", section: overview, label: "Price", value: price, raw: token.priceUsd, scope: "token", asOf: sourceAt("priceUsd") }) : notReported("obs:price", overview, "Price", "token"));
  for (const [id, label, value, period, key] of [
    ["obs:change_24h", "Price change · 24h", token.change24hPct, PERIOD_24H, "change24hPct"],
    ["obs:change_7d", "Price change · 7d", token.change7dPct, PERIOD_7D, "change7dPct"],
  ] as const) {
    const change = formatChange(value);
    fields.push(change ? field({ id, section: overview, label, value: change.text, raw: value, scope: "token", period, asOf: sourceAt(key) }) : notReported(id, overview, label, "token"));
  }

  // Cards are converted with their displayed label/value; the stored number comes from the same data.
  const fromCard = (card: Card, section: string, scope: PayloadScope, observed: Record<string, { id: string; raw: number | null | undefined; period?: string; asOfKey?: string }>) => {
    const metric = calculated.get(card.id);
    if (metric) {
      // Only changes, percentage-point comparisons, and flags are measured over an interval (as the page labels
      // them); ratios and levels are point-in-time values even when their inputs were observed apart.
      const kind = presentMetric(metric)?.kind;
      const period = card.interval && (kind === "change" || kind === "points" || kind === "flag") ? (card.note ?? card.interval.label) : null;
      const note = [card.interval?.range ? `Measured ${card.interval.range}` : null, metric.sourceScopes ? `Input scopes: ${metric.sourceScopes}` : null].filter(Boolean).join(" · ") || null;
      return field({ id: `calc:${card.id}`, section, label: card.label, value: card.value, raw: metric.value, scope: "calculated", period, note, asOf: metric.calculatedAt, intervalHours: card.interval?.hours ?? null });
    }
    const known = observed[card.id];
    return field({
      id: known?.id ?? `obs:${card.id}`, section, label: card.label, value: card.value, raw: known?.raw ?? null, scope,
      period: known?.period ?? null, note: card.note ?? null, asOf: known?.asOfKey ? sourceAt(known.asOfKey) : null,
    });
  };

  // ---- Market snapshot (token scope) ----
  const market = "Market snapshot";
  const marketObserved = {
    market_cap: { id: "obs:market_cap", raw: token.marketCapUsd, asOfKey: "marketCapUsd" },
    volume_24h: { id: "obs:volume_24h", raw: token.volume24hUsd, period: PERIOD_24H, asOfKey: "volume24hUsd" },
    // Presentation changes computed directly in buildDashboardTokens (not the calculated-metrics
    // engine), so they are never in `calculated` -- given explicit raw values here instead of
    // falling through fromCard's calculated.get(card.id) lookup (which would leave them ungrounded).
    market_cap_change_daily_average: { id: "calc:market_cap_change_daily_average", raw: token.marketCapChangeDailyAveragePct, period: PERIOD_MARKET_CAP_CHANGE_DAILY_AVERAGE, asOfKey: "marketCapChangeDailyAveragePct" },
    volume_change_24h: { id: "calc:volume_change_24h", raw: token.volumeChange24hPct, period: PERIOD_VOLUME_CHANGE_24H, asOfKey: "volumeChange24hPct" },
    volume_to_market_cap_change_daily_average: { id: "calc:volume_to_market_cap_change_daily_average", raw: token.volumeToMarketCapChangeDailyAveragePct, period: PERIOD_VOLUME_TO_MARKET_CAP_CHANGE_DAILY_AVERAGE, asOfKey: "volumeToMarketCapChangeDailyAveragePct" },
  };
  for (const card of [...model.snapshot.cards, ...model.snapshot.changes]) fields.push(fromCard(card, market, "token", marketObserved));
  if (!model.snapshot.cards.some((card) => card.id === "market_cap")) fields.push(notReported("obs:market_cap", market, "Market cap", "token"));
  if (!model.snapshot.cards.some((card) => card.id === "volume_24h")) fields.push(notReported("obs:volume_24h", market, "Volume · 24h", "token"));

  // price_growth_pct is no longer shown as a Market Snapshot card (replaced by the horizon-pinned
  // market cap / volume change cards above), but it's still computed and stored server-side, and
  // the AI evidence contract still needs to be able to cite it -- so it's added directly here
  // rather than depending on being displayed, the same as obs:change_24h/obs:change_7d above.
  const priceGrowth = calculated.get("price_growth_pct");
  const priceGrowthDisplay = priceGrowth ? presentMetric(priceGrowth) : null;
  if (priceGrowth && priceGrowthDisplay) {
    fields.push(field({
      id: "calc:price_growth_pct", section: market, label: priceGrowthDisplay.label, value: priceGrowthDisplay.value, raw: priceGrowth.value,
      scope: "token", period: priceGrowthDisplay.interval?.label ?? null,
      note: priceGrowthDisplay.interval?.range ? `Measured ${priceGrowthDisplay.interval.range}` : null,
      asOf: priceGrowth.calculatedAt, intervalHours: priceGrowthDisplay.interval?.hours ?? null,
    }));
  }

  // ---- Fundamentals (associated-protocol scope) ----
  if (model.fundamentals.available) {
    const section = `Fundamentals (associated protocol: ${model.fundamentals.protocolName})`;
    const protocolObserved = {
      tvl: { id: "obs:tvl", raw: token.tvlUsd, asOfKey: "tvlUsd" },
      tvl_30d: { id: "calc:tvl_change_30d", raw: token.tvlChange30dPct, period: PERIOD_30D_TVL, asOfKey: "tvlChange30dPct" },
      fees_24h: { id: "obs:fees_24h", raw: token.fees24hUsd, period: PERIOD_24H, asOfKey: "fees24hUsd" },
      revenue_24h: { id: "obs:revenue_24h", raw: token.revenue24hUsd, period: PERIOD_24H, asOfKey: "revenue24hUsd" },
    };
    for (const card of [...model.fundamentals.primary, ...model.fundamentals.valuation, ...model.fundamentals.changes]) {
      fields.push(fromCard(card, section, "protocol", protocolObserved));
    }
  }

  // ---- Tokenomics (token scope) ----
  const tokenomics = "Tokenomics";
  const tokenomicsObserved = {
    circulating_supply: { id: "obs:circulating_supply", raw: data.circulatingSupply, asOfKey: "circulating_supply" },
    total_supply: { id: "obs:total_supply", raw: data.totalSupply, asOfKey: "total_supply" },
    maximum_supply: { id: "obs:maximum_supply", raw: data.maximumSupply, asOfKey: "maximum_supply" },
    fdv: { id: "obs:fdv", raw: token.fdvUsd ?? null, asOfKey: "fdvUsd" },
    market_cap_of_fdv: { id: "calc:market_cap_of_fdv", raw: null },
  };
  const shownTokenomics = model.tokenomics.available ? model.tokenomics.items : [];
  for (const card of shownTokenomics) {
    const converted = fromCard(card, tokenomics, "token", tokenomicsObserved);
    if (card.id === "market_cap_of_fdv" && isValidNumber(token.marketCapUsd) && isValidNumber(token.fdvUsd) && token.fdvUsd > 0) converted.raw = (token.marketCapUsd / token.fdvUsd) * 100;
    if (card.id === "market_cap_of_fdv") converted.scope = "calculated";
    fields.push(converted);
  }
  if (model.tokenomics.available && model.tokenomics.composition) {
    const composition = model.tokenomics.composition;
    fields.push(field({
      id: "calc:circulating_of_max_supply", section: tokenomics, label: "Circulating share of maximum supply",
      value: `${composition.circulatingPct.toFixed(1)}% circulating (${composition.circulating} of ${composition.maximum} ${composition.symbol})`,
      raw: composition.circulatingPct, scope: "calculated",
    }));
  }
  for (const [card, label] of [["circulating_supply", "Circulating supply"], ["total_supply", "Total supply"], ["maximum_supply", "Maximum supply"]] as const) {
    if (!shownTokenomics.some((item) => item.id === card)) fields.push(notReported(`obs:${card}`, tokenomics, label, "token"));
  }

  // ---- Market structure (exact-address DEX pairs) ----
  if (model.marketStructure.available) {
    const section = "Market structure (on-chain DEX pairs for this exact token address)";
    const dexObserved = { transactions_24h: { id: "obs:transactions_24h", raw: data.dexActivity.transactions24h, period: PERIOD_24H } };
    for (const card of model.marketStructure.cards) fields.push(fromCard(card, section, "market", dexObserved));
  }

  // ---- Market history: the figures each displayed chart shows, for every period the chart offers ----
  const asOf = new Date(data.history.asOf);
  if (model.history.available) {
    const series: HistoricalMetric[] = [
      ...model.history.series.filter((key): key is HistoricalMetric => key !== "riskProfile"),
      ...(model.history.tvl ? ["tvlUsd" as const] : []),
    ];
    for (const key of series) {
      const history = data.history[key];
      const scope: PayloadScope = key === "tvlUsd" ? "protocol" : "token";
      for (const period of HISTORICAL_PERIODS) {
        const coverage = history.periods[period];
        const points = pointsInPeriod(history.points, period, asOf);
        const latest = points.at(-1);
        const change = coverage.status === "available" ? coverageChangePct(points) : null;
        const id = `hist:${SERIES_ID[key]}_${period.toLowerCase()}`;
        const label = `${SERIES_LABEL[key]} history · ${period}${key === "tvlUsd" ? " (associated protocol)" : ""}`;
        if (!latest) continue;
        const changeText = formatChange(change);
        const value = [`latest ${formatUsd(latest.valueUsd, true)}`, changeText && coverage.coverageHours !== null ? `${changeText.text} over ${formatDuration(coverage.coverageHours)}` : "no trend (fewer than two stored points)"].join(" · ");
        fields.push(field({ id, section: "Market history", label, value, raw: change, scope, period: `${period} window: ${coverage.coverageLabel}`, asOf: latest.timestamp }));
      }
    }
    if (model.history.series.includes("riskProfile")) {
      // The Risk Profile chart uses granular hourly CoinGecko history. Keep the evidence
      // payload aligned with the same calculation rather than falling back to daily closes.
      for (const period of HISTORICAL_PERIODS) {
        const { hourly, volatility, drawdown } = riskProfile(data.history.priceUsd.points, period, asOf);
        const vol = volatility.at(-1)?.valueUsd;
        const dd = drawdown.at(-1)?.valueUsd;
        if (hourly.length < 2 || (vol === undefined && dd === undefined)) continue;
        const value = [vol !== undefined ? `volatility ${riskPct(vol)}` : null, dd !== undefined ? `drawdown ${riskPct(dd)}` : null].filter(Boolean).join(" · ");
        fields.push(field({
          id: `hist:risk_${period.toLowerCase()}`, section: "Market history", label: `Risk profile · ${period}`, value, raw: vol ?? dd ?? null, scope: "token",
          period: `${period} window: ${hourly.length} hourly samples`, note: "Volatility and drawdown from granular hourly price history.", asOf: hourly.at(-1)?.timestamp ?? null,
        }));
      }
    }
  }

  // ---- Technical indicators and cross-metric analysis ----
  const indicatorField = (indicator: TechnicalIndicator, section: string) => {
    const readings = indicator.readings.map((reading) => { const text = formatReading(reading); return text === null ? null : `${reading.label}: ${text}`; }).filter(Boolean).join(" · ");
    const firstNumeric = indicator.readings.find((reading) => typeof reading.value === "number");
    const numericReadings = Object.fromEntries(
      indicator.readings.filter((reading): reading is typeof reading & { value: number } => typeof reading.value === "number").map((reading) => [reading.label, reading.value]),
    );
    return field({
      id: `calc:ind_${indicator.id}`, section, label: indicator.name, value: readings || "—",
      raw: typeof firstNumeric?.value === "number" ? firstNumeric.value : null, scope: "calculated",
      period: indicator.periodLabel, note: [indicator.state, indicator.summary].filter(Boolean).join(" · ") || null, asOf: indicator.provenance.observationEnd,
      technicalState: indicator.state, technicalReadings: Object.keys(numericReadings).length > 0 ? numericReadings : null,
    });
  };
  for (const group of model.technical) for (const indicator of group.indicators) fields.push(indicatorField(indicator, `Technical indicators · ${group.label}`));
  const crossSection = "Cross-metric analysis";
  for (const card of [...model.divergence.comparisons, ...model.divergence.signals]) fields.push(fromCard(card, crossSection, "calculated", {}));
  for (const indicator of model.divergence.indicators) fields.push(indicatorField(indicator, crossSection));

  // ---- Sources & methodology: data freshness and the reference price ----
  for (const row of model.methodology.freshness) {
    fields.push(field({
      id: `fresh:${row.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`, section: "Data freshness", label: row.label,
      value: row.state ? `${row.state} (collected ${formatUtc(row.collectedAt)})` : `collected ${formatUtc(row.collectedAt)}`, scope: "token", asOf: row.collectedAt,
    }));
  }
  if (model.methodology.referencePrice && data.tokenLevelPrice) {
    fields.push(field({
      id: "obs:reference_price", section: "Data freshness", label: "Reference token price", value: model.methodology.referencePrice.value,
      raw: data.tokenLevelPrice.value, scope: "token", note: "Secondary token-level price; it may share upstream data with the primary market data, so it is not independent confirmation.",
      asOf: data.tokenLevelPrice.observedAt,
    }));
  }

  // ---- Scope and availability notes shown on the page ----
  const coverage = (provider: string) => data.coverage.find((item) => item.provider === provider);
  const protocolMapped = coverage("defillama")?.status === "mapped" && data.protocol !== null;
  const dexMapped = coverage("dexpaprika")?.status === "mapped";
  const scope: ScopeNote[] = [
    { id: "scope:coingecko", provider: "CoinGecko", mapped: true, statement: "Market snapshot, overview, tokenomics, and market history are token-level market data." },
    {
      id: "scope:defillama", provider: "DeFiLlama", mapped: protocolMapped,
      statement: model.fundamentals.available ? `Fundamentals: ${model.fundamentals.scopeLine}` : `Fundamentals not shown: ${model.fundamentals.note.reason} (no DeFiLlama protocol mapping for this token, so protocol TVL, fees, and revenue are unavailable by design).`,
    },
    {
      id: "scope:dexpaprika", provider: "DexPaprika", mapped: dexMapped,
      statement: model.marketStructure.available ? `Market structure: ${model.marketStructure.scopeLine}` : `DEX markets not shown: ${model.marketStructure.note.reason}${dexMapped ? "" : " (no verified DexPaprika address mapping for this token, so DEX metrics are unavailable by design)"}.`,
    },
  ];

  return {
    version: PROFILE_PAYLOAD_VERSION,
    token: { id: token.id, name: token.name, symbol: token.symbol, chain: token.chain, category: token.category, isNative: data.isNative, contractAddress: data.contractAddress },
    dataAsOf: data.metricSources.snapshot?.collectedAt ?? null,
    scope,
    fields,
  };
}

/** Human-readable text of the same payload, for the profile's "Copy data" action. */
export function formatProfilePayloadText(payload: ProfilePayload): string {
  const { token } = payload;
  const lines = [
    `TOKEN SAMURAI — ${token.name.toUpperCase()}`,
    `Token: ${token.name} (${token.symbol})`,
    `Chain: ${token.chain}`,
    `Category: ${token.category}`,
    `Contract: ${token.isNative ? "Native asset — no contract" : token.contractAddress ?? "Not recorded"}`,
    `Data as of: ${formatUtc(payload.dataAsOf) ?? "not reported"}`,
  ];
  let section = "";
  for (const item of payload.fields) {
    if (item.section !== section) {
      section = item.section;
      lines.push("", `${section.toUpperCase()}`);
    }
    const extras = [item.period, item.note].filter(Boolean).join(" · ");
    lines.push(`${item.label}: ${item.value}${extras ? ` (${extras})` : ""}`);
  }
  lines.push("", "SCOPE");
  for (const note of payload.scope) lines.push(`${note.provider}: ${note.statement}`);
  return lines.join("\n");
}
