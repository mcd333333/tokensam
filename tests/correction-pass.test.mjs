// Correction-pass experiment helpers (src/lib/analysis/correction-pass.ts). No network.

import assert from "node:assert/strict";

import { CORRECTION_TASK, buildCorrectionUserContent, correctionItems, stripServerFields, unmappedWordingFrom } from "../src/lib/analysis/correction-pass.ts";
import { PROFILE_SYSTEM_INSTRUCTION } from "../src/lib/analysis/prompt.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const WORDING = unmappedWordingFrom(PROFILE_SYSTEM_INSTRUCTION);
// Messages in the exact shapes the unchanged validator produces.
const VIOLATIONS = [
  'executiveSummary.overview: directional/sentiment language ("momentum"); describe observed changes neutrally.',
  "marketPerformance.statements[4].text: number(s) 24 do not match any value in the cited sources.",
  'marketPerformance.statements[4].text: "24-hour" is not a period established by the cited sources.',
  "liquidityMarketStructure.overview: refers to DexPaprika data without stating the context's reason (no DexPaprika mapping for this token).",
  "tokenomics.overview: contains numbers or dates; state evidence-derived facts as sourced statements.",
  'risks[1].detail: "7-day" is not a period established by the cited sources.',
  "furtherResearchQuestions[0]: refers to DexPaprika data without stating the context's reason (no DexPaprika mapping for this token).",
];

test("R1. corrections are grouped by report location from the validator's own messages (no duplicates)", () => {
  const items = correctionItems(VIOLATIONS, WORDING);
  assert.deepEqual(items.map((item) => item.location), [
    "executiveSummary.overview", "marketPerformance.statements[4]", "liquidityMarketStructure.overview",
    "tokenomics.overview", "risks[1]", "furtherResearchQuestions[0]",
  ]);
  const statement = items.find((item) => item.location === "marketPerformance.statements[4]");
  assert.equal(statement.problems.length, 2, "both messages about one statement stay together");
  assert.equal(statement.fix.length, 2);
  assert.equal(correctionItems([...VIOLATIONS, ...VIOLATIONS], WORDING).length, items.length, "repeated messages are not duplicated");
  const total = items.reduce((sum, item) => sum + item.problems.length, 0);
  assert.equal(total, VIOLATIONS.length, "every validator message is preserved");
});

test("R2. fixes are generic and use the prompt's prescribed provider wording", () => {
  const items = correctionItems(VIOLATIONS, WORDING);
  const dex = items.find((item) => item.location === "liquidityMarketStructure.overview");
  assert.ok(WORDING["DexPaprika"], "the wording is read from the system instruction");
  assert.ok(dex.fix[0].includes(WORDING["DexPaprika"]));
  assert.match(items.find((item) => item.location === "tokenomics.overview").fix[0], /Remove every digit/);
  assert.match(items.find((item) => item.location === "executiveSummary.overview").fix[0], /neutral/);
  const other = correctionItems(["valuation.statements[2].text: number(s) 9 do not match any value in the cited sources."], WORDING);
  assert.equal(other[0].location, "valuation.statements[2]", "works for any location, not just Bitcoin's");
});

test("R3. the correction request carries the payload, the constrained task, the problems, and the model-facing report", () => {
  const payload = { version: "profile-1", token: { id: "t", name: "T", symbol: "T", chain: "c", category: "x", isNative: true, contractAddress: null }, dataAsOf: null, scope: [], fields: [] };
  const report = { executiveSummary: { overview: "o", statements: [{ kind: "observed", text: "a <b>", sourceIds: ["obs:price"], period: "server label" }] } };
  const text = buildCorrectionUserContent(payload, report, correctionItems(VIOLATIONS, WORDING));
  assert.ok(text.includes("<token_samurai_data>") && text.includes(CORRECTION_TASK) && text.includes("PROBLEMS TO FIX"));
  assert.match(CORRECTION_TASK, /Revise ONLY the text at the listed locations/);
  assert.match(CORRECTION_TASK, /Do not invent, add, or replace evidence IDs/);
  assert.match(CORRECTION_TASK, /Do not introduce new factual claims, numbers, dates, or time periods/);
  assert.match(CORRECTION_TASK, /Return the complete corrected report/);
  const block = text.slice(text.indexOf("<report_to_correct>\n") + 20, text.lastIndexOf("\n</report_to_correct>"));
  assert.deepEqual(JSON.parse(block), stripServerFields(report));
  assert.equal(JSON.parse(block).executiveSummary.statements[0].period, undefined, "server-attached periods are not sent back");
  assert.equal(text.split("</report_to_correct>").length, 2, "report text cannot close its block");
});

let failures = 0;
for (const { name, run } of cases) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : "unknown error"}`);
  }
}
console.log(`${cases.length - failures}/${cases.length} correction-pass checks passed.`);
if (failures > 0) process.exitCode = 1;
