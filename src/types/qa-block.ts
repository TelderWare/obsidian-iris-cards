import { EXERCISE_TYPES, type ExerciseType, type QAVariant, type ParsedQA } from "./exercises";

export function parseQABlock(fullContent: string): ParsedQA {
  const noFm = fullContent.replace(/^---[\s\S]*?---\n*/, "");
  const sepIdx = noFm.lastIndexOf("\n---\nQ: ");
  // Also check for blocks that start with Eligible: before any Q:
  const eligibleSepIdx = noFm.lastIndexOf("\n---\nEligible: ");
  const blockStart = eligibleSepIdx !== -1 ? Math.min(eligibleSepIdx, sepIdx === -1 ? Infinity : sepIdx) : sepIdx;

  if (blockStart === -1 || blockStart === Infinity) {
    return { body: noFm.trim(), eligibleTypes: [], variants: [] };
  }

  const body = noFm.slice(0, blockStart).trim();
  const lines = noFm.slice(blockStart + 5).split("\n"); // skip "\n---\n"

  let eligibleTypes: ExerciseType[] = [];
  const variants: QAVariant[] = [];
  let type: ExerciseType = "Q&A";
  let q = "";
  let a = "";
  let accepted: string[] = [];
  let reviewed: string | null = null;
  let suspended = false;
  let recordMs: number | null = null;
  let difficulty: number | null = null;

  const exerciseSet = new Set<string>(EXERCISE_TYPES);
  const LEGACY_ALIASES: Record<string, ExerciseType> = { "Order Steps": "Place in Order" };

  const pushVariant = () => {
    if (q && a) variants.push({ exerciseType: type, question: q, answer: a, acceptedAnswers: accepted, lastReviewed: reviewed, suspended, recordMs, difficulty });
  };

  for (const line of lines) {
    if (line.startsWith("Eligible: ")) {
      eligibleTypes = line.slice(10).split(",").map(s => s.trim()).filter((s): s is ExerciseType => exerciseSet.has(s));
    } else if (line.startsWith("Q: ")) {
      pushVariant();
      q = line.slice(3).trim();
      a = "";
      type = "Q&A";
      accepted = [];
      reviewed = null;
      suspended = false;
      recordMs = null;
      difficulty = null;
    } else if (line.startsWith("A: ")) {
      a = line.slice(3).trim();
    } else if (line.startsWith("Type: ")) {
      const val = line.slice(6).trim();
      const mapped = LEGACY_ALIASES[val] ?? val;
      if (exerciseSet.has(mapped)) type = mapped as ExerciseType;
    } else if (line.startsWith("Also accepted: ")) {
      accepted = line.slice(15).split(" | ").map(s => s.trim()).filter(Boolean);
    } else if (line.startsWith("Reviewed: ")) {
      reviewed = line.slice(10).trim() || null;
    } else if (line.startsWith("Suspended: ")) {
      suspended = line.slice(11).trim() === "true";
    } else if (line.startsWith("Record: ")) {
      const val = parseInt(line.slice(8).trim(), 10);
      if (!isNaN(val)) recordMs = val;
    } else if (line.startsWith("Difficulty: ")) {
      const val = parseFloat(line.slice(12).trim());
      if (!isNaN(val)) difficulty = val;
    } else if (q && !a && line.length > 0) {
      // Continuation of a multi-line question (e.g. MC options)
      q += "\n" + line;
    }
  }
  pushVariant();

  return { body, eligibleTypes, variants };
}

/**
 * Merge variants with the same (exerciseType, question) into one.
 * Chosen when the QC pass collapses a Q&A main + alternate to identical strings,
 * or when two generations happen to yield the same canonical form. Preserves
 * the more-reviewed variant's state and unions acceptedAnswers so no user data
 * is lost.
 */
export function dedupeVariants(variants: QAVariant[]): QAVariant[] {
  const seen = new Map<string, QAVariant>();
  const order: string[] = [];
  for (const v of variants) {
    const key = `${v.exerciseType}|${v.question}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, v);
      order.push(key);
    } else {
      seen.set(key, mergeVariants(existing, v));
    }
  }
  return order.map(k => seen.get(k)!);
}

function mergeVariants(a: QAVariant, b: QAVariant): QAVariant {
  // Primary = more recently reviewed; null < any date
  const primary = (a.lastReviewed ?? "") >= (b.lastReviewed ?? "") ? a : b;
  const secondary = primary === a ? b : a;
  const acceptedAnswers = Array.from(new Set([...primary.acceptedAnswers, ...secondary.acceptedAnswers]));
  const recordMs = primary.recordMs != null && secondary.recordMs != null
    ? Math.min(primary.recordMs, secondary.recordMs)
    : primary.recordMs ?? secondary.recordMs;
  return {
    exerciseType: primary.exerciseType,
    question: primary.question,
    answer: primary.answer,
    acceptedAnswers,
    lastReviewed: primary.lastReviewed,
    suspended: primary.suspended || secondary.suspended,
    recordMs,
    difficulty: primary.difficulty ?? secondary.difficulty,
  };
}

export function buildQABlock(variants: QAVariant[], eligibleTypes: ExerciseType[] = []): string {
  if (variants.length === 0 && eligibleTypes.length === 0) return "";
  const entries = variants.map(v => {
    let entry = `Q: ${v.question}\nA: ${v.answer}`;
    if (v.exerciseType !== "Q&A") {
      entry += `\nType: ${v.exerciseType}`;
    }
    if (v.acceptedAnswers.length > 0) {
      entry += `\nAlso accepted: ${v.acceptedAnswers.join(" | ")}`;
    }
    if (v.lastReviewed) {
      entry += `\nReviewed: ${v.lastReviewed}`;
    }
    if (v.suspended) {
      entry += `\nSuspended: true`;
    }
    if (v.recordMs != null) {
      entry += `\nRecord: ${v.recordMs}`;
    }
    if (v.difficulty != null) {
      entry += `\nDifficulty: ${v.difficulty}`;
    }
    return entry;
  });
  const eligibleLine = eligibleTypes.length > 0 ? `Eligible: ${eligibleTypes.join(", ")}\n\n` : "";
  return "\n\n---\n" + eligibleLine + entries.join("\n\n") + "\n";
}

export function stripQABlock(fullContent: string): string {
  // Strip frontmatter before searching so we don't accidentally match inside it
  const fmMatch = fullContent.match(/^---[\s\S]*?---\n*/);
  const fmLength = fmMatch ? fmMatch[0].length : 0;
  const body = fullContent.slice(fmLength);
  const qIdx = body.lastIndexOf("\n---\nQ: ");
  const eIdx = body.lastIndexOf("\n---\nEligible: ");
  const idx = eIdx !== -1 ? Math.min(eIdx, qIdx === -1 ? Infinity : qIdx) : qIdx;
  if (idx === -1 || idx === Infinity) return fullContent;
  return fullContent.slice(0, fmLength + idx);
}
