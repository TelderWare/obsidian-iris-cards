import { callClaudeTool } from "../api/client";

// ─── Fact-level quality gate ──────────────────────────────────

const FACT_QC_MODEL = "claude-opus-4-6";

const FACT_QC_PROMPT =
  "You are a quality gate for spaced-repetition flashcard facts. " +
  "For each fact, decide whether it can produce a card with a concrete, unambiguous answer " +
  "(a name, number, mechanism, structure, location, equation, sequence, or defined term). " +
  "Reject facts that are vague, subjective, or whose only testable content is a soft qualifier " +
  "('well-characterised', 'commonly associated', 'plays an important role', 'is widespread', 'is significant'). " +
  "Reject facts that are purely contextual framing with no standalone testable content. " +
  "Reject facts that lack an explicit subject — if you cannot tell *what* the fact is about without reading surrounding text, reject it. " +
  "Return the indices (0-based) of the facts that pass.";

const FACT_QC_TOOL = {
  name: "filter_facts",
  description: "Return the indices of facts that pass the quality gate.",
  input_schema: {
    type: "object" as const,
    properties: {
      passed: {
        type: "array" as const,
        items: { type: "number" as const, description: "0-based index of a fact that passes" },
      },
    },
    required: ["passed"],
  },
};

/**
 * Independent quality gate: filters an array of extracted facts,
 * keeping only those with concrete, testable answers.
 * Uses Opus regardless of user model setting.
 */
export async function filterFacts(
  facts: string[], apiKey: string,
): Promise<string[]> {
  if (facts.length === 0) return [];
  const numbered = facts.map((f, i) => `[${i}] ${f}`).join("\n");
  try {
    const r = await callClaudeTool<{ passed: number[] }>(
      apiKey, FACT_QC_MODEL, FACT_QC_PROMPT, numbered, FACT_QC_TOOL, 300,
    );
    if (!Array.isArray(r.passed)) return facts;
    const valid = new Set(r.passed.filter(i => i >= 0 && i < facts.length));
    return facts.filter((_, i) => valid.has(i));
  } catch {
    // If QC fails, pass all facts through rather than blocking
    return facts;
  }
}

const EXTRACT_PROMPT =
  "You are a fact extractor for spaced repetition flashcards. Given a note, extract the core testable facts. " +
  "Each fact should be a self-contained, atomic statement (one concept) that names its subject explicitly. If the source text uses an implicit subject from a prior sentence, rewrite the fact to include it. " +
  "Be conservative: extract only facts a student would reasonably memorize, and err on the side of omission. " +
  "Skip headings, metadata, examples, restatements, and any prose that isn't central testable knowledge. " +
  "Skip vague or subjective claims — a good fact has a concrete, unambiguous answer (a name, a number, a mechanism, a structure). " +
  "Reject excerpts whose key content is a soft qualifier like 'well-characterised', 'commonly associated', 'plays an important role', or 'is widely known'. " +
  "Prefer a short list of essential facts over exhaustive coverage.";

const EXTRACT_TOOL = {
  name: "extract_facts",
  description: "Extract testable facts from a note.",
  input_schema: {
    type: "object" as const,
    properties: {
      facts: {
        type: "array" as const,
        items: { type: "string" as const, description: "A self-contained testable fact" },
      },
    },
    required: ["facts"],
  },
};

export async function extractFactsFromNote(
  content: string, apiKey: string, model: string,
): Promise<string[]> {
  const r = await callClaudeTool<{ facts: string[] }>(
    apiKey, model, EXTRACT_PROMPT, content, EXTRACT_TOOL, 4096, 0,
  );
  return Array.isArray(r.facts) ? r.facts.filter(f => typeof f === "string" && f.trim()) : [];
}
