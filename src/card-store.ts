import { App, TFile, TFolder, normalizePath } from "obsidian";
import { parseQABlock, stripQABlock, buildQABlock, type QAVariant, type ExerciseType } from "./claude";
import { getStability, getDifficulty, updateStability, updateDifficulty, getDueCards, S_INITIAL, buildLogEntry, appendReviewLog } from "./leitner";

function normalizeAnswer(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

export class CardStore {
  constructor(private app: App) {}

  /** Read, mutate, and write back a card's QA variants in one step. */
  async updateVariants(
    file: TFile,
    updater: (variants: QAVariant[], eligible: ExerciseType[]) => void,
  ): Promise<QAVariant[]> {
    const content = await this.app.vault.read(file);
    const parsed = parseQABlock(content);
    updater(parsed.variants, parsed.eligibleTypes);
    const stripped = stripQABlock(content);
    await this.app.vault.modify(file, stripped.trimEnd() + buildQABlock(parsed.variants, parsed.eligibleTypes));
    return parsed.variants;
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
    source?: { file: TFile; module?: string; date?: string },
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
  ): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      const S = getStability(fm);
      const D = getDifficulty(fm);
      fm["stability"] = updateStability(S, correct, D, elapsedMs);
      fm["difficulty"] = updateDifficulty(D, correct);
      delete fm["box"];
      fm["last-reviewed"] = new Date().toISOString();
      fm["repetitions"] = (fm["repetitions"] ?? 0) + 1;
      appendReviewLog(fm, buildLogEntry(correct, elapsedMs));
    });

    if (questionShown) {
      await this.updateVariants(file, (variants) => {
        const idx = variants.findIndex(v => v.question === questionShown);
        if (idx === -1) return;
        const v = variants[idx];
        const updated: QAVariant = { ...v, lastReviewed: new Date().toISOString() };

        if (correct && userAnswer) {
          const norm = normalizeAnswer(userAnswer);
          const all = [v.answer, ...v.acceptedAnswers];
          if (!all.some(a => normalizeAnswer(a) === norm)) {
            updated.acceptedAnswers = [...v.acceptedAnswers, userAnswer.trim()];
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
  async addAcceptedAnswer(file: TFile, questionShown: string, userAnswer: string): Promise<void> {
    await this.updateVariants(file, (variants) => {
      const idx = variants.findIndex(v => v.question === questionShown);
      if (idx === -1) return;
      const v = variants[idx];
      const norm = normalizeAnswer(userAnswer);
      const all = [v.answer, ...v.acceptedAnswers];
      if (!all.some(a => normalizeAnswer(a) === norm)) {
        variants[idx] = { ...v, acceptedAnswers: [...v.acceptedAnswers, userAnswer.trim()] };
      }
    });
  }

  /** Suspend a specific variant by question text. Returns remaining active variants. */
  async suspendVariant(file: TFile, questionText: string): Promise<QAVariant[]> {
    const variants = await this.updateVariants(file, (variants) => {
      const idx = variants.findIndex(v => v.question === questionText);
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
