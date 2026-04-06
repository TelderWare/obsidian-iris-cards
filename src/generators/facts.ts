import { callClaudeTool } from "../api/client";

const EXTRACT_PROMPT =
  "You are a fact extractor for spaced repetition flashcards. Given a note, identify every discrete, testable piece of knowledge by returning verbatim excerpts from the source text. " +
  "Each excerpt must be copied exactly as it appears — do not rephrase, summarize, or combine. " +
  "Each excerpt should be a self-contained, atomic fact (one concept). " +
  "Skip headings, metadata, navigation text, and prose that doesn't contain testable knowledge.";

const EXTRACT_TOOL = {
  name: "extract_facts",
  description: "Extract verbatim testable facts from a note.",
  input_schema: {
    type: "object" as const,
    properties: {
      facts: {
        type: "array" as const,
        items: { type: "string" as const, description: "Verbatim excerpt from the note" },
      },
    },
    required: ["facts"],
  },
};

export async function extractFactsFromNote(
  content: string, apiKey: string, model: string,
): Promise<string[]> {
  const r = await callClaudeTool<{ facts: string[] }>(
    apiKey, model, EXTRACT_PROMPT, content, EXTRACT_TOOL, 4096,
  );
  return Array.isArray(r.facts) ? r.facts.filter(f => typeof f === "string" && f.trim()) : [];
}
