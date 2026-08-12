/**
 * Match — two columns of boxes the learner connects with dragged lines. Purely
 * hand-authored (the AI never generates these), and marked locally: a pairing
 * is either right or it isn't, so no backend is involved.
 *
 * Stored in Q as human-readable lines, mirroring Pairs. An optional first line
 * is the prompt; every `left:: right` line after it is one correct pairing:
 *
 *   Match each enzyme to what it breaks down
 *   amylase:: starch
 *   lipase:: fat
 *
 * `::` can't collide with the QA block's own directives (Type:, Reviewed:, …),
 * which all use a single colon. Newlines inside an item are stored as <br> so
 * every pairing stays on one line. No A: line — the whole payload is in Q.
 */

export interface MatchPair {
  left: string;
  right: string;
}

export interface MatchResult {
  prompt: string;
  pairs: MatchPair[];
}

export const DEFAULT_MATCH_PROMPT = "Match each item on the left to its pair on the right.";

/** Minimum pairs for the exercise to be worth anything — with two, connecting
 * one correctly forces the other, so it's a single coin flip. */
export const MIN_MATCH_PAIRS = 3;

const PAIR_RE = /^([^:]+?)::\s*(.+)$/;

const oneLine = (s: string) => s.replace(/\r?\n/g, "<br>").trim();
const unLine = (s: string) => s.replace(/<br>/g, "\n").trim();

export function encodeMatch(m: MatchResult): { question: string; answer: string } {
  // A `::` in the prompt would make the decoder read it as the first pairing.
  const prompt = oneLine(m.prompt).replace(/::/g, ":");
  const lines = m.pairs.map(p => `${oneLine(p.left).replace(/:/g, "")}:: ${oneLine(p.right)}`);
  return {
    question: [prompt, ...lines].filter(Boolean).join("\n"),
    answer: "",
  };
}

export function decodeMatch(question: string): MatchResult {
  const pairs: MatchPair[] = [];
  const promptLines: string[] = [];

  for (const line of question.trim().split("\n")) {
    const m = line.match(PAIR_RE);
    if (m) {
      const left = unLine(m[1]);
      const right = unLine(m[2]);
      if (left && right) pairs.push({ left, right });
    } else if (pairs.length === 0 && line.trim()) {
      // Anything before the first pairing is the prompt. Once pairings have
      // started, a non-pair line is malformed and simply ignored.
      promptLines.push(line.trim());
    }
  }

  if (pairs.length < 2) throw new Error("Match card needs at least two pairs");
  return { prompt: promptLines.join(" ") || DEFAULT_MATCH_PROMPT, pairs };
}

/**
 * Grade a set of connections. `connections` maps left index → right index, both
 * into the card's own pair order, so a left is correct exactly when it points at
 * the right sharing its index.
 *
 * Duplicate right targets can't happen (the renderer enforces a bijection), but
 * grading doesn't rely on that — an unconnected left is simply wrong.
 */
export function markMatch(pairCount: number, connections: Map<number, number>): boolean[] {
  const results: boolean[] = [];
  for (let i = 0; i < pairCount; i++) results.push(connections.get(i) === i);
  return results;
}
