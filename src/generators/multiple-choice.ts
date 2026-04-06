import { callClaudeTool, TITLE_HINT } from "../api/client";

const MC_PROMPT =
  "You are an exercise generator. Given a fact, generate exactly one multiple choice question with 4 options labeled A-D. Exactly one option must be correct. The three distractors must be plausible — they should be the same kind of thing as the correct answer (e.g., if the answer is an enzyme, the distractors should be enzymes). Avoid joke answers, obviously wrong options, and \"all of the above.\" Name the specific subject in the question to anchor it." + TITLE_HINT;

const MC_TOOL = {
  name: "multiple_choice",
  description: "Return a multiple choice question with four options and the correct answer letter.",
  input_schema: {
    type: "object" as const,
    properties: {
      question: { type: "string" as const, description: "The question stem" },
      A: { type: "string" as const, description: "Option A" },
      B: { type: "string" as const, description: "Option B" },
      C: { type: "string" as const, description: "Option C" },
      D: { type: "string" as const, description: "Option D" },
      correct: { type: "string" as const, description: "The correct letter (A, B, C, or D)" },
    },
    required: ["question", "A", "B", "C", "D", "correct"],
  },
};

export interface MCResult {
  question: string;
  options: { letter: string; text: string }[];
  correct: string;
}

export async function generateMultipleChoice(
  content: string,
  apiKey: string,
  model: string,
): Promise<MCResult> {
  const r = await callClaudeTool<{ question: string; A: string; B: string; C: string; D: string; correct: string }>(
    apiKey, model, MC_PROMPT, content, MC_TOOL, 400,
  );
  return {
    question: r.question ?? "Could not generate question.",
    options: ["A", "B", "C", "D"].map(l => ({ letter: l, text: r[l as "A" | "B" | "C" | "D"] ?? "" })),
    correct: (r.correct ?? "A").toUpperCase(),
  };
}

/** Encode an MC question into Q/A fields for storage. */
export function encodeMC(mc: MCResult): { question: string; answer: string } {
  const opts = mc.options.map(o => `${o.letter}. ${o.text}`).join("\n");
  return {
    question: `${mc.question}\n${opts}`,
    answer: mc.correct,
  };
}

/** Decode stored MC fields back into structured data. */
export function decodeMC(question: string, answer: string): MCResult {
  const lines = question.split("\n");
  const stem = lines[0];
  const options: { letter: string; text: string }[] = [];
  for (const line of lines.slice(1)) {
    const m = line.match(/^([A-D])\.\s+(.+)$/);
    if (m) options.push({ letter: m[1], text: m[2] });
  }
  return { question: stem, options, correct: answer };
}
