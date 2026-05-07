import { type App, type Component, Component as ComponentImpl, Modal, TFile, MarkdownRenderer, setIcon } from "obsidian";
import type IrisCardsPlugin from "../main";
import { type ParsedQA, type QAVariant } from "../types/exercises";
import { parseQABlock } from "../types/qa-block";
import { decodeGapAlt } from "../types/gap-alternates";
import { markAnswer, appealAnswer } from "../generators/qa";
import { hasRelay } from "../api/client";
import { parseClozeTerms, occludeCloze } from "../generators/cloze";
import { decodeMC } from "../generators/multiple-choice";
import { decodeTFPair } from "../generators/true-false";
import { decodeSolveEquation, randomizeKnowns, evaluateFormula, roundToSigFigs, checkNumericalAnswer } from "../generators/solve-equation";
import { decodeOrderSteps, shuffleArray } from "../generators/order-steps";
import { decodeList, markList } from "../generators/list";
import { decodeImageOcclusion } from "../types/image-occlusion";
import { updateStability, getStability, getDifficulty, updateDifficulty, migrateDifficulty } from "../leitner";
import { type ReviewView, normalizeAnswer } from "./review-view";

/**
 * Minimal surface the per-type renderers need. `ReviewView` satisfies this
 * structurally; the homepage widget implements it via a lightweight Component
 * subclass so it can reuse the same renderers (MarkdownRenderer, MC/TF buttons,
 * drag-to-order list, typed input + LLM marking, …) without dragging in the
 * full view's layout/queue state.
 */
export type RenderContext = Component & {
  readonly app: App;
  readonly plugin: IrisCardsPlugin;
  peekedAnswer: boolean;
  getRenderState(cardFile: TFile, variant: QAVariant): Record<string, unknown>;
  playFeedback(correct: boolean, record?: boolean): void;
};

class PeekModal extends Modal {
  private file: TFile;
  private component = new ComponentImpl();

  constructor(app: App, file: TFile) {
    super(app);
    this.file = file;
  }

  async onOpen(): Promise<void> {
    this.component.load();
    this.modalEl.addClass("iris-peek-modal-wrap");
    const { contentEl } = this;
    contentEl.addClass("iris-peek-modal");
    const body = contentEl.createDiv({ cls: "iris-peek-content" });
    const content = await this.app.vault.cachedRead(this.file);
    await MarkdownRenderer.render(this.app, content, body, this.file.path, this.component);
  }

  onClose(): void {
    this.component.unload();
    this.contentEl.empty();
  }
}

/**
 * Parse-block cache shared between the full review view's upcoming-card
 * previews and the homepage widget's advance prefetch. Keyed on `(path, mtime)`
 * so modifying the file transparently invalidates its entry on next access.
 * LRU-ish — oldest entry evicted when we cross PARSED_CACHE_MAX.
 */
const PARSED_CACHE_MAX = 200;
const parsedCache = new Map<string, { mtime: number; parsed: ParsedQA }>();

export async function getParsedCached(app: App, file: TFile): Promise<ParsedQA> {
  const mtime = file.stat.mtime;
  const hit = parsedCache.get(file.path);
  if (hit && hit.mtime === mtime) {
    // Bump to most-recent by re-inserting (Map preserves insertion order).
    parsedCache.delete(file.path);
    parsedCache.set(file.path, hit);
    return hit.parsed;
  }
  const content = await app.vault.cachedRead(file);
  const parsed = parseQABlock(content);
  parsedCache.set(file.path, { mtime, parsed });
  if (parsedCache.size > PARSED_CACHE_MAX) {
    const oldest = parsedCache.keys().next().value;
    if (oldest !== undefined) parsedCache.delete(oldest);
  }
  return parsed;
}

/** Drop a cache entry (called by callers after they mutate the file). */
export function invalidateParsedCache(path: string): void {
  parsedCache.delete(path);
}

// ─── Answer Handler ─────────────────────────────────────────────────────

/** Callback renderers invoke when the user answers. Encapsulates timer, feedback, and rating. */
type AnswerFn = (correct: boolean, userAnswer?: string, gapTerm?: string) => Promise<void>;

/**
 * Create the answer handler for a card. Captures the timer, feedback, and rating
 * so individual renderers only need to call answer(correct).
 */
export function createAnswerHandler(
  view: ReviewView,
  card: HTMLElement,
  cardFile: TFile,
  variant: QAVariant,
): AnswerFn {
  const t0 = performance.now();
  return async (correct: boolean, userAnswer?: string, gapTerm?: string) => {
    const elapsedMs = Math.round(performance.now() - t0);
    const record = correct && variant.recordMs != null && elapsedMs < variant.recordMs;
    view.playFeedback(correct, record);

    await view.rateCard(cardFile, correct, userAnswer, variant.question, elapsedMs, gapTerm);
  };
}

// ─── Shared Rendering Primitives ────────────────────────────────────────

