import { callClaudeTool, TITLE_HINT } from "../api/client";

const ASSEMBLE_EQUATION_PROMPT =
  "You are an exercise generator. Given a fact containing an equation or formula, return the name of the equation and the equation itself. Wrap every variable, constant, and operator group in the equation with asterisks so they can be individually blanked out. For example: *F* = *m* × *a*, or *E* = *m* × *c²*. Each asterisk-wrapped piece should be a single meaningful term the learner could be asked to recall." + TITLE_HINT;

const ASSEMBLE_EQUATION_TOOL = {
  name: "assemble_equation",
  description: "Return the equation name and the equation with key terms wrapped in asterisks.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: { type: "string" as const, description: "Name of the equation (e.g. 'Newton\\'s Second Law')" },
      equation: { type: "string" as const, description: "The equation with each variable/constant wrapped in asterisks, e.g. '*F* = *m* × *a*'" },
    },
    required: ["title", "equation"],
  },
};

export async function generateAssembleEquation(
  content: string,
  apiKey: string,
  model: string,
): Promise<{ title: string; equation: string }> {
  const r = await callClaudeTool<{ title: string; equation: string }>(
    apiKey, model, ASSEMBLE_EQUATION_PROMPT, content, ASSEMBLE_EQUATION_TOOL, 300,
  );
  return { title: r.title ?? "", equation: r.equation ?? "" };
}

/** Encode Assemble Equation into Q/A fields. Q = title, A = equation with *terms*. */
export function encodeAssembleEquation(ae: { title: string; equation: string }): { question: string; answer: string } {
  return { question: ae.title, answer: ae.equation };
}
