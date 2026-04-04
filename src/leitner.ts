import { App, TFile, TFolder } from "obsidian";

// --- Forgetting curve parameters ---
const ALPHA = 1.0;       // growth rate (correct answer)
const BETA = 0.5;        // growth scaling (weaker cards gain stability faster)
const GAMMA = 0.5;       // decay multiplier (incorrect answer)
const S_MIN = 0.5;       // minimum stability floor (days)
export const S_INITIAL = 1.0; // initial stability for new cards (days)

// --- Utility weights ---
const W_FORGET = 1.0;    // weight for forgetting urgency
const W_STALENESS = 0.01; // weight for staleness prevention

// --- Scheduling ---
const DUE_THRESHOLD = 0.15; // utility threshold for "due"

const MS_PER_DAY = 86400000;

// Migration: old Leitner box intervals for converting box → stability
const BOX_INTERVALS = [1, 2, 4, 7, 14, 30, 60];

/** Probability of forgetting given elapsed days and stability. */
export function pForget(deltaDays: number, stability: number): number {
  return 1 - Math.exp(-deltaDays / stability);
}

/** Update stability after a review. */
export function updateStability(stability: number, correct: boolean): number {
  if (correct) {
    return stability * (1 + ALPHA * Math.pow(stability, -BETA));
  }
  return Math.max(S_MIN, GAMMA * stability);
}

/** Compute utility score for a card. Higher = more urgent to review. */
function computeUtility(deltaDays: number, stability: number): number {
  return W_FORGET * pForget(deltaDays, stability) + W_STALENESS * deltaDays;
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

/** Elapsed days since last review (or Infinity if never reviewed). */
function elapsedDays(lastReviewed: string | null, offsetDays = 0): number {
  if (!lastReviewed) return Infinity;
  return Math.max(0, (Date.now() + offsetDays * MS_PER_DAY - new Date(lastReviewed).getTime()) / MS_PER_DAY);
}

/** Card utility from frontmatter. */
function cardUtility(fm: Record<string, unknown> | undefined, offsetDays = 0): number {
  const lastReviewed = (fm?.["last-reviewed"] as string) ?? null;
  const dt = elapsedDays(lastReviewed, offsetDays);
  if (!isFinite(dt)) return Infinity; // never reviewed → top priority
  const S = getStability(fm);
  return computeUtility(dt, S);
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

export function getDueCards(app: App, cardsFolder: string, offsetDays = 0, moduleFilter?: Set<string>): TFile[] {
  const scored: { file: TFile; utility: number }[] = [];
  forEachCard(app, cardsFolder, (file, fm) => {
    if (fm?.["all-suspended"]) return;
    if (moduleFilter && moduleFilter.size > 0 && !moduleFilter.has(fm?.["module"] as string)) return;
    const u = cardUtility(fm, offsetDays);
    if (u > DUE_THRESHOLD) scored.push({ file, utility: u });
  });
  scored.sort((a, b) => b.utility - a.utility);
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
function sortByFilename(cards: TFile[]): TFile[] {
  return cards.sort((a, b) => a.basename.localeCompare(b.basename, undefined, { numeric: true }));
}


export function countDueFromCache(app: App, cardsFolder: string, offsetDays = 0): number {
  let count = 0;
  forEachCard(app, cardsFolder, (_file, fm) => {
    if (fm?.["all-suspended"]) return;
    if (cardUtility(fm, offsetDays) > DUE_THRESHOLD) count++;
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
