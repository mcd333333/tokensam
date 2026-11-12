/**
 * Deep AI Analysis output contract: the JSON Schema Gemini must follow, the
 * TypeScript types the UI renders, and the validator that sits between them.
 * Nothing from the model is displayed or stored until it passes validation.
 */

import {
  buildEvidenceIndex,
  findAnalyticalLanguage,
  findCausalLanguage,
  findDirectionalLanguage,
  findExternalConcept,
  findLeakedEvidenceMarker,
  findOtherAsset,
  findUnsupportedNamedPeriod,
  overviewPeriods,
  sentenceCount,
  storedEvidence,
  ungroundedNumbers,
  type EvidenceIndex,
  type EvidenceItem,
} from "./evidence-rules.ts";

export { buildEvidenceIndex };

/** v2: evidence contract (sourced statements, grounded numbers, verbatim periods, overview limits). */
export const ANALYSIS_SCHEMA_VERSION = "2";

export const STATEMENT_KINDS = ["observed", "calculated", "interpretation", "uncertainty"] as const;
export const DATA_GAP_CATEGORIES = [
  "unavailable_metric", "stale_data", "missing_history", "mapping_limitation",
  "scope", "uncertain_period", "insufficient_observations", "provider_limitation",
] as const;
export const SECTION_KEYS = [
  "executiveSummary", "marketPerformance", "fundamentalPerformance", "valuation",
  "marketFundamentalRelationships", "liquidityMarketStructure", "tokenomics",
] as const;

export type StatementKind = (typeof STATEMENT_KINDS)[number];
export type SectionKey = (typeof SECTION_KEYS)[number];

export type AnalysisStatement = {
  kind: StatementKind;
  text: string;
  sourceIds: string[];
  period: string | null;
  /** Server-computed: at least one cited ID exists in the research context. */
  traceable: boolean;
};
export type AnalysisSection = { overview: string; statements: AnalysisStatement[] };
export type RiskItem = { title: string; basis: "evidence" | "data_limitation"; detail: string; sourceIds: string[] };
export type DataGapItem = { category: (typeof DATA_GAP_CATEGORIES)[number]; detail: string; sourceIds: string[] };
export type ResearchQuestion = { question: string; rationale: string; sourceIds: string[] };

export type ModelAnalysis = Record<SectionKey, AnalysisSection> & {
  risks: RiskItem[];
  dataGaps: DataGapItem[];
  furtherResearchQuestions: ResearchQuestion[];
};

export type AnalysisMetadata = {
  tokenId: string;
  /** Display name of the provider that actually generated this analysis (e.g. "Google Gemini", "OpenRouter"). */
  provider: string;
  /** The model that actually generated it (for OpenRouter, the routed model it reported). */
  model: string;
  /** The requested model identifier (for OpenRouter, e.g. "openrouter/free"). Absent on analyses stored before fallback existed. */
  requestedModel?: string;
  /** OpenRouter's upstream provider for the routed model, when reported. */
  upstreamProvider?: string | null;
  /** Whether Gemini was temporarily unavailable and OpenRouter produced this result. */
  fallback?: { used: boolean; reason: string | null };
  /** Provider-router record (Phase 2): every provider considered, in order, with sanitized outcomes. */
  routing?: {
    runId: string;
    providerId: string;
    freeTier: string;
    fallbackReason: string | null;
    attempts: {
      provider: string; model: string; action: "attempted" | "skipped"; skipReason: string | null; category: string | null;
      httpStatus: number | null; latencyMs: number | null; inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null;
      validationPassed: boolean | null; validationViolations: number | null;
    }[];
  };
  promptVersion: string;
  schemaVersion: string;
  contextVersion: string;
  generatedAt: string;
  contextAsOf: string | null;
  contextHash: string;
  /** Labels for every cited source ID, so the UI can show provenance. */
  sources: Record<string, string>;
  validation: { droppedSourceIds: number; untraceableFactualStatements: number };
  /** Non-fatal evidence-contract observations (e.g. analytical wording, an overview period already grounded elsewhere in the section). */
  validationWarnings?: string[];
  /**
   * Present only on reports from the deterministic Deep Analysis Engine (analysis/engine/*), never
   * on the earlier AI-provider-generated reports: which analytical-rule version produced the
   * findings/narrative, and the same "as of" instant already in contextAsOf, named for the engine's
   * own report metadata. Their absence on a stored report identifies it as pre-engine.
   */
  engineVersion?: string;
  analysisVersion?: string;
  dataSnapshotAt?: string | null;
  /** The report header's regime label and its confidence — see engine/report.ts's classifyRegime/driverConfidence. Present only on engine reports carrying this field (post-redesign). */
  regime?: string;
  regimeConfidence?: "high" | "moderate" | "low";
};

