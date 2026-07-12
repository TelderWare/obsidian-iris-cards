import { type QAVariant } from "../types/exercises";

/**
 * Audio review handles basic Q&A only. Other exercise types are visual or
 * interaction-heavy; the standalone audio process (audio-view.ts) simply
 * skips cards that have no active Q&A variant.
 */
export function isAudioSupported(exerciseType: QAVariant["exerciseType"]): boolean {
  return exerciseType === "Q&A";
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

/** Speakable question text; null for anything but Q&A. */
export function questionTextForAudio(variant: QAVariant): string | null {
  if (!isAudioSupported(variant.exerciseType)) return null;
  return stripMarkdownForSpeech(variant.question);
}

/**
 * Keyterms to bias STT for this variant. Scribe is strong at generic English
 * but mangles uncommon vocabulary (Greek roots, drug names, biochem terms)
 * unless told to expect them. The canonical answer plus accepted alternates is
 * usually enough to flip recognition from "play" to "pleo".
 *
 * Returned raw — `sanitizeKeyterms` in api/elevenlabs handles dedupe, char
 * stripping, and length caps so callers don't have to repeat that logic.
 */
export function keytermsForAudio(variant: QAVariant): string[] {
  return [variant.answer, ...variant.acceptedAnswers];
}

export function answerTextForAudio(variant: QAVariant): string {
  return stripMarkdownForSpeech(variant.answer);
}
