import { callClaudeTool, TITLE_HINT } from "../api/client";

const WORD_PROMPT =
  "You are an exercise generator for memorizing how to spell long technical words letter-by-letter — systematic chemical names, complex drug names, long enzyme, anatomical, or taxonomic terms. " +
  "Given study material, pick ONE genuinely long single word worth memorizing and split it, in order, into its meaningful sub-units (morphemes, roots, affixes, or chemical segments). " +
  "Concatenating the segments in order with no separators MUST reproduce the original word exactly, including any leading numbers or locants. " +
  "Aim for 3 or more segments; never return just one. " +
  "Also give the word's well-known acronym or abbreviation if it has one (e.g. 3,4-Methylenedioxymethamphetamine -> MDMA); otherwise return an empty string. " +
  "If no single word in the material is long or segmentable enough to make spelling it a meaningful exercise, return an empty segments array." + TITLE_HINT;

const WORD_TOOL = {
  name: "word",
  description: "Return a long word split into ordered segments plus its acronym.",
  input_schema: {
    type: "object" as const,
    properties: {
      segments: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "The word's meaningful sub-units in order; concatenated with no separators they must reproduce the word exactly",
      },
      acronym: { type: "string" as const, description: "The word's common acronym/abbreviation (e.g. MDMA), or an empty string if it has none" },
    },
    required: ["segments", "acronym"],
  },
};

export interface WordResult {
  /** Cloze-encoded word: every segment wrapped in *asterisks*, no separators. */
  source: string;
  /** The word's acronym, shown as the card title, or "" if none. */
  acronym: string;
}

export async function generateWord(
  content: string,
  apiKey: string,
  model: string,
): Promise<WordResult> {
  const r = await callClaudeTool<{ segments?: string[]; acronym?: string }>(
    apiKey, model, WORD_PROMPT, content, WORD_TOOL, 300,
  );
  const segments = (r.segments ?? []).map(s => s.trim()).filter(Boolean);
  if (segments.length < 2) throw new Error("No segmentable word found.");
  // Reuse the cloze gap syntax so the review path is shared: each segment is a
  // gap, with nothing between them so the word renders flush (Methylene___meth…).
  const source = segments.map(s => `*${s}*`).join("");
  return { source, acronym: (r.acronym ?? "").trim() };
}