export type TokenAnalysis = ModelAnalysis & { metadata: AnalysisMetadata };

const MAX_TEXT = 2000;
const LIMITS = { statements: 12, risks: 10, dataGaps: 15, questions: 10, sourceIds: 12 };

// ---- JSON Schema sent as generationConfig.responseJsonSchema ----
// No maxItems here: Gemini rejected the full schema with maxItems on every nested
// array (HTTP 400 INVALID_ARGUMENT, verified against gemini-3.6-flash). Array
// sizes are enforced after generation instead: the validator trims to LIMITS.

const sourceIdsSchema = {
  type: "array",
  description: "IDs from the research context that support this item (for example obs:123, calc:456, hist:coingecko:price_usd, fresh:defillama, scope:defillama). Use only IDs that appear in the context; never invent IDs or external citations.",
  items: { type: "string" },
};

const statementSchema = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: [...STATEMENT_KINDS],
      description: "observed = a provider observation restated; calculated = a deterministic calculated metric restated; interpretation = your analytical reading of the evidence (never causal unless causal evidence is supplied); uncertainty = a limitation or unknown.",
    },
    text: { type: "string", description: "One neutral, evidence-based sentence or two. No advice, predictions, or price targets." },
    sourceIds: sourceIdsSchema,
    period: { type: "string", description: "For time-based statements, the exact period label from the context (period.label, window.label, or history summary.label). Empty string when not time-based." },
  },
  required: ["kind", "text", "sourceIds", "period"],
  additionalProperties: false,
};

const sectionSchema = (description: string) => ({
  type: "object",
  description,
  properties: {
    overview: { type: "string", description: "A short neutral synthesis (at most three sentences; one sentence if there are no statements). No numbers, dates, values, or facts that are not carried by the sourced statements below." },
    statements: { type: "array", items: statementSchema },
  },
  required: ["overview", "statements"],
  additionalProperties: false,
});

export const ANALYSIS_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    executiveSummary: sectionSchema("Concise evidence-based summary of the token's current observable state. Not bullish/bearish, not a recommendation."),
    marketPerformance: sectionSchema("Price, market cap, FDV, volume, provider-reported changes, and stored price history; current values kept distinct from historical changes."),
    fundamentalPerformance: sectionSchema("TVL, fees, revenue, and their changes. State that DeFiLlama data is protocol-level where it applies."),
    valuation: sectionSchema("Existing calculated valuation and market-structure ratios only: what each measures and what the evidence may indicate, without calling a ratio good or bad."),
    marketFundamentalRelationships: sectionSchema("Observed relationships or divergences between market and fundamental series, over the stated aligned periods. No causal claims."),
    liquidityMarketStructure: sectionSchema("DEX liquidity, volume/liquidity, buy/sell activity, transactions, FDV; clearly DEX-specific."),
    tokenomics: sectionSchema("Circulating, total, and maximum supply and supply relationships from the context only. No unlocks or emissions unless supplied."),
    risks: {
      type: "array",
      description: "Only risks or anomalies supported by evidence, plus clearly labelled data limitations. Do not turn every missing metric into a risk.",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          basis: { type: "string", enum: ["evidence", "data_limitation"], description: "evidence = the supplied data shows the issue; data_limitation = the issue is missing or weak data." },
          detail: { type: "string" },
          sourceIds: sourceIdsSchema,
        },
        required: ["title", "basis", "detail", "sourceIds"],
        additionalProperties: false,
      },
    },
    dataGaps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: [...DATA_GAP_CATEGORIES] },
          detail: { type: "string" },
          sourceIds: sourceIdsSchema,
        },
        required: ["category", "detail", "sourceIds"],
        additionalProperties: false,
      },
    },
    furtherResearchQuestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "A question for further research, not a recommendation." },
          rationale: { type: "string" },
          sourceIds: sourceIdsSchema,
        },
        required: ["question", "rationale", "sourceIds"],
        additionalProperties: false,
      },
    },
  },
  required: [...SECTION_KEYS, "risks", "dataGaps", "furtherResearchQuestions"],
  additionalProperties: false,
} as const;