/** Manual reveal mode: question -> eye button -> answer -> right/wrong buttons. */
async function renderManualReveal(
  view: RenderContext, card: HTMLElement, answer: AnswerFn,
  questionMd: string, answerMd: string,
): Promise<void> {
  const questionSection = card.createDiv({ cls: "iris-question" });
  await MarkdownRenderer.render(view.app, questionMd, questionSection.createDiv(), "", view);

  const showBtn = card.createEl("button", {
    cls: "iris-show-btn",
    attr: { "aria-label": "Show answer" },
  });
  setIcon(showBtn, "eye");

  const answerSection = card.createDiv({ cls: "iris-answer iris-hidden" });
  await MarkdownRenderer.render(view.app, answerMd, answerSection.createDiv(), "", view);

  const actions = card.createDiv({ cls: "iris-actions iris-hidden" });

  const wrongBtn = actions.createEl("button", { cls: "iris-wrong-btn", attr: { "aria-label": "Wrong" } });
  setIcon(wrongBtn, "x");
  wrongBtn.addEventListener("click", () => { answer(false); });

  const rightBtn = actions.createEl("button", { cls: "iris-right-btn", attr: { "aria-label": "Right" } });
  setIcon(rightBtn, "check");
  rightBtn.addEventListener("click", () => { answer(true); });

  showBtn.addEventListener("click", () => {
    answerSection.removeClass("iris-hidden");
    showBtn.addClass("iris-hidden");
    actions.removeClass("iris-hidden");
  });
}

// ─── Dispatch & Orchestration ───────────────────────────────────────────

/** Dispatch to the correct type-specific renderer for a card element. */
export async function renderVariantInto(
  view: RenderContext, card: HTMLElement, cardFile: TFile, variant: QAVariant, answer: AnswerFn,
): Promise<void> {
  const rendererMap: Record<string, () => Promise<void>> = {
    "Multiple Choice": async () => {
      const mc = decodeMC(variant.question, variant.answer);
      await renderChoiceCard(view, card, variant, answer, {
        questionMd: mc.question,
        options: mc.options.map(o => ({ label: o.text, value: o.letter })),
        correct: mc.correct,
      });
    },
    "True/False": async () => {
      const pair = decodeTFPair(variant.question, variant.answer);
      let statement: string;
      let correct: string;
      if (pair) {
        const rs = view.getRenderState(cardFile, variant);
        const showTrue = (rs.tfShowTrue as boolean) ?? (rs.tfShowTrue = Math.random() < 0.5);
        statement = showTrue ? pair.trueStatement : pair.falseStatement;
        correct = showTrue ? "True" : "False";
      } else {
        statement = variant.question;
        correct = variant.answer;
      }
      await renderChoiceCard(view, card, variant, answer, {
        questionMd: `**True or false?**\n\n${statement}`,
        options: [
          { label: "True", value: "True", cls: "iris-tf-true" },
          { label: "False", value: "False", cls: "iris-tf-false" },
        ],
        correct,
        optionsCls: "iris-tf-options",
      });
    },
    "Cloze": () => renderOcclude(view, card, cardFile, variant, answer, {
      source: variant.question,
    }),
    "Solve Equation": () => renderSolveEquation(view, card, cardFile, variant, answer),
    "Place in Order": () => renderOrderSteps(view, card, cardFile, variant, answer),
    "List": () => renderList(view, card, cardFile, variant, answer),
    "Correct the Mistake": async () => {
      if (view.plugin.settings.autoMark) {
        await renderInputCard(view, card, cardFile, variant, answer, {
          questionMd: `**Find and correct the mistake:**\n\n${variant.question}`,
          canonicalAnswer: variant.answer,
          autoSubmitOnMatch: true,
          llmMarker: {
            question: `The following statement contains a mistake: "${variant.question}"\nWhat is the corrected version?`,
            answer: variant.answer,
            acceptedAnswers: variant.acceptedAnswers,
          },
          knownIncorrect: variant.knownIncorrect,
        });
        return;
      }
      await renderManualReveal(view, card, answer, `**Find and correct the mistake:**\n\n${variant.question}`, variant.answer);
    },
    "Assemble Equation": () => renderOcclude(view, card, cardFile, variant, answer, {
      source: variant.answer,
      title: variant.question,
      minTerms: 2,
      errorText: "Malformed equation.",
    }),
    "Image Occlusion": () => renderImageOcclusion(view, card, cardFile, variant, answer),
  };
  await (rendererMap[variant.exerciseType] ?? (() => renderQA(view, card, cardFile, variant, answer)))();
}

