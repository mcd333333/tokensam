import type { LiveTokenProfileData, CalculatedMetricView } from "../../types/token.ts";
import type { HistoryChartKey } from "../../types/historical-data.ts";
import type { TechnicalIndicator, TechnicalIndicatorGroup } from "../../types/technical-indicators.ts";
import type { CoverageReason, ProviderCoverage } from "../../data/provider-coverage.ts";
import { metricLabel, metricSection, presentMetric, type MetricDisplay } from "./calculated.ts";
import { formatChange, formatCount, formatShare, formatSupply, formatUsd, horizonLabel, isValidNumber, type Horizon, type Interval, type Tone } from "./format.ts";
import { TECHNICAL_PROVENANCE, datasetLabel, plainLanguage } from "./data-language.ts";

/**
 * Token Profile view model. Builds only what has valid data: a metric with
 * no valid value is omitted (a numeric zero is valid), and a section with
 * nothing meaningful becomes a single contextual note. Each section holds
 * one data scope — token, protocol, or market — and never mixes them.
 */

export type Card = { id: string; label: string; value: string; tone: Tone; note?: string; title?: string; interval?: Interval | null };
/** A main Market Snapshot card paired with its own horizon-pinned change, for column-matched display. */
export type SnapshotPair = { id: string; main: Card; change: Card | null };
export type SectionNote = { title: string; reason: string };
/** Circulating vs maximum supply. `barPct` is clamped to 0–100 for drawing; `circulatingPct` is the actual ratio. */
export type SupplyComposition = { circulatingPct: number; remainingPct: number; barPct: number; circulating: string; maximum: string; symbol: string };
/** One on-chain pool row for the DEX Markets pool list. */
export type PoolRow = { id: string; dexLabel: string; pairAddress: string; liquidity: string | null; volume24h: string | null };
/** One exchange row: its name, share of its group's listed volume and its 24h volume for this token. */
export type ExchangeRow = { id: string; name: string; pairs: number; volume24h: string; sharePct: number };
export type ExchangeGroup = { kind: "cex" | "dex"; title: string; total: string | null; rows: ExchangeRow[] };
export type SectionId =
  | "overview" | "market" | "fundamentals" | "tokenomics" | "market-structure" | "dex-markets" | "exchanges" | "onchain-identity"
  | "history" | "technical" | "analysis" | "sources";

export type ProfileModel = {
  snapshot: { cards: Card[]; changes: Card[]; pairs: SnapshotPair[] };
  /** Historical Signals: token-scope market series, plus the associated protocol's TVL series (kept separate by scope). */
  history: { available: true; series: HistoryChartKey[]; tvl: boolean } | { available: false; note: SectionNote };
  fundamentals:
    | { available: true; protocolName: string; scopeLine: string; primary: Card[]; valuation: Card[]; changes: Card[] }
    | { available: false; note: SectionNote };
  marketStructure: { available: true; scopeLine: string; cards: Card[] } | { available: false; note: SectionNote };
  /** On-chain DEX pools (DEX Screener, up to 30 per token): pool-level data (DEX, pool, liquidity, volume), distinct from the trading aggregate above. */
  dexMarkets: { available: true; scopeLine: string; cards: Card[]; dexes: string[]; pools: PoolRow[] } | { available: false; note: SectionNote };
  /** Exchange listings (centralised and decentralised) with each exchange's own 24h volume (daily snapshot); omitted when none is stored. */
  exchanges: { available: true; scopeLine: string; groups: ExchangeGroup[]; asOf: string } | { available: false };
  /** Network + exact contract address for this token's on-chain identity. */
  onchainIdentity: { available: true; network: string; contractAddress: string } | { available: false; note: SectionNote };
  tokenomics: { available: true; items: Card[]; circulatingOfMaxPct: number | null; composition: SupplyComposition | null } | { available: false; note: SectionNote };
  /** Technical indicator categories (price action, volume, on-chain); cross-metric groups live in `divergence`. */
  technical: TechnicalIndicatorGroup[];
  /**
   * Cross-metric divergence: stored cross-scope comparisons and divergence flags from the metrics engine,
   * and the 30-day relationships from the indicator layer. Rendered only when at least one exists.
   */
  divergence: { comparisons: Card[]; signals: Card[]; signalsHorizon: "24h" | Exclude<Horizon, "24H"> | null; indicators: TechnicalIndicator[] };
  sections: { id: SectionId; label: string }[];
  methodology: Methodology;
};

