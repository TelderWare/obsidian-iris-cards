import { callClaudeTool, getRelay, TITLE_HINT } from "../api/client";

const LIST_PROMPT =
  "You are an exercise generator. Given a fact that contains an enumerable set of items (members, components, types, examples, parts), generate a free-recall list question. Output a `prompt` (a clear question or imperative, e.g. 'What are the four humours?' or 'Name the steps of mitosis.') and `items` (the correct items, each a short standalone phrase). Items will be matched unordered, so do not depend on sequence. Each item must stand on its own — never use anaphoric references like 'the previous one'. Do not leak any item through the prompt." + TITLE_HINT;

const LIST_TOOL = {
  name: "list_recall",
  description: "Return a list-recall question with its correct items.",
  input_schema: {
    type: "object" as const,
    properties: {
      prompt: { type: "string" as const, description: "Question asking for the list" },
      items: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "Correct items, each a short standalone phrase. Order does not matter.",
      },
    },
    required: ["prompt", "items"],
  },
};

export interface ListResult {
  prompt: string;
  items: string[];
}

export async function generateList(
  content: string,
  apiKey: string,
  model: string,
): Promise<ListResult> {
  const r = await callClaudeTool<ListResult>(
    apiKey, model, LIST_PROMPT, content, LIST_TOOL, 400,
  );
  return { prompt: r.prompt ?? "", items: r.items ?? [] };
}

/** Encode a List into Q/A storage. Q = prompt, A = JSON array of items. */
export function encodeList(l: ListResult): { question: string; answer: string } {
  return { question: l.prompt, answer: JSON.stringify(l.items) };
}

/** Decode stored List fields. */
export function decodeList(question: string, answer: string): ListResult {
  let items: string[];
  try { items = JSON.parse(answer); } catch { throw new Error("Invalid list JSON"); }
  if (!Array.isArray(items)) throw new Error("List answer is not an array");
  return { prompt: question, items };
}

const NLI_ENTAILMENT_THRESHOLD = 0.5;
const NLI_CONTRADICTION_GUARD = 0.5;

const JUDGE_PROMPT =
  "You are a flashcard reviewer. The user was asked to list items and gave their answers. For each user answer, judge whether it correctly names one of the expected items (order does not matter). Be lenient with phrasing and synonyms but strict on factual accuracy.";

const JUDGE_TOOL = {
  name: "list_judgment",
  description: "Return per-item correctness for the user's list answers.",
  input_schema: {
    type: "object" as const,
    properties: {
      results: {
        type: "array" as const,
        items: { type: "boolean" as const },
        description: "One boolean per user answer, in the order given — true if it correctly names one of the expected items.",
      },
    },
    required: ["results"],
  },
};

/**
 * Mark a list answer item-by-item, unordered. Each filled user item is matched
 * against the pool of expected items (greedy first-match). Empty inputs auto-fail.
 * Returns one boolean per user answer.
 */
export async function markList(
  question: string,
  expected: string[],
  userItems: string[],
  apiKey: string,
  model: string,
): Promise<boolean[]> {
  const out: (boolean | null)[] = userItems.map(u => (u.trim() ? null : false));
  const filledIndices = userItems
    .map((u, i) => (u.trim() ? i : -1))
    .filter(i => i >= 0);
  if (filledIndices.length === 0) return out.map(v => v ?? false);
  const filled = filledIndices.map(i => userItems[i].trim());

  const relay = getRelay();
  if (relay?.isHFConfigured?.()) {
    try {
      const remaining = [...expected];
      const filledResults: boolean[] = [];
      for (const userItem of filled) {
        let matched = -1;
        for (let i = 0; i < remaining.length; i++) {
          const exp = remaining[i];
          const [forward, backward] = await Promise.all([
            relay.nli(userItem, exp, { callerId: "iris-cards:list-mark" }),
            relay.nli(exp, userItem, { callerId: "iris-cards:list-mark" }),
          ]);
          const contradiction = Math.max(forward.contradiction, backward.contradiction);
          if (contradiction > NLI_CONTRADICTION_GUARD) continue;
          const entailment = Math.max(forward.entailment, backward.entailment);
          if (entailment > NLI_ENTAILMENT_THRESHOLD) {
            matched = i;
            break;
          }
        }
        if (matched >= 0) {
          remaining.splice(matched, 1);
          filledResults.push(true);
        } else {
          filledResults.push(false);
        }
      }
      filledIndices.forEach((origIdx, j) => { out[origIdx] = filledResults[j]; });
      return out.map(v => v ?? false);
    } catch (err) {
      console.warn("iris-cards: HF NLI list marking failed; falling back to Claude", err);
    }
  }

  try {
    const r = await callClaudeTool<{ results: boolean[] }>(
      apiKey, model, JUDGE_PROMPT,
      `Question: ${question}\nExpected items: ${JSON.stringify(expected)}\nUser answers: ${JSON.stringify(filled)}`,
      JUDGE_TOOL, 200,
    );
    const filledResults = (r.results ?? []).slice(0, filled.length);
    while (filledResults.length < filled.length) filledResults.push(false);
    filledIndices.forEach((origIdx, j) => { out[origIdx] = filledResults[j]; });
    return out.map(v => v ?? false);
  } catch {
    return out.map(v => v ?? false);
  }
}