export async function renderCurrentCard(
  view: ReviewView, body: HTMLDivElement, cardFile: TFile, variant: QAVariant,
): Promise<void> {
  body.querySelectorAll(".iris-card-preview").forEach((el) => el.remove());
  const card = body.createDiv({ cls: "iris-card" });
  view.currentCardEl = card;

  const answer = createAnswerHandler(view, card, cardFile, variant);
  await renderVariantInto(view, card, cardFile, variant, answer);

  // Suspend button — permanently disables this question variant
  const suspendBtn = card.createEl("button", {
    cls: "iris-card-icon iris-suspend-btn",
    attr: { "aria-label": "Suspend question" },
  });
  setIcon(suspendBtn, "eye-off");
  suspendBtn.addEventListener("click", async () => {
    const remaining = await view.plugin.cardStore.suspendVariant(cardFile, variant.question);
    view.plugin.qaCache.delete(cardFile.path);
    if (remaining.length === 0) view.dueCards.shift();
    await view.showNextCard();
  });

  // Parent note button — peeks at the source note in a modal
  const parentNote = view.app.metadataCache.getFileCache(cardFile)?.frontmatter?.["parent-note"];
  if (parentNote) {
    const linkMatch = typeof parentNote === "string" && parentNote.match(/^\[\[(.+?)(\|.+?)?\]\]$/);
    if (linkMatch) {
      const resolved = view.app.metadataCache.getFirstLinkpathDest(linkMatch[1], cardFile.path);
      if (resolved) {
        const parentBtn = card.createEl("button", {
          cls: "iris-card-icon iris-parent-btn",
          attr: { "aria-label": "Peek at parent note" },
        });
        setIcon(parentBtn, "help-circle");
        parentBtn.addEventListener("click", () => {
          view.peekedAnswer = true;
          new PeekModal(view.app, resolved).open();
        });
      }
    }
  }

  // Card file button — opens the card .md file in an editable tab
  const cardFileBtn = card.createEl("button", {
    cls: "iris-card-icon iris-card-file-btn",
    attr: { "aria-label": "Open card file" },
  });
  setIcon(cardFileBtn, "file-text");
  cardFileBtn.addEventListener("click", () => {
    view.peekedAnswer = true;
    view.app.workspace.getLeaf("tab").openFile(cardFile);
  });

  // Skip button — moves card to end without affecting box
  const skipBtn = card.createEl("button", {
    cls: "iris-card-icon iris-skip-card-btn",
    attr: { "aria-label": "Skip card" },
  });
  setIcon(skipBtn, "arrow-right");
  skipBtn.addEventListener("click", async () => {
    const skipped = view.dueCards.shift();
    if (skipped) view.dueCards.push(skipped);
    await view.showNextCard();
  });

  view.scrollToCenter(card);

  renderUpcomingPreviews(view, body);
}

// ─── Shared Input Card Helper ───────────────────────────────────────────

/**
 * Renders a card with: question -> text input -> marking.
 * On submit, the input is replaced in-place with the canonical answer so the
 * card never grows vertically. Grading modes:
 *   - checkAnswer: local check (Cloze, Solve Equation, Assemble Equation)
 *   - llmMarker: exact-match shortcut then LLM fallback (Q&A, Correct the Mistake)
 *   - Both: local check for auto-submit + LLM fallback for grading
 */
