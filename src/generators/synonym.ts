import { callClaudeTool, TITLE_HINT } from "../api/client";

const SYNONYM_PROMPT =
  "You are an exercise generator. Given some study material, identify a key term or concept that has a well-known synonym, alternate name, or equivalent term used in the same field. " +
  "Generate a question asking for the synonym/alternate name, and provide the answer. " +
  "The synonym must be a genuinely accepted alternate term — not a definition, description, or loose paraphrase. " +
  "Examples of good synonym pairs: Krebs cycle / citric acid cycle, epinephrine / adrenaline, trisomy 21 / Down syndrome." + TITLE_HINT;

const SYNONYM_TOOL = {
  name: "synonym",
  description: "Return a question asking for a synonym and the expected answer.",
  input_schema: {
    type: "object" as const,
    properties: {
      question: { type: "string" as const, description: "Question asking for a synonym or alternate name (e.g. 'What is another name for the Krebs cycle?')" },
      answer: { type: "string" as const, description: "The synonym or alternate name" },
    },
    required: ["question", "answer"],
  },
};

export interface SynonymResult {
  question: string;
  answer: string;
}

export async function generateSynonym(
  content: string,
  apiKey: string,
  model: string,
): Promise<SynonymResult> {
  const r = await callClaudeTool<{ question: string; answer: string }>(
    apiKey, model, SYNONYM_PROMPT, content, SYNONYM_TOOL, 300,
  );
  return {
    question: r.question ?? "Could not generate question.",
    answer: r.answer ?? "Could not generate answer.",
  };
}
