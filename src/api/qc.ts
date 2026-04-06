import { callClaudeTool } from "./client";

const QC_MODEL = "claude-opus-4-6";

const QC_PROMPT =
  "You are a flashcard quality controller. Given the source fact and a generated question+answer, verify and correct them.\n" +
  "1. Check that the question uses terminology correctly. The question must ask for exactly what the answer provides — if the answer is a drug class, the question must ask for the drug class, not the mechanism of action. If the answer is a definition, the question must ask for the definition, not an example. Fix any mismatch.\n" +
  "2. Check that the answer is factually correct against the source fact.\n" +
  "3. Remove answer leaks from the question.\n" +
  "4. Remove extraneous filler and gratuitous name-dropping of topic titles.\n" +
  "5. If the question is unsalvageable — nonsensical or tests nothing meaningful — set reject to true.";

const QC_TOOL = {
  name: "standardized",
  description: "Return the cleaned-up question and answer, or reject if unsalvageable.",
  input_schema: {
    type: "object" as const,
    properties: {
      question: { type: "string" as const, description: "The standardized question" },
      answer: { type: "string" as const, description: "The standardized answer" },
      reject: { type: "boolean" as const, description: "true if the question is unsalvageable and should be suspended" },
    },
    required: ["question", "answer"],
  },
};

export async function standardizeQuestion(
  fact: string, question: string, answer: string, apiKey: string,
): Promise<{ question: string; answer: string; reject?: boolean }> {
  const input = `Source fact:\n${fact}\n\nQuestion:\n${question}\n\nAnswer:\n${answer}`;
  return callClaudeTool<{ question: string; answer: string; reject?: boolean }>(
    apiKey, QC_MODEL, QC_PROMPT, input, QC_TOOL, 400,
  );
}
