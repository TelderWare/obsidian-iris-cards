import { TFile, MarkdownRenderer, setIcon } from "obsidian";
import { type QAVariant } from "../types/exercises";
import { parseQABlock } from "../types/qa-block";
import { markAnswer, appealAnswer } from "../generators/qa";
import { hasRelay } from "../api/client";
import { parseClozeTerms, occludeCloze } from "../generators/cloze";
import { decodeMC } from "../generators/multiple-choice";
import { decodeSolveEquation, randomizeKnowns, evaluateFormula, roundToSigFigs, checkNumericalAnswer } from "../generators/solve-equation";
import { decodeOrderSteps, shuffleArray } from "../generators/order-steps";
import { updateStability, getStability, getDifficulty, updateDifficulty } from "../leitner";
import { type ReviewView, normalizeAnswer } from "./review-view";

// ─── Answer Handler ─────────────────────────────────────────────────────

/** Callback renderers invoke when the user answers. Encapsulates timer, feedback, and rating. */
type AnswerFn = (correct: boolean, userAnswer?: string, silent?: boolean) => Promise<void>;

/**
 * Create the answer handler for a card. Captures the timer, feedback, and rating
 * so individual renderers only need to call answer(correct).
 */
function createAnswerHandler(
  view: ReviewView,
  card: HTMLElement,
  cardFile: TFile,
  variant: QAVariant,
): AnswerFn {
  const t0 = performance.now();
  return async (correct: boolean, userAnswer?: string, silent?: boolean) => {
    const elapsedMs = Math.round(performance.now() - t0);
    const record = correct && variant.recordMs != null && elapsedMs < variant.recordMs;
    if (!silent) view.playFeedback(correct, record);

    await view.rateCard(cardFile, correct, userAnswer, variant.question, elapsedMs);
  };
}

// ─── Shared Rendering Primitives ────────────────────────────────────────

/** Manual reveal mode: question -> eye button -> answer -> right/wrong buttons. */
async function renderManualReveal(
  view: ReviewView, card: HTMLElement, answer: AnswerFn,
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
  view: ReviewView, card: HTMLElement, cardFile: TFile, variant: QAVariant, answer: AnswerFn,
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
      await renderChoiceCard(view, card, variant, answer, {
        questionMd: `**True or false?**\n\n${variant.question}`,
        options: [
          { label: "True", value: "True", cls: "iris-tf-true" },
          { label: "False", value: "False", cls: "iris-tf-false" },
        ],
        correct: variant.answer,
        optionsCls: "iris-tf-options",
      });
    },
    "Cloze": () => renderOcclude(view, card, cardFile, variant, answer, {
      source: variant.question,
    }),
    "Solve Equation": () => renderSolveEquation(view, card, cardFile, variant, answer),
    "Order Steps": () => renderOrderSteps(view, card, cardFile, variant, answer),
    "Correct the Mistake": async () => {
      await renderInputCard(view, card, cardFile, variant, answer, {
        questionMd: `**Find and correct the mistake:**\n\n${variant.question}`,
        answerMd: variant.answer,
        autoSubmitOnMatch: true,
        llmMarker: {
          question: `The following statement contains a mistake: "${variant.question}"\nWhat is the corrected version?`,
          answer: variant.answer,
          acceptedAnswers: variant.acceptedAnswers,
        },
      });
    },
    "Assemble Equation": () => renderOcclude(view, card, cardFile, variant, answer, {
      source: variant.answer,
      title: variant.question,
      minTerms: 2,
      errorText: "Malformed equation.",
    }),
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

  // Parent note button — opens the source note
  const parentNote = view.app.metadataCache.getFileCache(cardFile)?.frontmatter?.["parent-note"];
  if (parentNote) {
    const linkMatch = typeof parentNote === "string" && parentNote.match(/^\[\[(.+?)(\|.+?)?\]\]$/);
    if (linkMatch) {
      const parentBtn = card.createEl("button", {
        cls: "iris-card-icon iris-parent-btn",
        attr: { "aria-label": "Open parent note" },
      });
      setIcon(parentBtn, "help-circle");
      parentBtn.addEventListener("click", () => {
        view.app.workspace.openLinkText(linkMatch[1], cardFile.path);
      });
    }
  }

  // Don't know button — counts as wrong without attempting
  const dontKnowBtn = card.createEl("button", {
    cls: "iris-card-icon iris-dontknow-btn",
    attr: { "aria-label": "Don\u2019t know" },
  });
  setIcon(dontKnowBtn, "circle-slash");
  dontKnowBtn.addEventListener("click", () => { answer(false, undefined, true); });

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
 * Renders a card with: question -> text input -> hidden answer -> marking.
 * Grading modes:
 *   - checkAnswer: local check (Cloze, Solve Equation, Assemble Equation)
 *   - llmMarker: exact-match shortcut then LLM fallback (Q&A, Correct the Mistake)
 *   - Both: local check for auto-submit + LLM fallback for grading
 */
