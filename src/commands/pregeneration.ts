import { TFile } from "obsidian";
import { TYPE_PRIORITY, type QAVariant, type ExerciseType } from "../types/exercises";
import { parseQABlock } from "../types/qa-block";
import { setRelayPriority, hasRelay } from "../api/client";
import { standardizeQuestion, reframeQuestion } from "../api/qc";
import {
  classifyEligibility,
  generateQA, generateVariant,
  generateCloze,
  generateMultipleChoice, encodeMC,
  generateSolveEquation, encodeSolveEquation,
  generateOrderSteps, encodeOrderSteps,
  generateList, encodeList,
  generateCorrectMistake,
  generateTrueFalse, generateTrueFalseInverse, encodeTFPair,
  generateAssembleEquation, encodeAssembleEquation,
} from "../generators";
import { getDueCards } from "../leitner";
import type IrisCardsPlugin from "../main";

interface PregenEntry {
  card: TFile;
  priority: number;
  resolve: (v: QAVariant[]) => void;
}

export class PregenManager {
  private pregenQueue: PregenEntry[] = [];
  private pregenQueued = new Set<string>();
  private pregenRunning = 0;
  private readonly PREGEN_CONCURRENCY = 3;

  constructor(private plugin: IrisCardsPlugin) {}

  enqueuePregen(card: TFile, priority: number): void {
    if (this.plugin.qaCache.has(card.path)) return;
    if (this.pregenQueued.has(card.path)) {
      const existing = this.pregenQueue.findIndex(e => e.card.path === card.path);
      if (existing === -1 || this.pregenQueue[existing].priority >= priority) return;
      const [entry] = this.pregenQueue.splice(existing, 1);
      entry.priority = priority;
      const idx = this.pregenQueue.findIndex(e => e.priority < priority);
      if (idx === -1) this.pregenQueue.push(entry);
      else this.pregenQueue.splice(idx, 0, entry);
      return;
    }
    let resolve!: (v: QAVariant[]) => void;
    const promise = new Promise<QAVariant[]>((res) => { resolve = res; });
    this.plugin.qaCache.set(card.path, promise);
    this.pregenQueued.add(card.path);
    const entry: PregenEntry = { card, priority, resolve };
    const idx = this.pregenQueue.findIndex(e => e.priority < priority);
    if (idx === -1) {
      this.pregenQueue.push(entry);
    } else {
      this.pregenQueue.splice(idx, 0, entry);
    }
  }

