/**
 * Deep Analysis Engine — deterministic synthesis layer (Phase 1 of the research-report redesign).
 *
 * findings.ts answers "what is true and evidence-supported here?" one Finding at a time. This
 * module answers the question findings.ts and narrative.ts were never built to answer: "of
 * everything that's true, what actually matters, and how much temporal/analytical weight does it
 * carry?" It sits strictly between the two: it consumes `Finding[]` and produces a structured,
 * still-prose-free `SynthesisResult` — relationships, redundancy groups, and a short list of
 * Thesis Drivers — that a later narrative layer can render into report text.
 *
 * Hard invariants (do not weaken these while extending this module):
 * - No prose. Every output here is a structured object; only IDs, enums, and numbers.
 * - No invented evidence. Every Relationship/ThesisDriver's `findingIds`/`evidenceIds` are a subset
 *   of the IDs already present on the `Finding[]` it was built from — this module only groups and
 *   scores what findings.ts already extracted and grounded.
 * - Fully deterministic. Same `Finding[]` in (same values, same order or not — see below) always
 *   produces the same `SynthesisResult` out: no `Date.now()`, no `Math.random()`, no reliance on
 *   object/array iteration order beyond what is explicitly sorted with a documented, stable
 *   tie-breaker.
 * - Findings never carry their own persistent ID (findings.ts intentionally doesn't add one — see
 *   its own module comment on staying a thin, construction-time extraction layer). This module
 *   derives a stable `findingId` from a finding's own category + type + evidence instead, which
 *   requires no change to findings.ts and is exactly as stable as the finding's own content.
 */

import type { Finding, FindingCategory, FindingSeverity, MultiHorizonPattern } from "./findings.ts";

// ---- Stable, derived finding identity (no change to findings.ts required) ----

/** Deterministic, content-derived identity for a Finding — stable across runs for the same evidence. */
export function findingId(finding: Finding): string {
  return `${finding.category}:${finding.findingType}:${finding.evidenceIds.join("+")}`;
}

// ---- 1. Horizon classification ----

/**
 * How much temporal weight a finding's evidence can support:
 * - "snapshot": a point-in-time read with no time dimension at all (a ratio, a current supply
 *   share, a current ranking of a metric against another) — per the brief, this explicitly
 *   includes current FDV/MC and current supply-share reads, which fluctuate with price/mint
 *   events and must never be read as a trend merely because they look large.
 * - "short_term": a change measured over <=7 days (24H/7D price change; the metrics engine's own
 *   "aligned interval" divergence/percentage-point comparisons, whose actual duration is not
 *   guaranteed to be long — it can be minutes — so these are never promoted past short_term here
 *   regardless of how the underlying interval happens to be labelled).
 * - "medium_term": a ~30-day-scale comparison (30D price window; TVL/fees/revenue growth, which
 *   this engine already buckets at the "30d" magnitude-word tier in thresholds.ts).
 * - "structural": a 90-day price trend, or a risk read from ~90 days of daily closes.
 *
 * This is a relabeling of horizon information the engine already computes (thresholds.ts's
 * MomentumPeriodKey, findings.ts's Horizon.key, and the hist:risk_{period} evidence ID) — it adds
 * no new calculation and reads no new data.
 */
export type HorizonClass = "snapshot" | "short_term" | "medium_term" | "structural";

const HORIZON_WEIGHT: Record<HorizonClass, number> = { snapshot: 2, short_term: 4, medium_term: 6, structural: 8 };

/** Matches ui/format.ts's `intervalBetween`: below this, a measured interval is snapshot-to-snapshot, not a trend. */
const SHORT_ALIGNED_INTERVAL_HOURS = 24;

/** Every risk-history evidence ID names its own window explicitly (hist:risk_7d/30d/90d) — read directly, not guessed. */
function riskHorizonFromEvidenceId(id: string | undefined): HorizonClass {
  if (!id) return "short_term";
  if (id.includes("risk_90d")) return "structural";
  if (id.includes("risk_30d")) return "medium_term";
  return "short_term"; // risk_7d
}