async function renderInputCard(
  view: RenderContext,
  card: HTMLElement, cardFile: TFile, variant: QAVariant,
  answer: AnswerFn,
  opts: {
    questionMd?: string;
    questionEl?: HTMLElement;
    canonicalAnswer: string;
    checkAnswer?: (input: string) => boolean;
    autoSubmitOnMatch?: boolean;
    inputMode?: string;
    llmMarker?: { question: string; answer: string; acceptedAnswers?: string[] };
    knownIncorrect?: string[];
    gapTerm?: string;
  },
): Promise<void> {
  if (opts.questionEl) {
    card.appendChild(opts.questionEl);
  } else {
    const questionSection = card.createDiv({ cls: "iris-question" });
    await MarkdownRenderer.render(view.app, opts.questionMd!, questionSection.createDiv(), "", view);
  }

  const inputSection = card.createDiv({ cls: "iris-user-answer" });
  const attrs: Record<string, string> = {};
  if (opts.inputMode) attrs.inputmode = opts.inputMode;
  const input = inputSection.createEl("input", { type: "text", cls: "iris-answer-input", attr: attrs });

  const markingEl = card.createDiv({ cls: "iris-marking" });

  input.focus();

  let answered = false;

  const showResult = (correct: boolean) => {
    markingEl.removeClass("iris-loading");
    markingEl.setText(correct ? (view.peekedAnswer ? "Correct (peeked)" : "Correct") : "Incorrect");
    markingEl.toggleClass("iris-marking-correct", correct);
    markingEl.toggleClass("iris-marking-incorrect", !correct);
    input.value = opts.canonicalAnswer;
    input.disabled = true;
  };

  // Build exact-match checker from LLM marker for shortcut grading
  const isExactMatch = opts.llmMarker
    ? (val: string) => {
        const norm = normalizeAnswer(val);
        const all = [opts.llmMarker!.answer, ...(opts.llmMarker!.acceptedAnswers ?? [])];
        return all.some(a => normalizeAnswer(a) === norm);
      }
    : null;

  const isKnownIncorrect = opts.knownIncorrect?.length
    ? (val: string) => {
        const norm = normalizeAnswer(val);
        return opts.knownIncorrect!.some(a => normalizeAnswer(a) === norm);
      }
    : null;

  const submitAnswer = async () => {
    if (answered) return;
    answered = true;
    // Lock card height so async markdown finishers (MathJax, images, embeds)
    // can't grow the question section during the marking await window.
    card.style.height = `${card.offsetHeight}px`;
    const userAnswer = input.value.trim();

    if (!userAnswer) {
      showResult(false);
      await answer(false, undefined, opts.gapTerm);
      return;
    }

    if (isKnownIncorrect?.(userAnswer)) {
      showResult(false);
      await answer(false, userAnswer, opts.gapTerm);
      return;
    }

    // Local check (custom checker or exact-match shortcut)
    const localCheck = opts.checkAnswer ?? isExactMatch;
    if (localCheck?.(userAnswer)) {
      showResult(true);
      await answer(true, userAnswer, opts.gapTerm);
      return;
    }

    // No LLM marker — local check is final
    if (!opts.llmMarker) {
      showResult(false);
      addAppealButton(view, card, cardFile, variant, userAnswer, markingEl, opts.questionMd, opts.gapTerm);
      await answer(false, userAnswer, opts.gapTerm);
      return;
    }

    // LLM fallback marking — reuse markingEl so the card doesn't grow mid-mark
    input.disabled = true;
    markingEl.setText("Marking\u2026");
    markingEl.addClass("iris-loading");
    try {
      const apiKey = view.plugin.settings.anthropicApiKey;
      const correct = await markAnswer(
        opts.llmMarker.question, opts.llmMarker.answer, userAnswer,
        apiKey, view.plugin.settings.claudeModel,
      );
      showResult(correct);
      if (!correct) addAppealButton(view, card, cardFile, variant, userAnswer, markingEl, undefined, opts.gapTerm);
      await answer(correct, userAnswer, opts.gapTerm);
    } catch (e) {
      answered = false;
      input.disabled = false;
      markingEl.removeClass("iris-loading");
      markingEl.setText(`Marking failed: ${e instanceof Error ? e.message : String(e)}`);
      markingEl.addClass("iris-marking-incorrect");
    }
  };

  if (opts.autoSubmitOnMatch) {
    const checker = opts.checkAnswer ?? isExactMatch;
    if (checker) {
      input.addEventListener("input", () => {
        if (!answered && checker(input.value.trim())) submitAnswer();
      });
    }
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitAnswer(); }
  });
}

// ─── Appeal Helper ─────────────────────────────────────────────────────

function addAppealButton(
  view: RenderContext,
  card: HTMLElement,
  cardFile: TFile,
  variant: QAVariant,
  userAnswer: string,
  markingEl: HTMLElement,
  appealQuestion?: string,
  gapTerm?: string,
): void {
  if (!view.plugin.settings.autoMark) return;
  const apiKey = view.plugin.settings.anthropicApiKey;
  if (!apiKey && !hasRelay()) return;

  const preFm = view.app.metadataCache.getFileCache(cardFile)?.frontmatter;
  const preStability = getStability(preFm);
  const preDifficulty = getDifficulty(preFm);

  const appealBtn = card.createEl("button", {
    cls: "iris-card-icon iris-appeal-icon",
    attr: { "aria-label": "Appeal" },
  });
  setIcon(appealBtn, "scale");

  appealBtn.addEventListener("click", async () => {
    appealBtn.disabled = true;
    appealBtn.addClass("iris-loading");
    markingEl.setText("Remarking\u2026");
    markingEl.removeClass("iris-marking-incorrect");
    markingEl.removeClass("iris-marking-correct");
    markingEl.addClass("iris-loading");
    try {
      const overturned = await appealAnswer(
        appealQuestion ?? variant.question, userAnswer, apiKey,
      );
      markingEl.removeClass("iris-loading");
      if (overturned) {
        view.playFeedback(true);
        await view.app.fileManager.processFrontMatter(cardFile, (fm) => {
          fm["stability"] = updateStability(preStability, preDifficulty, true);
          fm["difficulty"] = updateDifficulty(preDifficulty, true);
          delete fm["box"];
        });
        await view.plugin.cardStore.addAcceptedAnswer(cardFile, variant.question, userAnswer);
        // Invalidate cached variants so the next render of this card sees the
        // newly-accepted answer; otherwise pregenerateQA's pre-appeal snapshot
        // sticks around and isExactMatch keeps missing, forcing re-appeal forever.
        view.plugin.qaCache.delete(cardFile.path);
        markingEl.setText(view.peekedAnswer ? "Correct (peeked)" : "Correct");
        markingEl.addClass("iris-marking-correct");
        appealBtn.remove();
        view.plugin.updateBadge();
      } else {
        view.playFeedback(false);
        markingEl.setText("Incorrect");
        markingEl.addClass("iris-marking-incorrect");
        appealBtn.remove();
      }
    } catch {
      markingEl.removeClass("iris-loading");
      markingEl.setText("Remarking failed");
      markingEl.addClass("iris-marking-incorrect");
      appealBtn.disabled = false;
      appealBtn.removeClass("iris-loading");
    }
  });
}

