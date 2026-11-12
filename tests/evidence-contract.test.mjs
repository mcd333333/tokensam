import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildEvidenceIndex, findExternalConcept } from "../src/lib/analysis/evidence-rules.ts";
import { AnalysisValidationError, parseStoredAnalysis, validateModelAnalysis } from "../src/lib/analysis/schema.ts";

// Real fixtures from the 2026-09-24 Bitcoin generation (public market data only):
// the research context Nemotron received and its raw structured output.
const context = JSON.parse(readFileSync("tests/fixtures/bitcoin-context-2026-09-24.json", "utf8"));
const nemotronOutput = JSON.parse(readFileSync("tests/fixtures/nemotron-bitcoin-output-2026-09-24.json", "utf8"));
const evidence = buildEvidenceIndex(context);

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const obs = (metric) => context.observations.find((item) => item.provider === "CoinGecko" && item.metric === metric);
const calc = (metricId) => context.calculatedMetrics.find((item) => item.metricId === metricId);
const st = (kind, text, sourceIds, period = "") => ({ kind, text, sourceIds, period });

/** A Bitcoin analysis that follows the evidence contract. */
function validBitcoin() {
  const price = obs("price_usd");
  const change24h = obs("price_change_24h_pct");
  const growth = calc("price_growth_pct");
  return {
    executiveSummary: { overview: "Bitcoin evidence here is limited to CoinGecko market data.", statements: [
      st("observed", `CoinGecko reported a price of about $${Math.round(price.value).toLocaleString("en-US")}.`, [price.id]),
    ] },
    marketPerformance: { overview: "Price changes are reported over their own stated periods.", statements: [
      st("observed", `CoinGecko reported a price change of about +${change24h.value.toFixed(2)}% over its rolling 24-hour window.`, [change24h.id], change24h.window.label),
      st("calculated", `Price decreased by about ${Math.abs(growth.value).toFixed(2)}% between the two most recent stored observations.`, [growth.id], growth.period.label),
      st("interpretation", "The provider-reported rolling change and the change between the two most recent stored observations differ in sign, which reflects their different periods.", [change24h.id, growth.id], growth.period.label),
    ] },
    fundamentalPerformance: { overview: "No protocol-level fundamentals are available for this token.", statements: [
      st("uncertainty", "Bitcoin has no DeFiLlama mapping, so protocol TVL, fees, and revenue are unavailable by design.", ["scope:defillama"]),
    ] },
    valuation: { overview: "Only one valuation ratio is available.", statements: [
      st("calculated", `CoinGecko volume was about ${(calc("volume_to_market_cap").value * 100).toFixed(1)}% of market capitalization.`, [calc("volume_to_market_cap").id]),
    ] },
    marketFundamentalRelationships: { overview: "No price-to-fundamentals relationship can be assessed for this token.", statements: [] },
    liquidityMarketStructure: { overview: "DEX market structure is unavailable by design for this token.", statements: [
      st("uncertainty", "No verified DexPaprika address mapping exists for Bitcoin, so DEX metrics are unavailable by design.", ["scope:dexpaprika"]),
    ] },
    tokenomics: { overview: "Supply figures come from CoinGecko.", statements: [
      st("observed", `CoinGecko reported a circulating supply of about ${obs("circulating_supply").value.toLocaleString("en-US")} BTC and a maximum supply of ${obs("maximum_supply").value.toLocaleString("en-US")} BTC.`, [obs("circulating_supply").id, obs("maximum_supply").id]),
    ] },
    risks: [{ title: "Protocol fundamentals unavailable", basis: "data_limitation", detail: "Bitcoin has no DeFiLlama mapping, so TVL, fees, and revenue are unavailable by design.", sourceIds: ["scope:defillama"] }],
    dataGaps: [{ category: "mapping_limitation", detail: "Bitcoin has no DeFiLlama mapping; TVL, fees, and revenue are unavailable by design.", sourceIds: ["scope:defillama"] }],
    furtherResearchQuestions: [{ question: "Which additional data sources could describe Bitcoin market structure beyond CoinGecko aggregates?", rationale: "Only CoinGecko market data is available in this context.", sourceIds: [] }],
  };
}

