import { App, TFile, TFolder } from "obsidian";

// --- Forgetting curve parameters ---
const ALPHA = 1.0;       // growth rate (correct answer)
const BETA = 0.5;        // growth scaling (weaker cards gain stability faster)
const GAMMA = 0.5;       // base decay multiplier (incorrect answer)
const S_MIN = 0.5;       // minimum stability floor (days)
export const S_INITIAL = 1.0; // initial stability for new cards (days)

// --- Difficulty bounds ---
const D_INITIAL = 0.5;
const D_MIN = 0.1;
const D_MAX = 1.0;
const D_CORRECT_DELTA = -0.05;
const D_INCORRECT_DELTA = 0.1;

// --- Response-time baseline ---
const MEDIAN_MS = 8000;  // assumed median correct-answer time

// --- Review log ---
const MAX_LOG_ENTRIES = 50;

const MS_PER_DAY = 86400000;

// Migration: old Leitner box intervals for converting box → stability
const BOX_INTERVALS = [1, 2, 4, 7, 14, 30, 60];

/** Probability of forgetting given elapsed days and stability. */
export function pForget(deltaDays: number, stability: number): number {
  return 1 - Math.exp(-deltaDays / stability);
}

/** Optimal review interval for a desired retention rate. */
export function optimalInterval(stability: number, desiredRetention: number): number {
  return -stability * Math.log(desiredRetention);
}

/** Deterministic jitter factor in [-0.05, 0.05] based on file path. */
function jitterFactor(filePath: string): number {
  let hash = 0;
  for (let i = 0; i < filePath.length; i++) hash = (hash + filePath.charCodeAt(i)) % 1000;
  return (hash / 1000 - 0.5) * 0.1;
}

