/**
 * EXPERIMENT (isolated; not wired into the production service): one constrained correction
 * pass. Given the canonical payload, a report that failed the evidence contract, and the
 * validator's own messages, build a single repair request for the same model. The corrected
 * report is judged by the same schema checks and the unchanged evidence validator.
 *
 * The correction list is derived from the actual validator messages (grouped by the report
 * location they name), never from token-specific paths.
 */

import { buildProfileUserContent } from "./prompt.ts";
import type { ProfilePayload } from "./profile-payload.ts";

export type CorrectionItem = { location: string; problems: string[]; fix: string[] };

/** "marketPerformance.statements[4].text: …" → location "marketPerformance.statements[4]" (a text field's parent item). */
function locationOf(message: string): { location: string; problem: string } {
  const colon = message.indexOf(": ");
  const path = colon > 0 ? message.slice(0, colon) : "report";
  const problem = colon > 0 ? message.slice(colon + 2) : message;
  const location = path.replace(/\.(text|detail|title|question|rationale|sourceIds)$/, "");
  return { location, problem };
}

/** Generic repair guidance per violation type (no token-specific content). */
function fixFor(problem: string, unmappedWording: Record<string, string>): string | null {
  if (/directional\/sentiment language/.test(problem)) return "Replace the sentiment or trend wording with neutral descriptive wording.";
  if (/contains numbers or dates/.test(problem)) return "Remove every digit, number, and date from this overview; keep it a neutral synthesis.";
  if (/do not match any value in the cited sources/.test(problem)) return "Remove the unsupported number(s); do not replace them with other numbers.";
  if (/is not a period established by the cited sources|names a period/.test(problem)) return "Remove the unsupported period wording; do not substitute another period.";
  if (/has no period/.test(problem)) return "Cite only the fields this text actually restates.";
  const unmapped = problem.match(/refers to (DeFiLlama|DexPaprika) data|explains unavailable (DeFiLlama|DexPaprika) data/);
  if (unmapped) {
    const provider = unmapped[1] ?? unmapped[2];
    return `Do not present ${provider} data as available. Either remove the ${provider} reference, or state in this same text: "${unmappedWording[provider]}", and cite that provider's scope note.`;
  }
  if (/introduces "/.test(problem)) return "Remove the concept that the data does not contain.";
  if (/unknown source ID/.test(problem)) return "Use only evidence IDs that exist in the data.";
  if (/must cite|without citing their sources/.test(problem)) return "Cite at least one existing evidence ID that supports this text, or remove the unsupported claim.";
  if (/distinct asset/.test(problem)) return "Remove the reference to the other asset.";
  return null;
}

/** Group validator messages by report location, de-duplicating repeated messages and fixes. */
export function correctionItems(violations: string[], unmappedWording: Record<string, string>): CorrectionItem[] {
  const byLocation = new Map<string, CorrectionItem>();
  for (const message of violations) {
    const { location, problem } = locationOf(message);
    const item = byLocation.get(location) ?? { location, problems: [], fix: [] };
    if (!item.problems.includes(problem)) item.problems.push(problem);
    const fix = fixFor(problem, unmappedWording);
    if (fix && !item.fix.includes(fix)) item.fix.push(fix);
    byLocation.set(location, item);
  }
  return [...byLocation.values()];
}

/** The model-facing shape of a report (statements carry no period; the server attaches periods). */
export function stripServerFields(report: unknown): unknown {
  return JSON.parse(JSON.stringify(report), (key, value) => (key === "period" ? undefined : value));
}

export const CORRECTION_TASK = `CORRECTION TASK
You previously produced the report below from the Token Samurai data. The evidence-contract validator rejected it for the listed problems.
Perform a constrained factual repair:
- Revise ONLY the text at the listed locations. Keep every other section, statement, risk, data gap, and question exactly as it is.
- Make the smallest textual change that fixes each listed problem. Do not delete sections, and do not remove items unless the item cannot be repaired.
- Preserve the report structure and every existing evidence ID. Do not invent, add, or replace evidence IDs.
- Do not introduce new factual claims, numbers, dates, or time periods, and add nothing that the data does not support.
- Return the complete corrected report as JSON in exactly the same schema.`;

/** The user turn for the single correction request. The system instruction stays the profile instruction. */
export function buildCorrectionUserContent(payload: ProfilePayload, report: unknown, items: CorrectionItem[]): string {
  const corrections = items.map((item, index) => [
    `${index + 1}. ${item.location}`,
    ...item.problems.map((problem) => `   Problem: ${problem}`),
    ...item.fix.map((fix) => `   Fix: ${fix}`),
  ].join("\n")).join("\n");
  return [
    buildProfileUserContent(payload),
    "",
    CORRECTION_TASK,
    "",
    "PROBLEMS TO FIX",
    corrections,
    "",
    "<report_to_correct>",
    JSON.stringify(stripServerFields(report)).replace(/</g, "\\u003c"),
    "</report_to_correct>",
  ].join("\n");
}

/** Exact unmapped-provider wording prescribed by the system instruction (kept in one place). */
export function unmappedWordingFrom(systemInstruction: string): Record<string, string> {
  const wording: Record<string, string> = {};
  for (const provider of ["DeFiLlama", "DexPaprika"]) {
    const match = systemInstruction.match(new RegExp(`- ${provider}: "([^"]+)"`));
    if (match) wording[provider] = match[1];
  }
  return wording;
}