function violations(output) {
  try {
    validateModelAnalysis(output, evidence);
  } catch (error) {
    if (error instanceof AnalysisValidationError) return error.violations;
    throw error;
  }
  return [];
}
function expectViolation(output, pattern, label) {
  const found = violations(output);
  assert.ok(found.some((item) => pattern.test(item)), `${label}: expected a violation matching ${pattern}; got ${JSON.stringify(found)}`);
}
/** Non-fatal warnings: from a successful validation, or from a rejected one (still collected). */
function warningsOf(output) {
  try {
    return validateModelAnalysis(output, evidence).warnings;
  } catch (error) {
    if (error instanceof AnalysisValidationError) return error.warnings;
    throw error;
  }
}

// ---- Positive controls ----

test("8, 10. a sourced, period-correct Bitcoin analysis passes (including a grounded interpretation)", () => {
  assert.deepEqual(violations(validBitcoin()), []);
});

test("9. a pure research question without sources passes; one embedding figures without sources fails", () => {
  const withNumbers = validBitcoin();
  withNumbers.furtherResearchQuestions[0].question = "Why is circulating supply about 95.7% of maximum supply?";
  expectViolation(withNumbers, /states figures without citing their sources/, "question with figures");
});

test("9b. a research question naming an unestablished concept to investigate passes; asserting a fact about it still requires evidence", () => {
  const adoptionQuestion = validBitcoin();
  adoptionQuestion.furtherResearchQuestions[0].question = "What additional data could clarify user adoption?";
  assert.deepEqual(violations(adoptionQuestion), [], "naming a concept for future research is not a factual claim");
  const adoptionClaim = validBitcoin();
  adoptionClaim.furtherResearchQuestions[0].question = "Why did adoption increase 30%?";
  expectViolation(adoptionClaim, /states figures without citing their sources/, "a factual claim with a number still needs a source, even inside a question");
});

// ---- Adversarial cases ----

test("1. a factual overview with an empty statement array fails", () => {
  const output = validBitcoin();
  output.executiveSummary = { overview: "Bitcoin traded at approximately $84,388 with a market cap of about $1.69 trillion.", statements: [] };
  // No statements at all means no evidence is cited by this section, so neither number is grounded.
  expectViolation(output, /executiveSummary\.overview: number\(s\) 84,388, 1\.69 do not match any value in the cited sources/, "numeric overview");
  const paragraph = validBitcoin();
  paragraph.liquidityMarketStructure = { overview: "DEX metrics are unavailable by design. Derived DEX ratios therefore cannot be calculated.", statements: [] };
  expectViolation(paragraph, /has no statements, so its overview may only be a one-sentence note/, "overview paragraph without statements");
});

test("2. a factual statement without sources fails; kinds must cite matching source types", () => {
  const unsourced = validBitcoin();
  unsourced.executiveSummary.statements[0].sourceIds = [];
  expectViolation(unsourced, /"observed" statement must cite an observation/, "unsourced observed");
  const wrongType = validBitcoin();
  wrongType.valuation.statements[0].sourceIds = [obs("volume_24h_usd").id];
  expectViolation(wrongType, /"calculated" statement must cite a calculated-metric/, "calculated citing an observation");
  const scopeOnlyRisk = validBitcoin();
  scopeOnlyRisk.risks[0].basis = "evidence";
  expectViolation(scopeOnlyRisk, /evidence-based risk must cite observed or calculated data/, "evidence risk without data");
  const gapWithoutSource = validBitcoin();
  gapWithoutSource.dataGaps[0].sourceIds = [];
  expectViolation(gapWithoutSource, /must cite the context item that records the gap/, "unsourced data gap");
});

test("3. an unknown source ID fails", () => {
  const output = validBitcoin();
  output.tokenomics.statements[0].sourceIds.push("obs:999999999");
  expectViolation(output, /unknown source ID "obs:999999999"/, "unknown ID");
});

