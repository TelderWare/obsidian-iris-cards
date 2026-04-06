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
      if (exerciseSet.has(val)) type = val as ExerciseType;
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
