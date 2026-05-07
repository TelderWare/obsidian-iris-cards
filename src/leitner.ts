import { App, TFile, TFolder } from "obsidian";

// FSRS-6 default weights (open-spaced-repetition/py-fsrs defaults).
// Indices:
//   0-3   initial stability per grade (Again, Hard, Good, Easy)
//   4-5   initial difficulty params
//   6-7   difficulty update (delta scale, mean-reversion weight)
//   8-10  stability on successful recall
//   11-14 stability after lapse
//   15-16 Hard penalty / Easy bonus (unused with binary grading)
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

const GRADE_CORRECT = 3; // Good
const GRADE_WRONG = 1;   // Again

const MS_PER_DAY = 86400000;
// Bumped from 50 so the FSRS optimizer has enough per-card history to fit
// from. With ~daily reviews this keeps roughly the last ~3 years of reviews.
const MAX_LOG_ENTRIES = 1000;
const BOX_INTERVALS = [1, 2, 4, 7, 14, 30, 60]; // legacy Leitner migration

export const S_INITIAL = 1.0;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function initDFromGrade(grade: number): number {
  const d = W[4] - Math.exp(W[5] * (grade - 1)) + 1;
  return clamp(d, D_MIN, D_MAX);
}

// Recomputed per call so it reflects the active W after setFSRSWeights().
function dInitialGood(): number {
  return initDFromGrade(GRADE_CORRECT);
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

function jitterFactor(filePath: string): number {
  let hash = 0;
  for (let i = 0; i < filePath.length; i++) hash = (hash + filePath.charCodeAt(i)) % 1000;
  return (hash / 1000 - 0.5) * 0.1;
}

function jitteredInterval(stability: number, desiredRetention: number, filePath: string): number {
  return optimalInterval(stability, desiredRetention) * (1 + jitterFactor(filePath));
}

export function initialStability(correct: boolean): number {
  const g = correct ? GRADE_CORRECT : GRADE_WRONG;
  return clamp(W[g - 1], S_MIN, S_MAX);
}

export function initialDifficulty(correct: boolean): number {
  return initDFromGrade(correct ? GRADE_CORRECT : GRADE_WRONG);
}

/**
 * Recall: stability grows by (11-D)·S^-w9·(e^(w10·(1-R))-1)·e^w8.
 * Lapse: stability rebuilt as w11·D^-w12·((S+1)^w13 - 1)·e^(w14·(1-R)), capped by pre-lapse S.
 */
export function updateStability(S: number, D: number, correct: boolean, retrievabilityAtReview = 0.9): number {
  const s = clamp(S, S_MIN, S_MAX);
  const d = clamp(D, D_MIN, D_MAX);
  const r = clamp(retrievabilityAtReview, 0.001, 0.999);
  if (correct) {
    const growth = Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1);
    return clamp(s * (1 + growth), S_MIN, S_MAX);
  }
  const lapsed = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
  return clamp(Math.min(lapsed, s), S_MIN, S_MAX);
}

/** Linear-damped delta + mean-reversion toward Easy's initial D. */
export function updateDifficulty(D: number, correct: boolean): number {
  const d = clamp(D, D_MIN, D_MAX);
  const g = correct ? GRADE_CORRECT : GRADE_WRONG;
  const deltaD = -W[6] * (g - 3);
  const damped = d + (deltaD * (10 - d)) / 9;
  const target = initDFromGrade(4);
  const blend = clamp(W[7], 0, 1);
  const reverted = blend * target + (1 - blend) * damped;
  return clamp(reverted, D_MIN, D_MAX);
}

/** Coerce a difficulty value (possibly from the old 0.1–1.0 coefficient scale) to FSRS 1–10. */
export function migrateDifficulty(raw: unknown): number {
  if (typeof raw !== "number" || isNaN(raw)) return dInitialGood();
  if (raw > 0 && raw <= 1.5) return clamp(1 + 9 * raw, D_MIN, D_MAX);
  return clamp(raw, D_MIN, D_MAX);
}

export function getStability(fm: Record<string, unknown> | undefined): number {
  if (!fm) return S_INITIAL;
  if (typeof fm["stability"] === "number") return fm["stability"];
  const box = fm["box"];
  if (typeof box === "number" && box >= 1 && box <= BOX_INTERVALS.length) {
    return BOX_INTERVALS[box - 1];
  }
  return S_INITIAL;
}

export function getDifficulty(fm: Record<string, unknown> | undefined): number {
  if (!fm) return dInitialGood();
  return migrateDifficulty(fm["difficulty"]);
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
    fn(child, cache.frontmatter);
  }
}

