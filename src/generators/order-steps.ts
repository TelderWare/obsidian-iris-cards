import { callClaudeTool, TITLE_HINT } from "../api/client";

const ORDER_STEPS_PROMPT =
  "You are an exercise generator. Given a fact describing a sequential process, list the steps in the correct order as numbered steps. Each step should be a short, standalone phrase. CRITICAL: Steps will be shown in random order for the learner to sort, so each step must NOT leak its position — never use sequencing words like 'first', 'then', 'next', 'finally', 'after that', 'subsequently', or anaphoric references like 'do this', 'transfer each one', 'repeat the above'. Each step must be fully self-contained." + TITLE_HINT;

const ORDER_STEPS_TOOL = {
  name: "order_steps",
  description: "Return the steps of a process in the correct order.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: { type: "string" as const, description: "Short title describing the process" },
      steps: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "Steps in the correct order, each a short phrase",
      },
    },
    required: ["title", "steps"],
  },
};

export interface OrderStepsResult {
  title: string;
  steps: string[];
}

export async function generateOrderSteps(
  content: string,
  apiKey: string,
  model: string,
): Promise<OrderStepsResult> {
  const r = await callClaudeTool<{ title: string; steps: string[] }>(
    apiKey, model, ORDER_STEPS_PROMPT, content, ORDER_STEPS_TOOL, 400,
  );
  return { title: r.title ?? "", steps: r.steps ?? [] };
}

/** Encode Order Steps into Q/A fields. Q = title, A = JSON array of steps in correct order. */
export function encodeOrderSteps(os: OrderStepsResult): { question: string; answer: string } {
  return { question: os.title, answer: JSON.stringify(os.steps) };
}

/** Decode stored Order Steps fields. */
export function decodeOrderSteps(question: string, answer: string): OrderStepsResult {
  let steps: string[];
  try { steps = JSON.parse(answer); } catch { throw new Error("Invalid order-steps JSON"); }
  if (!Array.isArray(steps)) throw new Error("Order-steps answer is not an array");
  return { title: question, steps };
}

/** Shuffle an array (Fisher-Yates), returns a new array. */
export function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