// ─── Type-Specific Renderers ────────────────────────────────────────────

// --- Q&A ---

async function renderQA(
  view: RenderContext,
  card: HTMLElement, cardFile: TFile, variant: QAVariant, answer: AnswerFn,
): Promise<void> {
  if (view.plugin.settings.autoMark) {
    await renderInputCard(view, card, cardFile, variant, answer, {
      questionMd: variant.question,
      canonicalAnswer: variant.answer,
      autoSubmitOnMatch: true,
      llmMarker: {
        question: variant.question,
        answer: variant.answer,
        acceptedAnswers: variant.acceptedAnswers,
      },
      knownIncorrect: variant.knownIncorrect,
    });
    return;
  }

  await renderManualReveal(view, card, answer, variant.question, variant.answer);
}

// --- Choice (Multiple Choice + True/False) ---

async function renderChoiceCard(
  view: RenderContext,
  card: HTMLElement, variant: QAVariant, answer: AnswerFn,
  opts: { questionMd: string; options: { label: string; value: string; cls?: string }[]; correct: string; optionsCls?: string },
): Promise<void> {
  const questionSection = card.createDiv({ cls: "iris-question" });
  await MarkdownRenderer.render(view.app, opts.questionMd, questionSection.createDiv(), "", view);

  const optionsSection = card.createDiv({ cls: `iris-mc-options${opts.optionsCls ? " " + opts.optionsCls : ""}` });
  let answered = false;

  for (const opt of opts.options) {
    const btn = optionsSection.createEl("button", {
      cls: `iris-mc-option${opt.cls ? " " + opt.cls : ""}`,
      text: opt.label,
      attr: { "data-value": opt.value },
    });

    btn.addEventListener("click", async () => {
      if (answered) return;
      answered = true;

      const correct = opt.value === opts.correct;

      for (const child of Array.from(optionsSection.querySelectorAll<HTMLButtonElement>(".iris-mc-option"))) {
        child.disabled = true;
        if (child.dataset.value === opts.correct) {
          child.addClass("iris-mc-correct");
        } else if (child === btn && !correct) {
          child.addClass("iris-mc-incorrect");
        }
      }

      await answer(correct);
    });
  }
}

// --- Occlude (Cloze + Assemble Equation) ---

interface OccludeOpts {
  source: string;
  title?: string;
  minTerms?: number;
  errorText?: string;
}

async function renderOcclude(
  view: RenderContext,
  card: HTMLElement, cardFile: TFile, variant: QAVariant,
  answer: AnswerFn, opts: OccludeOpts,
): Promise<void> {
  const terms = parseClozeTerms(opts.source);
  if (terms.length < (opts.minTerms ?? 1)) {
    card.createEl("p", { text: opts.errorText ?? "No cloze terms found in this card.", cls: "iris-error" });
    return;
  }

  const rs = view.getRenderState(cardFile, variant);
  const occludeIdx = (rs.clozeIdx as number) ?? (rs.clozeIdx = Math.floor(Math.random() * terms.length));
  const { display, answer: term } = occludeCloze(opts.source, occludeIdx);

  let ti = 0;
  const filled = opts.source.replace(/\*([^*]+)\*/g, (_, t) => ti++ === occludeIdx ? `**${t}**` : t);

  const fmtQ = opts.title ? `**${opts.title}**\n\n${display}` : display;

  if (view.plugin.settings.autoMark) {
    const apiKey = view.plugin.settings.anthropicApiKey;
    const useLlm = apiKey || hasRelay();
    await renderInputCard(view, card, cardFile, variant, answer, {
      questionMd: fmtQ,
      canonicalAnswer: term,
      autoSubmitOnMatch: true,
      llmMarker: useLlm ? {
        question: opts.title ? `${opts.title}\n${display}` : display,
        answer: term,
        acceptedAnswers: variant.acceptedAnswers,
      } : undefined,
      knownIncorrect: variant.knownIncorrect,
      checkAnswer: (val) => {
        const norm = normalizeAnswer(val);
        return [term, ...variant.acceptedAnswers].some(a => normalizeAnswer(a) === norm);
      },
    });
    return;
  }

  const fmtA = opts.title ? `**${opts.title}**\n\n${filled}` : filled;
  await renderManualReveal(view, card, answer, fmtQ, fmtA);
}

// --- Solve Equation ---