  async pregenerateAll(): Promise<void> {
    const apiKey = this.plugin.settings.anthropicApiKey;
    if (!apiKey && !hasRelay()) return;
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
      const entry = this.pregenQueue.shift()!;
      const { card, priority: localPriority, resolve } = entry;
      this.pregenQueued.delete(card.path);
      this.pregenRunning++;
      void (async () => {
        let existingVariants: QAVariant[] = [];
        try {
          setRelayPriority(PregenManager.toRelayPriority(localPriority));
          const content = await this.plugin.app.vault.read(card);
          const parsed = parseQABlock(content);
          existingVariants = [...parsed.variants];

          let eligible = parsed.eligibleTypes;
          let variants = [...existingVariants];

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
          const candidates = prioritized.filter(t => !coveredTypes.has(t));
          const nextType = !hasUnreviewed && candidates.length > 0
            ? candidates[Math.floor(Math.random() * candidates.length)]
            : undefined;

          let generatedVariants: QAVariant[] = [];
          if (nextType) {
            try {
              generatedVariants = await this.generateForType(nextType, parsed.body, apiKey);
              variants.push(...generatedVariants);
            } catch { /* single type failure is non-fatal */ }
          }

          if (nextType || parsed.eligibleTypes.length === 0) {
            variants = await this.plugin.cardStore.updateVariants(card, (vs, el) => {
              vs.push(...generatedVariants);
              el.length = 0;
              el.push(...eligible);
            });
          }
          await this.plugin.cardStore.updateSuspendedFlag(card, variants);
          resolve(variants);
        } catch (e) {
          this.plugin.qaCache.delete(card.path);
          // Fall back to existing variants on the card if generation failed.
          // If none exist, resolve empty so the reviewer skips this card.
          resolve(existingVariants);
        } finally {
          setRelayPriority(undefined);
          this.pregenRunning--;
          this.drainPregenQueue(apiKey);
        }
      })();
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
      question: q.trim(),
      answer: a.trim(),
      acceptedAnswers: [],
      knownIncorrect: [],
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
      "Place in Order": async () => { const e = encodeOrderSteps(await generateOrderSteps(body, apiKey, model)); return [make(e.question, e.answer)]; },
      "List": async () => { const e = encodeList(await generateList(body, apiKey, model)); return [make(e.question, e.answer)]; },
      "Correct the Mistake": async () => { const r = await generateCorrectMistake(body, apiKey, model); return [make(r.incorrect, r.corrected)]; },
      "True/False": async () => {
        const r = await generateTrueFalse(body, apiKey, model);
        try {
          const inv = await generateTrueFalseInverse(r.statement, r.answer, apiKey, model);
          const t = r.answer === "True" ? r.statement : inv.statement;
          const f = r.answer === "False" ? r.statement : inv.statement;
          const e = encodeTFPair(t, f);
          return [make(e.question, e.answer)];
        } catch { return [make(r.statement, r.answer)]; }
      },
      "Assemble Equation": async () => { const e = encodeAssembleEquation(await generateAssembleEquation(body, apiKey, model)); return [make(e.question, e.answer)]; },
    };

    const gen = generators[type];
    if (!gen) return [];
    let variants = await gen();

    const QC_TYPES: Set<string> = new Set(["Q&A"]);
    if (QC_TYPES.has(type)) {
      const reframePromises: Promise<void>[] = [];
      const reject = (i: number, reason: string) => {
        console.debug(`[Iris QC] rejected: ${reason}`);
        const original = variants[i];
        variants[i] = { ...original, suspended: true };
        reframePromises.push((async () => {
          try {
            const rf = await reframeQuestion(body, original.question, original.answer, reason, apiKey);
            if (!rf.abandon && rf.question && rf.answer) {
              variants[i] = {
                ...original,
                question: rf.question.trim(),
                answer: rf.answer.trim(),
                suspended: false,
              };
            }
          } catch (err) {
            console.debug("[Iris QC] reframe failed", err);
          }
        })());
      };

      // Deterministic pre-screen: any answer longer than this is treated as
      // rejected for length and routed to the reframer directly, skipping the
      // standardize call. The standardizer's "distill the paragraph" rule is
      // unreliable past a certain length — at that point the Q&A is almost
      // always multi-fact and needs a fresh angle, not editing.
      const MAX_QA_ANSWER_CHARS = 50;
      const qcIndices: number[] = [];
      for (let i = 0; i < variants.length; i++) {
        if (variants[i].answer.length > MAX_QA_ANSWER_CHARS) {
          reject(i, `Answer too long for a basic Q&A (${variants[i].answer.length} chars).`);
        } else {
          qcIndices.push(i);
        }
      }

      if (qcIndices.length > 0) {
        const stdResults = await Promise.allSettled(
          qcIndices.map(i => standardizeQuestion(body, variants[i].question, variants[i].answer, apiKey)),
        );
        for (let k = 0; k < qcIndices.length; k++) {
          const i = qcIndices[k];
          const r = stdResults[k];
          if (r.status === "fulfilled" && r.value.question && r.value.answer) {
            if (r.value.reject) {
              reject(i, r.value.reject_reason ?? "(no reason given)");
            } else {
              variants[i] = { ...variants[i], question: r.value.question.trim(), answer: r.value.answer.trim() };
            }
          }
        }
      }

      if (reframePromises.length > 0) await Promise.all(reframePromises);
    }
    return variants;
  }
}