export function getParentNoteName(fm: Record<string, unknown> | undefined): string | undefined {
  const v = fm?.["parent-note"];
  if (typeof v !== "string" || !v) return undefined;
  const m = v.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
  return (m ? m[1] : v).trim() || undefined;
}

function getParentModule(app: App, fm: Record<string, unknown> | undefined): string | undefined {
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

export function getDueCards(app: App, cardsFolder: string, offsetDays = 0, moduleFilter?: Set<string>, desiredRetention = 0.9, noteFilter?: string): TFile[] {
  const scored: { file: TFile; overdueRatio: number }[] = [];
  forEachCard(app, cardsFolder, (file, fm) => {
    if (fm?.["all-suspended"]) return;
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
    const S = getStability(fm);
    const interval = jitteredInterval(S, desiredRetention, file.path);
    if (dt >= interval) {
      scored.push({ file, overdueRatio: dt / interval });
    }
  });
  scored.sort((a, b) => b.overdueRatio - a.overdueRatio);
  return scored.map(s => s.file);
}

export type InfiniteSort = "filename" | "least-reps" | "random";

function reviewCount(fm: Record<string, unknown> | undefined): number {
  const log = fm?.["review-log"];
  return Array.isArray(log) ? log.length : 0;
}

export function getAllCards(app: App, cardsFolder: string, moduleFilter?: Set<string>, sort: InfiniteSort = "filename", noteFilter?: string): TFile[] {
  const cards: TFile[] = [];
  forEachCard(app, cardsFolder, (file, fm) => {
    if (fm?.["all-suspended"]) return;
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
  return sortCards(app, cards, sort);
}

function sortCards(app: App, cards: TFile[], mode: InfiniteSort): TFile[] {
  if (mode === "random") {
    const arr = [...cards];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  if (mode === "least-reps") {
    return [...cards].sort((a, b) => {
      const ar = reviewCount(app.metadataCache.getFileCache(a)?.frontmatter);
      const br = reviewCount(app.metadataCache.getFileCache(b)?.frontmatter);
      if (ar !== br) return ar - br;
      return a.basename.localeCompare(b.basename, undefined, { numeric: true });
    });
  }
  return sortByFilename(cards);
}

export function sortByFilename(cards: TFile[]): TFile[] {
  return cards.sort((a, b) => a.basename.localeCompare(b.basename, undefined, { numeric: true }));
}

export function countDueFromCache(app: App, cardsFolder: string, offsetDays = 0, desiredRetention = 0.9): number {
  let count = 0;
  forEachCard(app, cardsFolder, (file, fm) => {
    if (fm?.["all-suspended"]) return;
    const lastReviewed = (fm?.["last-reviewed"] as string) ?? null;
    const dt = elapsedDays(lastReviewed, offsetDays);
    if (!isFinite(dt)) { count++; return; }
    const S = getStability(fm);
    const interval = jitteredInterval(S, desiredRetention, file.path);
    if (dt >= interval) count++;
  });
  return count;
}

export function getModules(app: App, cardsFolder: string): string[] {
  const modules = new Set<string>();
  forEachCard(app, cardsFolder, (_file, fm) => {
    const mod = getParentModule(app, fm);
    if (mod) modules.add(mod);
  });
  return [...modules].sort();
}

// Log format: ISO-8601 timestamp,c|w,elapsedMs   (e.g. 2026-05-04T14:23:45.123Z,c,1832)
// Old format `YYYY-MM-DD,c|w,ms` is still parsed by parseLogEntry — Date.parse
// reads the date as midnight UTC, giving day-resolution timestamps for old data.
export function buildLogEntry(correct: boolean, elapsedMs?: number): string {
  const ts = new Date().toISOString();
  const flag = correct ? "c" : "w";
  const ms = elapsedMs != null ? String(Math.round(elapsedMs)) : "";
  return `${ts},${flag},${ms}`;
}

export interface ParsedLogEntry {
  timestamp: number;
  correct: boolean;
  elapsedMs: number | null;
}

export function parseLogEntry(entry: unknown): ParsedLogEntry | null {
  if (typeof entry !== "string") return null;
  const parts = entry.split(",");
  if (parts.length < 2) return null;
  const t = Date.parse(parts[0]);
  if (!isFinite(t)) return null;
  const correct = parts[1] === "c";
  const ms = parts[2] != null && parts[2] !== "" ? Number(parts[2]) : NaN;
  return { timestamp: t, correct, elapsedMs: isFinite(ms) ? ms : null };
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