export function classifyHorizon(finding: Finding): HorizonClass {
  if (finding.category === "marketPerformance" && finding.findingType.startsWith("multi_horizon_") && finding.horizons && finding.horizons.length > 0) {
    const longest = finding.horizons[finding.horizons.length - 1].key;
    if (longest === "90d") return "structural";
    if (longest === "30d") return "medium_term";
    return "short_term"; // 24h or 7d only
  }
  if (
    finding.findingType.startsWith("tvl_growth_") || finding.findingType.startsWith("fees_growth_") || finding.findingType.startsWith("revenue_growth_")
    || finding.findingType === "fundamentals_improving" || finding.findingType === "fundamentals_deteriorating" || finding.findingType === "fundamentals_mixed"
  ) {
    return "medium_term";
  }
  if (finding.findingType === "elevated_volatility" || finding.findingType === "sharp_drawdown") {
    return riskHorizonFromEvidenceId(finding.evidenceIds[0]);
  }
  // A 7-day supply-change reading is a real short-window fact, same tier as a 7D price/volume change.
  if (finding.findingType === "circulating_supply_increase_7d" || finding.findingType === "circulating_supply_decrease_7d") return "short_term";
  // The four cross-metric technical indicators are genuine 30-day comparisons (catalog.ts's own
  // `windowDays: 30`); everything else technical (moving averages, MACD, RSI, Bollinger, swing
  // structure, closing range) is a current-state read of where price sits right now, not a trend.
  if (finding.category === "technical") {
    const THIRTY_DAY_TECHNICAL_PREFIXES = ["technical_price_tvl_", "technical_price_volume_", "technical_valuation_", "technical_turnover_"];
    return THIRTY_DAY_TECHNICAL_PREFIXES.some((prefix) => finding.findingType.startsWith(prefix)) ? "medium_term" : "snapshot";
  }
  // Divergence flags and percentage-point comparisons (marketFundamentalRelationships) are
  // measured over the metrics engine's own "aligned interval," whose length is not guaranteed —
  // see the module comment. Never treated as medium/structural regardless of magnitude. When the
  // real measured duration is known and is itself very short (the same <24h "snapshot-to-snapshot,
  // not a trend" threshold the Token Profile UI already uses — see ui/format.ts's `intervalBetween`),
  // demote it one tier further, to snapshot: a ~37-minute-aligned divergence is a valid observation,
  // but it must never carry the same temporal weight as a genuine multi-day comparison merely
  // because both currently classify under the same finding category. When the duration is unknown
  // (`intervalHours` is null — most fixtures/payloads that predate this calibration), the prior,
  // conservative short_term classification is unchanged: absence of duration data is never treated
  // as evidence the interval was short.
  if (finding.category === "marketFundamentalRelationships") {
    const intervalHours = finding.data.intervalHours;
    if (typeof intervalHours === "number" && Number.isFinite(intervalHours) && intervalHours < SHORT_ALIGNED_INTERVAL_HOURS) return "snapshot";
    return "short_term";
  }
  // Everything else this engine currently extracts is a point-in-time read: valuation ratios,
  // FDV/MC and market-cap/FDV shares, supply-share facts (a design characteristic in principle,
  // but this engine has only a single snapshot read of it, never a supply time series, so it is
  // classified with the same caution as any other current ratio — see the module comment on
  // never inferring more temporal weight than the underlying data actually supports), liquidity/
  // turnover ratios, structure_* cards, the "no elevated risk" fallback, and data-quality gaps.
  return "snapshot";
}

// ---- Shared: persistence and severity-as-magnitude ----

export type Persistence = "single" | "persistent" | "conflicting";

const SEVERITY_MAGNITUDE: Record<FindingSeverity, number> = { low: 2, moderate: 4, high: 6 };

const PERSISTENT_PATTERNS: MultiHorizonPattern[] = [
  "consistent_up_accelerating", "consistent_up_decelerating", "consistent_up_steady",
  "consistent_down_accelerating", "consistent_down_decelerating", "consistent_down_steady",
];
const CONFLICTING_PATTERNS: MultiHorizonPattern[] = ["reversal_to_down", "reversal_to_up", "mixed"];

