import { TFile, MarkdownRenderer, setIcon } from "obsidian";
import { type QAVariant } from "../types/exercises";
import { parseQABlock } from "../types/qa-block";
import { markAnswer, appealAnswer } from "../generators/qa";
import { parseClozeTerms, occludeCloze } from "../generators/cloze";
import { decodeMC } from "../generators/multiple-choice";
import { decodeSolveEquation, randomizeKnowns, evaluateFormula, roundToSigFigs, checkNumericalAnswer } from "../generators/solve-equation";
import { decodeOrderSteps, shuffleArray } from "../generators/order-steps";
import { updateStability, getStability, getDifficulty, updateDifficulty } from "../leitner";
import { type ReviewView, normalizeAnswer } from "./review-view";

/** Dispatch to the correct type-specific renderer for a card element. */
export async function renderVariantInto(view: ReviewView, card: HTMLElement, cardFile: TFile, variant: QAVariant, apiKey: string): Promise<void> {
  const rendererMap: Record<string, () => Promise<void>> = {
    "Multiple Choice": async () => {
      const mc = decodeMC(variant.question, variant.answer);
      await renderChoiceCard(view, card, cardFile, variant, {
        questionMd: mc.question,
        options: mc.options.map(o => ({ label: o.text, value: o.letter })),
        correct: mc.correct,
      });
    },
    "True/False": async () => {
      await renderChoiceCard(view, card, cardFile, variant, {
        questionMd: `**True or false?**\n\n${variant.question}`,
        options: [
          { label: "True", value: "True", cls: "iris-tf-true" },
          { label: "False", value: "False", cls: "iris-tf-false" },
        ],
        correct: variant.answer,
        optionsCls: "iris-tf-options",
      });
    },
    "Cloze": () => renderCloze(view, card, cardFile, variant),
    "Solve Equation": () => renderSolveEquation(view, card, cardFile, variant),
    "Order Steps": () => renderOrderSteps(view, card, cardFile, variant),
    "Correct the Mistake": async () => {
      await renderInputCard(view, card, cardFile, variant, {
        questionMd: `**Find and correct the mistake:**\n\n${variant.question}`,
        answerMd: variant.answer,
        llmMarker: {
          apiKey,
          question: `The following statement contains a mistake: "${variant.question}"\nWhat is the corrected version?`,
          answer: variant.answer,
          acceptedAnswers: variant.acceptedAnswers,
        },
      });
    },
    "Assemble Equation": () => renderAssembleEquation(view, card, cardFile, variant),
  };
  await (rendererMap[variant.exerciseType] ?? (() => renderQA(view, card, cardFile, variant, apiKey)))();
}

export async function renderCurrentCard(view: ReviewView, body: HTMLDivElement, cardFile: TFile, variant: QAVariant, apiKey: string): Promise<void> {
  body.querySelectorAll(".iris-card-preview").forEach((el) => el.remove());
  const card = body.createDiv({ cls: "iris-card" });
  view.currentCardEl = card;

  await renderVariantInto(view, card, cardFile, variant, apiKey);

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

  // Render previews as inert (no input focus, no click handlers)
  renderUpcomingPreviews(view, body);
}

// ─── Shared Input Card Helper ───────────────────────────────────────────────

/**
 * Renders a card with: question → text input → hidden answer → marking.
 * Supports three modes via opts:
 *   - checkAnswer only: instant local check (Cloze, Solve Equation, Assemble Equation)
 *   - llmMarker: exact-match shortcut → LLM fallback (Q&A autoMark, Correct the Mistake, Explain Why)
 *   - Both can have autoSubmitOnMatch for auto-submit when typed answer matches locally
 */
