import { App, type CachedMetadata, TFile, TFolder, getAllTags, normalizePath } from "obsidian";
import { type QAVariant, type ExerciseType } from "./types/exercises";
import { parseQABlock, stripQABlock, buildQABlock, dedupeVariants } from "./types/qa-block";
import { encodeGapAlt, decodeGapAlt } from "./types/gap-alternates";
import { getStability, getDifficulty, updateStability, updateDifficulty, getDueCards, S_INITIAL, buildLogEntry, appendReviewLog, initialStability, initialDifficulty, retrievability, daysSince, computeNextDue, getParentNoteName, getLeitnerBox, leitnerNextBox, leitnerDueIso } from "./scheduler";
import type { SchedulerAlgorithm } from "./settings";
import { normalizeAnswer } from "./utils/text";

/** A note's tags (frontmatter + inline), normalized: no leading '#', deduped, sorted. */
function noteTags(cache: CachedMetadata | null | undefined): string[] {
  const tags = cache ? getAllTags(cache) ?? [] : [];
  return [...new Set(tags.map(t => t.replace(/^#/, "")))].sort();
}

/** Normalize a frontmatter `tags` value (string or array, with or without '#') for comparison. */
function normalizeTagList(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  return [...new Set(
    list.filter((t): t is string => typeof t === "string")
      .map(t => t.trim().replace(/^#/, ""))
      .filter(Boolean),
  )].sort();
}

export class CardStore {
  constructor(private app: App) {}

  /**
   * Mirror parent-note tags onto child cards, so a card's `tags` frontmatter
   * always reflects its parent note's *current* tags (live inheritance, not a
   * copy frozen at creation). Pass `parentName` to sync just one note's
   * children (event-driven); omit it to sweep every card (startup). Only
   * cards whose tags actually differ are written.
   */
  async syncInheritedTags(cardsFolder: string, parentName?: string): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(cardsFolder.trim() || "Iris Cards");
    if (!(folder instanceof TFolder)) return;
    const tagCache = new Map<string, string[]>();
    const parentTags = (name: string): string[] => {
      let t = tagCache.get(name);
      if (!t) {
        const f = this.app.metadataCache.getFirstLinkpathDest(name, "");
        t = f ? noteTags(this.app.metadataCache.getFileCache(f)) : [];
        tagCache.set(name, t);
      }
      return t;
    };
    for (const child of folder.children) {
      if (!(child instanceof TFile) || child.extension !== "md") continue;
      const fm = this.app.metadataCache.getFileCache(child)?.frontmatter;
      const parent = getParentNoteName(fm);
      if (!parent || (parentName != null && parent !== parentName)) continue;
      const wanted = parentTags(parent);
      const current = normalizeTagList(fm?.["tags"]);
      if (current.length === wanted.length && current.every((t, i) => t === wanted[i])) continue;
      await this.app.fileManager.processFrontMatter(child, (f) => {
        if (wanted.length > 0) f["tags"] = wanted;
        else delete f["tags"];
      });
    }
  }

  /**
   * Read, mutate, and write back a card's QA variants in one step. Dedupes
   * variants with matching (exerciseType, question) both before and after the
   * updater runs so `findIndex(v => v.question === ...)` lookups in the
   * updater are unambiguous, and any duplicates introduced by appends
   * (e.g., pregen generating a Q&A whose main + alternate collapse to the
   * same canonical form after QC) get merged back down.
   */
  async updateVariants(
    file: TFile,
    updater: (variants: QAVariant[], eligible: ExerciseType[]) => void,
  ): Promise<QAVariant[]> {
    const content = await this.app.vault.read(file);
    const parsed = parseQABlock(content);
    const variants = dedupeVariants(parsed.variants);
    updater(variants, parsed.eligibleTypes);
    const final = dedupeVariants(variants);
    const stripped = stripQABlock(content);
    await this.app.vault.modify(file, stripped.trimEnd() + buildQABlock(final, parsed.eligibleTypes));
    return final;
  }

  /** Sync the all-suspended frontmatter flag with current variant state. */
  async updateSuspendedFlag(file: TFile, variants: QAVariant[]): Promise<void> {
    const hasActive = variants.some(v => !v.suspended);
    if (variants.length > 0 && !hasActive) {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        fm["all-suspended"] = true;
      });
    } else {
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache?.frontmatter?.["all-suspended"]) {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          delete fm["all-suspended"];
        });
      }
    }
  }

  /**
   * Create a new card file with body text and metadata from a source note.
   * `group` stamps fact-group membership: a human-readable name, the card's
   * position, and whether it starts out waiting (not reviewable until the
   * user starts it — see getWaitingGroups).
   */
  async createCard(
    cardsFolder: string,
    body: string,
    source?: { file: TFile; contentFile?: TFile; module?: string; date?: string; aiSelected?: boolean },
    group?: { name: string; order: number; waiting: boolean },
  ): Promise<TFile> {
    await this.ensureFolderExists(cardsFolder);
    const uid = String(Date.now());
    const targetPath = normalizePath(`${cardsFolder}/${uid}.md`);
    const newFile = await this.app.vault.create(targetPath, body);

    await this.app.fileManager.processFrontMatter(newFile, (fm) => {
      fm["stability"] = S_INITIAL;
      if (source?.file) {
        fm["parent-note"] = `[[${source.file.basename}]]`;
        // Card filenames are bare timestamps; mirror the parent note's title so
        // the card reads as something human in the explorer, graph, and links.
        const title = this.parentDisplayTitle(source.file);
        if (title) fm["displayTitle"] = title;
        // Cards inherit the parent note's tags (kept live by syncInheritedTags).
        const tags = noteTags(this.app.metadataCache.getFileCache(source.file));
        if (tags.length > 0) fm["tags"] = tags;
      }
      if (source?.module != null) fm["module"] = source.module;
      if (source?.date != null) fm["date"] = source.date;
      if (source?.aiSelected) fm["ai-selected"] = true;
      if (source?.contentFile && source.contentFile.path !== source.file.path) {
        fm["content-note"] = `[[${source.contentFile.basename}]]`;
      }
      if (group) {
        fm["group"] = group.name;
        fm["group-order"] = group.order;
        if (group.waiting) fm["waiting"] = true;
      }
    });

    return newFile;
  }

  /**
   * Human-readable title for a card, taken from its parent note. Prefers the
   * note's own `displayTitle`/`title` frontmatter, falling back to the note's
   * basename, then to the raw parent-note name when the note can't be resolved.
   */
  private parentDisplayTitle(parentFile: TFile | null, parentName?: string): string | undefined {
    if (parentFile) {
      const fm = this.app.metadataCache.getFileCache(parentFile)?.frontmatter;
      const dt = fm?.["displayTitle"] ?? fm?.["title"];
      if (typeof dt === "string" && dt.trim()) return dt.trim();
      return parentFile.basename;
    }
    return parentName?.trim() || undefined;
  }

  /**
   * One-time backfill: stamp `displayTitle` on legacy cards that predate the
   * field, deriving it from each card's parent note. Skips cards that already
   * have one and cards with no resolvable parent. Returns the number filled.
   */
  async backfillDisplayTitles(cardsFolder: string): Promise<number> {
    const folder = this.app.vault.getAbstractFileByPath(cardsFolder.trim() || "Iris Cards");
    if (!(folder instanceof TFolder)) return 0;
    let filled = 0;
    for (const child of folder.children) {
      if (!(child instanceof TFile) || child.extension !== "md") continue;
      const fm = this.app.metadataCache.getFileCache(child)?.frontmatter;
      const existing = fm?.["displayTitle"];
      if (typeof existing === "string" && existing.trim()) continue;
      const parentName = getParentNoteName(fm);
      if (!parentName) continue;
      const parentFile = this.app.metadataCache.getFirstLinkpathDest(parentName, child.path);
      const title = this.parentDisplayTitle(parentFile, parentName);
      if (!title) continue;
      await this.app.fileManager.processFrontMatter(child, (f) => {
        if (typeof f["displayTitle"] === "string" && f["displayTitle"].trim()) return;
        f["displayTitle"] = title;
      });
      filled++;
    }
    return filled;
  }

  /**
   * Record a review outcome: update frontmatter (stability, last-reviewed)
   * and variant metadata (lastReviewed, acceptedAnswers, recordMs).
   */
  async recordReview(
    file: TFile,
    correct: boolean,
    questionShown?: string,
    userAnswer?: string,
    elapsedMs?: number,
    gapTerm?: string,
    grade?: number,
    cardsFolder?: string,
    desiredRetention?: number,
    scheduler: SchedulerAlgorithm = "fsrs",
  ): Promise<void> {
    // Read variant difficulty before updating frontmatter so the stability
    // calculation uses the reviewed variant's difficulty, not the file-level
    // one. For gap-based reviews (cloze, image occlusion) the reviewed gap's
    // own difficulty is even more specific — prefer it when present.
    let variantD: number | undefined;
    if (questionShown) {
      const content = await this.app.vault.cachedRead(file);
      const parsed = parseQABlock(content);
      const v = parsed.variants.find(v => v.question.trim() === questionShown.trim());
      const gapD = v && gapTerm ? v.gapDifficulties?.[gapTerm] : undefined;
      if (gapD != null) variantD = gapD;
      else if (v && v.difficulty != null) variantD = v.difficulty;
    }

    await this.app.fileManager.processFrontMatter(file, (fm) => {
      const reps = (fm["repetitions"] as number | undefined) ?? 0;
      // Read the box before mutating stability — getLeitnerBox falls back to a
      // stability-derived box for cards that predate the field.
      const prevBox = getLeitnerBox(fm, desiredRetention ?? 0.9);
      let newS: number;
      let newD: number;
      if (reps === 0) {
        newS = initialStability(correct, grade);
        newD = initialDifficulty(correct, grade);
      } else {
        const S = getStability(fm);
        const D = variantD ?? getDifficulty(fm);
        const R = retrievability(daysSince(fm["last-reviewed"] as string | undefined), S);
        newS = updateStability(S, D, correct, R, grade);
        newD = updateDifficulty(getDifficulty(fm), correct, grade);
      }
      // FSRS state always updates (even under Leitner) so switching algorithms
      // either way loses nothing — only the due-date assignment differs.
      fm["stability"] = newS;
      fm["difficulty"] = newD;
      fm["last-reviewed"] = new Date().toISOString();
      fm["repetitions"] = reps + 1;
      appendReviewLog(fm, buildLogEntry(correct, elapsedMs, grade));

      if (scheduler === "leitner") {
        const newBox = leitnerNextBox(reps === 0 ? 1 : prevBox, correct);
        fm["box"] = newBox;
        fm["next-due"] = leitnerDueIso(newBox);
      } else if (cardsFolder) {
        fm["next-due"] = computeNextDue(
          this.app, cardsFolder, newS,
          desiredRetention ?? 0.9, file.path,
          getParentNoteName(fm),
        );
      }
    });

    if (questionShown) {
      await this.updateVariants(file, (variants) => {
        const idx = variants.findIndex(v => v.question.trim() === questionShown.trim());
        if (idx === -1) return;
        const v = variants[idx];
        const newVD = v.difficulty == null || v.lastReviewed == null
          ? initialDifficulty(correct, grade)
          : updateDifficulty(v.difficulty, correct, grade);
        const updated: QAVariant = {
          ...v,
          lastReviewed: new Date().toISOString(),
          difficulty: newVD,
        };

        // Gap-based review: track the reviewed gap's own difficulty so each
        // gap of a cloze schedules like its own memory item.
        if (gapTerm) {
          const prevGD = v.gapDifficulties?.[gapTerm];
          const newGD = prevGD == null
            ? initialDifficulty(correct, grade)
            : updateDifficulty(prevGD, correct, grade);
          updated.gapDifficulties = { ...v.gapDifficulties, [gapTerm]: newGD };
        }

        if (correct && userAnswer) {
          const norm = normalizeAnswer(userAnswer);
          const canonicalNorms = gapTerm
            ? [normalizeAnswer(gapTerm)]
            : [normalizeAnswer(v.answer)];
          const existingNorms = v.acceptedAnswers
            .map(decodeGapAlt)
            .filter(d => gapTerm ? (d.term === gapTerm || d.term === null) : d.term === null)
            .map(d => normalizeAnswer(d.alt));
          if (![...canonicalNorms, ...existingNorms].includes(norm)) {
            const entry = gapTerm ? encodeGapAlt(gapTerm, userAnswer.trim()) : userAnswer.trim();
            updated.acceptedAnswers = [...v.acceptedAnswers, entry];
          }
        }

        if (!correct && userAnswer) {
          const norm = normalizeAnswer(userAnswer);
          const canonicalNorms = gapTerm
            ? [normalizeAnswer(gapTerm)]
            : [normalizeAnswer(v.answer)];
          const acceptedNorms = v.acceptedAnswers
            .map(decodeGapAlt)
            .filter(d => gapTerm ? (d.term === gapTerm || d.term === null) : d.term === null)
            .map(d => normalizeAnswer(d.alt));
          const existingNorms = v.knownIncorrect
            .map(decodeGapAlt)
            .filter(d => gapTerm ? (d.term === gapTerm || d.term === null) : d.term === null)
            .map(d => normalizeAnswer(d.alt));
          if (![...canonicalNorms, ...acceptedNorms, ...existingNorms].includes(norm)) {
            const entry = gapTerm ? encodeGapAlt(gapTerm, userAnswer.trim()) : userAnswer.trim();
            updated.knownIncorrect = [...v.knownIncorrect, entry];
          }
        }

        if (correct && elapsedMs != null && (v.recordMs == null || elapsedMs < v.recordMs)) {
          updated.recordMs = elapsedMs;
        }

        variants[idx] = updated;
      });
    }
  }

  /** Add a user answer as accepted for a variant (used after successful appeal). */
  async addAcceptedAnswer(file: TFile, questionShown: string, userAnswer: string, gapTerm?: string): Promise<void> {
    await this.updateVariants(file, (variants) => {
      const idx = variants.findIndex(v => v.question.trim() === questionShown.trim());
      if (idx === -1) return;
      const v = variants[idx];
      const norm = normalizeAnswer(userAnswer);
      const canonicalNorms = gapTerm
        ? [normalizeAnswer(gapTerm)]
        : [normalizeAnswer(v.answer)];
      const existingNorms = v.acceptedAnswers
        .map(decodeGapAlt)
        .filter(d => gapTerm ? (d.term === gapTerm || d.term === null) : d.term === null)
        .map(d => normalizeAnswer(d.alt));
      // Strip from knownIncorrect — without this, isKnownIncorrect fires on the
      // next review before the local exact-match check, forcing re-appeal forever.
      const knownIncorrect = v.knownIncorrect.filter(entry => {
        const decoded = decodeGapAlt(entry);
        const matchesScope = gapTerm ? (decoded.term === gapTerm || decoded.term === null) : decoded.term === null;
        return !(matchesScope && normalizeAnswer(decoded.alt) === norm);
      });
      const acceptedAnswers = [...canonicalNorms, ...existingNorms].includes(norm)
        ? v.acceptedAnswers
        : [...v.acceptedAnswers, gapTerm ? encodeGapAlt(gapTerm, userAnswer.trim()) : userAnswer.trim()];
      variants[idx] = { ...v, acceptedAnswers, knownIncorrect };
    });
  }

  /** Suspend a specific variant by question text. Returns remaining active variants. */
  async suspendVariant(file: TFile, questionText: string): Promise<QAVariant[]> {
    const variants = await this.updateVariants(file, (variants) => {
      const idx = variants.findIndex(v => v.question.trim() === questionText.trim());
      if (idx !== -1) {
        variants[idx] = { ...variants[idx], suspended: true };
      }
    });
    const remaining = variants.filter(v => !v.suspended);
    if (remaining.length === 0) {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        fm["all-suspended"] = true;
      });
    }
    return remaining;
  }

  /** Strip Q&A blocks from all due cards (cache clear). */
  async stripAllQABlocks(cardsFolder: string): Promise<void> {
    const cards = await getDueCards(this.app, cardsFolder);
    for (const card of cards) {
      const content = await this.app.vault.read(card);
      const stripped = stripQABlock(content);
      if (stripped !== content) {
        await this.app.vault.modify(card, stripped);
      }
    }
  }

  async ensureFolderExists(folderPath: string): Promise<void> {
    if (!folderPath || folderPath === "/") return;
    const existing = this.app.vault.getAbstractFileByPath(folderPath);
    if (existing) return;
    const lastSlash = folderPath.lastIndexOf("/");
    if (lastSlash > 0) {
      await this.ensureFolderExists(folderPath.substring(0, lastSlash));
    }
    await this.app.vault.createFolder(folderPath);
  }
}
