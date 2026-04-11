import { callClaudeTool, TITLE_HINT } from "../api/client";

const CORRECT_MISTAKE_PROMPT =
  "You are an exercise generator. Given a fact, restate it with exactly one plausible error introduced. " +
  "The error MUST change a specific relationship, value, direction, or term so that the statement becomes factually wrong. " +
  "Do NOT return the original fact unchanged — the incorrect statement must differ from the corrected one. " +
  "The error should be plausible enough that a student who hasn't studied might miss it. " +
  "Provide the incorrect statement and the corrected statement separately." + TITLE_HINT;

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
  const incorrect = r.incorrect ?? "";
  const corrected = r.corrected ?? "";
  if (incorrect.toLowerCase().trim() === corrected.toLowerCase().trim()) {
    throw new Error("Correct the Mistake: generated statement has no actual error");
  }
  return { incorrect, corrected };
}
