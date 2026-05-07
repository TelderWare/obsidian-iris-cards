import { App, TFile, TFolder, normalizePath } from "obsidian";
import { type QAVariant, type ExerciseType } from "./types/exercises";
import { parseQABlock, stripQABlock, buildQABlock, dedupeVariants } from "./types/qa-block";
import { encodeGapAlt, decodeGapAlt } from "./types/gap-alternates";
import { getStability, getDifficulty, updateStability, updateDifficulty, getDueCards, S_INITIAL, buildLogEntry, appendReviewLog, initialStability, initialDifficulty, retrievability, daysSince, migrateDifficulty } from "./leitner";

function normalizeAnswer(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

export class CardStore {
  constructor(private app: App) {}

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

  /** Create a new card file with body text and metadata from a source note. */
  async createCard(
    cardsFolder: string,
    body: string,
    source?: { file: TFile; contentFile?: TFile; module?: string; date?: string; aiSelected?: boolean },
  ): Promise<TFile> {
    await this.ensureFolderExists(cardsFolder);
    const uid = String(Date.now());
    const targetPath = normalizePath(`${cardsFolder}/${uid}.md`);
    const newFile = await this.app.vault.create(targetPath, body);

    await this.app.fileManager.processFrontMatter(newFile, (fm) => {
      fm["stability"] = S_INITIAL;
      fm["last-reviewed"] = new Date().toISOString();
      if (source?.file) {
        fm["parent-note"] = `[[${source.file.basename}]]`;
      }
      if (source?.module != null) fm["module"] = source.module;
      if (source?.date != null) fm["date"] = source.date;
      if (source?.aiSelected) fm["ai-selected"] = true;
      if (source?.contentFile && source.contentFile.path !== source.file.path) {
        fm["content-note"] = `[[${source.contentFile.basename}]]`;
      }
    });

    return newFile;
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
  ): Promise<void> {
    // Read variant difficulty before updating frontmatter so the stability
    // calculation uses the reviewed variant's difficulty, not the file-level one.
    let variantD: number | undefined;
    if (questionShown) {
      const content = await this.app.vault.cachedRead(file);
      const parsed = parseQABlock(content);
      const v = parsed.variants.find(v => v.question.trim() === questionShown.trim());
      if (v && v.difficulty != null) variantD = migrateDifficulty(v.difficulty);
    }

    await this.app.fileManager.processFrontMatter(file, (fm) => {
      const reps = (fm["repetitions"] as number | undefined) ?? 0;
      let newS: number;
      let newD: number;
      if (reps === 0) {
        newS = initialStability(correct);
        newD = initialDifficulty(correct);
      } else {
        const S = getStability(fm);
        const D = variantD ?? getDifficulty(fm);
        const R = retrievability(daysSince(fm["last-reviewed"] as string | undefined), S);
        newS = updateStability(S, D, correct, R);
        newD = updateDifficulty(getDifficulty(fm), correct);
      }
      fm["stability"] = newS;
      fm["difficulty"] = newD;
      delete fm["box"];
      fm["last-reviewed"] = new Date().toISOString();
      fm["repetitions"] = reps + 1;
      appendReviewLog(fm, buildLogEntry(correct, elapsedMs));
    });

    if (questionShown) {
      await this.updateVariants(file, (variants) => {
        const idx = variants.findIndex(v => v.question.trim() === questionShown.trim());
        if (idx === -1) return;
        const v = variants[idx];
        const newVD = v.difficulty == null || v.lastReviewed == null
          ? initialDifficulty(correct)
          : updateDifficulty(migrateDifficulty(v.difficulty), correct);
        const updated: QAVariant = {
          ...v,
          lastReviewed: new Date().toISOString(),
          difficulty: newVD,
        };

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
      if (![...canonicalNorms, ...existingNorms].includes(norm)) {
        const entry = gapTerm ? encodeGapAlt(gapTerm, userAnswer.trim()) : userAnswer.trim();
        variants[idx] = { ...v, acceptedAnswers: [...v.acceptedAnswers, entry] };
      }
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
