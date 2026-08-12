import { Notice, TFile, TFolder } from "obsidian";
import type IrisCardsPlugin from "../main";
import {
  forEachCard, computeNextDue, getStability, getLeitnerBox, leitnerDueIso,
  getParentNoteName, isConflictedCopy,
} from "../scheduler";

/**
 * Integrity check over stored `next-due` dates.
 *
 * Deliberately narrow. A due date in the past is *normal* — that's what an
 * overdue card is, and same-day scheduling writes today's UTC midnight, which
 * is already behind the clock. Clamping every past date forward would silently
 * erase a real backlog, and would also hide the far more likely explanation for
 * a card that looks stuck: it's due, but a filter (module, tag, scope) is
 * keeping it out of the queue.
 *
 * What this catches is a date that *cannot* be right whatever the backlog:
 *
 *   - `next-due` that doesn't parse as a date at all;
 *   - `next-due` earlier than `last-reviewed` — recording a review always
 *     writes a fresh due date, so a due date predating the last review means
 *     the write was lost or the file was hand-edited into an impossible state.
 *
 * Both are repaired by recomputing the due date from the card's current
 * stability (or Leitner box), exactly as a review would have.
 */

export type DueDateProblemKind = "malformed" | "before-last-review";

export interface DueDateProblem {
  file: TFile;
  kind: DueDateProblemKind;
  /** The stored value, verbatim — for the report. */
  stored: string;
  lastReviewed: string | null;
}

/** Scan every card, newest problem first. Read-only. */
export function auditDueDates(plugin: IrisCardsPlugin): DueDateProblem[] {
  const cardsFolder = plugin.settings.cardsFolder.trim() || "Iris Cards";
  const problems: DueDateProblem[] = [];

  forEachCard(plugin.app, cardsFolder, (file, fm) => {
    const raw = fm?.["next-due"];
    if (raw == null) return; // never scheduled — not a corruption
    const stored = String(raw);
    const dueTs = new Date(stored).getTime();
    if (!isFinite(dueTs)) {
      problems.push({ file, kind: "malformed", stored, lastReviewed: null });
      return;
    }
    const lastReviewed = (fm?.["last-reviewed"] as string) ?? null;
    if (!lastReviewed) return;
    const reviewedTs = new Date(lastReviewed).getTime();
    if (!isFinite(reviewedTs)) return;
    // Same-day scheduling writes UTC midnight of the review day, so a due date
    // up to a day behind the review timestamp is expected, not broken.
    if (dueTs < startOfUtcDay(reviewedTs)) {
      problems.push({ file, kind: "before-last-review", stored, lastReviewed });
    }
  });

  return problems;
}

function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/** Recompute the due date for each problem card, as a review would. */
export async function repairDueDates(plugin: IrisCardsPlugin, problems: DueDateProblem[]): Promise<number> {
  const cardsFolder = plugin.settings.cardsFolder.trim() || "Iris Cards";
  let fixed = 0;

  for (const p of problems) {
    try {
      await plugin.app.fileManager.processFrontMatter(p.file, (fm) => {
        fm["next-due"] = plugin.settings.scheduler === "leitner"
          ? leitnerDueIso(getLeitnerBox(fm))
          : computeNextDue(
              plugin.app, cardsFolder, getStability(fm),
              plugin.settings.desiredRetention, p.file.path,
              getParentNoteName(fm),
            );
      });
      plugin.qaCache.delete(p.file.path);
      fixed++;
    } catch (e) {
      console.error("[iris-cards] could not repair due date for", p.file.path, e);
    }
  }

  if (fixed > 0) plugin.updateBadge();
  return fixed;
}

/**
 * Files in the cards folder that the review machinery can't safely touch.
 *
 * Both kinds come from syncing a vault that's reviewed on two devices, and
 * both used to be invisible: a card whose YAML won't parse is skipped by every
 * frontmatter-driven scan (including the due-date audit above, which reads the
 * metadata cache), and a conflicted copy quietly reviews as a phantom card.
 * Neither is auto-repaired — merging two divergent review histories is a
 * judgement call — so they're reported by path for the user to resolve.
 */
export interface CardHealthReport {
  unparseable: TFile[];
  conflicted: TFile[];
}

export async function auditCardHealth(plugin: IrisCardsPlugin): Promise<CardHealthReport> {
  const cardsFolder = plugin.settings.cardsFolder.trim() || "Iris Cards";
  const folder = plugin.app.vault.getAbstractFileByPath(cardsFolder);
  const report: CardHealthReport = { unparseable: [], conflicted: [] };
  if (!(folder instanceof TFolder)) return report;

  for (const child of folder.children) {
    if (!(child instanceof TFile) || child.extension !== "md") continue;
    if (isConflictedCopy(child)) {
      report.conflicted.push(child);
      continue;
    }
    // A frontmatter block the parser rejected (duplicate keys after a merge)
    // leaves no `frontmatter` in the cache even though the file plainly opens
    // with one. That card can never be written to — recording a review on it
    // throws — so it's worth naming.
    const cache = plugin.app.metadataCache.getFileCache(child);
    if (cache?.frontmatter) continue;
    const text = await plugin.app.vault.cachedRead(child);
    if (text.startsWith("---")) report.unparseable.push(child);
  }
  return report;
}

/**
 * Command entry point: scan, report what was found, and repair. Every repaired
 * card is logged with its old and new date so a surprising result can be traced
 * (and reverted from file history) rather than just trusted.
 */
export async function checkAndRepairDueDates(plugin: IrisCardsPlugin): Promise<void> {
  const health = await auditCardHealth(plugin);
  for (const f of health.unparseable) {
    console.warn(`[iris-cards] unreadable frontmatter (reviews on this card cannot be recorded): ${f.path}`);
  }
  for (const f of health.conflicted) {
    console.warn(`[iris-cards] sync conflict copy, excluded from review: ${f.path}`);
  }
  const healthParts: string[] = [];
  if (health.unparseable.length) healthParts.push(`${health.unparseable.length} with unreadable frontmatter`);
  if (health.conflicted.length) healthParts.push(`${health.conflicted.length} sync conflict cop${health.conflicted.length === 1 ? "y" : "ies"}`);
  if (healthParts.length) {
    new Notice(`Needs your attention: ${healthParts.join(", ")}. Paths are in the console.`, 10000);
  }

  const problems = auditDueDates(plugin);
  if (problems.length === 0) {
    if (!healthParts.length) new Notice("Cards all healthy — nothing to fix.");
    return;
  }

  for (const p of problems) {
    console.info(
      `[iris-cards] due-date repair (${p.kind}): ${p.file.path} — stored "${p.stored}"`,
      p.lastReviewed ? `, last reviewed ${p.lastReviewed}` : "",
    );
  }

  const fixed = await repairDueDates(plugin, problems);
  const malformed = problems.filter(p => p.kind === "malformed").length;
  const stale = problems.length - malformed;
  const parts: string[] = [];
  if (stale) parts.push(`${stale} due before its own last review`);
  if (malformed) parts.push(`${malformed} unreadable`);
  new Notice(
    `Rescheduled ${fixed} of ${problems.length} card${problems.length === 1 ? "" : "s"} (${parts.join(", ")}). See console for details.`,
  );
}