// ---- Validation ----

export class AnalysisValidationError extends Error {
  readonly violations: string[];
  /** Non-fatal observations gathered before the fatal violations were found (diagnostics only). */
  warnings: string[] = [];
  constructor(message: string, violations: string[] = [message]) {
    super(message);
    this.name = "AnalysisValidationError";
    this.violations = violations;
  }
}

/**
 * Advice / prediction language the analysis must never contain. Phrased to
 * avoid false positives on legitimate terms such as "DEX buy/sell ratio".
 */
const PROHIBITED_PATTERNS: RegExp[] = [
  /\b(you|investors?|traders?|users?|readers?|one)\s+(should|must|ought to|may want to)\s+(buy|sell|hold|invest|accumulate|short|exit)\b/i,
  /\b(strong\s+)?(buy|sell|hold)\s+(rating|signal|recommendation|opportunity)\b/i,
  /\brecommend(?:s|ed|ing)?\s+(buying|selling|holding|investing|an?\s+(?:entry|exit|position))\b/i,
  /\bprice\s+targets?\b/i,
  /\b(will|is\s+(?:likely|expected|poised|set)\s+to)\s+(rise|fall|rally|surge|climb|drop|decline|crash|moon|outperform|underperform|reach|hit|double|triple)\b/i,
  /\b(good|great|bad|safe|solid)\s+investment\b/i,
  /\b(undervalued|overvalued)\b.*\b(buy|sell)\b/i,
  /\bprobability\s+of\s+(success|failure)\b/i,
];

export function findProhibitedLanguage(text: string): string | null {
  for (const pattern of PROHIBITED_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, path: string, { allowEmpty = false } = {}): string {
  if (typeof value !== "string") throw new AnalysisValidationError(`${path} must be a string.`);
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) throw new AnalysisValidationError(`${path} must not be empty.`);
  if (trimmed.length > MAX_TEXT) throw new AnalysisValidationError(`${path} exceeds ${MAX_TEXT} characters.`);
  const prohibited = findProhibitedLanguage(trimmed);
  if (prohibited) throw new AnalysisValidationError(`${path} contains investment-advice or prediction language ("${prohibited}").`);
  return trimmed;
}

function list(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new AnalysisValidationError(`${path} must be an array.`);
  return value.slice(0, max);
}

function oneOf<T extends string>(value: unknown, options: readonly T[], path: string): T {
  if (typeof value !== "string" || !options.includes(value as T)) throw new AnalysisValidationError(`${path} must be one of ${options.join(", ")}.`);
  return value as T;
}

type Counters = { droppedSourceIds: number; untraceableFactualStatements: number };

type Check = { evidence: EvidenceIndex; violations: string[]; warnings: string[]; counters: Counters };

const MAX_OVERVIEW_SENTENCES = 3;

function sourceIds(value: unknown, path: string, check: Check): string[] {
  const ids = list(value, path, LIMITS.sourceIds);
  const kept: string[] = [];
  for (const id of ids) {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (trimmed && check.evidence.ids.has(trimmed)) {
      if (!kept.includes(trimmed)) kept.push(trimmed);
    } else {
      check.counters.droppedSourceIds += 1;
      check.violations.push(`${path}: unknown source ID ${JSON.stringify(id)}.`);
    }
  }
  return kept;
}