test("4. unsupported general knowledge fails; concepts present in the context remain allowed", () => {
  const issuance = validBitcoin();
  issuance.tokenomics.statements.push(st("interpretation", "Supply is approaching its maximum under the programmed issuance schedule.", [obs("circulating_supply").id]));
  expectViolation(issuance, /introduces "issuance"/, "issuance schedule");
  // A research question naming a concept to investigate is not a factual claim, so it is only a warning.
  const subsidy = validBitcoin();
  subsidy.furtherResearchQuestions[0].question = "How does the current block subsidy compare with historical levels?";
  assert.deepEqual(violations(subsidy), [], "block subsidy in a research question does not fail the report");
  assert.ok(warningsOf(subsidy).some((item) => /introduces "block subsidy"/.test(item)), "but it is still recorded as a warning");
  const halving = validBitcoin();
  halving.marketPerformance.statements[2].text = "The difference may reflect the halving cycle.";
  expectViolation(halving, /introduces "halving"/, "external premise inside an interpretation");
  assert.equal(findExternalConcept("UNI is a governance token.", JSON.stringify({ relationship: "UNI governance token associated with the Uniswap protocol" })), null);
});

test("5. directional/sentiment language fails; neutral descriptions pass", () => {
  const bearish = validBitcoin();
  bearish.marketPerformance.overview = "Short-term price action was mildly bearish.";
  expectViolation(bearish, /directional\/sentiment language \("bearish"\)/, "bearish");
  // Analytical wording about already-observed behavior is only a warning, not a rejection —
  // but the sentence's own unsupported "Weekly" period claim is still fatal, independently.
  const momentum = validBitcoin();
  momentum.marketPerformance.statements.push(st("interpretation", "Weekly momentum remained positive.", [obs("price_change_7d_pct").id], obs("price_change_7d_pct").window.label));
  assert.ok(warningsOf(momentum).some((item) => /\("momentum"\)/.test(item)), "momentum is recorded as a warning");
  expectViolation(momentum, /"Weekly" is not a period established/, "weekly");
  const rise = validBitcoin();
  rise.executiveSummary.statements.push(st("interpretation", "The price is likely to rise.", [obs("price_usd").id]));
  assert.ok(violations(rise).length > 0, "prediction language is rejected");
});

test("5b. an overview period already established by this section's own cited statements is a warning, not a rejection; an unestablished one still fails", () => {
  const grounded = validBitcoin();
  grounded.marketPerformance.overview = "Price changes over the last 24 hours are reported alongside the interval between stored observations.";
  assert.deepEqual(violations(grounded), [], "the 24-hour period is established by this section's own cited 24-hour statement");
  assert.ok(warningsOf(grounded).some((item) => /names a period \("24 hours"\) already established/.test(item)));
  const ungroundedPeriod = validBitcoin();
  ungroundedPeriod.tokenomics.overview = "Supply figures are reported over a 30-day window.";
  expectViolation(ungroundedPeriod, /tokenomics\.overview: names a period \("30-day"\)/, "a period this section's evidence never establishes still fails");
});

test("6. a data gap about DeFiLlama fails only when it makes an ungrounded factual claim, not merely for naming DeFiLlama or giving its own reason", () => {
  // This still fails, but for the number/period it invents ("24 hours" not established by scope:defillama),
  // not for naming DeFiLlama or for the specific reason given — mentioning a legitimate Token Samurai
  // provider is never itself a violation (see the shared evidence-validation semantics change).
  const output = validBitcoin();
  output.dataGaps[0].detail = "No market-cap/TVL or price/TVL aligned observations exist within the last 24 hours, rendering divergence metrics unavailable.";
  expectViolation(output, /number\(s\) 24 do not match any value in the cited sources/, "an invented number, regardless of the provider named");
  expectViolation(output, /"24 hours" is not a period established by the cited sources/, "an invented period, regardless of the provider named");
  // A vague, non-"no mapping" explanation for the same provider now passes: it claims no specific
  // fact, so it is treated like any other unavailable-data statement, not policed by provider name.
  const vague = validBitcoin();
  vague.dataGaps[0].detail = "Historical observations for DeFiLlama TVL, fees, and revenue are absent.";
  assert.deepEqual(violations(vague), [], "a provider mention with no ungrounded fact passes");
});

test("6b. the unmapped-provider reason may be stated anywhere in a risk or question pair", () => {
  const output = validBitcoin();
  output.risks[0] = { title: "DEX liquidity unavailable", basis: "data_limitation", detail: "No verified DexPaprika address is configured for Bitcoin, so DEX metrics are unavailable by design.", sourceIds: ["scope:dexpaprika"] };
  assert.deepEqual(violations(output), []);
});

