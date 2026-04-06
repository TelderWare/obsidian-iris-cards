import { TFile } from "obsidian";
import { TYPE_PRIORITY, type QAVariant, type ExerciseType } from "../types/exercises";
import { parseQABlock } from "../types/qa-block";
import { setRelayPriority } from "../api/client";
import { standardizeQuestion } from "../api/qc";
import {
  classifyEligibility,
  generateQA, generateVariant,
  generateCloze,
  generateMultipleChoice, encodeMC,
  generateSolveEquation, encodeSolveEquation,
  generateOrderSteps, encodeOrderSteps,
  generateCorrectMistake,
  generateExplainWhy,
  generateTrueFalse,
  generateAssembleEquation, encodeAssembleEquation,
} from "../generators";
import { getDueCards } from "../leitner";
import type IrisCardsPlugin from "../main";

export class PregenManager {
  private pregenQueue: { card: TFile; priority: number }[] = [];
  private pregenQueued = new Set<string>();
  private pregenRunning = 0;
  private readonly PREGEN_CONCURRENCY = 3;

  constructor(private plugin: IrisCardsPlugin) {}

  enqueuePregen(card: TFile, priority: number): void {
    if (this.plugin.qaCache.has(card.path)) return;
    if (this.pregenQueued.has(card.path)) {
      const existing = this.pregenQueue.findIndex(e => e.card.path === card.path);
      if (existing === -1 || this.pregenQueue[existing].priority >= priority) return;
      this.pregenQueue.splice(existing, 1);
    }
    this.pregenQueued.add(card.path);
    const idx = this.pregenQueue.findIndex(e => e.priority < priority);
    if (idx === -1) {
      this.pregenQueue.push({ card, priority });
    } else {
      this.pregenQueue.splice(idx, 0, { card, priority });
    }
  }

  async pregenerateAll(): Promise<void> {
    const apiKey = this.plugin.settings.anthropicApiKey;
    if (!apiKey) return;
    const cards = await getDueCards(this.plugin.app, this.plugin.settings.cardsFolder, 0, undefined, this.plugin.settings.desiredRetention);
    for (const card of cards) {
      this.enqueuePregen(card, 0);
    }
    this.drainPregenQueue(apiKey);
  }

  pregenerateQA(card: TFile, apiKey: string, priority = 1): void {
    this.enqueuePregen(card, priority);
    this.drainPregenQueue(apiKey);
  }

  /** Map local pregeneration priority (0=background, 1=normal, 2=user-triggered)
   *  to relay priority (0-10 scale, lower = processed first). */
  private static toRelayPriority(localPriority: number): number {
    if (localPriority >= 2) return 1;
    if (localPriority <= 0) return 8;
    return 5;
  }

  private drainPregenQueue(apiKey: string): void {
    while (this.pregenRunning < this.PREGEN_CONCURRENCY && this.pregenQueue.length > 0) {
      const { card, priority: localPriority } = this.pregenQueue.shift()!;
      this.pregenQueued.delete(card.path);
      if (this.plugin.qaCache.has(card.path)) continue;
      this.pregenRunning++;
      const promise = (async () => {
        try {
          setRelayPriority(PregenManager.toRelayPriority(localPriority));
          const content = await this.plugin.app.vault.read(card);
          const parsed = parseQABlock(content);

          let eligible = parsed.eligibleTypes;
          let variants = [...parsed.variants];

          if (eligible.length === 0) {
            eligible = await classifyEligibility(parsed.body, apiKey, this.plugin.settings.claudeModel);
          }

          // Generate the next exercise type only when every active variant has
          // already been reviewed — i.e. there is no fresh variant waiting.
          // This keeps exactly one unviewed variant ready without over-generating.
          const active = variants.filter(v => !v.suspended);
          const hasUnreviewed = active.some(v => v.lastReviewed === null);

          const coveredTypes = new Set(variants.map(v => v.exerciseType));
          const prioritized = TYPE_PRIORITY.filter(t => eligible.includes(t));
          const nextType = !hasUnreviewed
            ? prioritized.find(t => !coveredTypes.has(t))
            : undefined;

          if (nextType) {
            try {
              const newVariants = await this.generateForType(nextType, parsed.body, apiKey);
              variants.push(...newVariants);
            } catch { /* single type failure is non-fatal */ }
          }

          if (nextType || parsed.eligibleTypes.length === 0) {
            await this.plugin.cardStore.updateVariants(card, (vs, el) => {
              vs.length = 0;
              vs.push(...variants);
              el.length = 0;
              el.push(...eligible);
            });
          }
          await this.plugin.cardStore.updateSuspendedFlag(card, variants);
          return variants;
        } finally {
          setRelayPriority(undefined);
          this.pregenRunning--;
          this.drainPregenQueue(apiKey);
        }
      })();
      this.plugin.qaCache.set(card.path, promise);
    }
  }

  private async generateForType(
    type: ExerciseType,
    body: string,
    apiKey: string,
  ): Promise<QAVariant[]> {
    const model = this.plugin.settings.claudeModel;
    const make = (q: string, a: string): QAVariant => ({
      exerciseType: type,
      question: q,
      answer: a,
      acceptedAnswers: [],
      lastReviewed: null,
      suspended: false,
      recordMs: null,
      difficulty: null,
    });

    const generators: Record<string, () => Promise<QAVariant[]>> = {
      "Q&A": async () => {
        const qa = await generateQA(body, apiKey, model);
        const variants = [make(qa.question, qa.answer)];
        try {
          const alt = await generateVariant(qa.question, qa.answer, apiKey, model);
          variants.push(make(alt.question, alt.answer));
        } catch { /* alternate is optional */ }
        return variants;
      },
      "Multiple Choice": async () => { const e = encodeMC(await generateMultipleChoice(body, apiKey, model)); return [make(e.question, e.answer)]; },
      "Cloze": async () => { const s = await generateCloze(body, apiKey, model); return [make(s, s)]; },
      "Solve Equation": async () => { const e = encodeSolveEquation(await generateSolveEquation(body, apiKey, model)); return [make(e.question, e.answer)]; },
      "Order Steps": async () => { const e = encodeOrderSteps(await generateOrderSteps(body, apiKey, model)); return [make(e.question, e.answer)]; },
      "Correct the Mistake": async () => { const r = await generateCorrectMistake(body, apiKey, model); return [make(r.incorrect, r.corrected)]; },
      "Explain Why": async () => { const r = await generateExplainWhy(body, apiKey, model); return [make(r.question, r.answer)]; },
      "True/False": async () => { const r = await generateTrueFalse(body, apiKey, model); return [make(r.statement, r.answer)]; },
      "Assemble Equation": async () => { const e = encodeAssembleEquation(await generateAssembleEquation(body, apiKey, model)); return [make(e.question, e.answer)]; },
    };

    const gen = generators[type];
    if (!gen) return [];
    let variants = await gen();

    const QC_TYPES: Set<string> = new Set(["Q&A", "Explain Why"]);
    if (QC_TYPES.has(type)) {
      const stdResults = await Promise.allSettled(
        variants.map(v => standardizeQuestion(body, v.question, v.answer, apiKey)),
      );
      for (let i = 0; i < variants.length; i++) {
        const r = stdResults[i];
        if (r.status === "fulfilled" && r.value.question && r.value.answer) {
          if (r.value.reject) {
            variants[i] = { ...variants[i], suspended: true };
          } else {
            variants[i] = { ...variants[i], question: r.value.question, answer: r.value.answer };
          }
        }
      }
    }
    return variants;
  }
}
