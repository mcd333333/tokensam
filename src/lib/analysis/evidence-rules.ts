import { canonicalTokens } from "../../data/canonical-tokens.ts";
import type { ResearchContext } from "./research-context.ts";

/**
 * Deterministic evidence rules for Deep AI Analysis output.
 *
 * These are deliberately practical, not a natural-language fact checker: they
 * make the statement structure the only place evidence-derived claims can live
 * (numbers must match cited values; periods must be copied from cited items)
 * and reject language that introduces premises the research context does not
 * contain (sentiment labels, external crypto concepts, other assets).
 *
 * Mentioning a legitimate Token Samurai data provider (CoinGecko, DeFiLlama,
 * DexPaprika, GeckoTerminal) by name is never itself a violation, mapped or
 * not: Token Samurai genuinely uses all of them, and "further research could
 * examine DeFiLlama TVL data" or "no GeckoTerminal mapping is available for
 * this token" are both accurate, not fabricated. Only a claim that a provider
 * supplied a specific fact this context does not contain is a violation, and
 * that is already caught by the number/period grounding rules below —
 * provider mentions are not policed separately from that.
 */

export type EvidenceItem = {
  id: string;
  type: "token" | "scope" | "fresh" | "obs" | "calc" | "hist" | "point";
  numbers: number[];
  text: string;
  periodLabels: string[];
  requiresPeriod: boolean;
};

export type EvidenceIndex = {
  ids: Set<string>;
  /** Present only when validating against a full research context. */
  context: {
    items: Map<string, EvidenceItem>;
    text: string;
    tokenSymbol: string;
  } | null;
};

