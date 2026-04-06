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

/** Extract all *starred* terms from a cloze sentence. */
export function parseClozeTerms(sentence: string): string[] {
  const matches = sentence.match(/\*([^*]+)\*/g);
  if (!matches) return [];
  return matches.map(m => m.slice(1, -1));
}

/** Replace the nth *starred* term with a blank placeholder. */
export function occludeCloze(sentence: string, index: number): { display: string; answer: string } {
  const terms = parseClozeTerms(sentence);
  if (index < 0 || index >= terms.length) throw new Error("Cloze index out of range");
  const answer = terms[index];
  let i = 0;
  const display = sentence.replace(/\*([^*]+)\*/g, (_, term) => {
    if (i++ === index) return "___";
    return term;
  });
  return { display, answer };
}
