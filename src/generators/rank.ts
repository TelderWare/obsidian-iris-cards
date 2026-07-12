import { callClaudeTool, TITLE_HINT } from "../api/client";

const RANK_PROMPT =
  "You are an exercise generator. Given study material that orders or ranks several comparable items along a single property (e.g. stability, electronegativity, acidity, atomic radius, boiling point), extract that ranking. " +
  "Return a short adjective describing the property as it would be used in the phrase 'Which is more ___?' (e.g. 'stable', 'electronegative', 'acidic', 'large') and the list of items ordered from LEAST to MOST of that property. " +
  "Use the items' own names, kept short. Only generate this when the material genuinely establishes a clear ordering of 3 or more comparable items along ONE property — do not invent an order the material does not support." + TITLE_HINT;

const RANK_TOOL = {
  name: "rank",
  description: "Return items ranked along a single comparable property.",
  input_schema: {
    type: "object" as const,
    properties: {
      property: { type: "string" as const, description: "Comparative adjective for the property, e.g. 'stable', 'electronegative', 'acidic'" },
      items: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "Items ordered from LEAST to MOST of the property, each a short label",
      },
    },
    required: ["property", "items"],
  },
};

export interface RankResult {
  property: string;
  items: string[];
}

export async function generateRank(
  content: string,
  apiKey: string,
  model: string,
): Promise<RankResult> {
  const r = await callClaudeTool<{ property: string; items: string[] }>(
    apiKey, model, RANK_PROMPT, content, RANK_TOOL, 400,
  );
  return { property: (r.property ?? "").trim(), items: r.items ?? [] };
}

/** Encode Rank into Q/A fields. Q = property adjective, A = JSON array ordered least→most. */
export function encodeRank(r: RankResult): { question: string; answer: string } {
  return { question: r.property, answer: JSON.stringify(r.items) };
}

/** Decode stored Rank fields. */
export function decodeRank(question: string, answer: string): RankResult {
  let items: string[];
  try { items = JSON.parse(answer); } catch { throw new Error("Invalid rank JSON"); }
  if (!Array.isArray(items)) throw new Error("Rank answer is not an array");
  return { property: question, items };
}