async function renderInputCard(
  view: ReviewView,
  card: HTMLElement, cardFile: TFile, variant: QAVariant,
  answer: AnswerFn,
  opts: {
    questionMd: string;
    answerMd: string;
    checkAnswer?: (input: string) => boolean;
    autoSubmitOnMatch?: boolean;
    inputMode?: string;
    llmMarker?: { question: string; answer: string; acceptedAnswers?: string[] };
  },
): Promise<void> {
  const questionSection = card.createDiv({ cls: "iris-question" });
  await MarkdownRenderer.render(view.app, opts.questionMd, questionSection.createDiv(), "", view);

  const inputSection = card.createDiv({ cls: "iris-user-answer" });
  const attrs: Record<string, string> = {};
  if (opts.inputMode) attrs.inputmode = opts.inputMode;
  const input = inputSection.createEl("input", { type: "text", cls: "iris-answer-input", attr: attrs });

  const answerSection = card.createDiv({ cls: "iris-answer iris-hidden" });
  await MarkdownRenderer.render(view.app, opts.answerMd, answerSection.createDiv(), "", view);

  const markingEl = card.createDiv({ cls: "iris-marking iris-hidden" });

  input.focus();

  let answered = false;

  const showResult = (correct: boolean) => {
    answerSection.removeClass("iris-hidden");
    markingEl.removeClass("iris-hidden");
    markingEl.setText(correct ? "Correct" : "Incorrect");
    markingEl.toggleClass("iris-marking-correct", correct);
    markingEl.toggleClass("iris-marking-incorrect", !correct);
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

  const submitAnswer = async () => {
    if (answered) return;
    answered = true;
    const userAnswer = input.value.trim();

    if (!userAnswer) {
      showResult(false);
      await answer(false);
      return;
    }

    // Local check (custom checker or exact-match shortcut)
    const localCheck = opts.checkAnswer ?? isExactMatch;
    if (localCheck?.(userAnswer)) {
      showResult(true);
      await answer(true, userAnswer);
      return;
    }

    // No LLM marker — local check is final
    if (!opts.llmMarker) {
      showResult(false);
      addAppealButton(view, card, cardFile, variant, userAnswer, markingEl, opts.questionMd);
      await answer(false, userAnswer);
      return;
    }

    // LLM fallback marking
    input.disabled = true;
    const marking = card.createEl("p", { text: "Marking\u2026", cls: "iris-loading" });
    try {
      const apiKey = view.plugin.settings.anthropicApiKey;
      const correct = await markAnswer(
        opts.llmMarker.question, opts.llmMarker.answer, userAnswer,
        apiKey, view.plugin.settings.claudeModel,
      );
      marking.remove();
      showResult(correct);
      if (!correct) addAppealButton(view, card, cardFile, variant, userAnswer, markingEl);
      await answer(correct, userAnswer);
    } catch (e) {
      marking.remove();
      answered = false;
      input.disabled = false;
      markingEl.setText(`Marking failed: ${e instanceof Error ? e.message : String(e)}`);
      markingEl.addClass("iris-marking-incorrect");
      markingEl.removeClass("iris-hidden");
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
  view: ReviewView,
  card: HTMLElement,
  cardFile: TFile,
  variant: QAVariant,
  userAnswer: string,
  markingEl: HTMLElement,
  appealQuestion?: string,
): void {
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
          fm["stability"] = updateStability(preStability, true, preDifficulty);
          fm["difficulty"] = updateDifficulty(preDifficulty, true);
          delete fm["box"];
        });
        await view.plugin.cardStore.addAcceptedAnswer(cardFile, variant.question, userAnswer);
        markingEl.setText("Correct");
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
  view: ReviewView,
  card: HTMLElement, cardFile: TFile, variant: QAVariant, answer: AnswerFn,
): Promise<void> {
  if (view.plugin.settings.autoMark) {
    await renderInputCard(view, card, cardFile, variant, answer, {
      questionMd: variant.question,
      answerMd: variant.answer,
      autoSubmitOnMatch: true,
      llmMarker: {
        question: variant.question,
        answer: variant.answer,
        acceptedAnswers: variant.acceptedAnswers,
      },
    });
    return;
  }

  await renderManualReveal(view, card, answer, variant.question, variant.answer);
}

// --- Choice (Multiple Choice + True/False) ---

async function renderChoiceCard(
  view: ReviewView,
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
  view: ReviewView,
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
  const fmtA = opts.title ? `**${opts.title}**\n\n${filled}` : filled;

  if (view.plugin.settings.autoMark) {
    const apiKey = view.plugin.settings.anthropicApiKey;
    const useLlm = apiKey || hasRelay();
    await renderInputCard(view, card, cardFile, variant, answer, {
      questionMd: fmtQ,
      answerMd: fmtA,
      autoSubmitOnMatch: true,
      llmMarker: useLlm ? {
        question: opts.title ? `${opts.title}\n${display}` : display,
        answer: term,
        acceptedAnswers: variant.acceptedAnswers,
      } : undefined,
      checkAnswer: (val) => {
        const norm = normalizeAnswer(val);
        return [term, ...variant.acceptedAnswers].some(a => normalizeAnswer(a) === norm);
      },
    });
    return;
  }

  await renderManualReveal(view, card, answer, fmtQ, fmtA);
}

// --- Solve Equation ---

async function renderSolveEquation(
  view: ReviewView,
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

  const knownLines = se.knowns
    .map(k => `- **${k.name}** (*${k.symbol}*) = ${values[k.symbol]} ${k.units}`)
    .join("\n");
  const display = `${se.scenario}\n\n${knownLines}\n\n**Solve for:** ${se.target.name} (*${se.target.symbol}*) in ${se.target.units}`;

  await renderInputCard(view, card, cardFile, variant, answer, {
    questionMd: display,
    answerMd: `${expected} ${se.target.units}`,
    checkAnswer: (val) => {
      const num = parseFloat(val);
      return !isNaN(num) && checkNumericalAnswer(num, expected, se.target.sigfigs);
    },
    inputMode: "decimal",
  });
}

// --- Order Steps ---

async function renderOrderSteps(
  view: ReviewView,
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
      row.createSpan({ cls: "iris-order-num", text: `${i + 1}` });
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
    markingEl.setText(correct ? "Correct" : "Incorrect");
    markingEl.addClass(correct ? "iris-marking-correct" : "iris-marking-incorrect");

    await answer(correct);
  });
}

// ─── Upcoming Previews ──────────────────────────────────────────────────

export async function renderUpcomingPreviews(view: ReviewView, body: HTMLDivElement): Promise<void> {
  const genId = ++view.previewGenId;
  const noop: AnswerFn = async () => {};
  for (let i = 1; i < view.dueCards.length; i++) {
    if (view.previewGenId !== genId) return;
    const file = view.dueCards[i];
    const content = await view.app.vault.cachedRead(file);
    if (view.previewGenId !== genId) return;
    const parsed = parseQABlock(content);
    const active = parsed.variants.filter(v => !v.suspended);
    if (active.length === 0) continue;
    const variant = active.reduce((best, v) => {
      const bD = best.difficulty ?? 0.5;
      const vD = v.difficulty ?? 0.5;
      if (vD > bD) return v;
      if (vD < bD) return best;
      if (best.lastReviewed === null) return best;
      if (v.lastReviewed === null) return v;
      return v.lastReviewed < best.lastReviewed ? v : best;
    }, active[0]);
    const preview = body.createDiv({ cls: "iris-card iris-card-preview", attr: { inert: "" } });
    await renderVariantInto(view, preview, file, variant, noop);
  }
}
