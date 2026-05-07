/**
 * Encoding for cloze/occlude alternates so each accepted answer is bound to
 * the canonical term of the gap it came from. Stored inline in
 * `QAVariant.acceptedAnswers` so the block file format is unchanged — entries
 * with no separator are treated as unbound (legacy / non-cloze) and apply to
 * any gap.
 */

const SEP = " :: ";

export function encodeGapAlt(term: string, alt: string): string {
  return `${term}${SEP}${alt}`;
}

export function decodeGapAlt(entry: string): { term: string | null; alt: string } {
  const i = entry.indexOf(SEP);
  if (i === -1) return { term: null, alt: entry };
  return { term: entry.slice(0, i), alt: entry.slice(i + SEP.length) };
}
