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

const INVERSE_PROMPT =
  "You are given a true/false statement and its answer. Produce a new statement that reads almost identically but swaps exactly one technical term (a molecule, enzyme, structure, process, direction, ion, cofactor, etc.) so the truth value flips: if the original was true the new one must be false, and vice-versa. The rest of the sentence must stay the same so both statements scan alike at a glance.";

const INVERSE_TOOL = {
  name: "true_false_inverse",
  description: "Return the inverted statement.",
  input_schema: {
    type: "object" as const,
    properties: {
      statement: { type: "string" as const, description: "The new statement with one technical term swapped" },
      answer: { type: "string" as const, enum: ["True", "False"], description: "Whether the new statement is true or false" },
    },
    required: ["statement", "answer"],
  },
};

export async function generateTrueFalseInverse(
  original: string,
  originalAnswer: string,
  apiKey: string,
  model: string,
): Promise<{ statement: string; answer: string }> {
  const content = `Statement: ${original}\nAnswer: ${originalAnswer}`;
  const r = await callClaudeTool<{ statement: string; answer: string }>(
    apiKey, model, INVERSE_PROMPT, content, INVERSE_TOOL, 300,
  );
  const answer = r.answer === "False" ? "False" : "True";
  // Validate the inverse actually flipped the truth value
  if (answer === originalAnswer) throw new Error("Inverse did not flip truth value");
  return { statement: r.statement ?? "", answer };
}

// ─── Paired encoding ───────────────────────────────────────────────────

export function encodeTFPair(trueStatement: string, falseStatement: string): { question: string; answer: string } {
  return {
    question: `TRUE: ${trueStatement}\nFALSE: ${falseStatement}`,
    answer: "Paired",
  };
}

export function decodeTFPair(question: string, answer: string): { trueStatement: string; falseStatement: string } | null {
  if (answer !== "Paired") return null;
  const idx = question.indexOf("\nFALSE: ");
  if (idx === -1 || !question.startsWith("TRUE: ")) return null;
  return { trueStatement: question.slice(6, idx), falseStatement: question.slice(idx + 8) };
}
