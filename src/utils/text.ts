/**
 * Canonicalize a free-text answer for exact-match comparison: lowercase, strip
 * punctuation, collapse whitespace. Shared by every answer-matching path so the
 * matching rule can't drift between card types.
 */
export function normalizeAnswer(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}