export async function renderInputCard(
view: ReviewView,
card: HTMLElement, cardFile: TFile, variant: QAVariant,
  opts: {
    questionMd: string;
    answerMd: string;
    checkAnswer?: (input: string) => boolean;
    autoSubmitOnMatch?: boolean;
    inputMode?: string;
    llmMarker?: { apiKey: string; question: string; answer: string; acceptedAnswers?: string[] };
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

  const t0 = performance.now();
  let answered = false;

  const showResult = (correct: boolean) => {
    answerSection.removeClass("iris-hidden");
    markingEl.removeClass("iris-hidden");
    markingEl.setText(correct ? "Correct" : "Incorrect");
    markingEl.toggleClass("iris-marking-correct", correct);
    markingEl.toggleClass("iris-marking-incorrect", !correct);
    input.disabled = true;
  };

  // Build exact-match checker for LLM marker mode
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
    const elapsedMs = Math.round(performance.now() - t0);
    const userAnswer = input.value.trim();
    const isRecord = (ms: number, correct: boolean) => correct && variant.recordMs != null && ms < variant.recordMs;

    if (!userAnswer) {
      view.playFeedback(false);
      showResult(false);
      await new Promise(r => setTimeout(r, 1200));
      await view.rateCard(cardFile, false, undefined, variant.question, elapsedMs);
      return;
    }

    // Local check mode (Cloze, Solve Equation, Assemble Equation)
    if (opts.checkAnswer && !opts.llmMarker) {
      const correct = opts.checkAnswer(userAnswer);
      view.playFeedback(correct, isRecord(elapsedMs, correct));
      showResult(correct);
      if (!correct) {
        addAppealButton(view, card, cardFile, variant, userAnswer, markingEl, opts.questionMd);
      }
      await view.rateCard(cardFile, correct, correct ? userAnswer : undefined, variant.question, elapsedMs);
      return;
    }

    // LLM marker mode: try exact match first, then fall back to LLM
    if (isExactMatch?.(userAnswer)) {
      view.playFeedback(true, isRecord(elapsedMs, true));
      showResult(true);
      await new Promise(r => setTimeout(r, 800));
      await view.rateCard(cardFile, true, userAnswer, variant.question, elapsedMs);
      return;
    }

    input.disabled = true;
    const marking = card.createEl("p", { text: "Marking\u2026", cls: "iris-loading" });
    try {
      const correct = await markAnswer(
        opts.llmMarker!.question, opts.llmMarker!.answer, userAnswer,
        opts.llmMarker!.apiKey, view.plugin.settings.claudeModel,
      );
      marking.remove();
      view.playFeedback(correct, isRecord(elapsedMs, correct));
      showResult(correct);
      if (!correct) {
        addAppealButton(view, card, cardFile, variant, userAnswer, markingEl);
      }
      await view.rateCard(cardFile, correct, correct ? userAnswer : undefined, variant.question, elapsedMs);
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
  if (!apiKey) return;

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

// ─── Q&A Renderer ──────────────────────────────────────────────────

export async function renderQA(
view: ReviewView,
card: HTMLElement, cardFile: TFile, variant: QAVariant, apiKey: string,
): Promise<void> {
  if (view.plugin.settings.autoMark) {
    await renderInputCard(view, card, cardFile, variant, {
      questionMd: variant.question,
      answerMd: variant.answer,
      autoSubmitOnMatch: true,
      llmMarker: {
        apiKey,
        question: variant.question,
        answer: variant.answer,
        acceptedAnswers: variant.acceptedAnswers,
      },
    });
    return;
  }

  const t0 = performance.now();

  const questionSection = card.createDiv({ cls: "iris-question" });
  await MarkdownRenderer.render(view.app, variant.question, questionSection.createDiv(), "", view);

  const showBtn = card.createEl("button", {
    cls: "iris-show-btn",
    attr: { "aria-label": "Show answer" },
  });
  setIcon(showBtn, "eye");

  const answerSection = card.createDiv({ cls: "iris-answer iris-hidden" });
  await MarkdownRenderer.render(view.app, variant.answer, answerSection.createDiv(), "", view);

  const actions = card.createDiv({ cls: "iris-actions iris-hidden" });

  const wrongBtn = actions.createEl("button", { cls: "iris-wrong-btn", attr: { "aria-label": "Wrong" } });
  setIcon(wrongBtn, "x");
  wrongBtn.addEventListener("click", () => {
    const elapsedMs = Math.round(performance.now() - t0);
    view.playFeedback(false);
    view.rateCard(cardFile, false, undefined, variant.question, elapsedMs);
  });

  const rightBtn = actions.createEl("button", { cls: "iris-right-btn", attr: { "aria-label": "Right" } });
  setIcon(rightBtn, "check");
  rightBtn.addEventListener("click", () => {
    const elapsedMs = Math.round(performance.now() - t0);
    const record = variant.recordMs != null && elapsedMs < variant.recordMs;
    view.playFeedback(true, record);
    view.rateCard(cardFile, true, undefined, variant.question, elapsedMs);
  });

  showBtn.addEventListener("click", () => {
    answerSection.removeClass("iris-hidden");
    showBtn.addClass("iris-hidden");
    actions.removeClass("iris-hidden");
  });
}

// ─── Choice Card Renderer (MC + True/False) ────────────────────────────

export async function renderChoiceCard(
view: ReviewView,
card: HTMLElement, cardFile: TFile, variant: QAVariant,
  opts: { questionMd: string; options: { label: string; value: string; cls?: string }[]; correct: string; optionsCls?: string },
): Promise<void> {
  const questionSection = card.createDiv({ cls: "iris-question" });
  await MarkdownRenderer.render(view.app, opts.questionMd, questionSection.createDiv(), "", view);

  const optionsSection = card.createDiv({ cls: `iris-mc-options${opts.optionsCls ? " " + opts.optionsCls : ""}` });
  let answered = false;
  const t0 = performance.now();

  for (const opt of opts.options) {
    const btn = optionsSection.createEl("button", {
      cls: `iris-mc-option${opt.cls ? " " + opt.cls : ""}`,
      text: opt.label,
      attr: { "data-value": opt.value },
    });

    btn.addEventListener("click", async () => {
      if (answered) return;
      answered = true;
      const elapsedMs = Math.round(performance.now() - t0);

      const correct = opt.value === opts.correct;
      const record = correct && variant.recordMs != null && elapsedMs < variant.recordMs;
      view.playFeedback(correct, record);

      for (const child of Array.from(optionsSection.querySelectorAll<HTMLButtonElement>(".iris-mc-option"))) {
        child.disabled = true;
        if (child.dataset.value === opts.correct) {
          child.addClass("iris-mc-correct");
        } else if (child === btn && !correct) {
          child.addClass("iris-mc-incorrect");
        }
      }

      await view.rateCard(cardFile, correct, undefined, variant.question, elapsedMs);
    });
  }
}

// ─── Cloze Renderer ──────────────────────────────────────────────────

export async function renderCloze(
view: ReviewView,
card: HTMLElement, cardFile: TFile, variant: QAVariant,
): Promise<void> {
  const sentence = variant.question;
  const terms = parseClozeTerms(sentence);
  if (terms.length === 0) {
    card.createEl("p", { text: "No cloze terms found in this card.", cls: "iris-error" });
    return;
  }

  const rs = view.getRenderState(cardFile, variant);
  const occludeIdx = (rs.clozeIdx as number) ?? (rs.clozeIdx = Math.floor(Math.random() * terms.length));
  const { display, answer } = occludeCloze(sentence, occludeIdx);
  const allAnswers = [answer, ...variant.acceptedAnswers];

  // Full sentence with the occluded term bolded
  let ti = 0;
  const filled = sentence.replace(/\*([^*]+)\*/g, (_, term) => ti++ === occludeIdx ? `**${term}**` : term);

  await renderInputCard(view, card, cardFile, variant, {
    questionMd: display,
    answerMd: filled,
    checkAnswer: (val) => allAnswers.some(a => normalizeAnswer(a) === normalizeAnswer(val)),
    autoSubmitOnMatch: true,
  });
}

// ─── Solve Equation Renderer ──────────────────────────────────────────

export async function renderSolveEquation(
view: ReviewView,
card: HTMLElement, cardFile: TFile, variant: QAVariant,
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

  await renderInputCard(view, card, cardFile, variant, {
    questionMd: display,
    answerMd: `${expected} ${se.target.units}`,
    checkAnswer: (val) => {
      const num = parseFloat(val);
      return !isNaN(num) && checkNumericalAnswer(num, expected, se.target.sigfigs);
    },
    inputMode: "decimal",
  });
}

// ─── Assemble Equation Renderer ────────────────────────────────────────

export async function renderAssembleEquation(
view: ReviewView,
card: HTMLElement, cardFile: TFile, variant: QAVariant,
): Promise<void> {
  const title = variant.question;
  const equation = variant.answer;
  const terms = parseClozeTerms(equation);
  if (terms.length < 2) {
    card.createEl("p", { text: "Malformed equation.", cls: "iris-error" });
    return;
  }

  const rs = view.getRenderState(cardFile, variant);
  const occludeIdx = (rs.clozeIdx as number) ?? (rs.clozeIdx = Math.floor(Math.random() * terms.length));
  const { display, answer } = occludeCloze(equation, occludeIdx);
  const allAnswers = [answer, ...variant.acceptedAnswers];

  // Full equation with the occluded term bolded
  let ti = 0;
  const filled = equation.replace(/\*([^*]+)\*/g, (_, term) => ti++ === occludeIdx ? `**${term}**` : term);

  await renderInputCard(view, card, cardFile, variant, {
    questionMd: `**${title}**\n\n${display}`,
    answerMd: `**${title}**\n\n${filled}`,
    checkAnswer: (val) => allAnswers.some(a => normalizeAnswer(a) === normalizeAnswer(val)),
    autoSubmitOnMatch: true,
  });
}

// ─── Order Steps Renderer ──────────────────────────────────────────────

export async function renderOrderSteps(
view: ReviewView,
card: HTMLElement, cardFile: TFile, variant: QAVariant,
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

  // Drag-to-reorder list
  const listEl = card.createDiv({ cls: "iris-order-list" });
  const rs = view.getRenderState(cardFile, variant);
  const order: { text: string; origIdx: number }[] =
    (Array.isArray(rs.shuffledOrder) ? rs.shuffledOrder : null) ??
    (rs.shuffledOrder = shuffleArray(os.steps.map((text, origIdx) => ({ text, origIdx }))));
  let answered = false;
  let dragIdx: number | null = null;
  const t0 = performance.now();

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

  // Check button
  const checkBtn = card.createEl("button", {
    cls: "iris-order-check",
    text: "Check",
  });

  checkBtn.addEventListener("click", async () => {
    if (answered) return;
    answered = true;
    const elapsedMs = Math.round(performance.now() - t0);
    checkBtn.remove();

    const correct = order.every((item, i) => item.text === os.steps[i]);
    const record = correct && variant.recordMs != null && elapsedMs < variant.recordMs;
    view.playFeedback(correct, record);

    // Mark each row correct/incorrect and disable dragging
    const rows = Array.from(listEl.querySelectorAll(".iris-order-row"));
    rows.forEach((row, i) => {
      row.setAttribute("draggable", "false");
      row.addClass(order[i].text === os.steps[i] ? "iris-order-correct" : "iris-order-incorrect");
    });

    // Show correct order
    const answerSection = card.createDiv({ cls: "iris-answer" });
    const correctMd = os.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
    await MarkdownRenderer.render(view.app, correctMd, answerSection.createDiv(), "", view);

    const markingEl = card.createDiv({ cls: "iris-marking" });
    markingEl.setText(correct ? "Correct" : "Incorrect");
    markingEl.addClass(correct ? "iris-marking-correct" : "iris-marking-incorrect");

    await view.rateCard(cardFile, correct, undefined, variant.question, elapsedMs);
  });
}

export async function renderUpcomingPreviews(view: ReviewView, body: HTMLDivElement): Promise<void> {
  const apiKey = view.plugin.settings.anthropicApiKey ?? "";
  for (let i = 1; i < view.dueCards.length; i++) {
    const file = view.dueCards[i];
    const content = await view.app.vault.cachedRead(file);
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
    await renderVariantInto(view, preview, file, variant, apiKey);
  }
}