/** Jittered optimal interval for a card. */
function jitteredInterval(stability: number, desiredRetention: number, filePath: string): number {
  const base = optimalInterval(stability, desiredRetention);
  return base * (1 + jitterFactor(filePath));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Update stability after a review. */
export function updateStability(stability: number, correct: boolean, difficulty = D_INITIAL, elapsedMs?: number): number {
  if (correct) {
    const speedFactor = elapsedMs != null ? clamp(MEDIAN_MS / elapsedMs, 0.5, 1.0) : 1.0;
    return stability * (1 + ALPHA * difficulty * speedFactor * Math.pow(stability, -BETA));
  }
  // Smarter lapse handling: mature cards retain more stability
  if (stability > 1) {
    return Math.max(S_MIN, stability * (GAMMA + 0.1 * Math.log(stability)));
  }
  return Math.max(S_MIN, GAMMA * stability);
}

/** Update difficulty after a review. */
export function updateDifficulty(difficulty: number, correct: boolean, softRetry = false): number {
  const delta = correct ? D_CORRECT_DELTA : (softRetry ? D_INCORRECT_DELTA * 0.5 : D_INCORRECT_DELTA);
  return clamp(difficulty + delta, D_MIN, D_MAX);
}

/** Read stability from frontmatter, migrating from box if needed. */
export function getStability(fm: Record<string, unknown> | undefined): number {
  if (!fm) return S_INITIAL;
  if (typeof fm["stability"] === "number") return fm["stability"];
  // Migrate from Leitner box
  const box = fm["box"];
  if (typeof box === "number" && box >= 1 && box <= BOX_INTERVALS.length) {
    return BOX_INTERVALS[box - 1];
  }
  return S_INITIAL;
}

/** Read difficulty from frontmatter. */
export function getDifficulty(fm: Record<string, unknown> | undefined): number {
  if (!fm) return D_INITIAL;
  if (typeof fm["difficulty"] === "number") return clamp(fm["difficulty"] as number, D_MIN, D_MAX);
  return D_INITIAL;
}

/** Elapsed days since last review (or Infinity if never reviewed). */
function elapsedDays(lastReviewed: string | null, offsetDays = 0): number {
  if (!lastReviewed) return Infinity;
  return Math.max(0, (Date.now() + offsetDays * MS_PER_DAY - new Date(lastReviewed).getTime()) / MS_PER_DAY);
}

/** Iterate over all .md card files in a folder, calling fn for each with its cached frontmatter. */
function forEachCard(app: App, cardsFolder: string, fn: (file: TFile, fm: Record<string, unknown> | undefined) => void): void {
  const folder = app.vault.getAbstractFileByPath(cardsFolder);
  if (!folder || !(folder instanceof TFolder)) return;
  for (const child of folder.children) {
    if (!(child instanceof TFile) || child.extension !== "md") continue;
    const cache = app.metadataCache.getFileCache(child);
    if (!cache) continue;
    fn(child, cache.frontmatter);
  }
}

export function getDueCards(app: App, cardsFolder: string, offsetDays = 0, moduleFilter?: Set<string>, desiredRetention = 0.9): TFile[] {
  const scored: { file: TFile; overdueRatio: number }[] = [];
  forEachCard(app, cardsFolder, (file, fm) => {
    if (fm?.["all-suspended"]) return;
    if (fm?.["ai-selected"]) return;
    if (moduleFilter && moduleFilter.size > 0 && !moduleFilter.has(fm?.["module"] as string)) return;
    const lastReviewed = (fm?.["last-reviewed"] as string) ?? null;
    const dt = elapsedDays(lastReviewed, offsetDays);
    if (!isFinite(dt)) {
      // Never reviewed → top priority
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

export function getAllCards(app: App, cardsFolder: string, moduleFilter?: Set<string>): TFile[] {
  const cards: TFile[] = [];
  forEachCard(app, cardsFolder, (file, fm) => {
    if (fm?.["all-suspended"]) return;
    if (moduleFilter && moduleFilter.size > 0 && !moduleFilter.has(fm?.["module"] as string)) return;
    cards.push(file);
  });
  return sortByFilename(cards);
}

/** Sort cards by basename so sibling facts stay in extraction order. */
export function sortByFilename(cards: TFile[]): TFile[] {
  return cards.sort((a, b) => a.basename.localeCompare(b.basename, undefined, { numeric: true }));
}


export function countDueFromCache(app: App, cardsFolder: string, offsetDays = 0, desiredRetention = 0.9): number {
  let count = 0;
  forEachCard(app, cardsFolder, (file, fm) => {
    if (fm?.["all-suspended"]) return;
    if (fm?.["ai-selected"]) return;
    const lastReviewed = (fm?.["last-reviewed"] as string) ?? null;
    const dt = elapsedDays(lastReviewed, offsetDays);
    if (!isFinite(dt)) { count++; return; }
    const S = getStability(fm);
    const interval = jitteredInterval(S, desiredRetention, file.path);
    if (dt >= interval) count++;
  });
  return count;
}

/** Collect unique module values from all cards. */
export function getModules(app: App, cardsFolder: string): string[] {
  const modules = new Set<string>();
  forEachCard(app, cardsFolder, (_file, fm) => {
    const m = fm?.["module"];
    if (typeof m === "string" && m) modules.add(m);
  });
  return [...modules].sort();
}

/** Build a compact review-log entry. */
export function buildLogEntry(correct: boolean, elapsedMs?: number): string {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const flag = correct ? "c" : "w";
  const ms = elapsedMs != null ? String(Math.round(elapsedMs)) : "";
  return `${date},${flag},${ms}`;
}

/** Append to review log, capping at MAX_LOG_ENTRIES. */
export function appendReviewLog(fm: Record<string, unknown>, entry: string): void {
  let log = Array.isArray(fm["review-log"]) ? [...fm["review-log"]] : [];
  log.push(entry);
  if (log.length > MAX_LOG_ENTRIES) log = log.slice(log.length - MAX_LOG_ENTRIES);
  fm["review-log"] = log;
}
