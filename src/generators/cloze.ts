import { callClaudeTool, TITLE_HINT } from "../api/client";

const CLOZE_PROMPT =
  "You are an exercise generator. Given a fact, restate it as a single sentence with the most important terms or values wrapped in asterisks. These are the parts the learner should recall. The surrounding sentence must make each blanked term unambiguous. Do not wrap filler words, adjectives, or context that merely sets up the sentence." + TITLE_HINT;

const CLOZE_TOOL = {
  name: "cloze",
  description: "Return a single sentence with key terms wrapped in asterisks.",
  input_schema: {
    type: "object" as const,
    properties: {
      sentence: { type: "string" as const, description: "The sentence with *key terms* wrapped in asterisks" },
    },
    required: ["sentence"],
  },
};

export async function generateCloze(
  content: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const r = await callClaudeTool<{ sentence: string }>(apiKey, model, CLOZE_PROMPT, content, CLOZE_TOOL, 300);
  if (!r.sentence) throw new Error("No tool response from Claude.");
  return r.sentence;
}

/**
 * A gap is wrapped in *asterisks*. Pipes inside the asterisks denote per-gap
 * alternates, with the first entry as canonical: `*pleo|poly*` means "pleo" is
 * shown when revealed but either "pleo" or "poly" is accepted as a guess.
 */
function splitGap(raw: string): string[] {
  return raw.split("|").map(s => s.trim()).filter(Boolean);
}

/** Canonical (first) term of each gap. Use this for counting and indexing gaps. */
export function parseClozeTerms(sentence: string): string[] {
  const matches = sentence.match(/\*([^*]+)\*/g);
  if (!matches) return [];
  return matches.map(m => splitGap(m.slice(1, -1))[0] ?? "");
}

/**
 * Replace the nth gap with a blank placeholder; other gaps collapse to their
 * canonical term. Returns the canonical answer and any per-gap alternates.
 */
export function occludeCloze(sentence: string, index: number): { display: string; answer: string; alternates: string[] } {
  const matches = sentence.match(/\*([^*]+)\*/g);
  if (!matches || index < 0 || index >= matches.length) throw new Error("Cloze index out of range");
  const accepted = splitGap(matches[index].slice(1, -1));
  const answer = accepted[0] ?? "";
  let i = 0;
  const display = sentence.replace(/\*([^*]+)\*/g, (_, raw) => {
    const isTarget = i++ === index;
    if (isTarget) return "___";
    return splitGap(raw)[0] ?? "";
  });
  return { display, answer, alternates: accepted.slice(1) };
}
