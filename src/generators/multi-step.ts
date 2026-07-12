/**
 * Multi-step — two or more Q&A sub-cards reviewed in sequence as one card.
 * Each step reveals before the next appears; the learner self-grades the card
 * as a whole at the end.
 *
 * Stored in Q as human-readable numbered lines:
 *
 *   Q1:: What activates PKA?
 *   A1:: cAMP
 *   Q2:: What does PKA phosphorylate?
 *   A2:: Phosphorylase kinase
 *
 * `Q1::` can't collide with the QA block's own `Q: `/`A: ` markers (different
 * prefix) or its single-colon directives. Newlines inside a step are stored as
 * <br> so every entry stays on one line. No A: line. Earlier v2 builds stored
 * a JSON array; decodeMultiStep still reads that as a legacy fallback.
 */

export interface MultiStep {
  question: string;
  answer: string;
}

export interface MultiStepResult {
  steps: MultiStep[];
}

export function encodeMultiStep(steps: MultiStep[]): { question: string; answer: string } {
  const lines: string[] = [];
  steps.forEach((s, i) => {
    lines.push(`Q${i + 1}:: ${s.question.replace(/\r?\n/g, "<br>").trim()}`);
    lines.push(`A${i + 1}:: ${s.answer.replace(/\r?\n/g, "<br>").trim()}`);
  });
  return { question: lines.join("\n"), answer: "" };
}

export function decodeMultiStep(question: string): MultiStepResult {
  const q = question.trim();
  const steps = q.startsWith("[") ? decodeMultiStepLegacyJson(q) : decodeMultiStepLines(q);
  if (steps.length < 2) throw new Error("Multi-step card needs at least two steps");
  return { steps };
}

function decodeMultiStepLines(q: string): MultiStep[] {
  const byNumber = new Map<number, { q?: string; a?: string }>();
  for (const line of q.split("\n")) {
    const m = line.match(/^([QA])(\d+)::\s*(.+)$/);
    if (!m) continue;
    const n = parseInt(m[2], 10);
    const text = m[3].replace(/<br>/g, "\n").trim();
    const entry = byNumber.get(n) ?? {};
    if (m[1] === "Q") entry.q = text;
    else entry.a = text;
    byNumber.set(n, entry);
  }
  return [...byNumber.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([, e]) => e)
    .filter((e): e is { q: string; a: string } => !!e.q && !!e.a)
    .map(e => ({ question: e.q, answer: e.a }));
}

/** Earlier v2 builds stored the steps as a JSON array in Q. */
function decodeMultiStepLegacyJson(q: string): MultiStep[] {
  let raw: unknown;
  try { raw = JSON.parse(q); } catch { throw new Error("Invalid multi-step data"); }
  if (!Array.isArray(raw)) throw new Error("Multi-step payload is not an array");
  const steps: MultiStep[] = [];
  for (const s of raw) {
    if (typeof s !== "object" || s === null) continue;
    const question = (s as Record<string, unknown>)["question"];
    const answer = (s as Record<string, unknown>)["answer"];
    if (typeof question === "string" && question.trim() && typeof answer === "string" && answer.trim()) {
      steps.push({ question: question.trim(), answer: answer.trim() });
    }
  }
  return steps;
}
