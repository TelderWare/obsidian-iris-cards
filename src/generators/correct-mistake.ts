import { callClaudeTool, TITLE_HINT } from "../api/client";

const CORRECT_MISTAKE_PROMPT =
  "You are an exercise generator. Given a fact, restate it with exactly one plausible error introduced. " +
  "The error MUST change a specific relationship, value, direction, or term so that the statement becomes factually wrong. " +
  "Do NOT return the original fact unchanged — the incorrect statement must differ from the corrected one. " +
  "The error should be plausible enough that a student who hasn't studied might miss it. " +
  "When the error changes a numeric value, use {correct|min..max} in the incorrect field instead of a specific wrong number — " +
  "this randomises the distractor on each review. For numbers in scientific notation, annotate coefficient and exponent " +
  "separately: {6.022|1.000..9.999} × 10^{23|20..26}. Pick a range spanning plausible wrong values for the domain. " +
  "The corrected field always contains the plain correct statement with no placeholders." + TITLE_HINT;

const CORRECT_MISTAKE_TOOL = {
  name: "correct_mistake",
  description: "Return an incorrect version of the fact and the corrected version.",
  input_schema: {
    type: "object" as const,
    properties: {
      incorrect: { type: "string" as const, description: "The statement with one plausible error introduced. Use {correct|min..max} syntax for numeric errors." },
      corrected: { type: "string" as const, description: "The corrected statement with the error fixed, no placeholders" },
    },
    required: ["incorrect", "corrected"],
  },
};

export interface CorrectMistakeResult {
  incorrect: string;
  corrected: string;
}

export async function generateCorrectMistake(
  content: string,
  apiKey: string,
  model: string,
): Promise<CorrectMistakeResult> {
  const r = await callClaudeTool<{ incorrect: string; corrected: string }>(
    apiKey, model, CORRECT_MISTAKE_PROMPT, content, CORRECT_MISTAKE_TOOL, 400,
  );
  const incorrect = r.incorrect ?? "";
  const corrected = r.corrected ?? "";
  if (incorrect.toLowerCase().trim() === corrected.toLowerCase().trim()) {
    throw new Error("Correct the Mistake: generated statement has no actual error");
  }
  return { incorrect, corrected };
}

// ─── Number-range distractor decoding ───────────────────────────────────────

/**
 * Replaces {correct|min..max} tokens in a question string with a randomly
 * chosen distractor. The pick is written to `rs` on first call and reused on
 * subsequent calls so previews are stable within a session.
 *
 * Scientific notation cards use two independent tokens — one for the
 * coefficient and one for the exponent — handled identically by this function.
 */
export function decodeNumberRanges(question: string, rs: Record<string, unknown>): string {
  const TOKEN_RE = /\{([-+]?\d*\.?\d+)\|([-+]?\d*\.?\d+)\.\.([-+]?\d*\.?\d+)\}/g;
  let tokenIdx = 0;
  return question.replace(TOKEN_RE, (_match, correctStr: string, minStr: string, maxStr: string) => {
    const correct = parseFloat(correctStr);
    const min = parseFloat(minStr);
    const max = parseFloat(maxStr);
    if (isNaN(correct) || isNaN(min) || isNaN(max) || min >= max) return correctStr;

    const key = `nrDistractor_${tokenIdx++}`;
    if (rs[key] === undefined) rs[key] = pickDistractor(correct, correctStr, min, max);

    const decimalPlaces = correctStr.includes(".") ? correctStr.split(".")[1].length : 0;
    return (rs[key] as number).toFixed(decimalPlaces);
  });
}

function pickDistractor(correct: number, correctStr: string, min: number, max: number): number {
  const decimalPlaces = correctStr.includes(".") ? correctStr.split(".")[1].length : 0;
  const scale = Math.pow(10, decimalPlaces);
  const iMin = Math.round(min * scale);
  const iMax = Math.round(max * scale);
  const iCorrect = Math.round(correct * scale);

  const total = iMax - iMin + 1;
  if (total <= 0) return min;

  const correctInRange = iCorrect >= iMin && iCorrect <= iMax;
  const available = correctInRange ? total - 1 : total;
  if (available <= 0) return iMin / scale;

  const idx = Math.floor(Math.random() * available);
  const pick = correctInRange && idx >= iCorrect - iMin ? iMin + idx + 1 : iMin + idx;
  return pick / scale;
}
