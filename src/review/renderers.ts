import { type App, type Component, Component as ComponentImpl, Modal, Platform, TFile, MarkdownRenderer, setIcon } from "obsidian";
import type IrisCardsPlugin from "../main";
import { type ParsedQA, type QAVariant, type ExerciseType } from "../types/exercises";
import { parseQABlock } from "../types/qa-block";
import { decodeGapAlt } from "../types/gap-alternates";
import { markAnswer, appealAnswer } from "../generators/qa";
import { parseClozeTerms, occludeCloze } from "../generators/cloze";
import { decodeMC } from "../generators/multiple-choice";
import { decodeTFPair } from "../generators/true-false";
import { decodeSolveEquation, randomizeKnowns, evaluateFormula, roundToSigFigs, checkNumericalAnswer } from "../generators/solve-equation";
import { decodeNumberRanges } from "../generators/correct-mistake";
import { decodeOrderSteps, shuffleArray } from "../generators/order-steps";
import { decodeRank } from "../generators/rank";
import { decodeList, markList } from "../generators/list";
import { decodePairs, isTypeableContent } from "../generators/pairs";
import { decodeMultiStep } from "../generators/multi-step";
import { decodeImageOcclusion } from "../types/image-occlusion";
import { llmMarkingEnabled } from "../ai";
import { editableTypeId, CardEditModal } from "./card-author";
import { updateStability, getStability, getDifficulty, updateDifficulty, GRADE_AGAIN, GRADE_HARD, GRADE_GOOD, GRADE_EASY, getLeitnerBox, leitnerNextBox, leitnerDueIso, computeNextDue, getParentNoteName } from "../scheduler";
import { type ReviewView } from "./review-view";
import { normalizeAnswer } from "../utils/text";
import { getOrInit, tfShowTrue, clozeIndex } from "./render-state";

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
  infiniteMode: boolean;
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
    this.setTitle(this.file.basename);
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
 * Parse-block cache shared between the full review view and the homepage
 * widget's advance prefetch. Keyed on `(path, mtime)`
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

/**
 * Callback renderers invoke when the user answers. Encapsulates timer, feedback,
 * and rating.
 */
export type AnswerFn = (correct: boolean, userAnswer?: string, gapTerm?: string, grade?: number) => Promise<void>;

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
  const fn: AnswerFn = async (correct: boolean, userAnswer?: string, gapTerm?: string, grade?: number) => {
    const elapsedMs = Math.round(performance.now() - t0);
    await view.rateCard(cardFile, correct, userAnswer, variant.question, elapsedMs, gapTerm, grade);
  };
  return fn;
}

// ─── Rating Keys ────────────────────────────────────────────────────────

/** Display metadata for each FSRS grade — single source for label/colour/key. */
const GRADE_META: Record<number, { label: string; cls: string; key: string }> = {
  [GRADE_AGAIN]: { label: "Again", cls: "iris-rate-again", key: "0" },
  [GRADE_HARD]:  { label: "Hard",  cls: "iris-rate-hard",  key: "1" },
  [GRADE_GOOD]:  { label: "Good",  cls: "iris-rate-good",  key: "2" },
  [GRADE_EASY]:  { label: "Easy",  cls: "iris-rate-easy",  key: "3" },
};

/** Grades offered after a card is answered *correctly* (Again is implicit-wrong). */
const POST_GRADES = [GRADE_HARD, GRADE_GOOD, GRADE_EASY];
/** Grades offered for self-graded (manual reveal) cards. */
const SELF_GRADES = [GRADE_AGAIN, GRADE_HARD, GRADE_GOOD, GRADE_EASY];

function gradeKeyMap(grades: number[]): Record<string, number> {
  return Object.fromEntries(grades.map(g => [GRADE_META[g].key, g]));
}

/**
 * Per-view registry of the single active rating-key listener. Binding a new
 * one disposes the prior (so a card replaced without rating doesn't leave a
 * stale capture-phase document listener that could fire for the wrong card),
 * and a one-time sweeper tied to the view's Component lifecycle removes the
 * active listener on view close / plugin unload.
 */
const activeRatingKeyCleanup = new WeakMap<Component, () => void>();
const ratingKeySweeperInstalled = new WeakSet<Component>();

/**
 * Visible flash before a key-selected grade commits. The rating buttons are
 * removed synchronously when the card advances, so the highlight needs a beat
 * to paint before onRate tears the card down.
 */
const KEY_FLASH_MS = 130;

/** Find the rating button in `container` that represents `grade`. */
function buttonForGrade(container: HTMLElement, grade: number): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`.${GRADE_META[grade].cls}`);
}

/**
 * Low-level card key listener: one live document listener per view (binding a
 * new one replaces the prior), swept on view unload. `handler` gets the event
 * plus its own cleanup so it can unbind once it consumes a key.
 */
function bindCardKeyListener(
  view: Component,
  handler: (e: KeyboardEvent, cleanup: () => void) => void,
): () => void {
  // Replace any listener still bound from a previous card in this view.
  activeRatingKeyCleanup.get(view)?.();

  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    handler(e, cleanup);
  };
  const cleanup = () => {
    document.removeEventListener("keydown", onKey, true);
    if (activeRatingKeyCleanup.get(view) === cleanup) activeRatingKeyCleanup.delete(view);
  };
  document.addEventListener("keydown", onKey, true);
  activeRatingKeyCleanup.set(view, cleanup);

  // Install exactly one unload sweeper per view so the active listener is
  // always removed on onClose()/unload, even if the card is never rated.
  if (!ratingKeySweeperInstalled.has(view)) {
    ratingKeySweeperInstalled.add(view);
    view.register(() => activeRatingKeyCleanup.get(view)?.());
  }

  return cleanup;
}

/** Bind digit keys to select a rating grade. Returns a cleanup function. */
function bindRatingKeys(
  view: Component,
  container: HTMLElement,
  gradeMap: Record<string, number>,
  onRate: (grade: number) => void,
): () => void {
  return bindCardKeyListener(view, (e, cleanup) => {
    const grade = gradeMap[e.key];
    if (grade == null) return;
    e.preventDefault();
    cleanup();
    // Light up the button this key maps to so the user can confirm the
    // key→button correspondence, then commit the grade after a brief flash.
    const btn = buttonForGrade(container, grade);
    if (btn) {
      btn.addClass("iris-rate-key-active");
      window.setTimeout(() => onRate(grade), KEY_FLASH_MS);
    } else {
      onRate(grade);
    }
  });
}

/**
 * Bind letter keys to option buttons (e.g. T/F on true-false cards). The key
 * clicks the matching option, so grading flows through the normal click path.
 */
function bindChoiceKeys(
  view: Component,
  optionsSection: HTMLElement,
  keyToValue: Record<string, string>,
): () => void {
  return bindCardKeyListener(view, (e, cleanup) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const value = keyToValue[e.key.toLowerCase()];
    if (value == null) return;
    const btn = optionsSection.querySelector<HTMLButtonElement>(`.iris-mc-option[data-value="${value}"]`);
    if (!btn || btn.disabled) return;
    e.preventDefault();
    cleanup();
    btn.click();
  });
}

// ─── Card Controller ────────────────────────────────────────────────────

/**
 * One controller per rendered card. It is the single owner of everything the
 * per-type renderers used to re-implement:
 *
 *   - the answer-once guard (claimed via `begin()`, released on retry via
 *     `abort()`, sealed by `resolve()`),
 *   - the speed-`record` timer and the `playFeedback` call,
 *   - the post-answer rating buttons (Hard/Good/Easy) and the manual self-grade
 *     buttons (Again/Hard/Good/Easy), including their 1–4 keyboard bindings and
 *     the peeked/infinite "auto-Next" shortcut,
 *   - whether interaction is wired at all (`interactive` is false for the
 *     upcoming-card previews, so a preview paints its question/options but
 *     attaches no listeners and steals no focus).
 *
 * Renderers present their own result DOM (fill the canonical answer, colour the
 * options, add an appeal button) and then hand the verdict to `resolve()`.
 */
