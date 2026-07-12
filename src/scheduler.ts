import { App, TFile, TFolder } from "obsidian";

// FSRS-6 default weights (open-spaced-repetition/py-fsrs defaults).
// Indices:
//   0-3   initial stability per grade (Again, Hard, Good, Easy)
//   4-5   initial difficulty params
//   6-7   difficulty update (delta scale, mean-reversion weight)
//   8-10  stability on successful recall
//   11-14 stability after lapse
//   15-16 Hard penalty / Easy bonus
export const FSRS_DEFAULT_WEIGHTS: readonly number[] = Object.freeze([
  0.4072, 1.1829, 3.1262, 15.4722,
  7.2102, 0.5316,
  1.0651, 0.0234,
  1.616, 0.1544, 1.0824,
  1.9813, 0.0953, 0.2975, 2.2042,
  0.2407, 2.9466,
]);

// Active weights — mutated by setFSRSWeights() so the plugin can swap in
// per-user fitted weights without threading them through every call site.
let W: number[] = FSRS_DEFAULT_WEIGHTS.slice();

export function setFSRSWeights(weights: number[] | null | undefined): void {
  if (weights && weights.length === FSRS_DEFAULT_WEIGHTS.length && weights.every(x => isFinite(x))) {
    W = weights.slice();
  } else {
    W = FSRS_DEFAULT_WEIGHTS.slice();
  }
}

export function getFSRSWeights(): number[] {
  return W.slice();
}

const DECAY = -0.5;
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1; // 19/81, so R(t=S) = 0.9

const S_MIN = 0.1;
const S_MAX = 36500;
const D_MIN = 1;
const D_MAX = 10;

export const GRADE_AGAIN    = 1;
export const GRADE_HARD     = 2;
export const GRADE_GOOD     = 3;
export const GRADE_EASY     = 4;

const MS_PER_DAY = 86400000;
// Bumped from 50 so the FSRS optimizer has enough per-card history to fit
// from. With ~daily reviews this keeps roughly the last ~3 years of reviews.
const MAX_LOG_ENTRIES = 1000;

export const S_INITIAL = 1.0;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function initDFromGrade(grade: number): number {
  const d = W[4] - Math.exp(W[5] * (grade - 1)) + 1;
  return clamp(d, D_MIN, D_MAX);
}

function dInitialGood(): number {
  return initDFromGrade(GRADE_GOOD);
}

export function retrievability(elapsedDays: number, stability: number): number {
  return Math.pow(1 + (FACTOR * elapsedDays) / Math.max(stability, S_MIN), DECAY);
}

export function pForget(deltaDays: number, stability: number): number {
  return 1 - retrievability(deltaDays, stability);
}

export function optimalInterval(stability: number, desiredRetention: number): number {
  return (stability / FACTOR) * (Math.pow(desiredRetention, 1 / DECAY) - 1);
}

// ─── Leitner boxes ──────────────────────────────────────────────────────
// Standard Leitner system: cards live in numbered boxes with fixed review
// intervals. A correct answer moves the card up one box; an incorrect answer
// sends it back to box 1. Runs alongside FSRS state (stability/difficulty keep
// updating), so switching algorithms either way loses nothing.

export const LEITNER_INTERVALS = [1, 2, 4, 8, 16]; // days per box, boxes 1..5
export const LEITNER_MAX_BOX = LEITNER_INTERVALS.length;

export function leitnerNextBox(prevBox: number, correct: boolean): number {
  if (!correct) return 1;
  return Math.min(Math.max(1, Math.round(prevBox)) + 1, LEITNER_MAX_BOX);
}

/**
 * Current box of a card. Cards that predate Leitner (no `box` field) derive a
 * starting box from their FSRS stability — the largest box whose interval fits
 * within the card's current optimal interval — so switching algorithms doesn't
 * reset progress.
 */
