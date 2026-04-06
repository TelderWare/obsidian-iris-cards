import { callClaudeTool, TITLE_HINT } from "../api/client";

const CORRECT_MISTAKE_PROMPT =
  "You are an exercise generator. Given a fact, restate it with exactly one plausible error introduced. The error should distort a specific relationship, value, direction, or term — not just swap a name randomly. Provide the incorrect statement and the corrected statement separately." + TITLE_HINT;

const CORRECT_MISTAKE_TOOL = {
  name: "correct_mistake",
  description: "Return an incorrect version of the fact and the corrected version.",
  input_schema: {
    type: "object" as const,
    properties: {
      incorrect: { type: "string" as const, description: "The statement with one plausible error introduced" },
      corrected: { type: "string" as const, description: "The corrected statement with the error fixed" },
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
  return { incorrect: r.incorrect ?? "", corrected: r.corrected ?? "" };
}
