/**
 * Per-presentation render state for a card variant.
 *
 * A card's render state holds the *stochastic presentation choices* made the
 * first time a variant is shown — which True/False polarity, which cloze gap,
 * which shuffled option order, which randomized knowns — so that re-renders and
 * upcoming-card previews stay stable, and so the visual card and the spoken
 * (audio-mode) prompt agree.
 *
 * The store itself is a plain `Record<string, unknown>` owned by the view /
 * widget (keyed by card path + question). These helpers are the *typed* gateway
 * to it: every read goes through `getOrInit`, so a key is initialized exactly
 * once and the `as` casts live in one place instead of being sprinkled across
 * every renderer.
 */

/** Initialize `key` once via `init`, then return the stored value on every call. */
export function getOrInit<T>(rs: Record<string, unknown>, key: string, init: () => T): T {
  if (rs[key] === undefined) rs[key] = init();
  return rs[key] as T;
}

/**
 * Whether a paired True/False card shows its TRUE statement this presentation.
 *
 * Memoized under a SINGLE key (`tfShowTrue`) shared by the visual renderer and
 * the audio path, so the on-screen statement and the spoken statement can never
 * pick opposite polarities. (They previously used different keys — `tfShowTrue`
 * vs `tfPick` — which let the card and the audio disagree in audio mode.)
 */
export function tfShowTrue(rs: Record<string, unknown>): boolean {
  return getOrInit(rs, "tfShowTrue", () => Math.random() < 0.5);
}

/**
 * Which cloze gap (0-based) is occluded this presentation. Memoized under
 * `clozeIdx`, shared by the visual renderer and the audio path so both occlude
 * the same gap.
 *
 * When per-gap `weights` are given (one per term, e.g. each gap's FSRS
 * difficulty), the pick is weighted so harder gaps come up more often.
 */
export function clozeIndex(rs: Record<string, unknown>, termCount: number, weights?: number[]): number {
  return getOrInit(rs, "clozeIdx", () => {
    if (weights && weights.length === termCount && weights.some(w => w > 0)) {
      const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
      let r = Math.random() * total;
      for (let i = 0; i < weights.length; i++) {
        r -= Math.max(0, weights[i]);
        if (r <= 0) return i;
      }
    }
    return Math.floor(Math.random() * Math.max(1, termCount));
  });
}