function collectNumbers(value: unknown, out: number[]): void {
  if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  else if (typeof value === "string") for (const token of value.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) out.push(Number(token.replace(/,/g, "")));
  else if (Array.isArray(value)) value.forEach((item) => collectNumbers(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectNumbers(item, out));
}

function item(id: string, type: EvidenceItem["type"], source: unknown, periodLabels: string[] = [], requiresPeriod = false): EvidenceItem {
  const numbers: number[] = [];
  collectNumbers(source, numbers);
  return { id, type, numbers, text: JSON.stringify(source).toLowerCase(), periodLabels, requiresPeriod };
}

/** The item constructor, shared with other evidence sources (the profile payload) so numbers and text are indexed identically. */
export { item as evidenceItem };

/** Build the evidence index for one research context. */
export function buildEvidenceIndex(context: ResearchContext): EvidenceIndex {
  const items = new Map<string, EvidenceItem>();
  items.set("token", item("token", "token", context.token));
  for (const scope of context.scope) items.set(scope.id, item(scope.id, "scope", scope));
  for (const fresh of context.providerFreshness) items.set(fresh.id, item(fresh.id, "fresh", fresh));
  for (const obs of context.observations) {
    items.set(obs.id, item(obs.id, "obs", obs, [obs.window.label], obs.status === "available" && obs.window.kind === "provider_rolling_window"));
  }
  for (const calc of context.calculatedMetrics) {
    const timeBased = calc.period.kind === "interval_between_latest_observations" || calc.period.kind === "aligned_interval";
    items.set(calc.id, item(calc.id, "calc", calc, [calc.period.label], calc.status === "available" && timeBased));
  }
  for (const series of context.history) {
    const labels = [series.summary?.label, ...Object.values(series.coverage).map((coverage) => coverage.coverageLabel)].filter((label): label is string => Boolean(label));
    items.set(series.id, item(series.id, "hist", series, labels, series.points.length >= 2));
    for (const point of series.points) {
      if (!items.has(point.sourceId)) items.set(point.sourceId, item(point.sourceId, "point", { ...point, provider: series.provider, metric: series.metric }));
    }
  }
  return { ids: new Set(items.keys()), context: { items, text: JSON.stringify(context), tokenSymbol: context.token.symbol } };
}

/** Evidence for re-validating a stored analysis: only its cited IDs are known. */
export function storedEvidence(ids: Iterable<string>): EvidenceIndex {
  return { ids: new Set(ids), context: null };
}

// ---- Text rules ----

/**
 * Sentiment/prediction language: opinion or forward-looking framing that reads as trading
 * guidance regardless of how well-grounded the underlying facts are. Always fatal.
 */
const DIRECTIONAL_PATTERNS: RegExp[] = [
  /\b(bullish|bearish)\b/i,
  /\b(up|down)trend\b/i,
  /\b(rally|rallies|rallied|sell-?off|breakout|overbought|oversold)\b/i,
  /\blikely to (rise|fall|increase|decrease|recover|decline|continue|rebound)\b/i,
  /\b(poised|set) (to|for) (rise|fall|gains?|losses|growth|decline)\b/i,
  /\b(positive|negative|bullish|bearish) (outlook|sentiment|signal)\b/i,
];

/**
 * Analytical/descriptive language about already-observed behavior (not a prediction or opinion).
 * A statement using one of these is only as good as its own grounding (sources, numbers, kind):
 * if that grounding passes, the word choice alone is a warning, not a rejection.
 */
const ANALYTICAL_PATTERNS: RegExp[] = [
  /\bmomentum\b/i,
  /\btrends?\b/i,
  /\bstrength(en(s|ed|ing)?)?\b/i,
  /\bweak(ness(es)?|en(s|ed|ing)?)?\b/i,
  /\bimprov(e[ds]?|ing|ement)\b/i,
  /\bdeterior(ate[ds]?|ating|ation)\b/i,
  /\bstab(le|ility|ilize[ds]?|ilizing)\b/i,
  /\bsignificant(ly)?\b/i,
  /\bconsistent(ly)?\b/i,
];

/**
 * Causal-claim language: the research context is purely observational (prices, TVL, supply,
 * on-chain aggregates), so it never establishes that one factor caused another. Unlike
 * ANALYTICAL_PATTERNS, a causal claim is always fatal regardless of how well-grounded its
 * numbers are — the claim itself (that X caused Y) is not something this evidence can support,
 * exactly like DIRECTIONAL_PATTERNS' sentiment/prediction language.
 */
// "due to" and "because of" are deliberately excluded: they are the normal, legitimate way this
// report explains why data is unavailable ("unavailable due to missing DeFiLlama data"), which
// must remain allowed (see the module comment on legitimate providers). Only phrasing that
// specifically attributes a market outcome to a cause is listed here.
const CAUSAL_PATTERNS: RegExp[] = [
  /\bcaused? (by|the)\b/i,
  /\b(led|leading) to\b/i,
  /\bdrove\b/i,
  /\bdriv(es|ing) (the|this|that)\b/i,
  /\bdriven by\b/i,
  /\bas a result of\b/i,
  /\battribut(e[ds]?|able) to\b/i,
];

/** Every internal evidence-ID marker literally written into prose (it belongs only in sourceIds). */
const LEAKED_MARKER_PATTERN = /\b(?:obs|hist|calc|scope):[a-z][a-z0-9_]*\b/i;

/** Every fatal sentiment/prediction term in the text (all are reported, not just the first). */
export function findDirectionalLanguage(text: string): string[] {
  return DIRECTIONAL_PATTERNS.flatMap((pattern) => text.match(pattern)?.[0] ?? []);
}

/** Every analytical/descriptive term in the text; downgraded to a warning when the text is otherwise grounded. */
export function findAnalyticalLanguage(text: string): string[] {
  return ANALYTICAL_PATTERNS.flatMap((pattern) => text.match(pattern)?.[0] ?? []);
}

/** Every fatal causal claim in the text (all are reported, not just the first). */
export function findCausalLanguage(text: string): string[] {
  return CAUSAL_PATTERNS.flatMap((pattern) => text.match(pattern)?.[0] ?? []);
}

/** An internal evidence-ID marker written directly into prose, where only sourceIds may cite it. */
export function findLeakedEvidenceMarker(text: string): string | null {
  return text.match(LEAKED_MARKER_PATTERN)?.[0] ?? null;
}

/**
 * External crypto concepts. A concept is rejected only when the research
 * context itself never mentions it (for example, "governance" is allowed for a
 * token whose DeFiLlama relationship names it as a governance token).
 */
const EXTERNAL_CONCEPTS: RegExp[] = [
  /\bblock (subsidy|subsidies|rewards?)\b/i,
  /\bhalving\b/i,
  /\bissuance\b/i,
  /\bemissions?\b/i,
  /\b(mining|miners?)\b/i,
  /\bhash ?rate\b/i,
  /\bproof[- ]of[- ](work|stake)\b/i,
  /\bstaking\b/i,
  /\bvalidators?\b/i,
  /\b(token )?burn(s|ed|ing)?\b/i,
  /\b(unlocks?|vesting)\b/i,
  /\bairdrops?\b/i,
  /\bgovernance\b/i,
  /\btreasury\b/i,
  /\bETFs?\b/,
  /\bregulat(ion|ory|ors?)\b/i,
  /\binstitutional\b/i,
  /\badoption\b/i,
  /\bwhales?\b/i,
  /\bactive addresses\b/i,
  /\bdeveloper activity\b/i,
  /\b(network upgrade|hard fork|mainnet)\b/i,
  /\b(inflation(ary)?|deflation(ary)?)\b/i,
  /\b(store of value|digital gold)\b/i,
  /\b(macro(economic)?|interest rates?)\b/i,
  /\blayer[- ]?2\b/i,
];

export function findExternalConcept(text: string, contextText: string): string | null {
  for (const pattern of EXTERNAL_CONCEPTS) {
    const match = text.match(pattern);
    if (match && !pattern.test(contextText)) return match[0];
  }
  return null;
}

const WRAPPED_ALIASES: RegExp[] = [/\bWETH\b/, /\bstETH\b/i, /\bwstETH\b/i, /\bcbBTC\b/i, /\btBTC\b/, /\bwrapped (bitcoin|btc|ether|eth)\b/i];

/** Another asset named in the text that the context does not name (e.g. WBTC in a Bitcoin report). */
export function findOtherAsset(text: string, contextText: string, tokenSymbol: string): string | null {
  for (const token of canonicalTokens) {
    if (token.symbol === tokenSymbol || token.symbol.length < 3) continue;
    const pattern = new RegExp(`\\b${token.symbol}\\b`);
    if (pattern.test(text) && !pattern.test(contextText)) return token.symbol;
  }
  for (const pattern of WRAPPED_ALIASES) {
    const match = text.match(pattern);
    if (match && !pattern.test(contextText)) return match[0];
  }
  return null;
}

// ---- Numbers and periods ----

function decimals(token: string): number {
  const dot = token.indexOf(".");
  return dot === -1 ? 0 : token.length - dot - 1;
}

/** Numbers in the text that do not match (within rounding/scale) any value of the cited evidence. */
export function ungroundedNumbers(text: string, cited: EvidenceItem[]): string[] {
  const candidates = cited.flatMap((evidence) => evidence.numbers);
  const scales = [1, 100, 0.01, 1e-3, 1e-6, 1e-9, 1e-12];
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).filter((token) => {
    const value = Number(token.replace(/,/g, ""));
    const tolerance = 0.5 * 10 ** -decimals(token);
    // Text states magnitudes ("decreased by 0.41%"), so compare against absolute values.
    return !candidates.some((candidate) => scales.some((scale) => {
      const scaled = Math.abs(candidate) * scale;
      return Math.abs(value - scaled) <= Math.max(tolerance, Math.abs(scaled) * 0.006);
    }));
  });
}