/**
 * Visible methodology is deliberately short. Unavailable/invalid metrics stay
 * in `calculatedMetrics` (status and stored reason) for integrity, debugging,
 * and AI evidence, but are not listed here: a metric that cannot be computed
 * is simply not shown. External provider names live only in `provenance`.
 */
export type Methodology = {
  /** This token's own latest collection per displayed dataset (never a global or page-load time). */
  freshness: { kind: "observation" | "calculation"; label: string; ageLabel: string; state: "current" | "stale" | null; collectedAt: string; observedAt: string | null }[];
  /** Associated protocol name when protocol data is shown (scope reminder). */
  protocolName: string | null;
  referencePrice: { value: string; observedAt: string } | null;
  /** Formulas in scope language; the stored backend text is unchanged. */
  formulas: { label: string; formula: string }[];
  /** Canonical token identity only (chain, contract or mint); never provider-specific IDs or slugs. */
  identifiers: { label: string; value: string; note: string | null }[];
  /** Data provenance: the external service behind each dataset (rendered), and raw collection notes kept for audit (not rendered). */
  provenance: { datasets: { dataset: string; provider: string }[]; notes: string[] };
};

// Price, trading activity, and the risk profile (volatility and drawdown derived from the price series).
const MARKET_HISTORY: HistoryChartKey[] = ["priceUsd", "volumeUsd", "riskProfile"];

function card(id: string, label: string, value: string | null, extra: Partial<Card> = {}): Card | null {
  return value === null ? null : { id, label, value, tone: "neutral", ...extra };
}

/** A horizon-pinned % change (e.g. "Market cap change · 24h"); null/undefined input hides the card. */
function changeCard(id: string, label: string, value: number | null | undefined): Card | null {
  const change = formatChange(value);
  return change ? { id, label, value: change.text, tone: change.tone } : null;
}

/** Changes carry their interval; protocol growth metrics use a normalized 24h comparison window. */
function intervalNote(display: MetricDisplay): string | undefined {
  if (!display.interval) return undefined;
  if (["tvl_growth_pct", "fees_growth_pct", "revenue_growth_pct"].includes(display.id)) {
    return "24h-equivalent change; baseline selected within ±6h of 24h earlier.";
  }
  if (display.kind === "flag") return `Evaluated ${display.interval.label}${display.interval.isShort ? " (snapshot interval, not a trend)" : ""}`;
  if (display.kind === "change" || display.kind === "points") return `${display.interval.isShort ? "Snapshot change " : ""}${display.interval.label}`;
  return undefined;
}

function fromMetric(display: MetricDisplay): Card {
  const note = intervalNote(display);
  return { id: display.id, label: display.label, value: display.value, tone: display.tone, note, title: display.interval?.range, interval: display.interval };
}

const present = <T>(items: (T | null)[]): T[] => items.filter((item): item is T => item !== null);

/** Stored metrics comparing two datasets (e.g. price change vs TVL growth, in percentage points). */
const isComparison = (id: string) => id.includes("_vs_");

/** One concise reason per unavailable DEX mapping, from the curated reason code (no wrapped substitution). */
function dexReason(reason: CoverageReason | null, isNative: boolean): string {
  if (reason === "wrapped_representation_only") return "Native asset has no canonical token address; wrapped assets are not substituted.";
  if (reason === "no_provider_data") return "No on-chain DEX market was found for this asset's canonical token identifier; wrapped assets are not substituted.";
  if (reason === "native_asset_lacks_provider_identifier" || isNative) return "No canonical token market is currently available for this native asset; wrapped assets are not substituted.";
  return "No canonical token market is currently available for this asset.";
}

