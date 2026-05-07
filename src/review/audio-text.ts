import { type QAVariant } from "../types/exercises";
import { decodeTFPair } from "../generators/true-false";
import { parseClozeTerms, occludeCloze } from "../generators/cloze";
import { decodeList } from "../generators/list";

/**
 * Exercise types currently supported in audio review mode.
 * Other types (Multiple Choice, Solve Equation, Place in Order, Assemble Equation,
 * Image Occlusion) are auto-skipped by review-view in audio mode.
 */
const AUDIO_SUPPORTED: ReadonlySet<QAVariant["exerciseType"]> = new Set([
  "Q&A",
  "Correct the Mistake",
  "True/False",
  "Cloze",
  "List",
]);

export function isAudioSupported(exerciseType: QAVariant["exerciseType"]): boolean {
  return AUDIO_SUPPORTED.has(exerciseType);
}

function stripMarkdownForSpeech(md: string): string {
  return md
    .replace(/!\[.*?\]\(.*?\)/g, "")         // images
    .replace(/\[([^\]]+)\]\(.*?\)/g, "$1")    // links → text
    .replace(/```[\s\S]*?```/g, "")           // fenced code
    .replace(/`([^`]+)`/g, "$1")              // inline code
    .replace(/\*\*(.+?)\*\*/g, "$1")          // bold
    .replace(/__(.+?)__/g, "$1")              // bold alt
    .replace(/\*(.+?)\*/g, "$1")              // italic
    .replace(/_(.+?)_/g, "$1")                // italic alt
    .replace(/~~(.+?)~~/g, "$1")              // strikethrough
    .replace(/^#{1,6}\s+/gm, "")              // headings
    .replace(/^[>\-*+]\s+/gm, "")             // lists/blockquotes
    .replace(/\|/g, ", ")                      // table pipes
    .replace(/\$\$[\s\S]*?\$\$/g, "formula")  // block math
    .replace(/\$([^$]+)\$/g, "$1")            // inline math (read symbols)
    .replace(/\n{2,}/g, ". ")                  // double newline → pause
    .replace(/\n/g, " ")                       // single newline → space
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract speakable question text from a QAVariant.
 * Returns null for exercise types that cannot be presented in audio (Image Occlusion).
 */
export function questionTextForAudio(
  variant: QAVariant,
  renderState: Record<string, unknown>,
): string | null {
  const q = variant.question;
  const a = variant.answer;

  if (!isAudioSupported(variant.exerciseType)) return null;

  switch (variant.exerciseType) {
    case "Q&A":
      return stripMarkdownForSpeech(q);

    case "Correct the Mistake":
      return `Identify and correct the mistake in this statement. ${stripMarkdownForSpeech(q)}`;

    case "True/False": {
      const tf = decodeTFPair(q, a);
      if (!tf) return `True or false? ${stripMarkdownForSpeech(q)}`;
      const pick = (renderState.tfPick as boolean | undefined) ?? Math.random() < 0.5;
      if (renderState.tfPick === undefined) renderState.tfPick = pick;
      const statement = pick ? tf.trueStatement : tf.falseStatement;
      return `True or false? ${stripMarkdownForSpeech(statement)}`;
    }

    case "Cloze": {
      const terms = parseClozeTerms(q);
      if (terms.length === 0) return stripMarkdownForSpeech(q);
      const idx = (renderState.clozeIdx as number | undefined) ?? Math.floor(Math.random() * terms.length);
      if (renderState.clozeIdx === undefined) renderState.clozeIdx = idx;
      const { display } = occludeCloze(q, idx);
      return stripMarkdownForSpeech(display).replace(/\[\.{3}\]/g, "blank");
    }

    case "List": {
      const l = decodeList(q, a);
      if (!l) return stripMarkdownForSpeech(q);
      return `${stripMarkdownForSpeech(l.prompt)}. Name all ${l.items.length} items.`;
    }

    default:
      return null;
  }
}

export function answerTextForAudio(variant: QAVariant): string {
  return stripMarkdownForSpeech(variant.answer);
}