function multiHorizonPersistence(finding: Finding): Persistence {
  const pattern = finding.findingType.replace("multi_horizon_", "") as MultiHorizonPattern;
  if (PERSISTENT_PATTERNS.includes(pattern)) return "persistent";
  if (CONFLICTING_PATTERNS.includes(pattern)) return "conflicting";
  return "single"; // single_up/single_down/flat: only one horizon available, nothing to agree or conflict
}

// ---- Data completeness: does a nearby, relevant data gap limit confidence in this signal? ----

export type Completeness = "complete" | "partial" | "limited";

/** Which data-quality findingType prefixes are relevant to each finding category — an explicit,
 *  inspectable table, not a heuristic guess. A gap outside a category's own relevant providers/
 *  series never penalizes it (e.g. a missing DEX mapping never discounts a fundamentals signal). */
const RELEVANT_GAP_PREFIXES: Partial<Record<FindingCategory, string[]>> = {
  marketPerformance: ["insufficient_history_price_", "insufficient_history_volume_"],
  fundamentalPerformance: ["unmapped_defillama", "missing_tvl", "missing_fees_24h", "missing_revenue_24h", "insufficient_history_tvl_"],
  marketFundamentalRelationships: ["unmapped_defillama", "insufficient_history_price_", "insufficient_history_tvl_"],
  liquidityMarketStructure: ["unmapped_dexpaprika"],
  tokenomics: ["missing_maximum_supply"],
  valuation: ["unmapped_defillama", "missing_market_cap", "missing_tvl", "missing_fees_24h", "missing_revenue_24h"],
  technical: ["unmapped_defillama"],
  risk: [],
  dataQuality: [],
};

function relevantGapCount(categories: FindingCategory[], dataGaps: Finding[]): number {
  const prefixes = new Set(categories.flatMap((category) => RELEVANT_GAP_PREFIXES[category] ?? []));
  if (prefixes.size === 0) return 0;
  return dataGaps.filter((gap) => [...prefixes].some((prefix) => gap.findingType.startsWith(prefix))).length;
}

function completenessFromGapCount(count: number): Completeness {
  if (count >= 2) return "limited";
  if (count === 1) return "partial";
  return "complete";
}

// ---- 4/5/6/7. Materiality ----

export type MaterialityBreakdown = {
  magnitude: number;
  horizonWeight: number;
  persistence: number;
  corroboration: number;
  evidenceSupport: number;
  dataGapPenalty: number;
  total: number;
};

/**
 * materiality = magnitude + horizonWeight + persistence + corroboration + evidenceSupport - dataGapPenalty
 *
 * Every term is a small, documented, bounded integer — this is deliberately not a sophisticated
 * model. The weights are chosen so that horizon dominates raw magnitude (see thresholds.ts's own
 * "never let a snapshot outrank a persistent trend" requirement): the gap between the top and
 * bottom horizon tier (8 vs 2 = 6) exceeds the gap between the top and bottom severity tier
 * (6 vs 2 = 4), so a moderate-severity structural finding (4 + 8 = 12) outranks a high-severity
 * snapshot finding (6 + 2 = 8) before persistence/corroboration are even considered.
 *
 * - magnitude: the finding's own severity (existing signal, reused as one input — never the whole
 *   score; see the module comment on materiality not being severity renamed).
 * - horizonWeight: from HORIZON_WEIGHT — how much temporal confidence the evidence supports.
 * - persistence: +3 when the same direction recurs across horizons/repeats (agreement is repeated
 *   evidence, not causal proof — never described as such downstream), -1 when horizons actively
 *   disagree (a reversal/mixed pattern), 0 for a single-horizon read.
 * - corroboration: +2 per additional distinct analytical category beyond the first backing this
 *   driver — a relationship confirmed from two angles (e.g. market performance and fundamentals)
 *   is more material than an isolated single-category read.
 * - evidenceSupport: +1 per additional supporting Finding beyond the first, capped at +3, so a
 *   relationship resting on many findings is not unboundedly inflated by count alone.
 * - dataGapPenalty: -2 with one relevant data gap nearby, -4 with two or more — confidence is
 *   reduced, never zeroed and never treated as evidence the underlying condition is negative.
 */