async function renderSolveEquation(
  view: RenderContext,
  card: HTMLElement, cardFile: TFile, variant: QAVariant, answer: AnswerFn,
): Promise<void> {
  let se;
  try {
    se = decodeSolveEquation(variant.question, variant.answer);
  } catch {
    card.createEl("p", { text: "Malformed equation problem.", cls: "iris-error" });
    return;
  }

  const rs = view.getRenderState(cardFile, variant);
  const values = (rs.knownValues as Record<string, number>) ?? (rs.knownValues = randomizeKnowns(se.knowns));
  let expected: number;
  try {
    expected = evaluateFormula(se.formula, values);
    if (!isFinite(expected)) throw new Error("Non-finite result");
  } catch {
    card.createEl("p", { text: "Could not compute expected answer.", cls: "iris-error" });
    return;
  }
  expected = roundToSigFigs(expected, se.target.sigfigs);

  const questionEl = createDiv({ cls: "iris-question iris-solve-question" });

  const problemEl = questionEl.createDiv({ cls: "iris-solve-problem" });
  await MarkdownRenderer.render(view.app, se.problem, problemEl, "", view);

  const knownsEl = questionEl.createDiv({ cls: "iris-solve-knowns" });
  for (const k of se.knowns) {
    const row = knownsEl.createDiv({ cls: "iris-solve-known" });
    await MarkdownRenderer.render(
      view.app,
      `**${k.name}** (*${k.symbol}*) = ${values[k.symbol]} ${k.units}`,
      row, "", view,
    );
  }

  const targetEl = questionEl.createDiv({ cls: "iris-solve-target" });
  await MarkdownRenderer.render(
    view.app,
    `**Solve for:** ${se.target.name} (*${se.target.symbol}*) in ${se.target.units}`,
    targetEl, "", view,
  );

  await renderInputCard(view, card, cardFile, variant, answer, {
    questionEl,
    canonicalAnswer: `${expected} ${se.target.units}`,
    checkAnswer: (val) => {
      const num = parseFloat(val);
      return !isNaN(num) && checkNumericalAnswer(num, expected, se.target.sigfigs);
    },
    inputMode: "decimal",
  });
}

// --- Order Steps ---

async function renderOrderSteps(
  view: RenderContext,
  card: HTMLElement, cardFile: TFile, variant: QAVariant, answer: AnswerFn,
): Promise<void> {
  let os;
  try {
    os = decodeOrderSteps(variant.question, variant.answer);
  } catch {
    card.createEl("p", { text: "Malformed order-steps problem.", cls: "iris-error" });
    return;
  }

  if (os.steps.length < 2) {
    card.createEl("p", { text: "Not enough steps to order.", cls: "iris-error" });
    return;
  }

  const questionSection = card.createDiv({ cls: "iris-question" });
  await MarkdownRenderer.render(view.app, `**Order the steps:** ${os.title}`, questionSection.createDiv(), "", view);

  const listEl = card.createDiv({ cls: "iris-order-list" });
  const rs = view.getRenderState(cardFile, variant);
  const order: { text: string; origIdx: number }[] =
    (Array.isArray(rs.shuffledOrder) ? rs.shuffledOrder : null) ??
    (rs.shuffledOrder = shuffleArray(os.steps.map((text, origIdx) => ({ text, origIdx }))));
  let answered = false;
  let dragIdx: number | null = null;

  const renderList = () => {
    listEl.empty();
    order.forEach((item, i) => {
      const row = listEl.createDiv({
        cls: "iris-order-row",
        attr: { draggable: "true" },
      });
      row.createSpan({ cls: "iris-order-handle" });
      setIcon(row.querySelector(".iris-order-handle")!, "grip-vertical");
      row.createSpan({ cls: "iris-order-text", text: item.text });

      row.addEventListener("dragstart", (e) => {
        dragIdx = i;
        row.addClass("iris-order-dragging");
        e.dataTransfer!.effectAllowed = "move";
      });

      row.addEventListener("dragend", () => {
        dragIdx = null;
        row.removeClass("iris-order-dragging");
        listEl.querySelectorAll(".iris-order-drop-above, .iris-order-drop-below")
          .forEach(el => { el.removeClass("iris-order-drop-above"); el.removeClass("iris-order-drop-below"); });
      });

      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (dragIdx === null || dragIdx === i) return;
        const rect = row.getBoundingClientRect();
        const above = e.clientY < rect.top + rect.height / 2;
        row.toggleClass("iris-order-drop-above", above);
        row.toggleClass("iris-order-drop-below", !above);
      });

      row.addEventListener("dragleave", () => {
        row.removeClass("iris-order-drop-above");
        row.removeClass("iris-order-drop-below");
      });

      row.addEventListener("drop", (e) => {
        e.preventDefault();
        if (dragIdx === null || dragIdx === i) return;
        const rect = row.getBoundingClientRect();
        const above = e.clientY < rect.top + rect.height / 2;
        const [dragged] = order.splice(dragIdx, 1);
        let target = above ? i : i + 1;
        if (dragIdx < i) target--;
        order.splice(target, 0, dragged);
        renderList();
      });
    });
  };

  renderList();

  const checkBtn = card.createEl("button", {
    cls: "iris-order-check",
    text: "Check",
  });

  checkBtn.addEventListener("click", async () => {
    if (answered) return;
    answered = true;
    checkBtn.remove();

    const correct = order.every((item, i) => item.text === os.steps[i]);

    const rows = Array.from(listEl.querySelectorAll(".iris-order-row"));
    rows.forEach((row, i) => {
      row.setAttribute("draggable", "false");
      row.addClass(order[i].text === os.steps[i] ? "iris-order-correct" : "iris-order-incorrect");
    });

    const answerSection = card.createDiv({ cls: "iris-answer" });
    const correctMd = os.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
    await MarkdownRenderer.render(view.app, correctMd, answerSection.createDiv(), "", view);

    const markingEl = card.createDiv({ cls: "iris-marking" });
    markingEl.setText(correct ? (view.peekedAnswer ? "Correct (peeked)" : "Correct") : "Incorrect");
    markingEl.addClass(correct ? "iris-marking-correct" : "iris-marking-incorrect");

    await answer(correct);
  });
}