function citedItems(ids: string[], check: Check): EvidenceItem[] {
  const items = check.evidence.context?.items;
  return items ? ids.map((id) => items.get(id)).filter((item): item is EvidenceItem => Boolean(item)) : [];
}

/**
 * Language rules that apply to every piece of model text.
 * `concept: "warning"` is used for forward-looking research questions/rationales, where naming a
 * concept to investigate is not the same as asserting it as fact (see furtherResearchQuestions).
 *
 * Naming a legitimate Token Samurai data provider (CoinGecko, DeFiLlama, DexPaprika,
 * GeckoTerminal) is never itself a violation, mapped or not — Token Samurai genuinely uses all of
 * them, so "no DeFiLlama mapping is available for this token" and "further research could examine
 * GeckoTerminal pool data" are both accurate. Only a specific fact attributed to a provider that
 * this context does not contain is a violation, and the grounding rules below already catch that
 * (an invented number or period), regardless of which provider, if any, the text names.
 */
function languageRules(value: string, path: string, check: Check, options: { concept?: "fatal" | "warning" } = {}): void {
  const marker = findLeakedEvidenceMarker(value);
  if (marker) check.violations.push(`${path}: contains the internal evidence marker "${marker}"; cite it in sourceIds instead of writing it in the text.`);
  for (const directional of findDirectionalLanguage(value)) {
    check.violations.push(`${path}: directional/sentiment language ("${directional}"); describe observed changes neutrally.`);
  }
  for (const causal of findCausalLanguage(value)) {
    check.violations.push(`${path}: causal language ("${causal}"); the supplied evidence is observational and never establishes that one factor caused another — describe an observed relationship instead.`);
  }
  for (const analytical of findAnalyticalLanguage(value)) {
    check.warnings.push(`${path}: analytical language ("${analytical}") — only a warning while the underlying claim is otherwise grounded.`);
  }
  const context = check.evidence.context;
  if (!context) return;
  const concept = findExternalConcept(value, context.text);
  if (concept) {
    const message = `${path}: introduces "${concept}", which the research context does not contain.`;
    if (options.concept === "warning") check.warnings.push(message); else check.violations.push(message);
  }
  const asset = findOtherAsset(value, context.text, context.tokenSymbol);
  if (asset) check.violations.push(`${path}: refers to ${asset}, a distinct asset the research context does not establish for this token.`);
}

/** Numbers and named periods in evidence-bearing text must come from the cited items. */
function groundingRules(value: string, path: string, ids: string[], check: Check): void {
  if (!check.evidence.context) return;
  const cited = citedItems(ids, check);
  const ungrounded = ungroundedNumbers(value, cited);
  if (ungrounded.length) check.violations.push(`${path}: number(s) ${ungrounded.join(", ")} do not match any value in the cited sources.`);
  const period = findUnsupportedNamedPeriod(value, cited);
  if (period) check.violations.push(`${path}: "${period}" is not a period established by the cited sources.`);
}

const KIND_SOURCES: Record<StatementKind, { test: (id: string) => boolean; need: string }> = {
  observed: { test: (id) => id.startsWith("obs:") || id.startsWith("hist:"), need: "an observation (obs:) or history (hist:) source" },
  calculated: { test: (id) => id.startsWith("calc:"), need: "a calculated-metric (calc:) source" },
  interpretation: { test: () => true, need: "at least one source" },
  uncertainty: { test: () => true, need: "at least one source" },
};

