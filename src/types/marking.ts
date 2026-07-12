/**
 * Outcome of an attempt to mark an answer.
 *
 * The `ok: false` arm makes "marking couldn't run" — no API key, dead key,
 * network failure — a value structurally distinct from any verdict, so a
 * backend failure can never be silently collapsed into a wrong answer (the bug
 * that motivated this type). Every marker returns this regardless of how its
 * card renders, so the grading contract stays uniform even where the renderer
 * is bespoke.
 *
 * The success payload `value` stays per-marker (a boolean for single-answer
 * cards, per-row results for List) — only the failure channel is shared, which
 * is the part that must never differ.
 */
export type MarkResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** Marking ran and produced a verdict. */
export function marked<T>(value: T): MarkResult<T> {
  return { ok: true, value };
}

/** Marking could not run. Pass the caught error; its message is extracted. */
export function markFailed(cause: unknown): MarkResult<never> {
  return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
}
