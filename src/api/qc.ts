import { callClaudeTool } from "./client";

const QC_MODEL = "claude-opus-4-6";

const QC_PROMPT =
  "You are a flashcard quality controller. Given the source fact and a generated question+answer, verify and correct them.\n" +
  "1. Check that the question uses terminology correctly. The question must ask for exactly what the answer provides — if the answer is a drug class, the question must ask for the drug class, not the mechanism of action. If the answer is a definition, the question must ask for the definition, not an example. Fix any mismatch.\n" +
  "2. Check that the answer is factually correct and fully supported by the source fact. If the question asks for something the source fact does not contain, reject it.\n" +
  "3. Remove answer leaks from the question.\n" +
  "4. Remove extraneous filler and gratuitous name-dropping of topic titles.\n" +
  "5. Reject questions whose answer is a vague qualifier ('well-characterised', 'widespread', 'important', 'commonly') rather than a concrete fact. A good answer is a name, number, mechanism, or structure.\n" +
  "6. Keep the answer concise. If it reads like a paragraph, distill it to the essential point.\n" +
  "7. If the question is unsalvageable — nonsensical, tests nothing meaningful, or not answerable from the source — set reject to true and give a brief reason.";

const QC_TOOL = {
  name: "standardized",
  description: "Return the cleaned-up question and answer, or reject if unsalvageable.",
  input_schema: {
    type: "object" as const,
    properties: {
      question: { type: "string" as const, description: "The standardized question" },
      answer: { type: "string" as const, description: "The standardized answer" },
      reject: { type: "boolean" as const, description: "true if the question is unsalvageable and should be suspended" },
      reject_reason: { type: "string" as const, description: "Brief reason for rejection (only when reject is true)" },
    },
    required: ["question", "answer"],
  },
};

export async function standardizeQuestion(
  fact: string, question: string, answer: string, apiKey: string,
): Promise<{ question: string; answer: string; reject?: boolean; reject_reason?: string }> {
  const input = `Source fact:\n${fact}\n\nQuestion:\n${question}\n\nAnswer:\n${answer}`;
  return callClaudeTool<{ question: string; answer: string; reject?: boolean; reject_reason?: string }>(
    apiKey, QC_MODEL, QC_PROMPT, input, QC_TOOL, 400,
  );
}