function section(value: unknown, path: string, check: Check): AnalysisSection {
  if (!isRecord(value)) throw new AnalysisValidationError(`${path} must be an object.`);
  const overview = text(value.overview, `${path}.overview`);
  const sectionIds: string[] = [];
  const statements = list(value.statements, `${path}.statements`, LIMITS.statements).map((item, index) => {
    const itemPath = `${path}.statements[${index}]`;
    if (!isRecord(item)) throw new AnalysisValidationError(`${itemPath} must be an object.`);
    const kind = oneOf(item.kind, STATEMENT_KINDS, `${itemPath}.kind`);
    const statementText = text(item.text, `${itemPath}.text`);
    const ids = sourceIds(item.sourceIds, `${itemPath}.sourceIds`, check);
    sectionIds.push(...ids);
    const period = item.period === null || item.period === undefined ? "" : text(item.period, `${itemPath}.period`, { allowEmpty: true });

    if (!ids.some(KIND_SOURCES[kind].test)) {
      if (kind === "observed" || kind === "calculated") check.counters.untraceableFactualStatements += 1;
      check.violations.push(`${itemPath}: a "${kind}" statement must cite ${KIND_SOURCES[kind].need}.`);
    }
    const cited = citedItems(ids, check);
    if (check.evidence.context && kind !== "uncertainty") {
      const labels = cited.flatMap((evidence) => evidence.periodLabels);
      if (!period && cited.some((evidence) => evidence.requiresPeriod)) {
        check.violations.push(`${itemPath}: cites time-based evidence but has no period; copy the period label of the cited item.`);
      }
      if (period && !labels.includes(period)) check.violations.push(`${itemPath}: period is not the label of a cited source.`);
    }
    languageRules(statementText, `${itemPath}.text`, check);
    groundingRules(statementText, `${itemPath}.text`, ids, check);
    return { kind, text: statementText, sourceIds: ids, period: period || null, traceable: ids.length > 0 };
  });

  // Overviews are short syntheses; evidence-derived facts belong in sourced statements. A named
  // period (e.g. "24 hours") or a number/date already established by this section's own cited
  // evidence is only a warning — the underlying fact is grounded, it's just described in the
  // synthesis too — but a period, number, or date the section's evidence does not establish is
  // still fatal, exactly like a statement's own grounding rule (4c).
  const sectionCited = citedItems(sectionIds, check);
  const { grounded, ungrounded, residual } = overviewPeriods(overview, sectionCited);
  for (const period of grounded) check.warnings.push(`${path}.overview: names a period ("${period}") already established by this section's own cited evidence.`);
  for (const period of ungrounded) check.violations.push(`${path}.overview: names a period ("${period}"); time-based claims belong in sourced statements.`);
  const ungroundedOverviewNumbers = ungroundedNumbers(residual, sectionCited);
  if (ungroundedOverviewNumbers.length) {
    check.violations.push(`${path}.overview: number(s) ${ungroundedOverviewNumbers.join(", ")} do not match any value in the cited sources.`);
  } else if (/\d/.test(residual)) {
    check.warnings.push(`${path}.overview: contains a number or date already established by this section's own cited evidence.`);
  }
  const sentences = sentenceCount(overview);
  if (sentences > MAX_OVERVIEW_SENTENCES) check.violations.push(`${path}.overview: longer than ${MAX_OVERVIEW_SENTENCES} sentences.`);
  if (statements.length === 0 && sentences > 1) check.violations.push(`${path}: has no statements, so its overview may only be a one-sentence note.`);
  languageRules(overview, `${path}.overview`, check);
  return { overview, statements };
}

/**
 * Validate a parsed model response. With a full research-context evidence
 * index, all evidence rules apply; with stored evidence (IDs only), the
 * structural and language rules apply. Throws AnalysisValidationError listing
 * every violation.
 */