// --- List (free-recall, unordered) ---

async function renderList(
  view: RenderContext,
  card: HTMLElement, cardFile: TFile, variant: QAVariant, answer: AnswerFn,
): Promise<void> {
  let l;
  try {
    l = decodeList(variant.question, variant.answer);
  } catch {
    card.createEl("p", { text: "Malformed list problem.", cls: "iris-error" });
    return;
  }
  if (l.items.length === 0) {
    card.createEl("p", { text: "No items in list.", cls: "iris-error" });
    return;
  }

  const questionSection = card.createDiv({ cls: "iris-question" });
  await MarkdownRenderer.render(view.app, l.prompt, questionSection.createDiv(), "", view);

  const inputsEl = card.createDiv({ cls: "iris-list-inputs" });
  const inputs: HTMLInputElement[] = [];
  for (let i = 0; i < l.items.length; i++) {
    const row = inputsEl.createDiv({ cls: "iris-list-row" });
    const input = row.createEl("input", {
      type: "text",
      cls: "iris-answer-input iris-list-input",
    });
    inputs.push(input);
  }
  inputs[0]?.focus();

  let answered = false;
  const checkBtn = card.createEl("button", { cls: "iris-list-check", text: "Check" });

  const submit = async () => {
    if (answered) return;
    answered = true;
    checkBtn.remove();
    card.style.height = `${card.offsetHeight}px`;

    const userItems = inputs.map(i => i.value.trim());
    const apiKey = view.plugin.settings.anthropicApiKey;
    const model = view.plugin.settings.claudeModel;

    const markingEl = card.createDiv({ cls: "iris-marking iris-loading" });
    markingEl.setText("Checking…");

    const results = await markList(l.prompt, l.items, userItems, apiKey, model);

    inputs.forEach((inp, i) => {
      inp.disabled = true;
      inp.toggleClass("iris-list-correct", results[i]);
      inp.toggleClass("iris-list-incorrect", !results[i]);
    });

    const allCorrect = results.every(Boolean);

    const answerSection = card.createDiv({ cls: "iris-answer" });
    const correctMd = l.items.map(s => `- ${s}`).join("\n");
    await MarkdownRenderer.render(view.app, correctMd, answerSection.createDiv(), "", view);

    markingEl.removeClass("iris-loading");
    markingEl.setText(allCorrect ? (view.peekedAnswer ? "Correct (peeked)" : "Correct") : "Incorrect");
    markingEl.toggleClass("iris-marking-correct", allCorrect);
    markingEl.toggleClass("iris-marking-incorrect", !allCorrect);

    await answer(allCorrect);
  };

  inputs.forEach(input => {
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        const idx = inputs.indexOf(input);
        if (idx < inputs.length - 1) inputs[idx + 1].focus();
        else void submit();
      }
    });
  });

  checkBtn.addEventListener("click", () => void submit());
}

// --- Image Occlusion ---