class CardController {
  private settled = false;
  private busy = false;
  private readonly t0 = performance.now();

  constructor(
    private readonly view: RenderContext,
    private readonly card: HTMLElement,
    private readonly answer: AnswerFn,
    private readonly variant: QAVariant,
    readonly interactive: boolean,
  ) {}

  /** Attach an event listener — a no-op for non-interactive previews. */
  on<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    if (!this.interactive) return;
    el.addEventListener(type, handler, options);
  }

  /** Focus an element — a no-op for non-interactive previews. */
  focus(el: HTMLElement | null | undefined): void {
    if (this.interactive) el?.focus();
  }

  /**
   * Autofocus when a card first renders. Skipped on mobile: focusing an input
   * pops the virtual keyboard the moment the card appears, which shoves the
   * question off-screen before it can be read. Mid-flow focus (advancing to
   * the next field while already typing) still uses `focus`.
   */
  focusInitial(el: HTMLElement | null | undefined): void {
    if (!Platform.isMobile) this.focus(el);
  }

  /** True once a terminal verdict has been recorded. */
  get done(): boolean { return this.settled; }

  /** True once an attempt is in flight or settled — used to freeze drag/touch. */
  get locked(): boolean { return this.busy || this.settled; }

  /** Claim the answer slot. Returns false if an attempt is in flight or settled. */
  begin(): boolean {
    if (this.locked) return false;
    this.busy = true;
    return true;
  }

  /** Release an in-flight attempt without settling (e.g. marking backend down). */
  abort(): void { this.busy = false; }

  private isRecord(correct: boolean): boolean {
    return correct
      && this.variant.recordMs != null
      && performance.now() - this.t0 < this.variant.recordMs;
  }

  /**
   * Fire sound/flash/record feedback for an outcome. `record` defaults to a
   * speed-record check against the card's best time; self-graded paths (manual
   * reveal, error fallback) pass `false` since their timing isn't comparable.
   */
  feedback(correct: boolean, record: boolean = this.isRecord(correct)): void {
    this.view.playFeedback(correct, record);
  }

  /**
   * Terminal resolution of a self-checked card: fire feedback, then route —
   * correct → Hard/Good/Easy rating (or auto-Next when peeked/infinite);
   * incorrect → immediate Again. Renderers that need to present a result first
   * (fill the answer, colour options, add an appeal button) do so, then call
   * this. No-ops if already settled.
   */
  async resolve(correct: boolean, opts: { userAnswer?: string; gapTerm?: string } = {}): Promise<void> {
    this.busy = false;
    if (this.settled) return;
    this.settled = true;
    this.feedback(correct);
    if (correct) {
      this.showPostRating(opts.userAnswer, opts.gapTerm);
    } else {
      await this.answer(false, opts.userAnswer, opts.gapTerm, GRADE_AGAIN);
    }
  }

  /**
   * Pre-render the Hard/Good/Easy rating buttons invisibly (space-reserving) so
   * a typed-input / list card is sized correctly before the answer is revealed.
   */
  prerenderRating(): HTMLElement {
    const rating = this.card.createDiv({ cls: "iris-actions iris-post-rating iris-pre-rating" });
    for (const g of POST_GRADES) {
      const m = GRADE_META[g];
      rating.createEl("button", { cls: `iris-rate-btn ${m.cls}`, text: m.label, attr: { "aria-label": m.label } });
    }
    return rating;
  }

  /** Post-correct rating: reveal/create Hard/Good/Easy, or auto-Next when peeked. */
  private showPostRating(userAnswer?: string, gapTerm?: string): void {
    if (this.view.peekedAnswer || this.view.infiniteMode) {
      this.card.querySelector(".iris-post-rating")?.remove();
      void this.answer(true, userAnswer, gapTerm, GRADE_GOOD);
      return;
    }
    let rating = this.card.querySelector<HTMLElement>(".iris-post-rating");
    if (!rating) {
      rating = this.card.createDiv({ cls: "iris-actions iris-post-rating" });
      for (const g of POST_GRADES) {
        const m = GRADE_META[g];
        rating.createEl("button", { cls: `iris-rate-btn ${m.cls}`, text: m.label, attr: { "aria-label": `${m.label} [${m.key}]` } });
      }
    }
    rating.removeClass("iris-pre-rating");
    this.wireGradeButtons(rating, POST_GRADES, (grade) => void this.answer(true, userAnswer, gapTerm, grade));
  }

  /**
   * Render a fresh set of grade buttons into `container` and wire them. Used for
   * the manual-reveal self-grade (Again/Hard/Good/Easy) and the error fallback.
   */
  renderGradeButtons(container: HTMLElement, grades: number[], onPick: (grade: number) => void): void {
    for (const g of grades) {
      const m = GRADE_META[g];
      container.createEl("button", { cls: `iris-rate-btn ${m.cls}`, text: m.label, attr: { "aria-label": `${m.label} [${m.key}]` } });
    }
    this.wireGradeButtons(container, grades, onPick);
  }

  /**
   * Bind clicks + 1–4 keys onto grade buttons already present in `container`,
   * with a one-shot guard so a card is graded exactly once. No keyboard binding
   * is installed for non-interactive previews.
   */
  private wireGradeButtons(container: HTMLElement, grades: number[], onPick: (grade: number) => void): void {
    let clicked = false;
    const pick = (grade: number) => { if (!clicked) { clicked = true; onPick(grade); } };
    const cleanup = this.interactive ? bindRatingKeys(this.view, container, gradeKeyMap(grades), pick) : () => {};
    for (const btn of Array.from(container.querySelectorAll<HTMLButtonElement>(".iris-rate-btn"))) {
      this.on(btn, "click", () => {
        if (clicked) return;
        cleanup();
        pick(gradeOfButton(btn, grades));
      });
    }
  }
}

/** Recover the grade a rating button represents from its colour class. */
function gradeOfButton(btn: HTMLElement, grades: number[]): number {
  for (const g of grades) {
    if (btn.hasClass(GRADE_META[g].cls)) return g;
  }
  return GRADE_GOOD;
}

/** Thrown by a renderer when a card's stored data can't be displayed. */
class CardRenderError extends Error {}

// ─── Render Args ────────────────────────────────────────────────────────

/** Everything a per-type renderer needs, bundled so signatures stay flat. */
interface RenderArgs {
  view: RenderContext;
  card: HTMLElement;
  cardFile: TFile;
  variant: QAVariant;
  answer: AnswerFn;
  controller: CardController;
}

// ─── Shared Rendering Primitives ────────────────────────────────────────

/**
 * Manual (self-graded) mode: question -> [optional text input] -> reveal answer
 * -> Again/Hard/Good/Easy buttons.
 *
 * With `opts.input`, the user types their answer first (active recall); pressing
 * Enter reveals the canonical answer, and the typed text stays on screen
 * (disabled) beside it for comparison. The self-grade is the verdict, and the
 * typed answer is recorded alongside it (Again -> knownIncorrect, otherwise ->
 * acceptedAnswers), the same as the AI-marking path.
 *
 * With `opts.match`, a typed answer that exactly matches (after normalization)
 * auto-reveals as correct and offers the post-correct Hard/Good/Easy rating —
 * the manual-mode counterpart of `autoSubmitOnMatch`.
 */
