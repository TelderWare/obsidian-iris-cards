import { ItemView, TFile, WorkspaceLeaf, MarkdownRenderer, setIcon } from "obsidian";
import type IrisCardsPlugin from "./main";
import { getDueCards, getAllCards, getModules, updateStability, getStability } from "./leitner";
import { markAnswer, appealAnswer, parseClozeTerms, occludeCloze, decodeMC, decodeSolveEquation, randomizeKnowns, evaluateFormula, roundToSigFigs, checkNumericalAnswer, decodeOrderSteps, shuffleArray, parseQABlock, type QAVariant } from "./claude";

export const VIEW_TYPE_REVIEW = "iris-cards-review";

function normalizeAnswer(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

export class ReviewView extends ItemView {
  private plugin: IrisCardsPlugin;
  private dueCards: TFile[] = [];
  private currentCard: TFile | null = null;
  private doneCheckInterval: number | null = null;
  private infiniteMode = false;
  private moduleFilter = new Set<string>();
  private shownVariants = new Set<string>();
  private scrollBody: HTMLDivElement | null = null;
  private layoutReady = false;
  private audioCtx: AudioContext | null = null;
  private currentCardEl: HTMLElement | null = null;
  private currentVariant: QAVariant | null = null;
  private scrollAnimId = 0;
  private renderStateCache = new Map<string, Record<string, unknown>>();

  constructor(leaf: WorkspaceLeaf, plugin: IrisCardsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_REVIEW;
  }

  getDisplayText(): string {
    return "Iris Cards";
  }

  getIcon(): string {
    return "brain";
  }

  private getAudioCtx(): AudioContext {
    if (!this.audioCtx) this.audioCtx = new AudioContext();
    return this.audioCtx;
  }

  async onOpen(): Promise<void> {
    await this.loadDueCards();
  }

  async onClose(): Promise<void> {
    this.clearDoneCheck();
    this.audioCtx?.close();
    this.audioCtx = null;
    this.layoutReady = false;
    this.contentEl.empty();
  }

  private getRenderState(cardFile: TFile, variant: QAVariant): Record<string, unknown> {
    const key = cardFile.path + "::" + variant.question;
    let state = this.renderStateCache.get(key);
    if (!state) {
      state = {};
      this.renderStateCache.set(key, state);
    }
    return state;
  }

  private clearDoneCheck(): void {
    if (this.doneCheckInterval !== null) {
      window.clearInterval(this.doneCheckInterval);
      this.doneCheckInterval = null;
    }
  }

  private async loadDueCards(): Promise<void> {
    this.dueCards = this.infiniteMode
      ? await getAllCards(this.app, this.plugin.settings.cardsFolder, this.moduleFilter.size > 0 ? this.moduleFilter : undefined)
      : await getDueCards(this.app, this.plugin.settings.cardsFolder, 0, this.moduleFilter.size > 0 ? this.moduleFilter : undefined);
    if (this.dueCards.length === 0) {
      this.renderDoneCard();
      return;
    }

    await this.plugin.pregenerateAll();
    await this.showNextCard();
  }

  private ensureLayout(): void {
    if (this.layoutReady) return;

    const container = this.contentEl;
    container.empty();
    container.addClass("iris-review");

    // Header
    const header = container.createDiv({ cls: "iris-header" });

    const headerLeft = header.createDiv({ cls: "iris-header-left" });

    const headerCenter = header.createDiv({ cls: "iris-header-center" });

    const makeToggle = (icon: string, title: string, active: boolean, onChange: (v: boolean) => void) => {
      const btn = headerCenter.createEl("button", { cls: "iris-toggle clickable-icon", attr: { "aria-label": title } });
      setIcon(btn, icon);
      btn.toggleClass("is-active", active);
      btn.addEventListener("click", () => {
        const next = !btn.hasClass("is-active");
        btn.toggleClass("is-active", next);
        onChange(next);
      });
    };

    makeToggle("volume-2", "Sound", this.plugin.settings.soundFeedback, async (v) => {
      await this.plugin.updateSetting("soundFeedback", v);
    });

    makeToggle("zap", "Flash", this.plugin.settings.flashFeedback, async (v) => {
      await this.plugin.updateSetting("flashFeedback", v);
    });

    makeToggle("brain-circuit", "LLM marking", this.plugin.settings.autoMark, async (v) => {
      await this.plugin.updateSetting("autoMark", v);
      if (this.currentCard && this.currentVariant && this.currentCardEl && this.scrollBody) {
        const apiKey = this.plugin.settings.anthropicApiKey;
        if (!apiKey) return;
        this.currentCardEl.remove();
        await this.renderCurrentCard(this.scrollBody, this.currentCard, this.currentVariant, apiKey);
      }
    });

    makeToggle("infinity", "Infinite mode", this.infiniteMode, async (v) => {
      this.infiniteMode = v;
      this.shownVariants.clear();
      this.layoutReady = false;
      await this.loadDueCards();
    });

    // Module filter — icon button with dropdown checklist
    const modules = getModules(this.app, this.plugin.settings.cardsFolder);
    if (modules.length > 0) {
      const filterWrap = headerLeft.createDiv({ cls: "iris-filter-wrap" });
      const filterBtn = filterWrap.createEl("button", { cls: "iris-toggle", attr: { "aria-label": "Filter by module" } });
      setIcon(filterBtn, "list-filter");
      const dropdown = filterWrap.createDiv({ cls: "iris-filter-dropdown iris-hidden" });

      const updateBtn = () => {
        filterBtn.toggleClass("iris-toggle-active", this.moduleFilter.size > 0);
      };
      updateBtn();

      for (const m of modules) {
        const row = dropdown.createDiv({ cls: "iris-filter-row" });
        const cb = row.createEl("input", { type: "checkbox", attr: { id: `iris-mod-${m}` } });
        cb.checked = this.moduleFilter.has(m);
        row.createEl("label", { text: m, attr: { for: `iris-mod-${m}` } });
        cb.addEventListener("change", async () => {
          if (cb.checked) this.moduleFilter.add(m);
          else this.moduleFilter.delete(m);
          updateBtn();
          this.layoutReady = false;
          await this.loadDueCards();
        });
      }

      filterBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        dropdown.toggleClass("iris-hidden", !dropdown.hasClass("iris-hidden"));
      });

      // Close dropdown when clicking outside
      this.registerDomEvent(document, "click", (e) => {
        if (!filterWrap.contains(e.target as Node)) {
          dropdown.addClass("iris-hidden");
        }
      });
    }

    const headerRight = header.createDiv({ cls: "iris-header-right" });

    const clearCache = headerRight.createEl("button", {
      cls: "iris-toggle",
      attr: { "aria-label": "Clear question cache" },
    });
    setIcon(clearCache, "trash-2");
    clearCache.addEventListener("click", async () => {
      this.plugin.qaCache.clear();
      await this.plugin.cardStore.stripAllQABlocks(this.plugin.settings.cardsFolder);
    });

    // Scrollable body
    this.scrollBody = container.createDiv({ cls: "iris-scroll-body" });
    this.layoutReady = true;
  }

  private scrollToCenter(el: HTMLElement): void {
    const body = this.scrollBody;
    if (!body) return;
    const id = ++this.scrollAnimId;
    requestAnimationFrame(() => {
      if (id !== this.scrollAnimId) return;
      const target = el.offsetTop - (body.clientHeight - el.offsetHeight) / 2;
      const start = body.scrollTop;
      const delta = target - start;
      if (Math.abs(delta) < 1) { body.scrollTop = target; return; }
      const duration = 400;
      const t0 = performance.now();
      const step = (now: number) => {
        if (id !== this.scrollAnimId) return;
        const p = Math.min((now - t0) / duration, 1);
        const ease = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
        body.scrollTop = start + delta * ease;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  private renderDoneCard(): void {
    this.clearDoneCheck();
    this.ensureLayout();
    const body = this.scrollBody!;
    body.querySelectorAll(".iris-card-preview").forEach((el) => el.remove());

    const card = body.createDiv({ cls: "iris-card iris-done-card" });
    card.createEl("h2", { text: "All caught up!" });
    card.createEl("p", { text: "No cards are due for review." });

    this.scrollToCenter(card);

    // Poll for newly due cards
    this.doneCheckInterval = window.setInterval(async () => {
      const cards = await getDueCards(this.app, this.plugin.settings.cardsFolder, 0, this.moduleFilter.size > 0 ? this.moduleFilter : undefined);
      if (cards.length > 0) {
        this.clearDoneCheck();
        this.dueCards = cards;
        await this.plugin.pregenerateAll();
        await this.showNextCard();
      }
    }, 10_000);
  }

  private async showNextCard(): Promise<void> {
    this.clearDoneCheck();
    // Skip deleted cards
    while (this.dueCards.length > 0 && !this.app.vault.getAbstractFileByPath(this.dueCards[0].path)) {
      this.plugin.qaCache.delete(this.dueCards[0].path);
      this.dueCards.shift();
    }

    if (this.dueCards.length === 0) {
      this.renderDoneCard();
      this.plugin.updateBadge();
      return;
    }

    this.currentCard = this.dueCards[0];
    const cardFile = this.currentCard;
    this.ensureLayout();

    // Pregenerate next card while user works on current one
    if (this.plugin.settings.anthropicApiKey && this.dueCards.length > 1) {
      this.plugin.pregenerateQA(this.dueCards[1], this.plugin.settings.anthropicApiKey, 2);
    }

    const body = this.scrollBody!;
    // Remove stale previews; answered cards stay
    body.querySelectorAll(".iris-card-preview").forEach((el) => el.remove());

    // Check API key
    const apiKey = this.plugin.settings.anthropicApiKey;
    if (!apiKey) {
      const card = body.createDiv({ cls: "iris-card" });
      card.createEl("p", {
        text: "No API key configured. Set your Anthropic API key in Iris Cards settings.",
        cls: "iris-error",
      });
      this.scrollToCenter(card);
      return;
    }

    // Show loading indicator while generating Q&A
    this.plugin.pregenerateQA(this.currentCard, apiKey, 2);
    const loadingCard = body.createDiv({ cls: "iris-card" });
    loadingCard.createEl("p", { text: "Generating question\u2026", cls: "iris-loading" });
    this.scrollToCenter(loadingCard);

    let variants: QAVariant[];
    try {
      variants = await this.plugin.qaCache.get(this.currentCard.path)!;
    } catch (e) {
      loadingCard.empty();
      loadingCard.createEl("p", {
        text: `Error generating Q&A: ${e instanceof Error ? e.message : String(e)}`,
        cls: "iris-error",
      });
      return;
    }

    loadingCard.remove();

    // Pool reviewable variants
    const active = variants.filter(v => !v.suspended);
    if (active.length === 0) {
      // All variants suspended — skip this card entirely
      this.dueCards.shift();
      await this.showNextCard();
      return;
    }

    // In infinite mode, prefer variants not yet shown this session
    let variant: QAVariant;
    if (this.infiniteMode) {
      const unseen = active.filter(v => !this.shownVariants.has(cardFile.path + "::" + v.question));
      const pool = unseen.length > 0 ? unseen : active;
      variant = pool.reduce((oldest, v) => {
        if (oldest.lastReviewed === null) return oldest;
        if (v.lastReviewed === null) return v;
        return v.lastReviewed < oldest.lastReviewed ? v : oldest;
      });
      this.shownVariants.add(cardFile.path + "::" + variant.question);
    } else {
      variant = active.reduce((oldest, v) => {
        if (oldest.lastReviewed === null) return oldest;
        if (v.lastReviewed === null) return v;
        return v.lastReviewed < oldest.lastReviewed ? v : oldest;
      });
    }

    // Create card
    this.currentVariant = variant;
    await this.renderCurrentCard(body, cardFile, variant, apiKey);
  }

  /** Dispatch to the correct type-specific renderer for a card element. */
  private async renderVariantInto(card: HTMLElement, cardFile: TFile, variant: QAVariant, apiKey: string): Promise<void> {
    const renderers: Record<string, () => Promise<void>> = {
      "Multiple Choice": async () => {
        const mc = decodeMC(variant.question, variant.answer);
        await this.renderChoiceCard(card, cardFile, variant, {
          questionMd: mc.question,
          options: mc.options.map(o => ({ label: o.text, value: o.letter })),
          correct: mc.correct,
        });
      },
      "True/False": async () => {
        await this.renderChoiceCard(card, cardFile, variant, {
          questionMd: `**True or false?**\n\n${variant.question}`,
          options: [
            { label: "True", value: "True", cls: "iris-tf-true" },
            { label: "False", value: "False", cls: "iris-tf-false" },
          ],
          correct: variant.answer,
          optionsCls: "iris-tf-options",
        });
      },
      "Cloze": () => this.renderCloze(card, cardFile, variant),
      "Solve Equation": () => this.renderSolveEquation(card, cardFile, variant),
      "Order Steps": () => this.renderOrderSteps(card, cardFile, variant),
      "Correct the Mistake": async () => {
        await this.renderInputCard(card, cardFile, variant, {
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
      "Assemble Equation": () => this.renderAssembleEquation(card, cardFile, variant),
    };
    await (renderers[variant.exerciseType] ?? (() => this.renderQA(card, cardFile, variant, apiKey)))();
  }

  private async renderCurrentCard(body: HTMLDivElement, cardFile: TFile, variant: QAVariant, apiKey: string): Promise<void> {
    body.querySelectorAll(".iris-card-preview").forEach((el) => el.remove());
    const card = body.createDiv({ cls: "iris-card" });
    this.currentCardEl = card;

    await this.renderVariantInto(card, cardFile, variant, apiKey);

    // Suspend button — permanently disables this question variant
    const suspendBtn = card.createEl("button", {
      cls: "iris-card-icon iris-suspend-btn",
      attr: { "aria-label": "Suspend question" },
    });
    setIcon(suspendBtn, "eye-off");
    suspendBtn.addEventListener("click", async () => {
      const remaining = await this.plugin.cardStore.suspendVariant(cardFile, variant.question);
      this.plugin.qaCache.delete(cardFile.path);
      if (remaining.length === 0) this.dueCards.shift();
      await this.showNextCard();
    });

    // Parent note button — opens the source note
    const parentNote = this.app.metadataCache.getFileCache(cardFile)?.frontmatter?.["parent-note"];
    if (parentNote) {
      const linkMatch = typeof parentNote === "string" && parentNote.match(/^\[\[(.+?)(\|.+?)?\]\]$/);
      if (linkMatch) {
        const parentBtn = card.createEl("button", {
          cls: "iris-card-icon iris-parent-btn",
          attr: { "aria-label": "Open parent note" },
        });
        setIcon(parentBtn, "help-circle");
        parentBtn.addEventListener("click", () => {
          this.app.workspace.openLinkText(linkMatch[1], cardFile.path);
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
      const skipped = this.dueCards.shift();
      if (skipped) this.dueCards.push(skipped);
      await this.showNextCard();
    });

    this.scrollToCenter(card);

    // Render previews as inert (no input focus, no click handlers)
    this.renderUpcomingPreviews(body);
  }

  // ─── Shared Input Card Helper ───────────────────────────────

  /**
   * Renders a card with: question → text input → hidden answer → marking.
   * Supports three modes via opts:
   *   - checkAnswer only: instant local check (Cloze, Solve Equation, Assemble Equation)
   *   - llmMarker: exact-match shortcut → LLM fallback (Q&A autoMark, Correct the Mistake, Explain Why)
   *   - Both can have autoSubmitOnMatch for auto-submit when typed answer matches locally
   */
  private async renderInputCard(
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
    await MarkdownRenderer.render(this.app, opts.questionMd, questionSection.createDiv(), "", this);

    const inputSection = card.createDiv({ cls: "iris-user-answer" });
    const attrs: Record<string, string> = {};
    if (opts.inputMode) attrs.inputmode = opts.inputMode;
    const input = inputSection.createEl("input", { type: "text", cls: "iris-answer-input", attr: attrs });

    const answerSection = card.createDiv({ cls: "iris-answer iris-hidden" });
    await MarkdownRenderer.render(this.app, opts.answerMd, answerSection.createDiv(), "", this);

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
        this.playFeedback(false);
        showResult(false);
        await new Promise(r => setTimeout(r, 1200));
        await this.rateCard(cardFile, false, undefined, variant.question, elapsedMs);
        return;
      }

      // Local check mode (Cloze, Solve Equation, Assemble Equation)
      if (opts.checkAnswer && !opts.llmMarker) {
        const correct = opts.checkAnswer(userAnswer);
        this.playFeedback(correct, isRecord(elapsedMs, correct));
        showResult(correct);
        if (!correct) {
          this.addAppealButton(card, cardFile, variant, userAnswer, markingEl, opts.questionMd);
        }
        await new Promise(r => setTimeout(r, correct ? 800 : 1200));
        await this.rateCard(cardFile, correct, correct ? userAnswer : undefined, variant.question, elapsedMs);
        return;
      }

      // LLM marker mode: try exact match first, then fall back to LLM
      if (isExactMatch?.(userAnswer)) {
        this.playFeedback(true, isRecord(elapsedMs, true));
        showResult(true);
        await new Promise(r => setTimeout(r, 800));
        await this.rateCard(cardFile, true, userAnswer, variant.question, elapsedMs);
        return;
      }

      input.disabled = true;
      const marking =card.createEl("p", { text: "Marking\u2026", cls: "iris-loading" });
      try {
        const correct = await markAnswer(
          opts.llmMarker!.question, opts.llmMarker!.answer, userAnswer,
          opts.llmMarker!.apiKey, this.plugin.settings.claudeModel,
        );
        marking.remove();
        this.playFeedback(correct, isRecord(elapsedMs, correct));
        showResult(correct);
        if (!correct) {
          this.addAppealButton(card, cardFile, variant, userAnswer, markingEl);
        }
        await new Promise(r => setTimeout(r, correct ? 800 : 1200));
        await this.rateCard(cardFile, correct, correct ? userAnswer : undefined, variant.question, elapsedMs);
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

  // ─── Appeal Helper ─────────────────────────────────────────

  private addAppealButton(
    card: HTMLElement,
    cardFile: TFile,
    variant: QAVariant,
    userAnswer: string,
    markingEl: HTMLElement,
    appealQuestion?: string,
  ): void {
    const apiKey = this.plugin.settings.anthropicApiKey;
    if (!apiKey) return;

    const preStability = getStability(this.app.metadataCache.getFileCache(cardFile)?.frontmatter);

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
          this.playFeedback(true);
          await this.app.fileManager.processFrontMatter(cardFile, (fm) => {
            fm["stability"] = updateStability(preStability, true);
            delete fm["box"];
          });
          await this.plugin.cardStore.addAcceptedAnswer(cardFile, variant.question, userAnswer);
          markingEl.setText("Correct");
          markingEl.addClass("iris-marking-correct");
          appealBtn.remove();
          this.plugin.updateBadge();
        } else {
          this.playFeedback(false);
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

  // ─── Q&A Renderer ──────────────────────────────────────────

  private async renderQA(
    card: HTMLElement, cardFile: TFile, variant: QAVariant, apiKey: string,
  ): Promise<void> {
    if (this.plugin.settings.autoMark) {
      await this.renderInputCard(card, cardFile, variant, {
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
    await MarkdownRenderer.render(this.app, variant.question, questionSection.createDiv(), "", this);

    const showBtn = card.createEl("button", {
      cls: "iris-show-btn",
      attr: { "aria-label": "Show answer" },
    });
    setIcon(showBtn, "eye");

    const answerSection = card.createDiv({ cls: "iris-answer iris-hidden" });
    await MarkdownRenderer.render(this.app, variant.answer, answerSection.createDiv(), "", this);

    const actions = card.createDiv({ cls: "iris-actions iris-hidden" });

    const wrongBtn = actions.createEl("button", { cls: "iris-wrong-btn", attr: { "aria-label": "Wrong" } });
    setIcon(wrongBtn, "x");
    wrongBtn.addEventListener("click", () => {
      const elapsedMs = Math.round(performance.now() - t0);
      this.playFeedback(false);
      this.rateCard(cardFile, false, undefined, variant.question, elapsedMs);
    });

    const rightBtn = actions.createEl("button", { cls: "iris-right-btn", attr: { "aria-label": "Right" } });
    setIcon(rightBtn, "check");
    rightBtn.addEventListener("click", () => {
      const elapsedMs = Math.round(performance.now() - t0);
      const record = variant.recordMs != null && elapsedMs < variant.recordMs;
      this.playFeedback(true, record);
      this.rateCard(cardFile, true, undefined, variant.question, elapsedMs);
    });

    showBtn.addEventListener("click", () => {
      answerSection.removeClass("iris-hidden");
      showBtn.addClass("iris-hidden");
      actions.removeClass("iris-hidden");
    });
  }

  // ─── Choice Card Renderer (MC + True/False) ────────────────────

  private async renderChoiceCard(
    card: HTMLElement, cardFile: TFile, variant: QAVariant,
    opts: { questionMd: string; options: { label: string; value: string; cls?: string }[]; correct: string; optionsCls?: string },
  ): Promise<void> {
    const questionSection = card.createDiv({ cls: "iris-question" });
    await MarkdownRenderer.render(this.app, opts.questionMd, questionSection.createDiv(), "", this);

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
        this.playFeedback(correct, record);

        for (const child of Array.from(optionsSection.querySelectorAll<HTMLButtonElement>(".iris-mc-option"))) {
          child.disabled = true;
          if (child.dataset.value === opts.correct) {
            child.addClass("iris-mc-correct");
          } else if (child === btn && !correct) {
            child.addClass("iris-mc-incorrect");
          }
        }

        await new Promise(r => setTimeout(r, correct ? 800 : 1200));
        await this.rateCard(cardFile, correct, undefined, variant.question, elapsedMs);
      });
    }
  }

  // ─── Cloze Renderer ──────────────────────────────────────────

  private async renderCloze(
    card: HTMLElement, cardFile: TFile, variant: QAVariant,
  ): Promise<void> {
    const sentence = variant.question;
    const terms = parseClozeTerms(sentence);
    if (terms.length === 0) {
      card.createEl("p", { text: sentence });
      return;
    }

    const rs = this.getRenderState(cardFile, variant);
    const occludeIdx = (rs.clozeIdx as number) ?? (rs.clozeIdx = Math.floor(Math.random() * terms.length));
    const { display, answer } = occludeCloze(sentence, occludeIdx);
    const allAnswers = [answer, ...variant.acceptedAnswers];

    // Full sentence with the occluded term bolded
    let ti = 0;
    const filled = sentence.replace(/\*([^*]+)\*/g, (_, term) => ti++ === occludeIdx ? `**${term}**` : term);

    await this.renderInputCard(card, cardFile, variant, {
      questionMd: display,
      answerMd: filled,
      checkAnswer: (val) => allAnswers.some(a => normalizeAnswer(a) === normalizeAnswer(val)),
      autoSubmitOnMatch: true,
    });
  }

  // ─── Solve Equation Renderer ──────────────────────────────────

  private async renderSolveEquation(
    card: HTMLElement, cardFile: TFile, variant: QAVariant,
  ): Promise<void> {
    let se;
    try {
      se = decodeSolveEquation(variant.question, variant.answer);
    } catch {
      card.createEl("p", { text: "Malformed equation problem.", cls: "iris-error" });
      return;
    }

    const rs = this.getRenderState(cardFile, variant);
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

    await this.renderInputCard(card, cardFile, variant, {
      questionMd: display,
      answerMd: `${expected} ${se.target.units}`,
      checkAnswer: (val) => {
        const num = parseFloat(val);
        return !isNaN(num) && checkNumericalAnswer(num, expected, se.target.sigfigs);
      },
      inputMode: "decimal",
    });
  }

  // ─── Assemble Equation Renderer ──────────────────────────────

  private async renderAssembleEquation(
    card: HTMLElement, cardFile: TFile, variant: QAVariant,
  ): Promise<void> {
    const title = variant.question;
    const equation = variant.answer;
    const terms = parseClozeTerms(equation);
    if (terms.length < 2) {
      card.createEl("p", { text: "Malformed equation.", cls: "iris-error" });
      return;
    }

    const rs = this.getRenderState(cardFile, variant);
    const occludeIdx = (rs.clozeIdx as number) ?? (rs.clozeIdx = Math.floor(Math.random() * terms.length));
    const { display, answer } = occludeCloze(equation, occludeIdx);
    const allAnswers = [answer, ...variant.acceptedAnswers];

    // Full equation with the occluded term bolded
    let ti = 0;
    const filled = equation.replace(/\*([^*]+)\*/g, (_, term) => ti++ === occludeIdx ? `**${term}**` : term);

    await this.renderInputCard(card, cardFile, variant, {
      questionMd: `**${title}**\n\n${display}`,
      answerMd: `**${title}**\n\n${filled}`,
      checkAnswer: (val) => allAnswers.some(a => normalizeAnswer(a) === normalizeAnswer(val)),
      autoSubmitOnMatch: true,
    });
  }

  // ─── Order Steps Renderer ──────────────────────────────────────

  private async renderOrderSteps(
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
    await MarkdownRenderer.render(this.app, `**Order the steps:** ${os.title}`, questionSection.createDiv(), "", this);

    // Drag-to-reorder list
    const listEl = card.createDiv({ cls: "iris-order-list" });
    const rs = this.getRenderState(cardFile, variant);
    const order = (rs.shuffledOrder as { text: string; origIdx: number }[]) ??
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
      this.playFeedback(correct, record);

      // Mark each row correct/incorrect and disable dragging
      const rows = Array.from(listEl.querySelectorAll(".iris-order-row"));
      rows.forEach((row, i) => {
        row.setAttribute("draggable", "false");
        row.addClass(order[i].text === os.steps[i] ? "iris-order-correct" : "iris-order-incorrect");
      });

      // Show correct order
      const answerSection = card.createDiv({ cls: "iris-answer" });
      const correctMd = os.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
      await MarkdownRenderer.render(this.app, correctMd, answerSection.createDiv(), "", this);

      const markingEl = card.createDiv({ cls: "iris-marking" });
      markingEl.setText(correct ? "Correct" : "Incorrect");
      markingEl.addClass(correct ? "iris-marking-correct" : "iris-marking-incorrect");

      await new Promise(r => setTimeout(r, correct ? 800 : 1200));
      await this.rateCard(cardFile, correct, undefined, variant.question, elapsedMs);
    });
  }

  private async renderUpcomingPreviews(body: HTMLDivElement): Promise<void> {
    const apiKey = this.plugin.settings.anthropicApiKey ?? "";
    for (let i = 1; i < this.dueCards.length; i++) {
      const file = this.dueCards[i];
      const content = await this.app.vault.cachedRead(file);
      const parsed = parseQABlock(content);
      const active = parsed.variants.filter(v => !v.suspended);
      if (active.length === 0) continue;
      const variant = active.reduce((oldest, v) => {
        if (oldest.lastReviewed === null) return oldest;
        if (v.lastReviewed === null) return v;
        return v.lastReviewed < oldest.lastReviewed ? v : oldest;
      });
      const preview = body.createDiv({ cls: "iris-card iris-card-preview", attr: { inert: "" } });
      await this.renderVariantInto(preview, file, variant, apiKey);
    }
  }

  private playFeedback(correct: boolean, record?: boolean): void {
    if (this.plugin.settings.soundFeedback) {
      const ctx = this.getAudioCtx();
      const now = ctx.currentTime;

      if (correct) {
        [0, 0.12].forEach((offset, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = i === 0 ? 523.25 : 659.25;
          osc.connect(gain);
          gain.connect(ctx.destination);
          gain.gain.setValueAtTime(0.001, now + offset);
          gain.gain.linearRampToValueAtTime(0.15, now + offset + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.5);
          osc.start(now + offset);
          osc.stop(now + offset + 0.5);
        });
      } else {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "square";
        osc.frequency.value = 220;
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.3);
      }
    }

    if (this.plugin.settings.flashFeedback) {
      const flash = this.contentEl.createDiv({ cls: "iris-flash" });
      flash.addClass(record ? "iris-flash-record" : correct ? "iris-flash-correct" : "iris-flash-incorrect");
      setTimeout(() => flash.remove(), 500);
    }

    if (record && this.currentCardEl) {
      const icon = this.currentCardEl.createDiv({ cls: "iris-record-icon" });
      setIcon(icon, "zap");
      setTimeout(() => icon.remove(), 1500);
    }
  }

  private async rateCard(file: TFile, correct: boolean, userAnswer?: string, questionShown?: string, elapsedMs?: number): Promise<void> {
    // Freeze the current card as answered — disable interactions, keep answer visible
    if (this.currentCardEl) {
      this.currentCardEl.addClass("iris-card-answered");
      // Reveal answer in manual mode
      this.currentCardEl.querySelectorAll(".iris-answer").forEach(el => el.removeClass("iris-hidden"));
      // Remove elements that no longer apply; keep suspend + appeal for scroll-back
      this.currentCardEl.querySelectorAll(".iris-skip-card-btn, .iris-actions, .iris-show-btn").forEach(el => el.remove());
      this.currentCardEl.querySelectorAll<HTMLInputElement>(".iris-answer-input").forEach(el => { el.disabled = true; });
    }

    this.plugin.qaCache.delete(file.path);
    if (questionShown) this.renderStateCache.delete(file.path + "::" + questionShown);
    await this.plugin.cardStore.recordReview(file, correct, questionShown, userAnswer, elapsedMs);

    if (this.infiniteMode) {
      const card = this.dueCards.shift();
      if (card) this.dueCards.push(card);
      // If queue is empty somehow, reload
      if (this.dueCards.length === 0) {
        this.shownVariants.clear();
        await this.loadDueCards();
        return;
      }
    } else {
      this.dueCards.shift();
    }
    this.plugin.updateBadge();
    await this.showNextCard();
  }
}