export function validateModelAnalysis(raw: unknown, evidenceOrIds: EvidenceIndex | Set<string>): { analysis: ModelAnalysis; counters: Counters; warnings: string[] } {
  if (!isRecord(raw)) throw new AnalysisValidationError("The response must be a JSON object.");
  const evidence = evidenceOrIds instanceof Set ? storedEvidence(evidenceOrIds) : evidenceOrIds;
  const check: Check = { evidence, violations: [], warnings: [], counters: { droppedSourceIds: 0, untraceableFactualStatements: 0 } };
  const sections = Object.fromEntries(SECTION_KEYS.map((key) => [key, section(raw[key], key, check)])) as Record<SectionKey, AnalysisSection>;

  const risks = list(raw.risks, "risks", LIMITS.risks).map((item, index) => {
    const path = `risks[${index}]`;
    if (!isRecord(item)) throw new AnalysisValidationError(`${path} must be an object.`);
    const risk = {
      title: text(item.title, `${path}.title`),
      basis: oneOf(item.basis, ["evidence", "data_limitation"] as const, `${path}.basis`),
      detail: text(item.detail, `${path}.detail`),
      sourceIds: sourceIds(item.sourceIds, `${path}.sourceIds`, check),
    };
    if (risk.sourceIds.length === 0) check.violations.push(`${path}: must cite at least one source.`);
    if (risk.basis === "evidence" && !risk.sourceIds.some((id) => /^(obs|calc|hist):/.test(id))) {
      check.violations.push(`${path}: an evidence-based risk must cite observed or calculated data.`);
    }
    for (const [field, value] of [["title", risk.title], ["detail", risk.detail]] as const) {
      languageRules(value, `${path}.${field}`, check);
      groundingRules(value, `${path}.${field}`, risk.sourceIds, check);
    }
    return risk;
  });

  const dataGaps = list(raw.dataGaps, "dataGaps", LIMITS.dataGaps).map((item, index) => {
    const path = `dataGaps[${index}]`;
    if (!isRecord(item)) throw new AnalysisValidationError(`${path} must be an object.`);
    const gap = {
      category: oneOf(item.category, DATA_GAP_CATEGORIES, `${path}.category`),
      detail: text(item.detail, `${path}.detail`),
      sourceIds: sourceIds(item.sourceIds, `${path}.sourceIds`, check),
    };
    if (gap.sourceIds.length === 0) check.violations.push(`${path}: must cite the context item that records the gap.`);
    languageRules(gap.detail, `${path}.detail`, check);
    groundingRules(gap.detail, `${path}.detail`, gap.sourceIds, check);
    return gap;
  });

  // Questions are not factual claims, so sources are optional; embedded numbers still need them.
  const furtherResearchQuestions = list(raw.furtherResearchQuestions, "furtherResearchQuestions", LIMITS.questions).map((item, index) => {
    const path = `furtherResearchQuestions[${index}]`;
    if (!isRecord(item)) throw new AnalysisValidationError(`${path} must be an object.`);
    const question = {
      question: text(item.question, `${path}.question`),
      rationale: text(item.rationale, `${path}.rationale`),
      sourceIds: sourceIds(item.sourceIds, `${path}.sourceIds`, check),
    };
    for (const [field, value] of [["question", question.question], ["rationale", question.rationale]] as const) {
      languageRules(value, `${path}.${field}`, check, { concept: "warning" });
      if (question.sourceIds.length === 0 && /\d/.test(value)) check.violations.push(`${path}.${field}: states figures without citing their sources.`);
      else groundingRules(value, `${path}.${field}`, question.sourceIds, check);
    }
    return question;
  });

  if (check.violations.length > 0) {
    const error = new AnalysisValidationError(`The analysis violates the evidence contract (${check.violations.length} issue(s)): ${check.violations.slice(0, 6).join(" ")}`, check.violations);
    error.warnings = check.warnings;
    throw error;
  }
  return { analysis: { ...sections, risks, dataGaps, furtherResearchQuestions }, counters: check.counters, warnings: check.warnings };
}

/** Re-validate a stored analysis before rendering it (stored JSON is still untrusted). */
export function parseStoredAnalysis(raw: unknown): TokenAnalysis | null {
  if (!isRecord(raw) || !isRecord(raw.metadata) || !isRecord(raw.metadata.sources)) return null;
  const metadata = raw.metadata as unknown as AnalysisMetadata;
  try {
    const { analysis } = validateModelAnalysis(raw, storedEvidence(Object.keys(metadata.sources)));
    return { ...analysis, metadata };
  } catch {
    return null;
  }
}