async function renderManualReveal(
  a: RenderArgs, questionMd: string, answerMd: string,
  opts: { input?: boolean; match?: string[]; gapTerm?: string } = {},
): Promise<void> {
  const { view, card, controller, answer } = a;
  const questionSection = card.createDiv({ cls: "iris-question" });
  await MarkdownRenderer.render(view.app, questionMd, questionSection.createDiv(), "", view);

  let input: HTMLInputElement | null = null;
  if (opts.input) {
    const inputSection = card.createDiv({ cls: "iris-user-answer" });
    input = inputSection.createEl("input", { type: "text", cls: "iris-answer-input" });
  }

  // With an input, Enter is the reveal — the eye button would be redundant.
  let showBtn: HTMLButtonElement | null = null;
  if (!input) {
    showBtn = card.createEl("button", {
      cls: "iris-show-btn",
      attr: { "aria-label": "Show answer" },
    });
    setIcon(showBtn, "eye");
  }

  const answerSection = card.createDiv({ cls: "iris-answer iris-hidden" });
  await MarkdownRenderer.render(view.app, answerMd, answerSection.createDiv(), "", view);

  const typedAnswer = () => input?.value.trim() || undefined;

  const actions = card.createDiv({ cls: "iris-actions iris-hidden" });
  controller.renderGradeButtons(actions, SELF_GRADES, (grade) => {
    const correct = grade !== GRADE_AGAIN;
    controller.feedback(correct, false);
    void answer(correct, typedAnswer(), opts.gapTerm, grade);
  });

  let revealed = false;
  const reveal = (showActions = true) => {
    if (revealed) return;
    revealed = true;
    if (input) input.disabled = true;
    answerSection.removeClass("iris-hidden");
    showBtn?.addClass("iris-hidden");
    if (!showActions) return;
    if (view.infiniteMode) {
      // Infinite mode auto-advances on every other card type — do the same
      // here instead of demanding an extra "Next" press. The revealed answer
      // stays on the answered card above the incoming one.
      void answer(true, typedAnswer(), opts.gapTerm, GRADE_GOOD);
    } else if (view.peekedAnswer) {
      const next = card.createDiv({ cls: "iris-actions" });
      const btn = next.createEl("button", { cls: "iris-rate-btn iris-rate-good", text: "Next" });
      controller.on(btn, "click", () => void answer(true, typedAnswer(), opts.gapTerm, GRADE_GOOD));
    } else {
      actions.removeClass("iris-hidden");
    }
  };

  if (showBtn) controller.on(showBtn, "click", () => reveal());
  if (input) {
    controller.on(input, "keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); reveal(); }
    });
    if (opts.match?.length) {
      const targets = opts.match.map(normalizeAnswer);
      controller.on(input, "input", () => {
        if (revealed || !targets.includes(normalizeAnswer(input!.value.trim()))) return;
        // Exact match is the one unambiguous verdict in a self-graded reveal — color
        // it green like the other card types. Non-exact answers stay uncolored
        // because there's no judgment to base a color on.
        input!.addClass("iris-answer-input-correct");
        controller.feedback(true, false);
        if (view.peekedAnswer || view.infiniteMode) { reveal(); return; }
        reveal(false);
        const rating = card.createDiv({ cls: "iris-actions" });
        controller.renderGradeButtons(rating, POST_GRADES, (grade) => {
          void answer(true, typedAnswer(), opts.gapTerm, grade);
        });
      });
    }
    controller.focusInitial(input);
  }
}

/** Options for the shared typed-input card. */
interface InputOpts {
  questionMd?: string;
  questionEl?: HTMLElement;
  canonicalAnswer: string;
  checkAnswer?: (input: string) => boolean;
  autoSubmitOnMatch?: boolean;
  inputMode?: string;
  llmMarker?: { question: string; answer?: string; acceptedAnswers?: string[] };
  knownIncorrect?: string[];
  gapTerm?: string;
  /** Spelling drill (Word): suppress the lenient LLM appeal button on a miss. */
  noAppeal?: boolean;
}

/**
 * Renders a card with: question -> text input -> marking.
 * On submit, the input is replaced in-place with the canonical answer so the
 * card never grows vertically. Grading modes:
 *   - checkAnswer: local check (Cloze, Solve Equation, Assemble Equation)
 *   - llmMarker: exact-match shortcut then LLM fallback (Q&A, Correct the Mistake)
 *   - Both: local check for auto-submit + LLM fallback for grading
 */
async function renderInputCard(a: RenderArgs, opts: InputOpts): Promise<void> {
  const { view, card, controller } = a;
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

  // Honest out: reveal the answer and take the Again, instead of guessing
  // (which pollutes marking) or typing filler.
  const dontKnowBtn = inputSection.createEl("button", { cls: "iris-dont-know-btn", text: "Don't know" });

  const markingEl = card.createDiv({ cls: "iris-marking" });
  controller.prerenderRating();

  controller.focusInitial(input);

  const showResult = (correct: boolean) => {
    dontKnowBtn.remove();
    markingEl.removeClass("iris-loading");
    markingEl.setText(correct ? (view.peekedAnswer ? "Correct (peeked)" : "Correct") : "Incorrect");
    markingEl.toggleClass("iris-marking-correct", correct);
    markingEl.toggleClass("iris-marking-incorrect", !correct);
    input.value = opts.canonicalAnswer;
    input.disabled = true;
    input.toggleClass("iris-answer-input-correct", correct);
    input.toggleClass("iris-answer-input-incorrect", !correct);
  };

  // Build exact-match checker from LLM marker for shortcut grading
  const isExactMatch = opts.llmMarker
    ? (val: string) => {
        const norm = normalizeAnswer(val);
        const all = [...(opts.llmMarker!.answer ? [opts.llmMarker!.answer] : []), ...(opts.llmMarker!.acceptedAnswers ?? [])];
        return all.length > 0 && all.some(a => normalizeAnswer(a) === norm);
      }
    : null;

  const isKnownIncorrect = opts.knownIncorrect?.length
    ? (val: string) => {
        const norm = normalizeAnswer(val);
        return opts.knownIncorrect!.some(a => normalizeAnswer(a) === norm);
      }
    : null;

  const submitAnswer = async () => {
    if (!controller.begin()) return;
    // Lock card height so async markdown finishers (MathJax, images, embeds)
    // can't grow the question section during the marking await window.
    card.style.height = `${card.offsetHeight}px`;
    const userAnswer = input.value.trim();

    if (!userAnswer) {
      showResult(false);
      await controller.resolve(false, { gapTerm: opts.gapTerm });
      return;
    }

    if (isKnownIncorrect?.(userAnswer)) {
      showResult(false);
      if (!opts.noAppeal) addAppealButton(a, userAnswer, markingEl, opts.questionMd);
      await controller.resolve(false, { userAnswer, gapTerm: opts.gapTerm });
      return;
    }

    // Local check (custom checker or exact-match shortcut)
    const localCheck = opts.checkAnswer ?? isExactMatch;
    if (localCheck?.(userAnswer)) {
      showResult(true);
      await controller.resolve(true, { userAnswer, gapTerm: opts.gapTerm });
      return;
    }

    // No LLM marker — local check is final
    if (!opts.llmMarker) {
      showResult(false);
      if (!opts.noAppeal) addAppealButton(a, userAnswer, markingEl, opts.questionMd);
      await controller.resolve(false, { userAnswer, gapTerm: opts.gapTerm });
      return;
    }

    // LLM fallback marking — reuse markingEl so the card doesn't grow mid-mark
    input.disabled = true;
    markingEl.setText("Marking…");
    markingEl.addClass("iris-loading");
    const apiKey = view.plugin.settings.anthropicApiKey;
    const mark = await markAnswer(
      opts.llmMarker.question, opts.llmMarker.answer, userAnswer,
      apiKey, view.plugin.settings.claudeModel,
    );
    if (!mark.ok) {
      // Marking couldn't run — surface the failure and let the user retry
      // instead of recording a verdict.
      controller.abort();
      input.disabled = false;
      markingEl.removeClass("iris-loading");
      markingEl.setText(`Marking failed: ${mark.error}`);
      markingEl.addClass("iris-marking-incorrect");
      return;
    }
    const correct = mark.value;
    showResult(correct);
    if (!correct) addAppealButton(a, userAnswer, markingEl);
    await controller.resolve(correct, { userAnswer, gapTerm: opts.gapTerm });
  };

  if (opts.autoSubmitOnMatch) {
    const checker = opts.checkAnswer ?? isExactMatch;
    if (checker) {
      controller.on(input, "input", () => {
        if (!controller.done && checker(input.value.trim())) void submitAnswer();
      });
    }
  }

  controller.on(input, "keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submitAnswer(); }
  });

  controller.on(dontKnowBtn, "click", async () => {
    if (!controller.begin()) return;
    card.style.height = `${card.offsetHeight}px`;
    showResult(false);
    await controller.resolve(false, { gapTerm: opts.gapTerm });
  });
}