/** Turns a raw on-chain DEX identifier ("uniswap_v3") into a readable label ("Uniswap V3"). Not a provider name. */
function humanizeDexId(id: string): string {
  return id.split(/[-_]/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
}

export function buildProfileModel(data: LiveTokenProfileData): ProfileModel {
  const { token, calculatedMetrics } = data;
  const coverageFor = (provider: ProviderCoverage["provider"]) => data.coverage.find((item) => item.provider === provider);
  const protocolMapped = coverageFor("defillama")?.status === "mapped" && data.protocol !== null;
  const dexCoverage = coverageFor("dexscreener");
  const dexMapped = dexCoverage?.status === "mapped";
  const displays = new Map(present(calculatedMetrics.map(presentMetric)).map((display) => [display.id, display]));
  const metric = (id: string) => displays.get(id);
  const inSection = (section: ReturnType<typeof metricSection>, category: CalculatedMetricView["category"]) =>
    calculatedMetrics.filter((item) => item.category === category && metricSection(item) === section)
      .map((item) => displays.get(item.id)).filter((item): item is MetricDisplay => item !== undefined).map(fromMetric);

  // A. Market snapshot: token scope only. On-chain trading conditions live in their own
  // Trading & Liquidity section (see D below) rather than being echoed here too.
  //
  // Market-cap changes and volume/market-cap changes compare consecutive completed
  // UTC-day market-cap values. Recent days may be point-in-time snapshots after retention
  // switched from daily averages. Volume change remains a rolling 24-hour comparison.
  const volumeToMcap = metric("volume_to_market_cap");
  const marketCapCard = card("market_cap", "Market cap", formatUsd(token.marketCapUsd, true));
  const volumeCard = card("volume_24h", "Volume · 24h", formatUsd(token.volume24hUsd, true));
  const volumeToMcapCard = volumeToMcap ? fromMetric(volumeToMcap) : null;
  const marketCapChange = changeCard("market_cap_change_daily_average", "Market cap change · daily", token.marketCapChangeDailyAveragePct);
  const volumeChange = changeCard("volume_change_24h", "Volume change · 24h", token.volumeChange24hPct);
  const volumeToMcapChange = changeCard("volume_to_market_cap_change_daily_average", "Volume / market cap change · daily", token.volumeToMarketCapChangeDailyAveragePct);
  const snapshot = {
    cards: present([marketCapCard, volumeCard, volumeToMcapCard]),
    changes: present([marketCapChange, volumeChange, volumeToMcapChange]),
    /** Each main card paired with its own change card directly beneath it, for column-matched display. */
    pairs: present([
      marketCapCard ? { id: "market_cap", main: marketCapCard, change: marketCapChange } : null,
      volumeCard ? { id: "volume_24h", main: volumeCard, change: volumeChange } : null,
      volumeToMcapCard ? { id: "volume_to_market_cap", main: volumeToMcapCard, change: volumeToMcapChange } : null,
    ]),
  };

  // B. Market history: token-scope series with at least one stored point; protocol TVL only with a curated mapping.
  const historySeries = MARKET_HISTORY.filter((key) => data.history[key === "riskProfile" ? "priceUsd" : key].points.length > 0);
  const tvlHistory = protocolMapped && data.history.tvlUsd.points.length > 0;
  const history: ProfileModel["history"] = historySeries.length > 0 || tvlHistory
    ? { available: true, series: historySeries, tvl: tvlHistory }
    : { available: false, note: { title: "Market history", reason: "No stored market observations fall within the last 90 days." } };

  // C. Fundamentals: protocol scope, only with a curated protocol association and stored data.
  let fundamentals: ProfileModel["fundamentals"];
  if (!protocolMapped) {
    fundamentals = {
      available: false,
      note: {
        title: "Protocol fundamentals",
        reason: data.isNative
          ? "No associated protocol is mapped to this native asset. Chain-level TVL is not attributed to the token."
          : "No associated protocol is mapped to this token.",
      },
    };
  } else {
    const tvlChange = formatChange(token.tvlChange30dPct);
    const primary = present([
      card("tvl", "TVL", formatUsd(token.tvlUsd, true), { note: "Associated protocol" }),
      tvlChange ? { id: "tvl_30d", label: "TVL change · 30D", value: tvlChange.text, tone: tvlChange.tone, note: "Observations ~30 days apart" } : null,
      card("fees_24h", "Fees · 24h", formatUsd(token.fees24hUsd, true)),
      card("revenue_24h", "Revenue · 24h", formatUsd(token.revenue24hUsd, true)),
    ]);
    const valuation = inSection("fundamentals", "valuation");
    // Token-vs-protocol comparisons (percentage points) belong to Cross-Metric Divergence, not here.
    const changes = inSection("fundamentals", "growth").filter((item) => !isComparison(item.id));
    const protocol = data.protocol!;
    fundamentals = primary.length + valuation.length + changes.length > 0
      ? {
        available: true,
        protocolName: protocol.name,
        scopeLine: `Describes the associated protocol, not the token itself${protocol.aggregatesVersions ? ` · covers every ${protocol.name} version` : ""}.`,
        primary, valuation, changes,
      }
      : { available: false, note: { title: "Protocol fundamentals", reason: `No protocol fundamentals are stored yet for the associated protocol (${protocol.name}).` } };
  }

  // D. Market structure: market scope, exact-address DEX pairs only.
  let marketStructure: ProfileModel["marketStructure"];
  if (!dexMapped) {
    marketStructure = { available: false, note: { title: "DEX markets", reason: dexReason(dexCoverage?.reason ?? null, data.isNative) } };
  } else {
    const { transactions24h, buys24h, sells24h } = data.dexActivity;
    const counts = [formatCount(buys24h) && `${formatCount(buys24h)} buys`, formatCount(sells24h) && `${formatCount(sells24h)} sells`].filter(Boolean).join(" · ");
    const aggregateLiquidity = metric("dex_aggregate_liquidity_usd");
    const primaryLiquidity = metric("dex_primary_pair_liquidity_usd");
    const aggregateVolume = metric("dex_aggregate_volume_24h_usd");
    const primaryVolume = metric("dex_primary_pair_volume_24h_usd");
    // Primary-pair values only add information when more than one pair is aggregated.
    const distinct = (primary: MetricDisplay | undefined, aggregate: MetricDisplay | undefined) =>
      primary && (!aggregate || primary.value !== aggregate.value) ? fromMetric(primary) : null;
    const primaryShare = metric("dex_liquidity_to_market_cap_pct");
    const aggregateShare = metric("dex_aggregate_liquidity_to_market_cap_pct");
    const cards = present([
      aggregateLiquidity ? { ...fromMetric(aggregateLiquidity), note: "On-chain DEX markets" } : null,
      aggregateVolume ? fromMetric(aggregateVolume) : null,
      metric("dex_volume_to_liquidity") ? fromMetric(metric("dex_volume_to_liquidity")!) : null,
      card("transactions_24h", "Transactions · 24h", formatCount(transactions24h), counts ? { note: counts } : {}),
      metric("dex_buy_sell_ratio") ? fromMetric(metric("dex_buy_sell_ratio")!) : null,
      aggregateShare ? fromMetric(aggregateShare) : null,
      distinct(primaryLiquidity, aggregateLiquidity),
      distinct(primaryVolume, aggregateVolume),
      distinct(primaryShare, aggregateShare),
    ]);
    marketStructure = cards.length > 0
      ? { available: true, scopeLine: "On-chain DEX trading conditions for this exact token address; centralised exchanges excluded.", cards }
      : { available: false, note: { title: "DEX markets", reason: "No exact-address DEX market data is currently stored for this token." } };
  }

  // D2. DEX Markets (DEX Screener pool snapshot): market scope, exact-address identity only. This is separate,
  // pool-level data (individual pools/DEXes) rather than a second copy of the Trading & Liquidity
  // aggregate above; both are shown, clearly separate, rather than merging or picking a "winning" provider.
  let dexMarkets: ProfileModel["dexMarkets"];
  let onchainIdentity: ProfileModel["onchainIdentity"];
  const onchain = data.onchainMarkets;
  if (!onchain) {
    const reason = "No canonical on-chain network/address identity is currently available for this asset; wrapped assets are not substituted.";
    dexMarkets = { available: false, note: { title: "DEX markets", reason } };
    onchainIdentity = { available: false, note: { title: "Contract / on-chain identity", reason } };
  } else {
    onchainIdentity = onchain.contractAddress
      ? { available: true, network: onchain.network ?? "Unknown network", contractAddress: onchain.contractAddress }
      : { available: false, note: { title: "Contract / on-chain identity", reason: "No contract address is recorded for this token's on-chain identity." } };
    if (onchain.pools.length === 0) {
      dexMarkets = { available: false, note: { title: "DEX markets", reason: "No on-chain DEX pools were found for this token's exact network and address." } };
    } else {
      const priceChange = formatChange(onchain.priceChange24hPct);
      const cards = present([
        card("gt_liquidity", "DEX liquidity", formatUsd(onchain.liquidityUsd, true), { note: "Most liquid on-chain pool" }),
        card("gt_volume", "DEX volume · 24h", formatUsd(onchain.volume24hUsd, true), { note: "Summed across on-chain pools" }),
        priceChange ? { id: "gt_price_change", label: "Price change · 24h", value: priceChange.text, tone: priceChange.tone } : null,
        card("gt_fdv", "Fully diluted valuation", formatUsd(onchain.fdvUsd, true)),
        card("gt_market_cap", "Market cap", formatUsd(onchain.marketCapUsd, true)),
      ]);
      const pools: PoolRow[] = [...onchain.pools]
        .sort((a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1))
        .map((pool) => ({
          id: pool.pairAddress,
          dexLabel: pool.dexId ? humanizeDexId(pool.dexId) : "Unknown DEX",
          pairAddress: pool.pairAddress,
          liquidity: formatUsd(pool.liquidityUsd, true),
          volume24h: formatUsd(pool.volume24hUsd, true),
        }));
      dexMarkets = cards.length > 0 || pools.length > 0
        ? {
          available: true,
          scopeLine: "On-chain DEX pools for this exact token address, across every decentralized exchange it was found on.",
          cards,
          dexes: onchain.dexes.map(humanizeDexId),
          pools,
        }
        : { available: false, note: { title: "DEX markets", reason: "No on-chain DEX market data is currently stored for this token." } };
    }
  }

  // D3. Exchanges: where the token is listed and its 24h volume on each (CoinGecko tickers, refreshed once a
  // day), split into centralised and decentralised venues. This covers every token, unlike DEX Markets
  // above, which needs an on-chain address mapping and shows individual pools.
  const exchangeData = data.exchangeVolumes;
  const exchangeGroups: ExchangeGroup[] = exchangeData
    ? (["cex", "dex"] as const).flatMap((kind) => {
      const items = exchangeData.exchanges.filter((item) => item.kind === kind);
      if (items.length === 0) return [];
      const total = items.reduce((sum, item) => sum + item.volumeUsd, 0);
      return [{
        kind,
        title: kind === "cex" ? "Centralised exchanges" : "Decentralised exchanges",
        total: formatUsd(total, true),
        rows: items.map((item) => ({
          id: item.id,
          name: item.name,
          pairs: item.pairs,
          volume24h: formatUsd(item.volumeUsd, true) ?? "—",
          sharePct: total > 0 ? (item.volumeUsd / total) * 100 : 0,
        })),
      }];
    })
    : [];
  const exchanges: ProfileModel["exchanges"] = exchangeData && exchangeGroups.length > 0
    ? {
      available: true,
      scopeLine: "Where this token trades, with its own 24-hour trading volume on each exchange, split into centralised and decentralised venues. Updated daily; shares are within each group.",
      groups: exchangeGroups,
      asOf: exchangeData.fetchedAt,
    }
    : { available: false };

  // E. Tokenomics: token-scope supply; a missing maximum is hidden, never labelled "uncapped".
  const supply = (value: number | null) => formatSupply(value) === null ? null : `${formatSupply(value)} ${token.symbol}`;
  // FDV is the token-level value reported in the stored market-data record, never derived here or taken from DEX data.
  const fdv = isValidNumber(token.fdvUsd) && token.fdvUsd > 0 ? token.fdvUsd : null;
  const mcapOfFdv = fdv !== null && isValidNumber(token.marketCapUsd) && token.marketCapUsd > 0 ? (token.marketCapUsd / fdv) * 100 : null;
  const items = present([
    card("circulating_supply", "Circulating supply", supply(data.circulatingSupply)),
    card("total_supply", "Total supply", supply(data.totalSupply)),
    card("maximum_supply", "Maximum supply", supply(data.maximumSupply)),
    card("fdv", "Fully diluted valuation", formatUsd(fdv, true), { note: "As reported with market data" }),
    card("market_cap_of_fdv", "Market cap / FDV", mcapOfFdv === null ? null : formatShare(mcapOfFdv), { note: "Share of fully diluted value already circulating" }),
  ]);
  const circulatingOfMaxPct = isValidNumber(data.circulatingSupply) && isValidNumber(data.maximumSupply) && data.maximumSupply > 0
    ? (data.circulatingSupply / data.maximumSupply) * 100
    : null;
  // Supply composition: shown only when both figures exist (a missing maximum is never treated as zero).
  const composition: SupplyComposition | null = circulatingOfMaxPct === null ? null : {
    circulatingPct: circulatingOfMaxPct,
    remainingPct: Math.max(0, 100 - circulatingOfMaxPct),
    barPct: Math.min(100, Math.max(0, circulatingOfMaxPct)),
    circulating: formatSupply(data.circulatingSupply)!,
    maximum: formatSupply(data.maximumSupply)!,
    symbol: token.symbol,
  };
  const tokenomics: ProfileModel["tokenomics"] = items.length > 0
    ? { available: true, items, circulatingOfMaxPct, composition }
    : { available: false, note: { title: "Tokenomics", reason: "No supply figures are reported for this token." } };

  // F. Technical indicators and G. cross-metric divergence. Availability is decided server-side; this only places groups.
  const groups = data.technicalIndicators?.groups ?? [];
  const technical = groups.filter((group) => group.category !== "divergence");
  // The metrics engine normalizes comparisons and flags to a compounded 24-hour
  // equivalent despite modest provider timestamp drift; source times remain in provenance.
  const crossMetricHorizon = (hours: number | undefined): "24h" | Exclude<Horizon, "24H"> => {
    const horizon = horizonLabel(hours);
    return horizon === "24H" ? "24h" : horizon;
  };
  const withHorizon = (item: Card): Card => ({
    ...item,
    label: `${item.label} · ${crossMetricHorizon(item.interval?.hours)}`,
    note: item.interval?.hours === 24 ? "Compounded 24h-equivalent changes; provider timestamps may differ by up to 6h." : item.interval ? `Measured ${item.interval.label}` : item.note,
  });
  const signals = protocolMapped ? inSection("fundamentals", "divergence") : [];
  const comparisons = protocolMapped
    ? inSection("fundamentals", "growth").filter((item) => isComparison(item.id)).map(withHorizon)
    : [];
  if (protocolMapped) {
    for (const id of ["price_change_vs_revenue_growth_pct_points", "market_cap_change_vs_revenue_growth_pct_points"]) {
      if (comparisons.some((item) => item.id === id)) continue;
      const stored = calculatedMetrics.find((item) => item.id === id);
      if (!stored) continue;
      const display = presentMetric(stored);
      if (display) {
        comparisons.push(withHorizon(fromMetric(display)));
      } else {
        comparisons.push({
          id,
          label: `${metricLabel(stored)} · 24h`,
          value: "Data unavailable",
          tone: "neutral",
          note: stored.unavailableReason ?? "Insufficient aligned history for a 24-hour comparison.",
        });
      }
    }
  }
  const divergence: ProfileModel["divergence"] = {
    comparisons,
    signals,
    signalsHorizon: signals.length > 0 ? crossMetricHorizon(signals.find((item) => item.interval)?.interval?.hours) : null,
    indicators: groups.find((group) => group.category === "divergence")?.indicators ?? [],
  };
  const hasCrossMetric = divergence.comparisons.length + divergence.signals.length + divergence.indicators.length > 0;

  // Research order: overview → market → fundamentals → tokenomics → history (evidence) → trading &
  // liquidity (current on-chain trading conditions) → technical (derived from history, with
  // cross-metric analysis inside) → AI → sources. Sections without data are omitted. The
  // "market-structure" id is kept stable (deep links, scroll targets, tests) even though its
  // visible label is now "Trading & Liquidity".
  const sections: ProfileModel["sections"] = [
    { id: "overview", label: "Overview" },
    { id: "market", label: "Market" },
    ...(fundamentals.available ? [{ id: "fundamentals" as const, label: "Fundamentals" }] : []),
    ...(tokenomics.available ? [{ id: "tokenomics" as const, label: "Tokenomics" }] : []),
    ...(history.available ? [{ id: "history" as const, label: "History" }] : []),
    ...(marketStructure.available ? [{ id: "market-structure" as const, label: "Trading & Liquidity" }] : []),
    ...(dexMarkets.available ? [{ id: "dex-markets" as const, label: "DEX Markets" }] : []),
    ...(exchanges.available ? [{ id: "exchanges" as const, label: "Exchanges" }] : []),
    ...(onchainIdentity.available ? [{ id: "onchain-identity" as const, label: "On-chain Identity" }] : []),
    // Cross-metric analysis is a subsection of Technical, not its own nav item.
    ...(technical.length > 0 || hasCrossMetric ? [{ id: "technical" as const, label: "Technical" }] : []),
    { id: "analysis", label: "AI Analysis" },
    { id: "sources", label: "Sources" },
  ];

  return { snapshot, history, fundamentals, marketStructure, dexMarkets, exchanges, onchainIdentity, tokenomics, technical, divergence, sections, methodology: buildMethodology(data, { protocolMapped, dexMapped }) };
}

function buildMethodology(data: LiveTokenProfileData, mapped: { protocolMapped: boolean; dexMapped: boolean }): Methodology {
  const available = data.calculatedMetrics.filter((item) => item.status === "available" && isValidNumber(item.value));
  const freshness = (data.datasetFreshness ?? [])
    // Defensive: never show a dataset whose section is not shown for this token.
    .filter((item) => (item.id !== "defillama" || mapped.protocolMapped) && (item.id !== "dexscreener" || mapped.dexMapped))
    .map((item) => ({ kind: item.id === "metrics" ? "calculation" as const : "observation" as const, label: datasetLabel(item.id, item.label), ageLabel: item.ageLabel, state: item.state, collectedAt: item.collectedAt, observedAt: item.observedAt }));

  const identifiers = [
    { label: "Chain", value: data.token.chain, note: null },
    { label: "Contract / mint", value: data.isNative ? "Native asset — no contract" : data.contractAddress ?? "Not recorded", note: null },
  ];

  return {
    freshness,
    protocolName: mapped.protocolMapped && data.protocol ? data.protocol.name : null,
    referencePrice: data.tokenLevelPrice ? { value: formatUsd(data.tokenLevelPrice.value) ?? "", observedAt: data.tokenLevelPrice.observedAt } : null,
    formulas: available.map((item) => ({ label: metricLabel(item), formula: plainLanguage(item.formula) })),
    identifiers,
    provenance: { datasets: TECHNICAL_PROVENANCE, notes: data.dataNotes },
  };
}