const NAMED_PERIODS: { pattern: RegExp; evidence: RegExp }[] = [
  { pattern: /\b(24[- ]?hours?|24h|twenty-four[- ]hours?|past day)\b/i, evidence: /24-hour|24 hours|24h/i },
  { pattern: /\b(7[- ]?days?|7d|seven[- ]days?)\b/i, evidence: /7-day|7 days|7d/i },
  { pattern: /\b(30[- ]?days?|30d|thirty[- ]days?)\b/i, evidence: /30-day|30 days|30d/i },
  { pattern: /\b(90[- ]?days?|90d|ninety[- ]days?)\b/i, evidence: /90-day|90 days|90d/i },
  { pattern: /\bweekly\b/i, evidence: /weekly/i },
  { pattern: /\bmonthly\b/i, evidence: /monthly/i },
  { pattern: /\b(yearly|annual(ly|ized)?|year-over-year)\b/i, evidence: /yearly|annual/i },
];

/** A named period in the text that none of the cited items' own labels/windows establish. */
export function findUnsupportedNamedPeriod(text: string, cited: EvidenceItem[]): string | null {
  // Period labels carry a disclaimer naming 24-hour/7-day/30-day periods they are NOT; it must not count as support.
  const citedText = cited.map((evidence) => evidence.text).join(" ").replace(/it is not a fixed [^.]*\./g, "");
  for (const { pattern, evidence } of NAMED_PERIODS) {
    const match = text.match(pattern);
    if (match && !evidence.test(citedText)) return match[0];
  }
  return null;
}

/**
 * Splits every named period mentioned in an overview into grounded (established by the section's
 * own cited evidence, e.g. a statement citing a 24-hour observation) and ungrounded. Grounded
 * matches are removed from the returned residual text before the caller's "no digits" check, so
 * an evidence-backed "24 hours" does not by itself fail the overview; a genuinely unsupported
 * period, or any other number, still does.
 */
export function overviewPeriods(text: string, cited: EvidenceItem[]): { grounded: string[]; ungrounded: string[]; residual: string } {
  const citedText = cited.map((evidence) => evidence.text).join(" ").replace(/it is not a fixed [^.]*\./g, "");
  const grounded: string[] = [];
  const ungrounded: string[] = [];
  let residual = text;
  for (const { pattern, evidence } of NAMED_PERIODS) {
    const match = text.match(pattern);
    if (!match) continue;
    if (evidence.test(citedText)) {
      grounded.push(match[0]);
      residual = residual.replace(pattern, "");
    } else {
      ungrounded.push(match[0]);
    }
  }
  return { grounded, ungrounded, residual };
}

export function sentenceCount(text: string): number {
  return text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim().length > 0).length;
}
