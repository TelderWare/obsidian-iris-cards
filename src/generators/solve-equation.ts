import { callClaudeTool, TITLE_HINT } from "../api/client";

const SOLVE_EQUATION_PROMPT =
  "You are an exercise generator. Given a fact containing an equation or quantitative relationship, generate a problem template. Describe a scenario that requires the learner to identify and apply the correct equation. Define each known variable with a name, a realistic range (min and max), units, and number of significant figures. Specify which variable the learner must solve for. Do not name or provide the equation in the scenario." + TITLE_HINT;

const SOLVE_EQUATION_TOOL = {
  name: "solve_equation",
  description: "Return a problem template with a scenario, known variables with ranges, a target variable, and a formula for internal validation.",
  input_schema: {
    type: "object" as const,
    properties: {
      scenario: { type: "string" as const, description: "Problem description. Do not mention the equation name or formula." },
      knowns: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            name: { type: "string" as const, description: "Human-readable name (e.g. 'mass')" },
            symbol: { type: "string" as const, description: "Short variable symbol (e.g. 'm')" },
            min: { type: "number" as const, description: "Minimum realistic value" },
            max: { type: "number" as const, description: "Maximum realistic value" },
            units: { type: "string" as const, description: "Units (e.g. 'kg', 'm/s')" },
            sigfigs: { type: "number" as const, description: "Number of significant figures" },
          },
          required: ["name", "symbol", "min", "max", "units", "sigfigs"],
        },
        description: "Known variables the learner is given",
      },
      target: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const, description: "Human-readable name of the variable to solve for" },
          symbol: { type: "string" as const, description: "Short variable symbol" },
          units: { type: "string" as const, description: "Units of the answer" },
          sigfigs: { type: "number" as const, description: "Number of significant figures for the answer" },
        },
        required: ["name", "symbol", "units", "sigfigs"],
      },
      formula: {
        type: "string" as const,
        description: "JavaScript expression using ONLY the known variable symbols that computes the target value. E.g. 'm * a' when solving for F. Use Math.sqrt(), Math.pow(), Math.PI, Math.log() for advanced operations. Not shown to learner.",
      },
    },
    required: ["scenario", "knowns", "target", "formula"],
  },
};

export interface SolveEquationKnown {
  name: string;
  symbol: string;
  min: number;
  max: number;
  units: string;
  sigfigs: number;
}

export interface SolveEquationTarget {
  name: string;
  symbol: string;
  units: string;
  sigfigs: number;
}

export interface SolveEquationResult {
  scenario: string;
  knowns: SolveEquationKnown[];
  target: SolveEquationTarget;
  formula: string;
}

export async function generateSolveEquation(
  content: string,
  apiKey: string,
  model: string,
): Promise<SolveEquationResult> {
  const r = await callClaudeTool<SolveEquationResult>(
    apiKey, model, SOLVE_EQUATION_PROMPT, content, SOLVE_EQUATION_TOOL, 600,
  );
  return {
    scenario: r.scenario ?? "",
    knowns: r.knowns ?? [],
    target: r.target ?? { name: "", symbol: "", units: "", sigfigs: 3 },
    formula: r.formula ?? "",
  };
}

/** Encode a Solve Equation problem into Q/A fields for storage. */
export function encodeSolveEquation(se: SolveEquationResult): { question: string; answer: string } {
  const { formula, ...display } = se;
  return {
    question: JSON.stringify(display),
    answer: formula,
  };
}

/** Decode stored Solve Equation fields back into structured data. */
export function decodeSolveEquation(question: string, answer: string): SolveEquationResult {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(question); } catch { throw new Error("Invalid solve-equation JSON"); }
  return { ...parsed, formula: answer } as SolveEquationResult;
}

/** Round a number to N significant figures. */
export function roundToSigFigs(num: number, sigfigs: number): number {
  if (num === 0) return 0;
  const d = Math.ceil(Math.log10(Math.abs(num)));
  const power = sigfigs - d;
  const magnitude = Math.pow(10, power);
  return Math.round(num * magnitude) / magnitude;
}

/** Generate concrete values for known variables within their ranges. */
export function randomizeKnowns(knowns: SolveEquationKnown[]): Record<string, number> {
  const values: Record<string, number> = {};
  for (const k of knowns) {
    const raw = k.min + Math.random() * (k.max - k.min);
    values[k.symbol] = roundToSigFigs(raw, k.sigfigs);
  }
  return values;
}

// evaluateFormula is imported from safe-math.ts (recursive descent parser, no Function constructor)
export { evaluateFormula } from "../safe-math";

/** Check if a user's numerical answer matches the expected value within sig-fig tolerance. */
export function checkNumericalAnswer(userAnswer: number, expected: number, sigfigs: number): boolean {
  const rounded = roundToSigFigs(expected, sigfigs);
  if (rounded === 0) return Math.abs(userAnswer) < 0.01;
  const relError = Math.abs(userAnswer - rounded) / Math.abs(rounded);
  return relError < 0.02;
}