export function getLeitnerBox(fm: Record<string, unknown> | undefined, desiredRetention = 0.9): number {
  const raw = fm?.["box"];
  if (typeof raw === "number" && isFinite(raw)) {
    return Math.min(Math.max(1, Math.round(raw)), LEITNER_MAX_BOX);
  }
  const interval = optimalInterval(getStability(fm), desiredRetention);
  let box = 1;
  for (let i = 1; i < LEITNER_INTERVALS.length; i++) {
    if (LEITNER_INTERVALS[i] <= interval) box = i + 1;
  }
  return box;
}

/** Next-due ISO timestamp for a card in `box` (UTC-midnight of the target day,
 * same convention as computeNextDue). */
export function leitnerDueIso(box: number): string {
  const days = LEITNER_INTERVALS[Math.min(Math.max(1, Math.round(box)), LEITNER_MAX_BOX) - 1];
  const due = new Date(Date.now() + days * MS_PER_DAY);
  due.setUTCHours(0, 0, 0, 0);
  return due.toISOString();
}

// ─── Fact groups ────────────────────────────────────────────────────────
// Cards can carry `group: <human-readable name>`, `group-order: <n>`, and
// `waiting: true` frontmatter (stamped by bulk capture, freely hand-editable).
// A waiting card is not reviewable — hidden from the queue and badge — until
// the user starts it. There is no automatic unlocking: pacing is entirely
// user-driven (the review view's done card offers "Start next" per group).

/**
 * Groups that still have waiting members, with the lowest-order waiting
 * member as the next one to start. Sorted by name.
 */
export interface WaitingGroup {
  name: string;
  total: number;
  started: number;
  nextPath: string;
}

/** All group names in the cards folder → their highest group-order. Used for
 * name autocomplete at capture time and for appending to an existing group. */
export function getGroupOrders(app: App, cardsFolder: string): Map<string, number> {
  const out = new Map<string, number>();
  forEachCard(app, cardsFolder, (_file, fm) => {
    const name = fm?.["group"];
    if (typeof name !== "string" || !name.trim()) return;
    const order = typeof fm?.["group-order"] === "number" ? fm["group-order"] as number : 0;
    out.set(name, Math.max(out.get(name) ?? 0, order));
  });
  return out;
}

