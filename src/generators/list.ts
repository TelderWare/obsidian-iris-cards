import { callClaudeTool, getRelay, TITLE_HINT } from "../api/client";
import { type MarkResult, marked, markFailed } from "../types/marking";
import { normalizeAnswer } from "../utils/text";

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
      matches: {
        type: "array" as const,
        items: { type: "number" as const },
        description: "One number per user answer, in the order given — the 0-based index of the expected item it correctly names, or -1 if it does not name any expected item. Do not match two user answers to the same expected index.",
      },
    },
    required: ["matches"],
  },
};

/** Result of marking a list answer. */
export interface ListMarking {
  /** One boolean per user answer (input), in input order — true if correct. */
  results: boolean[];
  /** Expected items the user did not recall, in original order. */
  missed: string[];
}

/**
 * Mark a list answer item-by-item, unordered. Each filled user item is matched
 * against the pool of expected items (greedy first-match). Empty inputs auto-fail.
 * Returns per-answer correctness plus the expected items left unrecalled.
 *
 * A normalized exact-match pass runs first (mirrors the Q&A exact-match
 * shortcut), so verbatim-correct answers are scored correct without consulting
 * the LLM/NLI — and stay correct even when no marking backend is reachable.
 * Only the remaining unmatched answers fall through to the backend.
 */
export async function markList(
  question: string,
  expected: string[],
  userItems: string[],
  apiKey: string,
  model: string,
): Promise<MarkResult<ListMarking>> {
  const out: (boolean | null)[] = userItems.map(u => (u.trim() ? null : false));
  const filledIndices = userItems
    .map((u, i) => (u.trim() ? i : -1))
    .filter(i => i >= 0);
  if (filledIndices.length === 0) {
    return marked({ results: out.map(v => v ?? false), missed: [...expected] });
  }
  const filled = filledIndices.map(i => userItems[i].trim());

  // `correct[j]` tracks the verdict for filled[j]; `remaining` is the pool of
  // expected items not yet claimed. Both are shared across the exact-match pass
  // and the backend pass, and finalize() projects them back onto `out`.
  const correct: boolean[] = new Array(filled.length).fill(false);
  const remaining = [...expected];
  const finalize = (): MarkResult<ListMarking> => {
    filledIndices.forEach((origIdx, j) => { out[origIdx] = correct[j]; });
    return marked({ results: out.map(v => v ?? false), missed: remaining });
  };

  // Exact-match fast path: claim any answer that normalizes equal to an expected
  // item. `unmatched` holds the indices into `filled` still needing the backend.
  const unmatched: number[] = [];
  filled.forEach((userItem, j) => {
    const norm = normalizeAnswer(userItem);
    const ei = remaining.findIndex(exp => normalizeAnswer(exp) === norm);
    if (ei >= 0) {
      remaining.splice(ei, 1);
      correct[j] = true;
    } else {
      unmatched.push(j);
    }
  });
  if (unmatched.length === 0) return finalize();
  const unmatchedItems = unmatched.map(j => filled[j]);

  const relay = getRelay();
  if (relay?.isHFConfigured?.()) {
    try {
      // Work on copies so a mid-loop throw leaves shared state clean for the
      // Claude fallback below.
      const pool = [...remaining];
      const subResults: boolean[] = [];
      for (const userItem of unmatchedItems) {
        let matched = -1;
        for (let i = 0; i < pool.length; i++) {
          const exp = pool[i];
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
          pool.splice(matched, 1);
          subResults.push(true);
        } else {
          subResults.push(false);
        }
      }
      unmatched.forEach((fIdx, k) => { correct[fIdx] = subResults[k]; });
      remaining.splice(0, remaining.length, ...pool);
      return finalize();
    } catch (err) {
      console.warn("iris-cards: HF NLI list marking failed; falling back to Claude", err);
    }
  }

  try {
    const r = await callClaudeTool<{ matches: number[] }>(
      apiKey, model, JUDGE_PROMPT,
      `Question: ${question}\nExpected items: ${JSON.stringify(remaining)}\nUser answers: ${JSON.stringify(unmatchedItems)}`,
      JUDGE_TOOL, 200,
    );
    const matches = (r.matches ?? []).slice(0, unmatchedItems.length);
    while (matches.length < unmatchedItems.length) matches.push(-1);
    const matchedExpected = new Set<number>();
    unmatched.forEach((fIdx, k) => {
      const m = matches[k];
      const hit = Number.isInteger(m) && m >= 0 && m < remaining.length;
      if (hit) {
        matchedExpected.add(m);
        correct[fIdx] = true;
      }
    });
    remaining.splice(0, remaining.length, ...remaining.filter((_, i) => !matchedExpected.has(i)));
    return finalize();
  } catch (e) {
    // The backend was needed (unmatched items remain) but couldn't run — e.g.
    // no API key / dead key / network. Report failure so the caller can surface
    // a marking error rather than silently scoring everything wrong.
    return markFailed(e);
  }
}