test("7. substituting WBTC (a distinct asset) for Bitcoin fails", () => {
  const proxy = validBitcoin();
  proxy.furtherResearchQuestions[0].question = "Could WBTC liquidity on Ethereum serve as a proxy for Bitcoin?";
  expectViolation(proxy, /refers to WBTC, a distinct asset/, "WBTC");
  const wrapped = validBitcoin();
  wrapped.furtherResearchQuestions[0].rationale = "Wrapped Bitcoin may be tracked elsewhere.";
  expectViolation(wrapped, /refers to Wrapped Bitcoin/i, "wrapped alias");
});

test("numbers must match cited values; periods must come from cited items", () => {
  const derived = validBitcoin();
  derived.tokenomics.statements.push(st("calculated", "Circulating supply is about 95.7% of maximum supply.", [calc("volume_to_market_cap").id]));
  expectViolation(derived, /number\(s\) 95\.7 do not match/, "derived figure");
  const named = validBitcoin();
  named.marketPerformance.statements[1].text = `Price decreased by about ${Math.abs(calc("price_growth_pct").value).toFixed(2)}% over 24 hours.`;
  expectViolation(named, /"24 hours" is not a period established by the cited sources/, "2.5-hour change called 24-hour");
  const missing = validBitcoin();
  missing.marketPerformance.statements[1].period = "";
  expectViolation(missing, /cites time-based evidence but has no period/, "missing period");
  const invented = validBitcoin();
  invented.marketPerformance.statements[1].period = "past day";
  expectViolation(invented, /period is not the label of a cited source/, "non-verbatim period");
});

test("stored analyses are re-validated with the context-free rules before display", () => {
  const compliant = { ...validBitcoin(), metadata: { sources: Object.fromEntries([...evidence.ids].map((id) => [id, id])) } };
  assert.ok(parseStoredAnalysis(compliant), "a compliant stored analysis renders");
  const numericOverview = { ...compliant, executiveSummary: { overview: "Price was about $84,388.", statements: [] } };
  assert.equal(parseStoredAnalysis(numericOverview), null, "a stored analysis with a numeric overview is not rendered");
});

// ---- Task 10: the real Nemotron output ----

test("the real 2026-09-24 Nemotron Bitcoin output is now rejected, for the reasons the audit identified", () => {
  const found = violations(nemotronOutput);
  const expected = [
    [/executiveSummary\.overview: number\(s\) .*do not match any value in the cited sources/, "facts and numbers in overviews, ungrounded (this section cites nothing)"],
    [/tokenomics\.overview: number\(s\) .*do not match any value in the cited sources/, "supply figures in the tokenomics overview, ungrounded (this section cites nothing)"],
    [/\("bearish"\)/, "mildly bearish"],
    [/marketPerformance\.overview: names a period \("weekly"\)/, "weekly (a named period in an overview)"],
    [/introduces "issuance"/, "issuance schedule"],
    [/refers to WBTC/, "WBTC as a proxy"],
    [/number\(s\) 95\.7 do not match/, "derived 95.7% figure"],
  ];
  for (const [pattern, label] of expected) assert.ok(found.some((item) => pattern.test(item)), `${label} is caught`);
  // dataGaps[1]/[2] mention DeFiLlama and give their own (not "no mapping") reason for a gap; under
  // the shared evidence-validation semantics change, naming a legitimate provider and explaining a
  // gap in its own words is no longer itself a violation — only an actual ungrounded fact would be,
  // and neither of these two entries states one. The report is still rejected regardless, for the
  // independent reasons above.
  assert.ok(!found.some((item) => item.startsWith("dataGaps[1]") || item.startsWith("dataGaps[2]")), "no dataGaps[1]/[2] violation remains once provider-name policing is retired");
  // "Weekly momentum" and "block subsidy" (named only inside a research question) are not
  // rejection reasons by themselves — both are still recorded as warnings, but the report is
  // rejected for the fatal reasons above regardless.
  const warnings = warningsOf(nemotronOutput);
  assert.ok(warnings.some((item) => /\("momentum"\)/.test(item)), "weekly momentum is still recorded as a warning");
  assert.ok(warnings.some((item) => /introduces "block subsidy"/.test(item)), "block subsidy (named only in a research question) is still recorded as a warning");
});

let failures = 0;
for (const { name, run } of cases) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}
console.log(`${cases.length - failures}/${cases.length} evidence-contract checks passed.`);
if (failures > 0) process.exitCode = 1;