export function materialityOf(input: {
  severity: FindingSeverity;
  horizon: HorizonClass;
  persistence: Persistence;
  categories: FindingCategory[];
  supportingFindingCount: number;
  completeness: Completeness;
}): MaterialityBreakdown {
  const magnitude = SEVERITY_MAGNITUDE[input.severity];
  const horizonWeight = HORIZON_WEIGHT[input.horizon];
  const persistence = input.persistence === "persistent" ? 3 : input.persistence === "conflicting" ? -1 : 0;
  const distinctCategories = new Set(input.categories).size;
  const corroboration = Math.max(0, distinctCategories - 1) * 2;
  const evidenceSupport = Math.min(3, Math.max(0, input.supportingFindingCount - 1));
  const dataGapPenalty = input.completeness === "limited" ? 4 : input.completeness === "partial" ? 2 : 0;
  const total = magnitude + horizonWeight + persistence + corroboration + evidenceSupport - dataGapPenalty;
  return { magnitude, horizonWeight, persistence, corroboration, evidenceSupport, dataGapPenalty, total };
}

// ---- 2. Redundancy collapse ----

export type RedundancyGroup = {
  /** Deterministic: the shared category+findingType key every member shares. */
  id: string;
  category: FindingCategory;
  findingType: string;
  /** The member whose horizon carries the most temporal weight — the group's representative figure. */
  representative: Finding;
  findingIds: string[];
  evidenceIds: string[];
  memberCount: number;
  horizon: HorizonClass;
  /** More than one member expressing the same signal at different windows is itself persistence. */
  persistence: Persistence;
  /**
   * Whether the members' own numeric magnitude (each finding's `data.raw`, when present — e.g. an
   * elevated-volatility reading's own %) actually agrees, or only their category+findingType label
   * does. Two same-typed findings collapse into one signal either way (a genuine restatement of the
   * same condition observed at a different window is still one condition), but a later narrative
   * layer should say "elevated across the available windows" for a "uniform" group and something
   * that reflects a real range (e.g. "ranging from X% to Y%") for a "varied" one — never the same
   * sentence for both. This module never renders either sentence itself (Phase 2); it only records
   * which is honest, from the same raw numbers already on each member, never inferring or estimating
   * a magnitude a finding did not itself report. "unknown" when a member carries no numeric `raw`.
   */
  valueSpread: "uniform" | "varied" | "unknown";
};

/** Relative spread above which a redundancy group's members are "materially different," not noise. */
const VALUE_SPREAD_RELATIVE_THRESHOLD = 0.2;