// ─── Appeal Helper ─────────────────────────────────────────────────────

function addAppealButton(
  a: RenderArgs,
  userAnswer: string,
  markingEl: HTMLElement,
  appealQuestion?: string,
): void {
  const { view, card, cardFile, variant, controller } = a;
  if (!llmMarkingEnabled(view.plugin)) return;
  const apiKey = view.plugin.settings.anthropicApiKey;

  const preFm = view.app.metadataCache.getFileCache(cardFile)?.frontmatter;
  const preStability = getStability(preFm);
  const preDifficulty = getDifficulty(preFm);
  const preBox = getLeitnerBox(preFm, view.plugin.settings.desiredRetention);

  const appealBtn = card.createEl("button", {
    cls: "iris-card-icon iris-appeal-icon",
    attr: { "aria-label": "Appeal" },
  });
  setIcon(appealBtn, "scale");

  controller.on(appealBtn, "click", async () => {
    appealBtn.disabled = true;
    appealBtn.addClass("iris-loading");
    markingEl.setText("Remarking…");
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
          const newS = updateStability(preStability, preDifficulty, true);
          fm["stability"] = newS;
          fm["difficulty"] = updateDifficulty(preDifficulty, true);
          if (view.plugin.settings.scheduler === "leitner") {
            // The wrong verdict already demoted the card to box 1 — restore
            // the promotion the correct answer would have earned.
            const newBox = leitnerNextBox(preBox, true);
            fm["box"] = newBox;
            fm["next-due"] = leitnerDueIso(newBox);
          } else {
            delete fm["box"];
            // The wrong verdict wrote a next-due from the lapsed stability —
            // reschedule from the corrected one, as recordReview would have.
            fm["next-due"] = computeNextDue(
              view.app, view.plugin.settings.cardsFolder, newS,
              view.plugin.settings.desiredRetention, cardFile.path,
              getParentNoteName(fm),
            );
          }
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

// --- Q&A / Synonym ---

async function renderQA(a: RenderArgs): Promise<void> {
  const { view, variant } = a;
  if (llmMarkingEnabled(view.plugin)) {
    await renderInputCard(a, {
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
  await renderManualReveal(a, variant.question, variant.answer, {
    input: true,
    match: [variant.answer, ...variant.acceptedAnswers],
  });
}

// --- Choice (Multiple Choice + True/False + Rank) ---

interface ChoiceOpts {
  questionMd: string;
  options: { label: string; value: string; cls?: string; ariaLabel?: string }[];
  correct: string;
  optionsCls?: string;
  /** Letter shortcuts (lowercase key → option value), e.g. `{ t: "True" }`. */
  keys?: Record<string, string>;
}

/** Sentinel option value for "Don't know" — never matches a real answer. */
const DONT_KNOW = "__dont-know__";

async function renderChoiceCard(a: RenderArgs, opts: ChoiceOpts): Promise<void> {
  const { view, card, controller } = a;
  const questionSection = card.createDiv({ cls: "iris-question" });
  await MarkdownRenderer.render(view.app, opts.questionMd, questionSection.createDiv(), "", view);

  const optionsSection = card.createDiv({ cls: `iris-mc-options${opts.optionsCls ? " " + opts.optionsCls : ""}` });

  // "Don't know" reveals the answer and counts as incorrect — an honest out
  // that beats guessing (a lucky guess would schedule the card as known).
  const allOptions = [
    ...opts.options,
    { label: "Don't know", value: DONT_KNOW, cls: "iris-dont-know" },
  ];

  for (const opt of allOptions) {
    const btn = optionsSection.createEl("button", {
      cls: `iris-mc-option${opt.cls ? " " + opt.cls : ""}`,
      text: opt.label,
      attr: { "data-value": opt.value, ...("ariaLabel" in opt && opt.ariaLabel ? { "aria-label": opt.ariaLabel } : {}) },
    });

    controller.on(btn, "click", async () => {
      if (!controller.begin()) return;
      const correct = opt.value === opts.correct;

      for (const child of Array.from(optionsSection.querySelectorAll<HTMLButtonElement>(".iris-mc-option"))) {
        child.disabled = true;
        if (child.dataset.value === opts.correct) {
          child.addClass("iris-mc-correct");
        } else if (child === btn && !correct && opt.value !== DONT_KNOW) {
          child.addClass("iris-mc-incorrect");
        }
      }

      await controller.resolve(correct);
    });
  }

  if (controller.interactive && opts.keys) {
    bindChoiceKeys(view, optionsSection, opts.keys);
  }
}

async function renderMultipleChoice(a: RenderArgs): Promise<void> {
  const { view, cardFile, variant } = a;
  const mc = decodeMC(variant.question, variant.answer);
  const rs = view.getRenderState(cardFile, variant);
  const order = getOrInit(rs, "shuffledOptions", () => shuffleArray(mc.options));
  await renderChoiceCard(a, {
    questionMd: mc.question,
    options: order.map(o => ({ label: o.text, value: o.letter })),
    correct: mc.correct,
  });
}

async function renderTrueFalse(a: RenderArgs): Promise<void> {
  const { view, cardFile, variant } = a;
  const pair = decodeTFPair(variant.question);
  let statement: string;
  let correct: string;
  if (pair) {
    // Identical statements make the card unanswerable — whichever polarity is
    // shown, the user reads the same sentence but the "correct" button is a
    // hidden coin flip. Surface it for fixing instead of reviewing it.
    if (normalizeAnswer(pair.trueStatement) === normalizeAnswer(pair.falseStatement)) {
      throw new CardRenderError("This card's true and false statements are identical — edit the card to fix it.");
    }
    const rs = view.getRenderState(cardFile, variant);
    const showTrue = tfShowTrue(rs);
    statement = showTrue ? pair.trueStatement : pair.falseStatement;
    correct = showTrue ? "True" : "False";
  } else {
    statement = variant.question;
    correct = variant.answer;
  }
  await renderChoiceCard(a, {
    questionMd: `**True or false?**\n\n${statement}`,
    options: [
      { label: "True", value: "True", cls: "iris-tf-true", ariaLabel: "True [T]" },
      { label: "False", value: "False", cls: "iris-tf-false", ariaLabel: "False [F]" },
    ],
    correct,
    optionsCls: "iris-tf-options",
    keys: { t: "True", f: "False" },
  });
}

async function renderRank(a: RenderArgs): Promise<void> {
  const { view, cardFile, variant } = a;
  let r;
  try {
    r = decodeRank(variant.question, variant.answer);
  } catch {
    throw new CardRenderError("Malformed rank card.");
  }
  if (r.items.length < 2) throw new CardRenderError("Not enough items to compare.");

  // Persist the chosen pair + direction so re-renders and previews stay stable.
  const rs = view.getRenderState(cardFile, variant);

  // Property-series order mode: with 3+ ranked items, half the presentations
  // ask to place a random trio in order instead of comparing a pair.
  if (r.items.length >= 3 && getOrInit(rs, "rankOrderMode", () => Math.random() < 0.5)) {
    await renderRankOrder(a, r);
    return;
  }
  let pair = Array.isArray(rs.rankPair) ? (rs.rankPair as number[]) : null;
  if (!pair) {
    const n = r.items.length;
    const a0 = Math.floor(Math.random() * n);
    let b = Math.floor(Math.random() * (n - 1));
    if (b >= a0) b++; // pick b distinct from a0; display order [a0, b] is already random
    pair = rs.rankPair = [a0, b];
  }
  const more = getOrInit(rs, "rankMore", () => Math.random() < 0.5);

  const [iA, iB] = pair;
  // items are stored least→most, so the larger index has more of the property.
  const correctIdx = more ? Math.max(iA, iB) : Math.min(iA, iB);
  const adjective = more ? `more ${r.property}` : `less ${r.property}`;

  await renderChoiceCard(a, {
    questionMd: `**Which is ${adjective}?**`,
    options: [
      { label: r.items[iA], value: String(iA) },
      { label: r.items[iB], value: String(iB) },
    ],
    correct: String(correctIdx),
    optionsCls: "iris-rank-options",
  });
}

/**
 * Property-series order mode: three items from the ranking, clicked in order
 * of the property. Click-to-order (numbered as you click) rather than drag —
 * cheap on mobile and no drag plumbing.
 */
async function renderRankOrder(a: RenderArgs, r: { property: string; items: string[] }): Promise<void> {
  const { view, card, cardFile, variant, controller } = a;
  const rs = view.getRenderState(cardFile, variant);

  // Trio of item indices, ascending (= least→most of the property).
  const trio = getOrInit(rs, "rankOrderTrio", () =>
    shuffleArray(r.items.map((_, i) => i)).slice(0, 3).sort((x, y) => x - y),
  );
  const asc = getOrInit(rs, "rankOrderAsc", () => Math.random() < 0.5);
  const displayOrder = getOrInit(rs, "rankOrderDisplay", () => shuffleArray(trio.slice()));
  const expected = asc ? trio : trio.slice().reverse();
  const dirLabel = asc ? "least → most" : "most → least";

  const questionSection = card.createDiv({ cls: "iris-question" });
  await MarkdownRenderer.render(
    view.app,
    `**Place in order of ${r.property}** (${dirLabel}) — click in order:`,
    questionSection.createDiv(), "", view,
  );

  const optionsSection = card.createDiv({ cls: "iris-mc-options iris-series-options" });
  const picked: number[] = [];
  const buttons = new Map<number, HTMLButtonElement>();

  for (const idx of displayOrder) {
    const btn = optionsSection.createEl("button", { cls: "iris-mc-option iris-series-option" });
    btn.createSpan({ cls: "iris-series-num" });
    btn.createSpan({ text: r.items[idx] });
    buttons.set(idx, btn);

    controller.on(btn, "click", async () => {
      if (controller.locked || picked.includes(idx)) return;
      picked.push(idx);
      btn.addClass("iris-series-picked");
      const num = btn.querySelector<HTMLElement>(".iris-series-num");
      if (num) num.setText(String(picked.length));
      clearBtn.toggleClass("iris-hidden", picked.length === 0);
      if (picked.length < expected.length) return;

      if (!controller.begin()) return;
      clearBtn.remove();
      let correct = true;
      picked.forEach((itemIdx, pos) => {
        const b = buttons.get(itemIdx)!;
        b.disabled = true;
        const ok = expected[pos] === itemIdx;
        if (!ok) correct = false;
        b.addClass(ok ? "iris-mc-correct" : "iris-mc-incorrect");
      });
      for (const b of buttons.values()) b.disabled = true;

      const answerSection = card.createDiv({ cls: "iris-answer" });
      const correctMd = `**${dirLabel}:** ${expected.map(i => r.items[i]).join(" → ")}`;
      await MarkdownRenderer.render(view.app, correctMd, answerSection.createDiv(), "", view);

      await controller.resolve(correct);
    });
  }

  // Undo mid-sequence misclicks; hidden until something is picked, gone once graded.
  const clearBtn = card.createEl("button", { cls: "iris-series-clear iris-hidden", text: "Clear" });
  controller.on(clearBtn, "click", () => {
    if (controller.locked) return;
    picked.length = 0;
    for (const b of buttons.values()) {
      b.removeClass("iris-series-picked");
      const num = b.querySelector<HTMLElement>(".iris-series-num");
      if (num) num.setText("");
    }
    clearBtn.addClass("iris-hidden");
  });
}

// --- Cloze + Assemble Equation (occlude) ---

interface OccludeOpts {
  source: string;
  title?: string;
  minTerms?: number;
  errorText?: string;
  /** Spelling drill (Word): exact-match only, never fall back to fuzzy LLM marking. */
  strict?: boolean;
}

async function renderOcclude(a: RenderArgs, opts: OccludeOpts): Promise<void> {
  const { view, cardFile, variant } = a;
  const terms = parseClozeTerms(opts.source);
  if (terms.length < (opts.minTerms ?? 1)) {
    // A degenerate "Assemble Equation" (a single atomic formula with nothing to
    // split apart) would otherwise dead-end the review. If we have a title, fall
    // back to a basic reveal of the formula so the card stays usable.
    if (opts.title) {
      const plain = opts.source.replace(/\*([^*]+)\*/g, (_, raw) => raw.split("|")[0].trim());
      await renderManualReveal(a, `**${opts.title}**`, plain);
      return;
    }
    throw new CardRenderError(opts.errorText ?? "No cloze terms found in this card.");
  }

  const rs = view.getRenderState(cardFile, variant);
  // Weight the gap pick by each gap's own difficulty so the parts of the
  // cloze the user struggles with come up more often. Unseen gaps get a
  // slightly-above-average weight so new material still gets exposure.
  const weights = terms.map(t => variant.gapDifficulties?.[t] ?? 6);
  const occludeIdx = clozeIndex(rs, terms.length, weights);
  const { display, answer: term, alternates } = occludeCloze(opts.source, occludeIdx);
  // Accepted/incorrect answers are bound to the gap they were given for
  // (encoded as `term :: alt`); only this gap's entries apply here.
  const boundAccepted = variant.acceptedAnswers
    .map(decodeGapAlt)
    .filter(d => d.term === term || d.term === null)
    .map(d => d.alt);
  const boundIncorrect = variant.knownIncorrect
    .map(decodeGapAlt)
    .filter(d => d.term === term || d.term === null)
    .map(d => d.alt);
  const accepted = [...alternates, ...boundAccepted];

  let ti = 0;
  const filled = opts.source.replace(/\*([^*]+)\*/g, (_, raw) => {
    const canonical = raw.split("|")[0].trim();
    return ti++ === occludeIdx ? `**${canonical}**` : canonical;
  });

  const fmtQ = opts.title ? `**${opts.title}**\n\n${display}` : display;

  if (llmMarkingEnabled(view.plugin)) {
    const useLlm = !opts.strict;
    await renderInputCard(a, {
      questionMd: fmtQ,
      canonicalAnswer: term,
      autoSubmitOnMatch: true,
      gapTerm: term,
      llmMarker: useLlm ? {
        question: opts.title ? `${opts.title}\n${display}` : display,
        answer: term,
        acceptedAnswers: accepted,
      } : undefined,
      knownIncorrect: boundIncorrect,
      noAppeal: opts.strict,
      checkAnswer: (val) => {
        const norm = normalizeAnswer(val);
        return [term, ...accepted].some(x => normalizeAnswer(x) === norm);
      },
    });
    return;
  }

  // Manual mode: typed input, exactly like standard Q&A — an exact match on
  // the gap term auto-marks correct, Enter reveals the filled sentence for
  // self-grading.
  const fmtA = opts.title ? `**${opts.title}**\n\n${filled}` : filled;
  await renderManualReveal(a, fmtQ, fmtA, {
    input: true,
    match: [term, ...accepted],
    gapTerm: term,
  });
}

// --- Correct the Mistake ---

async function renderCorrectMistake(a: RenderArgs): Promise<void> {
  const { view, cardFile, variant } = a;
  const rs = view.getRenderState(cardFile, variant);
  const displayQ = decodeNumberRanges(variant.question, rs);
  const prompt = `**Find and correct the mistake:**\n\n${displayQ}`;
  if (llmMarkingEnabled(view.plugin)) {
    await renderInputCard(a, {
      questionMd: prompt,
      canonicalAnswer: variant.answer,
      autoSubmitOnMatch: true,
      llmMarker: {
        question: `The following statement contains a mistake:\n"${displayQ}"\n\nThe user was asked to correct it.`,
        acceptedAnswers: [variant.answer, ...variant.acceptedAnswers],
      },
      knownIncorrect: variant.knownIncorrect,
    });
    return;
  }
  await renderManualReveal(a, prompt, variant.answer, {
    input: true,
    match: [variant.answer, ...variant.acceptedAnswers],
  });
}

// --- Solve Equation ---

async function renderSolveEquation(a: RenderArgs): Promise<void> {
  const { view, cardFile, variant } = a;
  let se;
  try {
    se = decodeSolveEquation(variant.question, variant.answer);
  } catch {
    throw new CardRenderError("Malformed equation problem.");
  }

  const rs = view.getRenderState(cardFile, variant);
  const values = getOrInit(rs, "knownValues", () => randomizeKnowns(se.knowns));
  let expected: number;
  try {
    expected = evaluateFormula(se.formula, values);
    if (!isFinite(expected)) throw new Error("Non-finite result");
  } catch {
    throw new CardRenderError("Could not compute expected answer.");
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

  await renderInputCard(a, {
    questionEl,
    canonicalAnswer: `${expected} ${se.target.units}`,
    checkAnswer: (val) => {
      const num = parseFloat(val);
      return !isNaN(num) && checkNumericalAnswer(num, expected, se.target.sigfigs);
    },
    inputMode: "decimal",
  });
}

// --- Place in Order ---

async function renderOrderSteps(a: RenderArgs): Promise<void> {
  const { view, card, cardFile, variant, controller } = a;
  let os;
  try {
    os = decodeOrderSteps(variant.question, variant.answer);
  } catch {
    throw new CardRenderError("Malformed order-steps problem.");
  }

  if (os.steps.length < 2) throw new CardRenderError("Not enough steps to order.");

  const questionSection = card.createDiv({ cls: "iris-question" });
  await MarkdownRenderer.render(view.app, `**Order the steps:** ${os.title}`, questionSection.createDiv(), "", view);

  const listEl = card.createDiv({ cls: "iris-order-list" });
  const rs = view.getRenderState(cardFile, variant);
  const order = getOrInit(rs, "shuffledOrder", () =>
    shuffleArray(os.steps.map((text, origIdx) => ({ text, origIdx }))),
  );
  let dragIdx: number | null = null;

  const clearDropIndicators = () => {
    listEl.querySelectorAll(".iris-order-drop-above, .iris-order-drop-below")
      .forEach(el => { el.removeClass("iris-order-drop-above"); el.removeClass("iris-order-drop-below"); });
  };

  const reorder = (fromIdx: number, targetRowIdx: number, above: boolean) => {
    const [dragged] = order.splice(fromIdx, 1);
    let target = above ? targetRowIdx : targetRowIdx + 1;
    if (fromIdx < targetRowIdx) target--;
    order.splice(target, 0, dragged);
    renderRows();
  };

  const renderRows = () => {
    listEl.empty();
    order.forEach((item, i) => {
      const row = listEl.createDiv({
        cls: "iris-order-row",
        attr: { draggable: "true" },
      });
      const handle = row.createSpan({ cls: "iris-order-handle" });
      setIcon(handle, "grip-vertical");
      row.createSpan({ cls: "iris-order-text", text: item.text });

      controller.on(row, "dragstart", (e) => {
        dragIdx = i;
        row.addClass("iris-order-dragging");
        e.dataTransfer!.effectAllowed = "move";
      });

      controller.on(row, "dragend", () => {
        dragIdx = null;
        row.removeClass("iris-order-dragging");
        clearDropIndicators();
      });

      controller.on(row, "dragover", (e) => {
        e.preventDefault();
        if (dragIdx === null || dragIdx === i) return;
        const rect = row.getBoundingClientRect();
        const above = e.clientY < rect.top + rect.height / 2;
        row.toggleClass("iris-order-drop-above", above);
        row.toggleClass("iris-order-drop-below", !above);
      });

      controller.on(row, "dragleave", () => {
        row.removeClass("iris-order-drop-above");
        row.removeClass("iris-order-drop-below");
      });

      controller.on(row, "drop", (e) => {
        e.preventDefault();
        if (dragIdx === null || dragIdx === i) return;
        const rect = row.getBoundingClientRect();
        const above = e.clientY < rect.top + rect.height / 2;
        reorder(dragIdx, i, above);
      });

      // Touch support: drag from the grip handle. Bound to the handle (not the
      // whole row) so taps on the row text don't hijack page scrolling.
      controller.on(handle, "touchstart", (e) => {
        if (controller.locked) return;
        e.preventDefault();
        dragIdx = i;
        row.addClass("iris-order-dragging");
      }, { passive: false });

      controller.on(handle, "touchmove", (e) => {
        if (dragIdx === null) return;
        e.preventDefault();
        const touch = e.touches[0];
        const targetEl = document.elementFromPoint(touch.clientX, touch.clientY);
        const targetRow = targetEl?.closest(".iris-order-row") as HTMLElement | null;
        clearDropIndicators();
        if (targetRow && targetRow !== row) {
          const rect = targetRow.getBoundingClientRect();
          const above = touch.clientY < rect.top + rect.height / 2;
          targetRow.toggleClass("iris-order-drop-above", above);
          targetRow.toggleClass("iris-order-drop-below", !above);
        }
      }, { passive: false });

      controller.on(handle, "touchend", (e) => {
        if (dragIdx === null) return;
        const touch = e.changedTouches[0];
        const targetEl = document.elementFromPoint(touch.clientX, touch.clientY);
        const targetRow = targetEl?.closest(".iris-order-row") as HTMLElement | null;
        const rows = Array.from(listEl.querySelectorAll(".iris-order-row"));
        const targetIdx = targetRow ? rows.indexOf(targetRow) : -1;
        const from = dragIdx;
        dragIdx = null;
        row.removeClass("iris-order-dragging");
        clearDropIndicators();
        if (targetIdx !== -1 && targetIdx !== from) {
          const rect = targetRow!.getBoundingClientRect();
          const above = touch.clientY < rect.top + rect.height / 2;
          reorder(from, targetIdx, above);
        }
      });

      controller.on(handle, "touchcancel", () => {
        if (dragIdx === null) return;
        dragIdx = null;
        row.removeClass("iris-order-dragging");
        clearDropIndicators();
      });
    });
  };

  renderRows();

  const checkBtn = card.createEl("button", {
    cls: "iris-order-check",
    text: "Check",
  });

  controller.on(checkBtn, "click", async () => {
    if (!controller.begin()) return;
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

    await controller.resolve(correct);
  });
}

// --- List (free-recall, unordered) ---

async function renderList(a: RenderArgs): Promise<void> {
  const { view, card, variant, controller } = a;
  let l;
  try {
    l = decodeList(variant.question, variant.answer);
  } catch {
    throw new CardRenderError("Malformed list problem.");
  }
  if (l.items.length === 0) throw new CardRenderError("No items in list.");

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
  const markingEl = card.createDiv({ cls: "iris-marking" });
  controller.prerenderRating();

  controller.focusInitial(inputs[0]);

  const submit = async () => {
    if (!controller.begin()) return;
    // Lock height before mutating so revealing the answer/rating can't shift
    // the card — same pattern as renderInputCard.
    card.style.height = `${card.offsetHeight}px`;

    markingEl.addClass("iris-loading");
    markingEl.setText("Checking…");

    const userItems = inputs.map(i => i.value.trim());
    const apiKey = view.plugin.settings.anthropicApiKey;
    const model = view.plugin.settings.claudeModel;

    const mark = await markList(l.prompt, l.items, userItems, apiKey, model);
    if (!mark.ok) {
      // Marking couldn't run (e.g. keys out / backend unreachable). Surface the
      // failure and let the user retry instead of scoring the card wrong and
      // revealing the key. Same contract as renderInputCard.
      controller.abort();
      markingEl.removeClass("iris-loading");
      markingEl.setText(`Marking failed: ${mark.error}`);
      markingEl.addClass("iris-marking-incorrect");
      return;
    }
    const { results, missed } = mark.value;

    // Reveal each unrecalled item on a row the user didn't get right (empty or
    // wrong). Correct rows keep the user's answer. Counts always line up:
    // missed.length === number of non-correct rows.
    const missedQueue = [...missed];
    inputs.forEach((inp, i) => {
      inp.disabled = true;
      if (results[i]) {
        inp.addClass("iris-list-correct");
        return;
      }
      const item = missedQueue.shift();
      if (item != null) inp.value = item;
      inp.addClass("iris-list-incorrect");
    });

    const allCorrect = results.every(Boolean);

    markingEl.removeClass("iris-loading");
    markingEl.setText(allCorrect ? (view.peekedAnswer ? "Correct (peeked)" : "Correct") : "Incorrect");
    markingEl.toggleClass("iris-marking-correct", allCorrect);
    markingEl.toggleClass("iris-marking-incorrect", !allCorrect);

    await controller.resolve(allCorrect);
  };

  // Enter — or a perfect match auto-entered for you — advances to the next
  // field and submits from the last, mirroring the single-box cards' Enter +
  // autoSubmitOnMatch behaviour. The auto-enter path passes requireAllFilled so a
  // perfect match in the last box never submits a partially-filled card; an
  // explicit Enter keypress still submits whenever the user chooses.
  const advance = (input: HTMLInputElement, requireAllFilled = false) => {
    const idx = inputs.indexOf(input);
    if (idx < inputs.length - 1) { inputs[idx + 1].focus(); return; }
    if (requireAllFilled && inputs.some(i => !i.value.trim())) return;
    void submit();
  };
  const expectedNorms = l.items.map(normalizeAnswer);

  inputs.forEach(input => {
    controller.on(input, "keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); advance(input); }
    });
    controller.on(input, "input", () => {
      if (controller.done) return;
      const norm = normalizeAnswer(input.value.trim());
      if (norm && expectedNorms.includes(norm)) advance(input, true);
    });
  });
}

// --- Image Occlusion ---

async function renderImageOcclusion(a: RenderArgs): Promise<void> {
  const { view, cardFile, variant } = a;
  let data;
  try {
    data = decodeImageOcclusion(variant.question, variant.answer);
  } catch {
    throw new CardRenderError("Malformed image occlusion card.");
  }
  if (data.regions.length === 0) throw new CardRenderError("No occlusion regions defined.");

  const imageFile = view.app.metadataCache.getFirstLinkpathDest(data.imagePath, cardFile.path);
  if (!imageFile) throw new CardRenderError(`Image not found: ${data.imagePath}`);
  const url = view.app.vault.getResourcePath(imageFile);

  const rs = view.getRenderState(cardFile, variant);
  const occludeIdx = getOrInit(rs, "occludeIdx", () => Math.floor(Math.random() * data.regions.length));
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
  // Overlay placement is layout, not interaction — wire it even for previews.
  if (img.complete && img.naturalWidth > 0) {
    placeOverlay();
  } else {
    img.addEventListener("load", placeOverlay, { once: true });
  }

  await renderInputCard(a, {
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
      return [target.label, ...bound].some(x => normalizeAnswer(x) === norm);
    },
    knownIncorrect: variant.knownIncorrect
      .map(decodeGapAlt)
      .filter(d => d.term === target.label || d.term === null)
      .map(d => d.alt),
    llmMarker: llmMarkingEnabled(view.plugin) ? {
      question: `What is labeled at the occluded region of this diagram?`,
      answer: target.label,
      acceptedAnswers: variant.acceptedAnswers
        .map(decodeGapAlt)
        .filter(d => d.term === target.label || d.term === null)
        .map(d => d.alt),
    } : undefined,
  });
}

// --- Pairs ---

async function renderPairs(a: RenderArgs): Promise<void> {
  const { view, cardFile, variant } = a;
  let p;
  try {
    p = decodePairs(variant.question);
  } catch {
    throw new CardRenderError("Malformed pairs card.");
  }

  // Persist which side is shown and which is asked so re-renders/previews
  // stay stable; with 3+ sides each fresh presentation picks a new pairing.
  const rs = view.getRenderState(cardFile, variant);
  const pick = getOrInit(rs, "pairsPick", () => {
    const n = p.fields.length;
    const show = Math.floor(Math.random() * n);
    let ask = Math.floor(Math.random() * (n - 1));
    if (ask >= show) ask++;
    return [show, ask];
  });
  const shown = p.fields[pick[0]];
  const asked = p.fields[pick[1]];
  if (!shown || !asked) throw new CardRenderError("Malformed pairs card.");

  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const questionMd = `**${cap(shown.name)}:**\n\n${shown.content}\n\n**What is the ${asked.name}?**`;
  const typeable = isTypeableContent(asked.content);

  if (typeable && llmMarkingEnabled(view.plugin)) {
    await renderInputCard(a, {
      questionMd,
      canonicalAnswer: asked.content,
      autoSubmitOnMatch: true,
      llmMarker: {
        question: `${cap(shown.name)}: ${shown.content}\nWhat is the ${asked.name}?`,
        answer: asked.content,
        acceptedAnswers: variant.acceptedAnswers,
      },
      knownIncorrect: variant.knownIncorrect,
    });
    return;
  }

  await renderManualReveal(a, questionMd, asked.content, typeable ? {
    input: true,
    match: [asked.content, ...variant.acceptedAnswers],
  } : {});
}

// --- Multi-step ---

/**
 * Two-plus Q&A sub-cards in sequence: type an answer, Enter reveals it and the
 * next step appears. The learner self-grades the card as a whole at the end
 * (an exact match on a step colours it green as it reveals).
 */
async function renderMultiStep(a: RenderArgs): Promise<void> {
  const { view, card, variant, controller, answer } = a;
  let ms;
  try {
    ms = decodeMultiStep(variant.question);
  } catch {
    throw new CardRenderError("Malformed multi-step card.");
  }
  const steps = ms.steps;
  const typed: string[] = [];

  const stepsEl = card.createDiv({ cls: "iris-multistep" });
  const actions = card.createDiv({ cls: "iris-actions iris-hidden" });
  controller.renderGradeButtons(actions, SELF_GRADES, (grade) => {
    const correct = grade !== GRADE_AGAIN;
    controller.feedback(correct, false);
    void answer(correct, typed.filter(Boolean).join(" / ") || undefined, undefined, grade);
  });

  const finish = () => {
    if (view.infiniteMode) {
      // Match the auto-advance every other card type does in infinite mode.
      void answer(true, typed.filter(Boolean).join(" / ") || undefined, undefined, GRADE_GOOD);
    } else if (view.peekedAnswer) {
      const next = card.createDiv({ cls: "iris-actions" });
      const btn = next.createEl("button", { cls: "iris-rate-btn iris-rate-good", text: "Next" });
      controller.on(btn, "click", () => void answer(true, typed.filter(Boolean).join(" / ") || undefined, undefined, GRADE_GOOD));
    } else {
      actions.removeClass("iris-hidden");
    }
  };

  const showStep = async (i: number): Promise<void> => {
    const step = steps[i];
    const wrap = stepsEl.createDiv({ cls: "iris-multistep-step" });
    const questionSection = wrap.createDiv({ cls: "iris-question" });
    await MarkdownRenderer.render(
      view.app,
      `**Step ${i + 1} of ${steps.length}:** ${step.question}`,
      questionSection.createDiv(), "", view,
    );
    const inputSection = wrap.createDiv({ cls: "iris-user-answer" });
    const input = inputSection.createEl("input", { type: "text", cls: "iris-answer-input" });
    const answerSection = wrap.createDiv({ cls: "iris-answer iris-hidden" });
    await MarkdownRenderer.render(view.app, step.answer, answerSection.createDiv(), "", view);

    let revealed = false;
    const reveal = async () => {
      if (revealed) return;
      revealed = true;
      input.disabled = true;
      typed[i] = input.value.trim();
      if (typed[i] && normalizeAnswer(typed[i]) === normalizeAnswer(step.answer)) {
        input.addClass("iris-answer-input-correct");
      }
      answerSection.removeClass("iris-hidden");
      if (i + 1 < steps.length) {
        await showStep(i + 1);
      } else {
        finish();
      }
    };

    controller.on(input, "keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void reveal(); }
    });
    controller.on(input, "input", () => {
      if (!revealed && normalizeAnswer(input.value.trim()) === normalizeAnswer(step.answer)) void reveal();
    });
    // First step follows the initial-autofocus rule; later steps keep focus
    // flowing since the user is already typing.
    if (i === 0) controller.focusInitial(input);
    else controller.focus(input);
  };

  await showStep(0);
}

// ─── Dispatch & Orchestration ───────────────────────────────────────────

/**
 * Static table of per-type renderers, built once at module load (the dispatch
 * used to be an object literal rebuilt on every render, including every
 * preview). Q&A is the implicit default for any unmapped type.
 */
const EXERCISE_RENDERERS: Partial<Record<ExerciseType, (a: RenderArgs) => Promise<void>>> = {
  "Q&A": renderQA,
  "Synonym": renderQA,
  "Multiple Choice": renderMultipleChoice,
  "True/False": renderTrueFalse,
  "Rank": renderRank,
  "Cloze": (a) => renderOcclude(a, { source: a.variant.question }),
  "Word": (a) => renderOcclude(a, {
    source: a.variant.question,
    title: a.variant.answer || undefined,
    minTerms: 2,
    strict: true,
    errorText: "Malformed word card.",
  }),
  "Assemble Equation": (a) => renderOcclude(a, {
    source: a.variant.answer,
    title: a.variant.question,
    minTerms: 2,
    errorText: "Malformed equation.",
  }),
  "Correct the Mistake": renderCorrectMistake,
  "Solve Equation": renderSolveEquation,
  "Place in Order": renderOrderSteps,
  "List": renderList,
  "Image Occlusion": renderImageOcclusion,
  "Pairs": renderPairs,
  "Multi-step": renderMultiStep,
};

/**
 * Last-resort rendering when a card's stored data can't be displayed. Instead of
 * a dead-end error message (which freezes the queue in the widget / audio mode,
 * where there's no skip chrome), show the problem and let the user grade and
 * move on — revealing the stored answer if there is one.
 */
async function renderErrorFallback(a: RenderArgs, err: unknown): Promise<void> {
  const { view, card, controller, variant } = a;
  if (!(err instanceof CardRenderError)) {
    console.error("[iris-cards] card render failed", variant.exerciseType, err);
  }
  card.empty();
  // Re-locking height from a prior partial render would pin us too small.
  card.style.height = "";

  const message = err instanceof CardRenderError ? err.message : "This card couldn't be displayed.";
  card.createEl("p", { text: message, cls: "iris-error" });

  const answerMd = variant.answer?.trim();
  if (answerMd) {
    const showBtn = card.createEl("button", { cls: "iris-show-btn", attr: { "aria-label": "Show answer" } });
    setIcon(showBtn, "eye");
    const answerSection = card.createDiv({ cls: "iris-answer iris-hidden" });
    try {
      await MarkdownRenderer.render(view.app, answerMd, answerSection.createDiv(), "", view);
    } catch {
      answerSection.setText(answerMd);
    }
    const actions = card.createDiv({ cls: "iris-actions iris-hidden" });
    controller.renderGradeButtons(actions, SELF_GRADES, (grade) => {
      const correct = grade !== GRADE_AGAIN;
      controller.feedback(correct, false);
      void a.answer(correct, undefined, undefined, grade);
    });
    let revealed = false;
    controller.on(showBtn, "click", () => {
      if (revealed) return;
      revealed = true;
      answerSection.removeClass("iris-hidden");
      showBtn.addClass("iris-hidden");
      actions.removeClass("iris-hidden");
    });
  } else {
    // Nothing to reveal — a single Skip records Again so the queue advances.
    const actions = card.createDiv({ cls: "iris-actions" });
    const btn = actions.createEl("button", { cls: "iris-rate-btn iris-rate-again", text: "Skip" });
    controller.on(btn, "click", () => void a.answer(false, undefined, undefined, GRADE_AGAIN));
  }
}

/** Dispatch to the correct type-specific renderer for a card element. */
export async function renderVariantInto(
  view: RenderContext, card: HTMLElement, cardFile: TFile, variant: QAVariant, answer: AnswerFn,
  opts: { interactive?: boolean } = {},
): Promise<void> {
  const controller = new CardController(view, card, answer, variant, opts.interactive ?? true);
  const a: RenderArgs = { view, card, cardFile, variant, answer, controller };
  const render = EXERCISE_RENDERERS[variant.exerciseType] ?? renderQA;
  try {
    await render(a);
  } catch (err) {
    await renderErrorFallback(a, err);
  }
}

export async function renderCurrentCard(
  view: ReviewView, body: HTMLDivElement, cardFile: TFile, variant: QAVariant,
): Promise<void> {
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

  // Edit button — reopens the authoring form pre-filled, so fixing a typo
  // never means hand-editing the card's encoded lines. Only for variants the
  // form knows how to decode.
  if (editableTypeId(variant)) {
    const editBtn = card.createEl("button", {
      cls: "iris-card-icon iris-edit-btn",
      attr: { "aria-label": "Edit card" },
    });
    setIcon(editBtn, "pencil");
    editBtn.addEventListener("click", () => {
      new CardEditModal(view.app, variant, async (authored) => {
        await view.plugin.cardStore.updateVariants(cardFile, (vs) => {
          const idx = vs.findIndex(v => v.question === variant.question && v.exerciseType === variant.exerciseType);
          if (idx === -1) {
            vs.push(authored.variant);
          } else {
            // Keep review history/metadata; replace only the content.
            vs[idx] = {
              ...vs[idx],
              exerciseType: authored.variant.exerciseType,
              question: authored.variant.question,
              answer: authored.variant.answer,
            };
          }
        });
        invalidateParsedCache(cardFile.path);
        view.plugin.qaCache.delete(cardFile.path);
        view.clearCommit(cardFile.path);
        view.renderStateCache.delete(cardFile.path + "\0" + variant.question);
        await view.showNextCard();
      }).open();
    });
  }

  view.scrollToCenter(card);
}