export function getWaitingGroups(app: App, cardsFolder: string): WaitingGroup[] {
  const groups = new Map<string, { total: number; waiting: { path: string; order: number }[] }>();
  forEachCard(app, cardsFolder, (file, fm) => {
    const name = fm?.["group"];
    if (typeof name !== "string" || !name.trim()) return;
    let g = groups.get(name);
    if (!g) {
      g = { total: 0, waiting: [] };
      groups.set(name, g);
    }
    g.total++;
    if (fm?.["waiting"]) {
      const order = typeof fm["group-order"] === "number" ? fm["group-order"] as number : Number.MAX_SAFE_INTEGER;
      g.waiting.push({ path: file.path, order });
    }
  });

  const out: WaitingGroup[] = [];
  for (const [name, g] of groups) {
    if (g.waiting.length === 0) continue;
    g.waiting.sort((a, b) => a.order - b.order);
    out.push({ name, total: g.total, started: g.total - g.waiting.length, nextPath: g.waiting[0].path });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

interface DayLoad { total: number; siblings: number }

// In-memory log of next-due assignments made this session. The metadata cache
// updates asynchronously after processFrontMatter, so siblings reviewed in
// quick succession wouldn't see each other's freshly written next-due values
// without this. Keyed by file path → { dueIso, parentNote, assignedAt }.
// Entries older than 30s are pruned on each write (cache is up-to-date by then).
const recentAssignments = new Map<string, { dueIso: string; parentNote: string | undefined; assignedAt: number }>();
const RECENT_TTL_MS = 30_000;

function pruneRecentAssignments(): void {
  const cutoff = Date.now() - RECENT_TTL_MS;
  for (const [path, entry] of recentAssignments) {
    if (entry.assignedAt < cutoff) recentAssignments.delete(path);
  }
}

const SIBLING_PENALTY = 3;

/**
 * Single O(n) pass over the vault building a load map for every day in [lo, hi]
 * (offsets from `now`). Each card contributes to the one day bucket it falls on.
 * Cards without a next-due field use the same ±5% window estimate as before,
 * but the estimate is now computed once per card rather than once per candidate day.
 *
 * Replaces the old dueDateLoad, which was called once per candidate day inside
 * loadBalancedDueDay, producing an O(n × windowSize) scan on every card rating.
 */
function buildDayLoadMap(
  app: App, cardsFolder: string,
  lo: number, hi: number,
  desiredRetention: number,
  skipPath: string,
  parentNote: string | undefined,
  now: number,
): Map<number, DayLoad> {
  const map = new Map<number, DayLoad>();
  for (let d = lo; d <= hi; d++) map.set(d, { total: 0, siblings: 0 });

  const seen = new Set<string>();

  const credit = (d: number, noteForSibling: string | undefined) => {
    const entry = map.get(d);
    if (!entry) return;
    entry.total++;
    if (parentNote && noteForSibling === parentNote) entry.siblings++;
  };

  forEachCard(app, cardsFolder, (file, fm) => {
    if (file.path === skipPath) return;
    if (fm?.["all-suspended"]) return;
    seen.add(file.path);

    const recent = recentAssignments.get(file.path);
    if (recent) {
      credit(Math.floor((new Date(recent.dueIso).getTime() - now) / MS_PER_DAY), recent.parentNote);
      return;
    }

    const noteForSibling = getParentNoteName(fm);
    const nextDue = fm?.["next-due"] as string | undefined;
    if (nextDue) {
      credit(Math.floor((new Date(nextDue).getTime() - now) / MS_PER_DAY), noteForSibling);
      return;
    }

    const lastReviewed = (fm?.["last-reviewed"] as string) ?? null;
    if (!lastReviewed) return;
    const daysSince = (now - new Date(lastReviewed).getTime()) / MS_PER_DAY;
    const S = getStability(fm);
    const interval = optimalInterval(S, desiredRetention);
    // Replicate the ±5% window from the old per-day isDue check:
    //   isDue(d) = daysSince+d >= interval*0.95 && daysSince+d < interval*1.05
    const dLo = Math.ceil(interval * 0.95 - daysSince);
    const dHi = Math.ceil(interval * 1.05 - daysSince) - 1;
    for (let d = Math.max(lo, dLo); d <= Math.min(hi, dHi); d++) {
      credit(d, noteForSibling);
    }
  });

  for (const [path, recent] of recentAssignments) {
    if (path === skipPath || seen.has(path)) continue;
    credit(Math.floor((new Date(recent.dueIso).getTime() - now) / MS_PER_DAY), recent.parentNote);
  }

  return map;
}

/**
 * Pick the least-loaded day in a window around the optimal interval.
 * Penalises days that already have siblings from the same parent note
 * so cards from one source get spread across different review days.
 */
export function loadBalancedDueDay(
  app: App, cardsFolder: string, stability: number,
  desiredRetention: number, filePath: string,
  parentNote: string | undefined,
): number {
  const raw = optimalInterval(stability, desiredRetention);
  if (raw < 2) return Math.max(1, Math.round(raw));
  const halfWindow = Math.max(1, Math.round(raw * 0.15));
  const lo = Math.max(1, Math.round(raw) - halfWindow);
  const hi = Math.round(raw) + halfWindow;

  const loadMap = buildDayLoadMap(app, cardsFolder, lo, hi, desiredRetention, filePath, parentNote, Date.now());

  let bestDay = Math.round(raw);
  let bestScore = Infinity;
  for (let d = lo; d <= hi; d++) {
    const load = loadMap.get(d) ?? { total: 0, siblings: 0 };
    const score = load.total + SIBLING_PENALTY * load.siblings + Math.abs(d - raw) * 0.01;
    if (score < bestScore) {
      bestScore = score;
      bestDay = d;
    }
  }
  return bestDay;
}

export function computeNextDue(
  app: App, cardsFolder: string, stability: number,
  desiredRetention: number, filePath: string,
  parentNote: string | undefined,
): string {
  const dayOffset = loadBalancedDueDay(app, cardsFolder, stability, desiredRetention, filePath, parentNote);
  const due = new Date(Date.now() + dayOffset * MS_PER_DAY);
  due.setUTCHours(0, 0, 0, 0);
  const iso = due.toISOString();
  pruneRecentAssignments();
  recentAssignments.set(filePath, { dueIso: iso, parentNote, assignedAt: Date.now() });
  return iso;
}

export function initialStability(correct: boolean, grade?: number): number {
  const g = grade ?? (correct ? GRADE_GOOD : GRADE_AGAIN);
  const idx = Math.min(g, GRADE_EASY) - 1;
  return clamp(W[idx], S_MIN, S_MAX);
}

export function initialDifficulty(correct: boolean, grade?: number): number {
  return initDFromGrade(grade ?? (correct ? GRADE_GOOD : GRADE_AGAIN));
}

/**
 * Recall: stability grows by (11-D)·S^-w9·(e^(w10·(1-R))-1)·e^w8.
 * Lapse: stability rebuilt as w11·D^-w12·((S+1)^w13 - 1)·e^(w14·(1-R)), capped by pre-lapse S.
 */
export function updateStability(S: number, D: number, correct: boolean, retrievabilityAtReview = 0.9, grade?: number): number {
  const s = clamp(S, S_MIN, S_MAX);
  const d = clamp(D, D_MIN, D_MAX);
  const r = clamp(retrievabilityAtReview, 0.001, 0.999);
  if (correct) {
    const growth = Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1);
    let newS = s * (1 + growth);
    const g = grade ?? GRADE_GOOD;
    if (g === GRADE_HARD) newS *= W[15];
    if (g === GRADE_EASY) newS *= W[16];
    return clamp(newS, S_MIN, S_MAX);
  }
  const lapsed = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
  return clamp(Math.min(lapsed, s), S_MIN, S_MAX);
}

/** Linear-damped delta + mean-reversion toward Easy's initial D. */
export function updateDifficulty(D: number, correct: boolean, grade?: number): number {
  const d = clamp(D, D_MIN, D_MAX);
  const g = grade ?? (correct ? GRADE_GOOD : GRADE_AGAIN);
  const deltaD = -W[6] * (g - 3);
  const damped = d + (deltaD * (10 - d)) / 9;
  const target = initDFromGrade(4);
  const blend = clamp(W[7], 0, 1);
  const reverted = blend * target + (1 - blend) * damped;
  return clamp(reverted, D_MIN, D_MAX);
}

export function getStability(fm: Record<string, unknown> | undefined): number {
  if (!fm) return S_INITIAL;
  if (typeof fm["stability"] === "number") return fm["stability"];
  return S_INITIAL;
}

export function getDifficulty(fm: Record<string, unknown> | undefined): number {
  if (!fm) return dInitialGood();
  const raw = fm["difficulty"];
  if (typeof raw !== "number" || isNaN(raw)) return dInitialGood();
  return clamp(raw, D_MIN, D_MAX);
}

export function daysSince(lastReviewed: string | null | undefined): number {
  if (!lastReviewed) return 0;
  return Math.max(0, (Date.now() - new Date(lastReviewed).getTime()) / MS_PER_DAY);
}

function elapsedDays(lastReviewed: string | null, offsetDays = 0): number {
  if (!lastReviewed) return Infinity;
  return Math.max(0, (Date.now() + offsetDays * MS_PER_DAY - new Date(lastReviewed).getTime()) / MS_PER_DAY);
}

function forEachCard(app: App, cardsFolder: string, fn: (file: TFile, fm: Record<string, unknown> | undefined) => void): void {
  const folder = app.vault.getAbstractFileByPath(cardsFolder);
  if (!folder || !(folder instanceof TFolder)) return;
  for (const child of folder.children) {
    if (!(child instanceof TFile) || child.extension !== "md") continue;
    const cache = app.metadataCache.getFileCache(child);
    if (!cache) continue;
    // ai-selected cards are excluded everywhere — no filter setting reveals
    // them. They live in the vault but are inert as far as review/listing.
    if (cache.frontmatter?.["ai-selected"]) continue;
    // Tables (and their state files) are their own data model (see
    // table-store.ts) — rows schedule through TableStore, never through
    // the card machinery.
    const kind = cache.frontmatter?.["kind"];
    if (kind === "table" || kind === "table-state") continue;
    fn(child, cache.frontmatter);
  }
}

/** Whether a card's frontmatter tags include `tag` — or a nested child of it
 * (`bio` matches `bio/enzymes`), mirroring Obsidian's tag-search semantics. */
export function cardHasTag(fm: Record<string, unknown> | undefined, tag: string): boolean {
  const raw = fm?.["tags"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const want = tag.trim().replace(/^#/, "").toLowerCase();
  if (!want) return false;
  return list.some(t => {
    if (typeof t !== "string") return false;
    const norm = t.trim().replace(/^#/, "").toLowerCase();
    return norm === want || norm.startsWith(want + "/");
  });
}

export function getParentNoteName(fm: Record<string, unknown> | undefined): string | undefined {
  const v = fm?.["parent-note"];
  if (typeof v !== "string" || !v) return undefined;
  const m = v.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
  return (m ? m[1] : v).trim() || undefined;
}

function getParentModule(app: App, fm: Record<string, unknown> | undefined): string | undefined {
  // Most cards have `module:` set directly at creation. Fall back to walking
  // the parent-note chain for older cards that predate that field.
  const own = fm?.["module"];
  if (typeof own === "string" && own) return own;
  const visited = new Set<string>();
  let currentFm = fm;
  while (true) {
    const parentName = getParentNoteName(currentFm);
    if (!parentName) return undefined;
    const parentFile = app.metadataCache.getFirstLinkpathDest(parentName, "");
    if (!parentFile || visited.has(parentFile.path)) return undefined;
    visited.add(parentFile.path);
    const parentFm = app.metadataCache.getFileCache(parentFile)?.frontmatter;
    const m = parentFm?.["module"];
    if (typeof m === "string" && m) return m;
    currentFm = parentFm;
  }
}

// Map module code → canonical Module note (file with `kind: "module"`).
// Codes that don't resolve to a Module note are dropped by the caller.
function buildModuleNoteIndex(app: App): Map<string, { file: TFile; fm: Record<string, unknown> }> {
  const index = new Map<string, { file: TFile; fm: Record<string, unknown> }>();
  for (const file of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (fm?.["kind"] !== "module") continue;
    const code = fm["module"];
    if (typeof code === "string" && code) index.set(code, { file, fm });
  }
  return index;
}

function getModuleDisplayName(file: TFile, fm: Record<string, unknown>, code: string): string {
  const dt = fm["displayTitle"];
  if (typeof dt === "string" && dt.trim()) return dt.trim();
  const base = file.basename;
  const stripped = base.startsWith(code) ? base.slice(code.length).trim() : base;
  return stripped || base || code;
}

export function getDueCards(app: App, cardsFolder: string, offsetDays = 0, moduleFilter?: Set<string>, desiredRetention = 0.9, noteFilter?: string): TFile[] {
  const scored: { file: TFile; overdueRatio: number }[] = [];
  forEachCard(app, cardsFolder, (file, fm) => {
    if (fm?.["all-suspended"]) return;
    if (fm?.["waiting"]) return;
    if (noteFilter) {
      const parent = getParentNoteName(fm);
      if (parent !== noteFilter) return;
    }
    if (moduleFilter && moduleFilter.size > 0) {
      const mod = getParentModule(app, fm);
      if (!mod || !moduleFilter.has(mod)) return;
    }
    const lastReviewed = (fm?.["last-reviewed"] as string) ?? null;
    const dt = elapsedDays(lastReviewed, offsetDays);
    if (!isFinite(dt)) {
      scored.push({ file, overdueRatio: Infinity });
      return;
    }

    const nextDue = fm?.["next-due"] as string | undefined;
    if (nextDue) {
      const dueTs = new Date(nextDue).getTime();
      const now = Date.now() + offsetDays * MS_PER_DAY;
      if (now >= dueTs) {
        const overdueDays = (now - dueTs) / MS_PER_DAY;
        const S = getStability(fm);
        const interval = optimalInterval(S, desiredRetention);
        scored.push({ file, overdueRatio: 1 + overdueDays / Math.max(interval, 1) });
      }
      return;
    }

    const S = getStability(fm);
    const interval = optimalInterval(S, desiredRetention);
    if (dt >= interval) {
      scored.push({ file, overdueRatio: dt / interval });
    }
  });
  scored.sort((a, b) => b.overdueRatio - a.overdueRatio);
  return scored.map(s => s.file);
}

/** Treat brand-new (never-reviewed) cards as if they have this much chance of being
 * forgotten. Tuned so new cards rank above well-stabilized review cards but below
 * cards the user is actively losing — appropriate for infinite/cram mode where
 * exposure to new material is itself a goal. */
export const NEW_CARD_FORGETTING_SCORE = 0.6;

/** Probability the card would fail right now under FSRS. New cards get a fixed
 * baseline. Used by infinite mode to surface what most needs review,
 * independent of whether the card is technically due. */
export function cardForgettingScore(fm: Record<string, unknown> | undefined): number {
  const lastReviewed = (fm?.["last-reviewed"] as string) ?? null;
  if (!lastReviewed) return NEW_CARD_FORGETTING_SCORE;
  const dt = daysSince(lastReviewed);
  const S = getStability(fm);
  return pForget(dt, S);
}

/**
 * Weighted random pick over an infinite-mode pool, weighting each card by its
 * current forgetting probability and discounting by how many times it has
 * already been shown this session (halved per show, capped at 6) so
 * recently-shown cards don't immediately re-appear. Shared by the visual and
 * audio review views so their infinite modes stay in sync.
 */
export function weightedForgettingPick(app: App, pool: TFile[], showCount: Map<string, number>): TFile | null {
  if (pool.length === 0) return null;
  const scored = pool.map(f => {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    let score = cardForgettingScore(fm);
    const shown = Math.min(6, showCount.get(f.path) ?? 0);
    if (shown > 0) score *= Math.pow(0.5, shown);
    return { file: f, score: Math.max(0.001, score) };
  });
  const total = scored.reduce((s, x) => s + x.score, 0);
  let r = Math.random() * total;
  let picked = scored[0].file;
  for (const x of scored) {
    r -= x.score;
    if (r <= 0) { picked = x.file; break; }
  }
  return picked;
}

export function getAllCards(app: App, cardsFolder: string, moduleFilter?: Set<string>, noteFilter?: string, excludeWaiting = false): TFile[] {
  const cards: TFile[] = [];
  forEachCard(app, cardsFolder, (file, fm) => {
    if (fm?.["all-suspended"]) return;
    if (excludeWaiting && fm?.["waiting"]) return;
    if (noteFilter) {
      const parent = getParentNoteName(fm);
      if (parent !== noteFilter) return;
    }
    if (moduleFilter && moduleFilter.size > 0) {
      const mod = getParentModule(app, fm);
      if (!mod || !moduleFilter.has(mod)) return;
    }
    cards.push(file);
  });
  return cards;
}

export function countDueFromCache(app: App, cardsFolder: string, offsetDays = 0, desiredRetention = 0.9, moduleFilter?: Set<string>): number {
  let count = 0;
  forEachCard(app, cardsFolder, (_file, fm) => {
    if (fm?.["all-suspended"]) return;
    if (fm?.["waiting"]) return;
    if (moduleFilter && moduleFilter.size > 0) {
      const mod = getParentModule(app, fm);
      if (!mod || !moduleFilter.has(mod)) return;
    }
    const lastReviewed = (fm?.["last-reviewed"] as string) ?? null;
    const dt = elapsedDays(lastReviewed, offsetDays);
    if (!isFinite(dt)) { count++; return; }

    const nextDue = fm?.["next-due"] as string | undefined;
    if (nextDue) {
      const dueTs = new Date(nextDue).getTime();
      const now = Date.now() + offsetDays * MS_PER_DAY;
      if (now >= dueTs) count++;
      return;
    }

    const S = getStability(fm);
    const interval = optimalInterval(S, desiredRetention);
    if (dt >= interval) count++;
  });
  return count;
}

/** Fallback when no review-log entries carry timing data yet. */
const DEFAULT_REVIEW_SECONDS = 20;

/** Estimated minutes to clear `dueCount` cards, based on the median elapsed
 * time of logged reviews (median so walk-away outliers don't skew it). */
export function estimateDueMinutes(app: App, cardsFolder: string, dueCount: number, moduleFilter?: Set<string>): number {
  if (dueCount <= 0) return 0;
  const samples: number[] = [];
  forEachCard(app, cardsFolder, (_file, fm) => {
    if (moduleFilter && moduleFilter.size > 0) {
      const mod = getParentModule(app, fm);
      if (!mod || !moduleFilter.has(mod)) return;
    }
    for (const e of parseReviewLog(fm)) {
      if (e.elapsedMs != null && e.elapsedMs > 0) samples.push(e.elapsedMs / 1000);
    }
  });
  samples.sort((a, b) => a - b);
  const perCardSec = samples.length > 0 ? samples[Math.floor(samples.length / 2)] : DEFAULT_REVIEW_SECONDS;
  return Math.max(1, Math.round((dueCount * perCardSec) / 60));
}

export function getModules(app: App, cardsFolder: string): { code: string; name: string }[] {
  const codes = new Set<string>();
  forEachCard(app, cardsFolder, (_file, fm) => {
    const code = getParentModule(app, fm);
    if (code) codes.add(code);
  });
  const index = buildModuleNoteIndex(app);
  const out: { code: string; name: string }[] = [];
  for (const code of codes) {
    const note = index.get(code);
    if (note) out.push({ code, name: getModuleDisplayName(note.file, note.fm, code) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Log format: ISO-8601 timestamp,c|w,elapsedMs   (e.g. 2026-05-04T14:23:45.123Z,c,1832)
// Old format `YYYY-MM-DD,c|w,ms` is still parsed by parseLogEntry — Date.parse
// reads the date as midnight UTC, giving day-resolution timestamps for old data.
export function buildLogEntry(correct: boolean, elapsedMs?: number, grade?: number): string {
  const ts = new Date().toISOString();
  const flag = correct ? "c" : "w";
  const ms = elapsedMs != null ? String(Math.round(elapsedMs)) : "";
  const g = grade != null ? String(grade) : "";
  return `${ts},${flag},${ms},${g}`;
}

export interface ParsedLogEntry {
  timestamp: number;
  correct: boolean;
  elapsedMs: number | null;
  grade: number | null;
}

export function parseLogEntry(entry: unknown): ParsedLogEntry | null {
  if (typeof entry !== "string") return null;
  const parts = entry.split(",");
  if (parts.length < 2) return null;
  const t = Date.parse(parts[0]);
  if (!isFinite(t)) return null;
  const correct = parts[1] === "c";
  const ms = parts[2] != null && parts[2] !== "" ? Number(parts[2]) : NaN;
  const gr = parts[3] != null && parts[3] !== "" ? Number(parts[3]) : NaN;
  return { timestamp: t, correct, elapsedMs: isFinite(ms) ? ms : null, grade: isFinite(gr) ? gr : null };
}

export function parseReviewLog(fm: Record<string, unknown> | undefined): ParsedLogEntry[] {
  const raw = fm?.["review-log"];
  if (!Array.isArray(raw)) return [];
  const out: ParsedLogEntry[] = [];
  for (const entry of raw) {
    const p = parseLogEntry(entry);
    if (p) out.push(p);
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}

export function appendReviewLog(fm: Record<string, unknown>, entry: string): void {
  let log = Array.isArray(fm["review-log"]) ? [...fm["review-log"]] : [];
  log.push(entry);
  if (log.length > MAX_LOG_ENTRIES) log = log.slice(log.length - MAX_LOG_ENTRIES);
  fm["review-log"] = log;
}