function numericRaw(finding: Finding): number | null {
  const raw = finding.data.raw;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function valueSpreadOf(members: Finding[]): "uniform" | "varied" | "unknown" {
  const raws = members.map(numericRaw);
  if (raws.some((raw) => raw === null)) return "unknown";
  const magnitudes = (raws as number[]).map(Math.abs);
  const max = Math.max(...magnitudes);
  const min = Math.min(...magnitudes);
  if (max === 0) return "uniform";
  return (max - min) / max > VALUE_SPREAD_RELATIVE_THRESHOLD ? "varied" : "uniform";
}

/**
 * Findings that share both category and findingType are, by construction, restatements of the
 * same underlying signal observed on a different field/window (the canonical example: elevated
 * volatility flagged at 30D and again at 90D). This key is deliberately exact-match and
 * conservative — it never merges findings of a genuinely different type, only true repeats.
 */
function redundancyKey(finding: Finding): string {
  return `${finding.category}:${finding.findingType}`;
}

/** Deterministic tie-break: higher horizon weight wins; ties broken by the lower evidenceId (stable, content-derived, never array order). */
function strongerOf(a: Finding, b: Finding): Finding {
  const weightA = HORIZON_WEIGHT[classifyHorizon(a)];
  const weightB = HORIZON_WEIGHT[classifyHorizon(b)];
  if (weightA !== weightB) return weightA > weightB ? a : b;
  return findingId(a) <= findingId(b) ? a : b;
}

export function collapseRedundant(findings: Finding[]): { survivors: Finding[]; groups: RedundancyGroup[] } {
  const byKey = new Map<string, Finding[]>();
  // Deterministic grouping order: sort the input by its own content-derived id first, so grouping
  // never depends on the order `findings` happened to arrive in.
  const sorted = [...findings].sort((a, b) => findingId(a).localeCompare(findingId(b)));
  for (const finding of sorted) {
    const key = redundancyKey(finding);
    byKey.set(key, [...(byKey.get(key) ?? []), finding]);
  }
  const survivors: Finding[] = [];
  const groups: RedundancyGroup[] = [];
  for (const [key, members] of [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (members.length === 1) {
      survivors.push(members[0]);
      continue;
    }
    const representative = members.reduce(strongerOf);
    survivors.push(representative);
    groups.push({
      id: key,
      category: representative.category,
      findingType: representative.findingType,
      representative,
      findingIds: members.map(findingId).sort(),
      evidenceIds: [...new Set(members.flatMap((member) => member.evidenceIds))].sort(),
      memberCount: members.length,
      horizon: classifyHorizon(representative),
      persistence: "persistent", // the same signal recurring across windows is, by definition, repeated evidence
      valueSpread: valueSpreadOf(members),
    });
  }
  return { survivors, groups: groups.sort((a, b) => a.id.localeCompare(b.id)) };
}

// ---- 3. Cross-category relationships ----

export type RelationshipType =
  | "price_fundamental_divergence" | "valuation_activity_relationship" | "market_momentum_valuation"
  | "supply_valuation_exposure" | "trading_liquidity_conditions" | "fundamental_activity_trajectory"
  | "technical_price_confluence" | "technical_fundamental_relationship" | "technical_liquidity_conditions";

export type Relationship = {
  id: string;
  type: RelationshipType;
  categories: FindingCategory[];
  findingIds: string[];
  evidenceIds: string[];
  horizon: HorizonClass;
  persistence: Persistence;
  completeness: Completeness;
  materiality: MaterialityBreakdown;
  /** Human-readable finding-type labels this relationship rests on — for the narrative layer, never rendered as-is. */
  supportingFindingTypes: string[];
};

function byCategory(findings: Finding[], category: FindingCategory): Finding[] {
  return findings.filter((finding) => finding.category === category);
}
function byType(findings: Finding[], findingType: string): Finding | undefined {
  return findings.find((finding) => finding.findingType === findingType);
}

function buildRelationship(
  type: RelationshipType,
  members: Finding[],
  dataGaps: Finding[],
): Relationship {
  const categories = [...new Set(members.map((member) => member.category))].sort();
  const findingIds = members.map(findingId).sort();
  const evidenceIds = [...new Set(members.flatMap((member) => member.evidenceIds))].sort();
  // A relationship's horizon is the strongest (highest-weight) horizon among its members: it can
  // speak with at least that much temporal confidence, backed by that specific member's evidence.
  const horizon = members.map(classifyHorizon).reduce((best, current) => HORIZON_WEIGHT[current] > HORIZON_WEIGHT[best] ? current : best);
  const persistence = members.some((member) => member.category === "marketPerformance" && member.findingType.startsWith("multi_horizon_"))
    ? multiHorizonPersistence(members.find((member) => member.findingType.startsWith("multi_horizon_"))!)
    : members.length > 1 ? "persistent" : "single";
  const completeness = completenessFromGapCount(relevantGapCount(categories, dataGaps));
  const materiality = materialityOf({
    severity: members.reduce<FindingSeverity>((worst, member) => SEVERITY_MAGNITUDE[member.severity] > SEVERITY_MAGNITUDE[worst] ? member.severity : worst, "low"),
    horizon, persistence, categories, supportingFindingCount: members.length, completeness,
  });
  return {
    id: `${type}:${findingIds.join("+")}`, type, categories, findingIds, evidenceIds, horizon, persistence, completeness, materiality,
    supportingFindingTypes: [...new Set(members.map((member) => member.findingType))].sort(),
  };
}

/** A. Price + TVL: reuses the metrics engine's own aligned-interval divergence flags — never re-derived from independently-periods findings. */
function priceFundamentalDivergence(findings: Finding[], dataGaps: Finding[]): Relationship[] {
  const relevant = byCategory(findings, "marketFundamentalRelationships").filter((finding) => finding.findingType === "divergence_price_up_tvl_down" || finding.findingType === "divergence_price_down_tvl_up");
  return relevant.map((finding) => buildRelationship("price_fundamental_divergence", [finding], dataGaps));
}

/** B. Market cap + TVL + MC/TVL: only when at least two of the three angles are present. */
function valuationActivityRelationship(findings: Finding[], dataGaps: Finding[]): Relationship[] {
  const tvlGrowth = byCategory(findings, "fundamentalPerformance").find((finding) => finding.findingType.startsWith("tvl_growth_"));
  const mcTvlRatio = byType(findings, "ratio_market_cap_to_tvl");
  const outpace = byCategory(findings, "marketFundamentalRelationships").find((finding) => finding.findingType === "divergence_market_cap_up_faster_tvl" || finding.findingType === "divergence_tvl_up_faster_market_cap");
  const members = [tvlGrowth, mcTvlRatio, outpace].filter((finding): finding is Finding => finding !== undefined);
  if (members.length < 2) return [];
  return [buildRelationship("valuation_activity_relationship", members, dataGaps)];
}

/** C. Price momentum + valuation context: only when both a momentum read and a valuation ratio exist. */
function marketMomentumValuation(findings: Finding[], dataGaps: Finding[]): Relationship[] {
  const momentum = byCategory(findings, "marketPerformance").find((finding) => finding.findingType.startsWith("multi_horizon_") && finding.findingType !== "multi_horizon_flat");
  const ratio = byCategory(findings, "valuation").find((finding) => finding.findingType.startsWith("ratio_"));
  if (!momentum || !ratio) return [];
  return [buildRelationship("market_momentum_valuation", [momentum, ratio], dataGaps)];
}

/** D. Tokenomics + FDV/MC: a low circulating share alongside a material FDV/market-cap gap is one dilution-exposure story, not two facts. */
function supplyValuationExposure(findings: Finding[], dataGaps: Finding[]): Relationship[] {
  const lowShare = byCategory(findings, "tokenomics").find((finding) => finding.findingType === "low_circulating_share");
  const fdvGap = byCategory(findings, "valuation").find((finding) => finding.findingType === "fdv_market_cap_gap");
  const members = [lowShare, fdvGap].filter((finding): finding is Finding => finding !== undefined);
  if (members.length < 2) return [];
  return [buildRelationship("supply_valuation_exposure", members, dataGaps)];
}

/** E. DEX activity + liquidity + transactions + buy/sell: bundles current trading conditions into one relationship, never one card per metric. */
function tradingLiquidityConditions(findings: Finding[], dataGaps: Finding[]): Relationship[] {
  const members = byCategory(findings, "liquidityMarketStructure").filter((finding) => finding.findingType.startsWith("structure_") || finding.findingType === "elevated_turnover" || finding.findingType === "low_turnover" || finding.findingType === "turnover_level");
  if (members.length < 2) return [];
  return [buildRelationship("trading_liquidity_conditions", members, dataGaps)];
}

/** F. TVL + fees + revenue + their changes: reuses the findings layer's own improving/deteriorating/mixed synthesis as the anchor when present. */
function fundamentalActivityTrajectory(findings: Finding[], dataGaps: Finding[]): Relationship[] {
  const members = byCategory(findings, "fundamentalPerformance");
  if (members.length < 2) return [];
  return [buildRelationship("fundamental_activity_trajectory", members, dataGaps)];
}

/** Finding types from technicalFindings() whose direction is directly comparable to price momentum's own direction. */
const DIRECTIONAL_TECHNICAL_TYPES = [
  "price_above_moving_averages", "price_below_moving_averages", "macd_above_signal", "macd_below_signal",
  "rsi_at_or_above_70", "rsi_at_or_below_30", "price_above_upper_band", "price_below_lower_band",
];

/**
 * G. Price momentum + technical configuration: bundles the multi-horizon momentum read with
 * whichever directional technical indicators are available (moving-average structure, MACD, RSI,
 * Bollinger position). Confluence or divergence is for the narrative layer to characterize from the
 * member finding types themselves — this only establishes that the relationship exists and what it
 * rests on, never which way it points.
 */
function technicalPriceConfluence(findings: Finding[], dataGaps: Finding[]): Relationship[] {
  const momentum = byCategory(findings, "marketPerformance").find((finding) => finding.findingType.startsWith("multi_horizon_") && finding.findingType !== "multi_horizon_flat");
  const technicalDirectional = byCategory(findings, "technical").filter((finding) => DIRECTIONAL_TECHNICAL_TYPES.includes(finding.findingType));
  if (!momentum || technicalDirectional.length === 0) return [];
  return [buildRelationship("technical_price_confluence", [momentum, ...technicalDirectional], dataGaps)];
}

/** H. The technical layer's own 30D price/TVL and valuation-trend indicators, read alongside the fundamentals findings they relate to. */
function technicalFundamentalRelationship(findings: Finding[], dataGaps: Finding[]): Relationship[] {
  const technicalCross = byCategory(findings, "technical").filter((finding) => finding.findingType.startsWith("technical_price_tvl_") || finding.findingType.startsWith("technical_valuation_"));
  const fundamentals = byCategory(findings, "fundamentalPerformance");
  if (technicalCross.length === 0 || fundamentals.length === 0) return [];
  return [buildRelationship("technical_fundamental_relationship", [...technicalCross, ...fundamentals], dataGaps)];
}

/** I. The technical layer's own 30D price/volume and turnover-trend indicators, read alongside on-chain trading-structure findings. */
function technicalLiquidityConditions(findings: Finding[], dataGaps: Finding[]): Relationship[] {
  const technicalLiquidity = byCategory(findings, "technical").filter((finding) => finding.findingType.startsWith("technical_price_volume_") || finding.findingType.startsWith("technical_turnover_"));
  const liquidity = byCategory(findings, "liquidityMarketStructure");
  if (technicalLiquidity.length === 0 || liquidity.length === 0) return [];
  return [buildRelationship("technical_liquidity_conditions", [...technicalLiquidity, ...liquidity], dataGaps)];
}

function buildRelationships(findings: Finding[], dataGaps: Finding[]): Relationship[] {
  const relationships = [
    ...priceFundamentalDivergence(findings, dataGaps),
    ...valuationActivityRelationship(findings, dataGaps),
    ...marketMomentumValuation(findings, dataGaps),
    ...supplyValuationExposure(findings, dataGaps),
    ...tradingLiquidityConditions(findings, dataGaps),
    ...fundamentalActivityTrajectory(findings, dataGaps),
    ...technicalPriceConfluence(findings, dataGaps),
    ...technicalFundamentalRelationship(findings, dataGaps),
    ...technicalLiquidityConditions(findings, dataGaps),
  ];
  return relationships.sort((a, b) => a.id.localeCompare(b.id));
}

// ---- 8. Thesis drivers ----

export type ThesisDriver = {
  id: string;
  driverType: "relationship" | "finding";
  relationshipType: RelationshipType | null;
  findingType: string | null;
  categories: FindingCategory[];
  findingIds: string[];
  evidenceIds: string[];
  horizon: HorizonClass;
  persistence: Persistence;
  completeness: Completeness;
  materiality: MaterialityBreakdown;
};

/**
 * A driver must clear this floor to headline the report — chosen so that a single low-severity,
 * snapshot-only, single-horizon, uncorroborated finding (2 + 2 + 0 + 0 + 0 - 0 = 4) never
 * qualifies alone, while a moderate finding with any one of {structural horizon, persistence,
 * cross-category corroboration} does. This is a threshold on the same transparent formula in
 * materialityOf, not a separate model.
 */
export const MIN_DRIVER_MATERIALITY = 8;
/** Thesis drivers are capped, never padded to a fixed count — see the module comment. */
export const MAX_THESIS_DRIVERS = 5;

function driverFromRelationship(relationship: Relationship): ThesisDriver {
  return {
    id: relationship.id, driverType: "relationship", relationshipType: relationship.type, findingType: null,
    categories: relationship.categories, findingIds: relationship.findingIds, evidenceIds: relationship.evidenceIds,
    horizon: relationship.horizon, persistence: relationship.persistence, completeness: relationship.completeness, materiality: relationship.materiality,
  };
}

function driverFromFinding(finding: Finding, dataGaps: Finding[]): ThesisDriver {
  const horizon = classifyHorizon(finding);
  const persistence = finding.category === "marketPerformance" && finding.findingType.startsWith("multi_horizon_") ? multiHorizonPersistence(finding) : "single";
  const completeness = completenessFromGapCount(relevantGapCount([finding.category], dataGaps));
  return {
    id: findingId(finding), driverType: "finding", relationshipType: null, findingType: finding.findingType,
    categories: [finding.category], findingIds: [findingId(finding)], evidenceIds: [...finding.evidenceIds].sort(),
    horizon, persistence, completeness,
    materiality: materialityOf({ severity: finding.severity, horizon, persistence, categories: [finding.category], supportingFindingCount: 1, completeness }),
  };
}

/** Deterministic total order: materiality desc, then horizon weight desc, then stable id asc — never array/object iteration order. */
function compareDrivers(a: ThesisDriver, b: ThesisDriver): number {
  if (a.materiality.total !== b.materiality.total) return b.materiality.total - a.materiality.total;
  const horizonDiff = HORIZON_WEIGHT[b.horizon] - HORIZON_WEIGHT[a.horizon];
  if (horizonDiff !== 0) return horizonDiff;
  return a.id.localeCompare(b.id);
}

function selectThesisDrivers(
  relationships: Relationship[],
  redundancyGroups: RedundancyGroup[],
  standaloneFindings: Finding[],
  dataGaps: Finding[],
): ThesisDriver[] {
  const relationshipFindingIds = new Set(relationships.flatMap((relationship) => relationship.findingIds));
  const groupDrivers = redundancyGroups
    .filter((group) => !relationshipFindingIds.has(findingId(group.representative)))
    .map((group): ThesisDriver => {
      const horizon = group.horizon;
      const completeness = completenessFromGapCount(relevantGapCount([group.category], dataGaps));
      return {
        id: group.id, driverType: "finding", relationshipType: null, findingType: group.findingType,
        categories: [group.category], findingIds: group.findingIds, evidenceIds: group.evidenceIds,
        horizon, persistence: group.persistence, completeness,
        materiality: materialityOf({ severity: group.representative.severity, horizon, persistence: group.persistence, categories: [group.category], supportingFindingCount: group.memberCount, completeness }),
      };
    });
  const standaloneDrivers = standaloneFindings
    .filter((finding) => !relationshipFindingIds.has(findingId(finding)))
    .map((finding) => driverFromFinding(finding, dataGaps));

  const candidates = [...relationships.map(driverFromRelationship), ...groupDrivers, ...standaloneDrivers]
    .filter((driver) => driver.materiality.total >= MIN_DRIVER_MATERIALITY)
    .sort(compareDrivers);
  return candidates.slice(0, MAX_THESIS_DRIVERS);
}

// ---- Entry point ----

export type SynthesisResult = {
  relationships: Relationship[];
  redundancyGroups: RedundancyGroup[];
  thesisDrivers: ThesisDriver[];
};

/**
 * Pure function: `Finding[]` in, structured synthesis out. Never mutates its input, never reads
 * the clock, never calls out to anything. `findings` should be every finding the token's snapshot
 * produced (extractFindings's full output, dataQuality findings included) so relationships can be
 * discounted correctly when a relevant metric is missing (see completenessFromGapCount).
 */
export function synthesize(findings: Finding[]): SynthesisResult {
  const dataGaps = findings.filter((finding) => finding.category === "dataQuality");
  const analytical = findings.filter((finding) => finding.category !== "dataQuality");

  const { survivors, groups } = collapseRedundant(analytical);
  const relationships = buildRelationships(survivors, dataGaps);

  const relationshipMemberIds = new Set(relationships.flatMap((relationship) => relationship.findingIds));
  const groupRepresentativeIds = new Set(groups.map((group) => findingId(group.representative)));
  const standaloneFindings = survivors.filter((finding) => !relationshipMemberIds.has(findingId(finding)) && !groupRepresentativeIds.has(findingId(finding)));

  const thesisDrivers = selectThesisDrivers(relationships, groups, standaloneFindings, dataGaps);

  return { relationships, redundancyGroups: groups, thesisDrivers };
}
