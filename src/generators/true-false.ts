import { callClaudeTool, TITLE_HINT } from "../api/client";

const TRUE_FALSE_PROMPT =
  "You are an exercise generator. Given a fact, generate exactly one true/false statement. The statement should be false approximately half the time. When generating a false statement, distort a specific relationship, property, direction, or value — not just swap a name for a random wrong one. The distortion should be plausible enough that someone with shallow understanding might believe it. State whether the answer is true or false." + TITLE_HINT;

const TRUE_FALSE_TOOL = {
  name: "true_false",
  description: "Return a statement and whether it is true or false.",
  input_schema: {
    type: "object" as const,
    properties: {
      statement: { type: "string" as const, description: "The true/false statement" },
      answer: { type: "string" as const, enum: ["True", "False"], description: "Whether the statement is true or false" },
    },
    required: ["statement", "answer"],
  },
};

export async function generateTrueFalse(
  content: string,
  apiKey: string,
  model: string,
): Promise<{ statement: string; answer: string }> {
  const r = await callClaudeTool<{ statement: string; answer: string }>(
    apiKey, model, TRUE_FALSE_PROMPT, content, TRUE_FALSE_TOOL, 300,
  );
  return { statement: r.statement ?? "", answer: r.answer === "False" ? "False" : "True" };
}