async function renderImageOcclusion(
  view: RenderContext,
  card: HTMLElement, cardFile: TFile, variant: QAVariant, answer: AnswerFn,
): Promise<void> {
  let data;
  try {
    data = decodeImageOcclusion(variant.question, variant.answer);
  } catch {
    card.createEl("p", { text: "Malformed image occlusion card.", cls: "iris-error" });
    return;
  }
  if (data.regions.length === 0) {
    card.createEl("p", { text: "No occlusion regions defined.", cls: "iris-error" });
    return;
  }

  const imageFile = view.app.metadataCache.getFirstLinkpathDest(data.imagePath, cardFile.path);
  if (!imageFile) {
    card.createEl("p", { text: `Image not found: ${data.imagePath}`, cls: "iris-error" });
    return;
  }
  const url = view.app.vault.getResourcePath(imageFile);

  const rs = view.getRenderState(cardFile, variant);
  const occludeIdx = (rs.occludeIdx as number) ?? (rs.occludeIdx = Math.floor(Math.random() * data.regions.length));
  const target = data.regions[occludeIdx];

  const questionEl = createDiv({ cls: "iris-question iris-image-occlusion-question" });
  const wrapper = questionEl.createDiv({ cls: "iris-image-occlusion-wrapper" });
  const img = wrapper.createEl("img", { cls: "iris-image-occlusion-img", attr: { src: url } });

  // Once the image's natural size is known we can size the overlay relative to
  // it. Coordinates are stored in image-natural pixels, projected onto the
  // displayed size via percentage positioning so they survive resizes.
  const placeOverlay = () => {
    const naturalW = img.naturalWidth || 1;
    const naturalH = img.naturalHeight || 1;
    overlay.style.left = `${(target.x / naturalW) * 100}%`;
    overlay.style.top = `${(target.y / naturalH) * 100}%`;
    overlay.style.width = `${(target.w / naturalW) * 100}%`;
    overlay.style.height = `${(target.h / naturalH) * 100}%`;
  };

  const overlay = wrapper.createDiv({ cls: "iris-occlusion-box" });
  if (img.complete && img.naturalWidth > 0) {
    placeOverlay();
  } else {
    img.addEventListener("load", placeOverlay, { once: true });
  }

  await renderInputCard(view, card, cardFile, variant, answer, {
    questionEl,
    canonicalAnswer: target.label,
    autoSubmitOnMatch: true,
    gapTerm: target.label,
    checkAnswer: (val) => {
      const norm = normalizeAnswer(val);
      const bound = variant.acceptedAnswers
        .map(decodeGapAlt)
        .filter(d => d.term === target.label || d.term === null)
        .map(d => d.alt);
      return [target.label, ...bound].some(a => normalizeAnswer(a) === norm);
    },
    knownIncorrect: variant.knownIncorrect
      .map(decodeGapAlt)
      .filter(d => d.term === target.label || d.term === null)
      .map(d => d.alt),
    llmMarker: view.plugin.settings.autoMark && (view.plugin.settings.anthropicApiKey || hasRelay()) ? {
      question: `What is labeled at the occluded region of this diagram?`,
      answer: target.label,
      acceptedAnswers: variant.acceptedAnswers
        .map(decodeGapAlt)
        .filter(d => d.term === target.label || d.term === null)
        .map(d => d.alt),
    } : undefined,
  });
}

// ─── Upcoming Previews ──────────────────────────────────────────────────

/**
 * First N previews render immediately (typical visible count); the rest render
 * on-demand when an IntersectionObserver sees them approach the viewport.
 * Before that they're empty placeholder cards with a fixed min-height so the
 * scrollbar reflects the real queue size.
 *
 * Rendering a preview runs a full `renderVariantInto` — MC option buttons,
 * drag-to-reorder lists, MarkdownRenderer on two blocks, etc. — so the cost
 * of eagerly rendering N of them is O(N). For 50 due cards the old behaviour
 * did ~50 preview renders on every advance; this cuts the initial per-advance
 * cost to EAGER_PREVIEW_COUNT regardless of queue length.
 */
const EAGER_PREVIEW_COUNT = 3;

function pickPreviewVariant(variants: QAVariant[]): QAVariant | null {
  const active = variants.filter(v => !v.suspended);
  if (active.length === 0) return null;
  return active.reduce((best, v) => {
    const bD = migrateDifficulty(best.difficulty);
    const vD = migrateDifficulty(v.difficulty);
    if (vD > bD) return v;
    if (vD < bD) return best;
    if (best.lastReviewed === null) return best;
    if (v.lastReviewed === null) return v;
    return v.lastReviewed < best.lastReviewed ? v : best;
  }, active[0]);
}

export async function renderUpcomingPreviews(view: ReviewView, body: HTMLDivElement): Promise<void> {
  const genId = ++view.previewGenId;
  const noop: AnswerFn = async () => {};

  const renderOne = async (file: TFile, preview: HTMLElement): Promise<void> => {
    if (view.previewGenId !== genId) return;
    let parsed: ParsedQA;
    try {
      parsed = await getParsedCached(view.app, file);
    } catch {
      preview.remove();
      return;
    }
    if (view.previewGenId !== genId) return;
    const variant = pickPreviewVariant(parsed.variants);
    if (!variant) { preview.remove(); return; }
    preview.removeClass("iris-card-placeholder");
    preview.style.minHeight = "";
    await renderVariantInto(view, preview, file, variant, noop);
  };

  const lazy: { file: TFile; preview: HTMLElement }[] = [];

  for (let i = 1; i < view.dueCards.length; i++) {
    if (view.previewGenId !== genId) return;
    const file = view.dueCards[i];
    const preview = body.createDiv({ cls: "iris-card iris-card-preview", attr: { inert: "" } });
    if (i <= EAGER_PREVIEW_COUNT) {
      await renderOne(file, preview);
    } else {
      // Empty placeholders would collapse to 0-height and all enter the
      // viewport at once — give them a realistic min-height so the IO can
      // actually differentiate near-viewport from far-below.
      preview.addClass("iris-card-placeholder");
      preview.style.minHeight = "140px";
      lazy.push({ file, preview });
    }
  }

  if (lazy.length === 0) return;

  const observer = new IntersectionObserver((entries) => {
    if (view.previewGenId !== genId) {
      observer.disconnect();
      return;
    }
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target as HTMLElement;
      const item = lazy.find(p => p.preview === el);
      observer.unobserve(el);
      if (item) void renderOne(item.file, item.preview);
    }
  }, { root: null, rootMargin: "400px 0px" });

  for (const { preview } of lazy) observer.observe(preview);
}
