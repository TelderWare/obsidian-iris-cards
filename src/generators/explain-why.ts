import { callClaudeTool, TITLE_HINT } from "../api/client";

const EXPLAIN_WHY_PROMPT =
  "You are an exercise generator. Given a fact, generate exactly one question asking the learner to explain the causal or mechanistic reason behind it. The question should not be answerable by restating the fact — it must require understanding of the underlying mechanism. Provide a model answer." + TITLE_HINT;

const EXPLAIN_WHY_TOOL = {
  name: "explain_why",
  description: "Return a why-question and a model answer explaining the mechanism.",
  input_schema: {
    type: "object" as const,
    properties: {
      question: { type: "string" as const, description: "A question asking why or how the fact is the case" },
      answer: { type: "string" as const, description: "A model answer explaining the causal or mechanistic reason" },
    },
    required: ["question", "answer"],
  },
};

export async function generateExplainWhy(
  content: string,
  apiKey: string,
  model: string,
): Promise<{ question: string; answer: string }> {
  const r = await callClaudeTool<{ question: string; answer: string }>(
    apiKey, model, EXPLAIN_WHY_PROMPT, content, EXPLAIN_WHY_TOOL, 400,
  );
  return { question: r.question ?? "Could not generate question.", answer: r.answer ?? "Could not generate answer." };
}
