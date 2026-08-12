/**
 * Canonicalize a free-text answer for exact-match comparison: lowercase and
 * collapse whitespace. Shared by every answer-matching path so the matching
 * rule can't drift between card types.
 *
 * Punctuation and symbols are NOT stripped: in this material they carry the
 * meaning (Na+ vs Na, 5'-AMP vs 5 AMP, 3,4-… vs 34…), and stripping them both
 * accepted wrong answers and auto-submitted a half-typed one the moment its
 * letters matched.
 */
export function normalizeAnswer(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
