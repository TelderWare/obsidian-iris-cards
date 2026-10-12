import { ItemView, MarkdownRenderer, Notice, TFile, TFolder, WorkspaceLeaf, setIcon } from "obsidian";
import type IrisCardsPlugin from "../main";
import { activeModuleFilter, getDueCards, getAllCards, getModules, getParentNoteName, cardHasTag, cardForgettingScore, getWaitingGroups } from "../scheduler";
import { playFeedbackSound } from "./feedback-sound";
import { openCardLibrary } from "./card-library";
import { EXERCISE_TYPES, exerciseTypeLabel, type QAVariant } from "../types/exercises";
import { renderCurrentCard, renderVariantInto, getParsedCached, invalidateParsedCache, type AnswerFn } from "./renderers";
import { buildCardAuthorForm, variantFactText } from "./card-author";
import { aiEnabled, llmMarkingEnabled } from "../ai";

/**
 * Narrows a review session to a subset of cards: one note's cards, a single
 * card, a tag (matched against the tags cards inherit from their parents), or
 * every note under a folder. `label` is what the tab title shows.
 */
export interface ReviewScope {
  kind: "note" | "card" | "tag" | "folder";
  value: string;
  label: string;
  /** Go through every card in scope once, due or not, in the order they were
   * written, then stop — rather than the due queue or endless practice. */
  runThrough?: boolean;
}

/** One entry in the review queue: a fact card's file. */
export interface ReviewItem {
  file: TFile;
}

/** Stable identity for per-item session maps (show counts, commits). */
function itemKey(item: ReviewItem): string {
  return item.file.path;
}

/**
 * The prose a captured fact is actually about, for seeding the types whose
 * card *is* that sentence. Embed-only lines are dropped: an image has no words
 * to hide, so a Cloze seeded with `![[diagram.png]]` would just be wrong.
 * Returns undefined when nothing quotable is left.
 */
function factSentence(body: string): string | undefined {
  const text = body
    .split("\n")
    .filter(l => !/^\s*!\[/.test(l))
    .join("\n")
    .trim();
  return text || undefined;
}

export const VIEW_TYPE_REVIEW = "iris-cards-review";

export class ReviewView extends ItemView {
  plugin: IrisCardsPlugin;
  dueCards: ReviewItem[] = [];
  currentItem: ReviewItem | null = null;
  private doneCheckInterval: number | null = null;
  infiniteMode = false;
  /** Set while working through the done card's "Write questions" list: facts
   * with no questions get the write-your-own form even when AI is on. */
  private writingQuestions = false;
  /** Per-item show count within the current infinite session. Each show
   * exponentially deprioritizes an item in the next pick so recently-shown
   * ones don't immediately re-appear. Reset on queue reload. */
  private sessionShowCount = new Map<string, number>();
  /**
   * Key of the item we committed to dueCards[1] on the previous pick. After
   * the user rates the current item, rateCard rotates it to the back, leaving
   * the committed next at dueCards[0]. pickByPriority detects that match and
   * skips re-picking position 0, so the card that was pregenerated as "next"
   * (showNextCard warms dueCards[1]) is the one that actually comes up.
   */
  private committedNextKey: string | null = null;
  moduleFilter = new Set<string>();
  typeFilter = new Set<string>();
  /** Active review scope (note/card/tag/folder), distinct from Obsidian's View.scope. */
  reviewScope: ReviewScope | null = null;
  shownVariants = new Set<string>();
  /**
   * Once a variant has been picked for a card, we commit to it so re-renders
   * show the same question. Cleared when the card leaves the queue
   * (rate/external/load) so infinite-mode revisits can pick a fresh unseen
   * variant.
   */
  private committedVariants = new Map<string, QAVariant>();
  scrollBody: HTMLDivElement | null = null;
  layoutReady = false;
  private audioCtx: AudioContext | null = null;
  currentCardEl: HTMLElement | null = null;
  currentVariant: QAVariant | null = null;
  peekedAnswer = false;
  scrollAnimId = 0;
  renderStateCache = new Map<string, Record<string, unknown>>();

  constructor(leaf: WorkspaceLeaf, plugin: IrisCardsPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.moduleFilter = new Set(plugin.settings.reviewModuleFilter);
    this.typeFilter = new Set(plugin.settings.reviewTypeFilter);
  }

  getViewType(): string {
    return VIEW_TYPE_REVIEW;
  }

  getDisplayText(): string {
    return this.reviewScope ? `Cards: ${this.reviewScope.label}` : "Cards";
  }

  getIcon(): string {
    return "loader";
  }

  async onOpen(): Promise<void> {
    this.plugin.reviewViews.add(this);
    await this.loadDueCards();
  }

  async onClose(): Promise<void> {
    this.plugin.reviewViews.delete(this);
    this.clearDoneCheck();
    this.layoutReady = false;
    this.contentEl.empty();
  }

  async setScope(scope: ReviewScope | null): Promise<void> {
    this.reviewScope = scope;
    this.layoutReady = false;
    this.shownVariants.clear();
    await this.loadDueCards();
  }

  /**
   * Apply the tag/folder/card scopes, which the scheduler queries don't know
   * about (note scope is passed to them directly as `noteFilter`).
   */
  private filterByScope(files: TFile[]): TFile[] {
    const s = this.reviewScope;
    if (!s) return files;
    switch (s.kind) {
      case "tag":
        return files.filter(f => cardHasTag(this.app.metadataCache.getFileCache(f)?.frontmatter, s.value));
      case "folder":
        return files.filter(f => {
          const parent = getParentNoteName(this.app.metadataCache.getFileCache(f)?.frontmatter);
          if (!parent) return false;
          const dest = this.app.metadataCache.getFirstLinkpathDest(parent, f.path);
          return !!dest && dest.path.startsWith(s.value + "/");
        });
      case "card":
        return files.filter(f => f.path === s.value);
      default:
        return files;
    }
  }

  getRenderState(cardFile: TFile, variant: QAVariant): Record<string, unknown> {
    const key = cardFile.path + "\0" + variant.question;
    let state = this.renderStateCache.get(key);
    if (!state) {
      state = {};
      this.renderStateCache.set(key, state);
    }
    return state;
  }

  /**
   * Pick a variant for `file` and commit to it, or return the existing commit
   * if it's still in the active set. Does NOT mark the variant as seen — that
   * happens when the card actually becomes current (see markCommitSeen).
   * Returns null when there are no usable variants.
   */
  commitVariantFor(file: TFile, active: QAVariant[]): QAVariant | null {
    if (!llmMarkingEnabled(this.plugin)) active = active.filter(v => v.exerciseType !== "List");
    if (this.typeFilter.size > 0) active = active.filter(v => this.typeFilter.has(v.exerciseType));
    if (active.length === 0) return null;
    // "Correct the Mistake" presents a deliberately wrong statement, so it's a
    // poor sole exposure to a fact. If suspension has left it as the only active
    // type, skip the card rather than reviewing it on its own.
    if (active.every(v => v.exerciseType === "Correct the Mistake")) return null;
    const existing = this.committedVariants.get(file.path);
    if (existing) {
      const stillActive = active.find(v => v.question === existing.question);
      if (stillActive) {
        this.committedVariants.set(file.path, stillActive);
        return stillActive;
      }
      this.committedVariants.delete(file.path);
    }
    const picked = this.pickFreshVariant(file, active);
    this.committedVariants.set(file.path, picked);
    return picked;
  }

  /** Drop the commitment for a card (called when it leaves the queue). */
  clearCommit(path: string): void {
    this.committedVariants.delete(path);
  }

  /** Record that a committed variant was actually presented to the user. */
  markCommitSeen(file: TFile, variant: QAVariant): void {
    this.shownVariants.add(file.path + "\0" + variant.question);
  }

  private pickFreshVariant(file: TFile, active: QAVariant[]): QAVariant {
    // Prefer harder questions (higher difficulty), then never-reviewed, then
    // oldest-reviewed.
    const pickHardest = (pool: QAVariant[]): QAVariant =>
      pool.reduce((best, v) => {
        const bD = best.difficulty ?? 0;
        const vD = v.difficulty ?? 0;
        if (vD > bD) return v;
        if (vD < bD) return best;
        if (best.lastReviewed === null) return best;
        if (v.lastReviewed === null) return v;
        return v.lastReviewed < best.lastReviewed ? v : best;
      }, pool[0]);

    if (this.infiniteMode) {
      const unseen = active.filter(v => !this.shownVariants.has(file.path + "\0" + v.question));
      return pickHardest(unseen.length > 0 ? unseen : active);
    }
    return pickHardest(active);
  }

  clearDoneCheck(): void {
    if (this.doneCheckInterval !== null) {
      window.clearInterval(this.doneCheckInterval);
      this.doneCheckInterval = null;
    }
  }

  /** The due (or, in infinite mode, full) queue. */
  private async fetchQueue(): Promise<ReviewItem[]> {
    // The module filter is an ambient default for the open-ended review. An
    // explicit scope (a note, tag, folder, or single card the user picked) is
    // a direct request for that content — honour it regardless of which
    // modules happen to be filtered, or a module-less note the user
    // explicitly asked to review would silently show nothing.
    const mf = this.reviewScope ? undefined : activeModuleFilter(this.app, this.plugin.settings.cardsFolder, this.moduleFilter);
    const nf = this.reviewScope?.kind === "note" ? this.reviewScope.value : undefined;
    if (this.reviewScope?.kind === "card") {
      // A single-card practice session includes the card whether or not it's due.
      const file = this.app.vault.getAbstractFileByPath(this.reviewScope.value);
      return file instanceof TFile ? [{ file }] : [];
    }
    if (this.reviewScope?.runThrough) {
      // Card filenames are creation timestamps, so this is writing order.
      const all = this.filterByScope(getAllCards(this.app, this.plugin.settings.cardsFolder, undefined, nf, true));
      return all.sort((a, b) => a.basename.localeCompare(b.basename)).map(f => ({ file: f }));
    }
    const facts = this.filterByScope(this.infiniteMode
      ? await getAllCards(this.app, this.plugin.settings.cardsFolder, mf, nf, true)
      : await getDueCards(this.app, this.plugin.settings.cardsFolder, 0, mf, this.plugin.settings.desiredRetention, nf));
    return facts.map(f => ({ file: f }));
  }

  async loadDueCards(): Promise<void> {
    this.writingQuestions = false;
    this.dueCards = await this.fetchQueue();
    this.sessionShowCount.clear();
    this.committedVariants.clear();
    this.committedNextKey = null;
    if (this.dueCards.length === 0) {
      this.renderDoneCard();
      return;
    }

    await this.plugin.pregen.pregenerateAll();
    await this.showNextCard();
  }

  /**
   * Weighted random pick over the infinite-mode queue, weighting each card by
   * its current forgetting probability and discounting by how many times we've
   * already shown it this session. The picked card is rotated to dueCards[0]
   * so downstream code (which treats the queue head as "current") works.
   *
   * Also pre-picks dueCards[1] using the same weighted scheme and remembers
   * its path in committedNextCardPath. When the user rates the current card,
   * rateCard rotates it to the back, leaving the committed next at position 0;
   * the next call detects that and skips re-picking position 0, so the card
   * showNextCard pregenerated as "next" is the one that actually comes up.
   */
  private pickByPriority(): void {
    if (this.dueCards.length === 0) {
      this.committedNextKey = null;
      return;
    }
    // If the previous pick committed a "next" and it's now at position 0
    // (because rateCard rotated the previous current to the back),
    // honor that commitment instead of re-picking — it's the card whose
    // question was already pregenerated.
    const honorCommitted = this.committedNextKey !== null
      && this.dueCards[0] && itemKey(this.dueCards[0]) === this.committedNextKey;
    if (!honorCommitted) {
      const picked = this.weightedPick(this.dueCards.slice(0));
      if (picked) {
        const idx = this.dueCards.indexOf(picked);
        if (idx > 0) {
          this.dueCards.splice(idx, 1);
          this.dueCards.unshift(picked);
        }
      }
    }
    // Lock in the next card so its preview is what the user actually sees next.
    if (this.dueCards.length >= 2) {
      const tail = this.dueCards.slice(1);
      const next = this.weightedPick(tail);
      if (next) {
        const idx = this.dueCards.indexOf(next);
        if (idx > 1) {
          this.dueCards.splice(idx, 1);
          this.dueCards.splice(1, 0, next);
        }
        this.committedNextKey = itemKey(next);
      } else {
        this.committedNextKey = null;
      }
    } else {
      this.committedNextKey = null;
    }
  }

  /** FSRS forgetting probability for a queue item. */
  private itemForgettingScore(item: ReviewItem): number {
    return cardForgettingScore(this.app.metadataCache.getFileCache(item.file)?.frontmatter);
  }

  /** Weighted random pick by forgetting probability, discounted per session
   * show (halved per show, capped at 6) — same scheme as the audio view's
   * weightedForgettingPick. */
  private weightedPick(pool: ReviewItem[]): ReviewItem | null {
    if (pool.length === 0) return null;
    const scored = pool.map(item => {
      let score = this.itemForgettingScore(item);
      const shown = Math.min(6, this.sessionShowCount.get(itemKey(item)) ?? 0);
      if (shown > 0) score *= Math.pow(0.5, shown);
      return { item, score: Math.max(0.001, score) };
    });
    const total = scored.reduce((s, x) => s + x.score, 0);
    let r = Math.random() * total;
    let picked = scored[0].item;
    for (const x of scored) {
      r -= x.score;
      if (r <= 0) { picked = x.item; break; }
    }
    return picked;
  }

  ensureLayout(): void {
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

    if (this.plugin.settings.aiFeatures) {
      makeToggle("brain-circuit", "LLM marking", this.plugin.settings.autoMark, async (v) => {
        await this.plugin.updateSetting("autoMark", v);
        if (this.currentItem && this.currentVariant && this.currentCardEl && this.scrollBody) {
          if (!this.plugin.settings.anthropicApiKey && !(this.plugin.app as any).irisRelay) return;
          this.currentCardEl.remove();
          await renderCurrentCard(this, this.scrollBody, this.currentItem.file, this.currentVariant);
        }
      });
    }

    // Audio-only review is its own process (see audio-view.ts / the
    // "Audio review" command) — no toggle here.

    // Infinite mode toggle. Queue order is driven by FSRS forgetting-priority
    // sampling (see pickByPriority) — no further configuration needed.
    const infBtn = headerCenter.createEl("button", { cls: "iris-toggle clickable-icon", attr: { "aria-label": "Infinite mode" } });
    setIcon(infBtn, "infinity");
    infBtn.toggleClass("is-active", this.infiniteMode);
    infBtn.addEventListener("click", async () => {
      this.infiniteMode = !this.infiniteMode;
      infBtn.toggleClass("is-active", this.infiniteMode);
      this.shownVariants.clear();
      this.layoutReady = false;
      await this.loadDueCards();
    });

    // Module filter — icon button with floating panel attached to document.body (JS-positioned to sidestep parent CSS issues)
    const modules = getModules(this.app, this.plugin.settings.cardsFolder);
    if (modules.length > 0) {
      this.makeFilterButton(headerLeft, {
        icon: "list-filter",
        label: "Filter by module",
        idPrefix: "iris-mod",
        items: modules.map(m => ({ value: m.code, label: m.name })),
        selected: this.moduleFilter,
        onChange: async () => {
          this.plugin.settings.reviewModuleFilter = [...this.moduleFilter];
          await this.plugin.saveSettings();
          this.layoutReady = false;
          await this.loadDueCards();
        },
      });
    }

    // Question-type filter — same floating-panel pattern over the exercise types.
    this.makeFilterButton(headerLeft, {
      icon: "shapes",
      label: "Filter by question type",
      idPrefix: "iris-type",
      items: EXERCISE_TYPES.map(t => ({ value: t, label: exerciseTypeLabel(t) })),
      selected: this.typeFilter,
      onChange: async () => {
        this.plugin.settings.reviewTypeFilter = [...this.typeFilter];
        await this.plugin.saveSettings();
        this.layoutReady = false;
        await this.loadDueCards();
      },
    });

    const headerRight = header.createDiv({ cls: "iris-header-right" });

    const libraryBtn = headerRight.createEl("button", {
      cls: "iris-toggle clickable-icon",
      attr: { "aria-label": "Card library" },
    });
    setIcon(libraryBtn, "book-open");
    libraryBtn.addEventListener("click", () => {
      void openCardLibrary(this.plugin);
    });

    // Cache clear strips stored QA blocks so the AI can regenerate them. With
    // AI off there is no regeneration — the button would just destroy
    // hand-written cards — so it only exists when AI features are on.
    if (this.plugin.settings.aiFeatures) {
      const clearCache = headerRight.createEl("button", {
        cls: "iris-toggle clickable-icon",
        attr: { "aria-label": "Clear question cache" },
      });
      setIcon(clearCache, "trash-2");
      clearCache.addEventListener("click", async () => {
        this.plugin.qaCache.clear();
        await this.plugin.cardStore.stripAllQABlocks(this.plugin.settings.cardsFolder);
      });
    }

    // Scrollable body
    this.scrollBody = container.createDiv({ cls: "iris-scroll-body" });

    this.layoutReady = true;

    // No virtual-keyboard handling here on purpose. Obsidian mobile already
    // resizes its own webview when the keyboard opens; a plugin re-measuring
    // the visual viewport and clamping its container on top of that is fighting
    // the host for control of the layout, and every such adjustment lands
    // mid-IME-composition — which is what garbled and reversed typed text.
    // If the bottom of a card turns out to be genuinely unreachable behind the
    // keyboard, fix it with layout (the scroll body owning its own height) and
    // never with a scroll or reflow driven by viewport events while typing.
  }

  /**
   * Icon button with a floating checkbox panel attached to document.body
   * (JS-positioned to sidestep parent CSS issues). Shared by the module and
   * question-type filters; `onChange` persists the selection and reloads.
   */
  private makeFilterButton(
    host: HTMLElement,
    opts: {
      icon: string;
      label: string;
      idPrefix: string;
      items: { value: string; label: string }[];
      selected: Set<string>;
      onChange: () => Promise<void>;
    },
  ): void {
    const filterBtn = host.createEl("button", { cls: "iris-toggle clickable-icon", attr: { "aria-label": opts.label } });
    setIcon(filterBtn, opts.icon);

    const updateBtn = () => {
      filterBtn.toggleClass("iris-toggle-active", opts.selected.size > 0);
    };
    updateBtn();

    let panel: HTMLDivElement | null = null;
    let onMouseDown: ((e: MouseEvent) => void) | null = null;
    let onKeyDown: ((e: KeyboardEvent) => void) | null = null;

    const closePanel = () => {
      if (!panel) return;
      if (onMouseDown) document.removeEventListener("mousedown", onMouseDown, true);
      if (onKeyDown) document.removeEventListener("keydown", onKeyDown, true);
      onMouseDown = null;
      onKeyDown = null;
      panel.remove();
      panel = null;
    };

    const openPanel = () => {
      const rect = filterBtn.getBoundingClientRect();
      panel = document.body.createDiv({ cls: "iris-filter-dropdown" }) as HTMLDivElement;
      panel.style.position = "fixed";
      panel.style.top = `${rect.bottom + 4}px`;
      panel.style.left = `${rect.left}px`;
      panel.style.zIndex = "1000";

      for (const item of opts.items) {
        const row = panel.createDiv({ cls: "iris-filter-row" });
        const id = `${opts.idPrefix}-${item.value.replace(/\W+/g, "-")}`;
        const cb = row.createEl("input", { type: "checkbox", attr: { id } });
        cb.checked = opts.selected.has(item.value);
        row.createEl("label", { text: item.label, attr: { for: id } });
        cb.addEventListener("change", async () => {
          if (cb.checked) opts.selected.add(item.value);
          else opts.selected.delete(item.value);
          updateBtn();
          await opts.onChange();
        });
      }

      onMouseDown = (e: MouseEvent) => {
        const target = e.target as Node;
        if (panel && !panel.contains(target) && !filterBtn.contains(target)) {
          closePanel();
        }
      };
      onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") closePanel();
      };
      document.addEventListener("mousedown", onMouseDown, true);
      document.addEventListener("keydown", onKeyDown, true);
    };

    filterBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (panel) closePanel();
      else openPanel();
    });

    this.register(() => closePanel());
  }

  scrollToCenter(el: HTMLElement): void {
    const body = this.scrollBody;
    if (!body) return;
    const id = ++this.scrollAnimId;
    requestAnimationFrame(() => {
      if (id !== this.scrollAnimId) return;
      // Centring a card that's taller than the pane lands you in its middle,
      // with the question already scrolled off the top — read it from the top
      // instead. Only cards that fit get centred.
      const target = el.offsetHeight > body.clientHeight
        ? el.offsetTop
        : el.offsetTop - (body.clientHeight - el.offsetHeight) / 2;
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

  renderDoneCard(): void {
    this.writingQuestions = false;
    this.clearDoneCheck();
    this.ensureLayout();
    const body = this.scrollBody!;
    body.empty();

    const card = body.createDiv({ cls: "iris-card iris-done-card" });

    // Distinguish "nothing due" from a misconfigured cards folder. If the
    // folder setting is blank or points at something that isn't a folder, the
    // queue is empty for a reason the user needs to fix in settings — not
    // because they've reviewed everything.
    const folderPath = this.plugin.settings.cardsFolder;
    const folder = folderPath ? this.app.vault.getAbstractFileByPath(folderPath) : null;
    if (!folderPath || !folderPath.trim()) {
      card.createEl("h2", { text: "No cards folder set" });
      const p = card.createEl("p", { text: "Set the cards folder in " });
      this.appendSettingsLink(p, "Iris Cards settings");
      p.appendText(" to start reviewing.");
    } else if (!(folder instanceof TFolder)) {
      card.createEl("h2", { text: "Cards folder not found" });
      const p = card.createEl("p", { text: `No folder named "${folderPath}" exists. Check the cards folder in ` });
      this.appendSettingsLink(p, "Iris Cards settings");
      p.appendText(".");
    } else if (getAllCards(this.app, folderPath).length === 0) {
      card.createEl("h2", { text: "No cards yet" });
      card.createEl("p", { text: `The folder "${folderPath}" doesn't contain any cards.` });
    } else if (this.reviewScope?.runThrough) {
      card.createEl("p", { text: `Finished every card from ${this.reviewScope.label}.` });
      this.scrollToCenter(card);
      // A run-through is one pass. Polling would refill the queue with the
      // same cards and start it over.
      return;
    } else {
      card.createEl("p", { text: "No cards due for review." });
      void this.renderWaitingGroups(card);
      void this.renderUnwrittenFacts(card);
    }

    this.scrollToCenter(card);

    // Poll for newly due cards
    this.doneCheckInterval = window.setInterval(async () => {
      const items = await this.fetchQueue();
      if (items.length > 0) {
        this.clearDoneCheck();
        this.dueCards = items;
        await this.plugin.pregen.pregenerateAll();
        await this.showNextCard();
      }
    }, 10_000);
  }

  /**
   * Groups with facts still waiting to be started, shown on the done card so
   * new material is pulled in when the user has capacity, never pushed by a
   * heuristic. Starting a group member clears its `waiting` flag; the new
   * item is never-reviewed, so it's due immediately.
   */
  private async renderWaitingGroups(card: HTMLElement): Promise<void> {
    const groups = getWaitingGroups(this.app, this.plugin.settings.cardsFolder);
    if (groups.length === 0) return;
    const wrap = card.createDiv({ cls: "iris-waiting-groups" });
    wrap.createDiv({ cls: "iris-waiting-title", text: "Waiting to be started" });

    for (const g of groups) {
      const row = wrap.createDiv({ cls: "iris-waiting-row" });
      row.createSpan({ cls: "iris-waiting-name", text: `${g.name} — ${g.started} of ${g.total} started` });
      const btn = row.createEl("button", { cls: "iris-waiting-start", text: "Start next" });
      btn.addEventListener("click", async () => {
        const file = this.app.vault.getAbstractFileByPath(g.nextPath);
        if (!(file instanceof TFile)) return;
        btn.disabled = true;
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          delete fm["waiting"];
        });
        // The due queue reads the metadata cache, which updates a beat after
        // the frontmatter write — reload once the change lands (with a
        // fallback so a missed event can't strand the view).
        let reloaded = false;
        const reload = () => {
          if (reloaded) return;
          reloaded = true;
          this.app.metadataCache.offref(ref);
          this.plugin.updateBadge();
          void this.loadDueCards();
        };
        const ref = this.app.metadataCache.on("changed", (f) => {
          if (f.path === g.nextPath) reload();
        });
        window.setTimeout(reload, 1500);
      });
    }
  }

  /**
   * Started facts that have no reviewable questions yet — offered on
   * the done card so you can write them when you have time, rather than only
   * when each one happens to come due. Uses the same scope as the queue.
   */
  private async renderUnwrittenFacts(card: HTMLElement): Promise<void> {
    if (this.reviewScope?.kind === "card") return;
    const mf = this.reviewScope ? undefined : activeModuleFilter(this.app, this.plugin.settings.cardsFolder, this.moduleFilter);
    const nf = this.reviewScope?.kind === "note" ? this.reviewScope.value : undefined;
    const files = this.filterByScope(getAllCards(this.app, this.plugin.settings.cardsFolder, mf, nf, true));
    const unwritten: ReviewItem[] = [];
    for (const file of files) {
      let variants: QAVariant[] = [];
      try {
        variants = (await getParsedCached(this.app, file)).variants;
      } catch { /* unreadable card — treated as having no variants */ }
      if (!variants.some(v => !v.suspended && !v.rephrase)) unwritten.push({ file });
    }
    if (unwritten.length === 0) return;

    const wrap = card.createDiv({ cls: "iris-waiting-groups" });
    const row = wrap.createDiv({ cls: "iris-waiting-row" });
    const n = unwritten.length;
    row.createSpan({ cls: "iris-waiting-name", text: `${n} fact${n === 1 ? " has" : "s have"} no questions yet` });
    const btn = row.createEl("button", { cls: "iris-waiting-start", text: "Write questions" });
    btn.addEventListener("click", async () => {
      this.clearDoneCheck();
      this.writingQuestions = true;
      this.dueCards = unwritten;
      await this.showNextCard();
    });
  }

  /** Append a link that opens this plugin's settings tab. */
  private appendSettingsLink(parent: HTMLElement, text: string): void {
    const link = parent.createEl("a", { text, href: "#", cls: "iris-settings-link" });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const setting = (this.app as any).setting;
      setting.open();
      setting.openTabById("iris-cards");
    });
  }

  async showNextCard(): Promise<void> {
    this.clearDoneCheck();
    this.peekedAnswer = false;

    // Skip deleted cards
    while (this.dueCards.length > 0 && !this.app.vault.getAbstractFileByPath(this.dueCards[0].file.path)) {
      this.plugin.qaCache.delete(this.dueCards[0].file.path);
      this.clearCommit(this.dueCards[0].file.path);
      this.dueCards.shift();
    }

    if (this.dueCards.length === 0) {
      this.renderDoneCard();
      this.plugin.updateBadge();
      return;
    }

    if (this.infiniteMode) {
      this.pickByPriority();
      // pickByPriority can surface a card that's been deleted; re-skip from head.
      while (this.dueCards.length > 0 && !this.app.vault.getAbstractFileByPath(this.dueCards[0].file.path)) {
        this.plugin.qaCache.delete(this.dueCards[0].file.path);
        this.dueCards.shift();
      }
      if (this.dueCards.length === 0) {
        this.renderDoneCard();
        this.plugin.updateBadge();
        return;
      }
    }

    const item = this.dueCards[0];
    this.currentItem = item;
    this.sessionShowCount.set(itemKey(item), (this.sessionShowCount.get(itemKey(item)) ?? 0) + 1);
    this.ensureLayout();

    const ai = aiEnabled(this.plugin);
    const apiKey = this.plugin.settings.anthropicApiKey;

    // Pregenerate next card while user works on current one
    if (ai && !this.writingQuestions && this.dueCards.length > 1) {
      this.plugin.pregen.pregenerateQA(this.dueCards[1].file, apiKey, 2);
    }

    const body = this.scrollBody!;
    // The review page shows exactly one card — the incoming one replaces
    // whatever was there, answered cards included.
    body.empty();

    const cardFile = item.file;

    if (!ai || this.writingQuestions) {
      // AI off: render straight from the variants stored on the card — no
      // API key needed, no generation cache.
      let variants: QAVariant[] = [];
      try {
        variants = (await getParsedCached(this.app, cardFile)).variants;
      } catch { /* unreadable card — treated as having no variants */ }
      const active = variants.filter(v => !v.suspended && !v.rephrase);
      const variant = this.commitVariantFor(cardFile, active);
      if (!variant) {
        if (this.typeFilter.size > 0 && active.length > 0) {
          // The card has reviewable variants, just none of the filtered types
          // — skip it rather than offering to author a new one.
          this.dueCards.shift();
          this.clearCommit(cardFile.path);
          await this.showNextCard();
          return;
        }
        // A captured fact with no usable variants yet — you write the card.
        await this.renderAuthorCard(cardFile);
        return;
      }
      this.markCommitSeen(cardFile, variant);
      this.currentVariant = variant;
      await renderCurrentCard(this, body, cardFile, variant);
      return;
    }

    // Show loading indicator while generating Q&A
    this.plugin.pregen.pregenerateQA(cardFile, apiKey, 2);
    const loadingCard = body.createDiv({ cls: "iris-card" });
    loadingCard.createEl("p", { text: "Generating question\u2026", cls: "iris-loading" });
    this.scrollToCenter(loadingCard);

    let variants: QAVariant[] = [];
    try {
      const cached = this.plugin.qaCache.get(cardFile.path);
      if (cached) variants = await cached;
    } catch {
      // Pregen falls back to existing variants on error; if anything still
      // bubbles up here, treat the card as having no usable variants.
    }

    loadingCard.remove();

    // Pool reviewable variants
    const active = variants.filter(v => !v.suspended && !v.rephrase);
    const variant = this.commitVariantFor(cardFile, active);
    if (!variant) {
      // No usable variants (generation failed with no fallback, or all suspended) — skip this card
      this.dueCards.shift();
      this.clearCommit(cardFile.path);
      await this.showNextCard();
      return;
    }
    this.markCommitSeen(cardFile, variant);

    // Create card
    this.currentVariant = variant;
    await renderCurrentCard(this, body, cardFile, variant);
  }

  /**
   * The write-your-own-card interface (AI off): a captured fact came due with
   * no variants yet. Shows the fact, a card-type picker, and the chosen type's
   * fields; saving stores the variant on the card and reviews it immediately.
   * "Later" pushes the fact to the back of the queue.
   */
  private async renderAuthorCard(cardFile: TFile): Promise<void> {
    const body = this.scrollBody!;
    this.currentVariant = null;
    const card = body.createDiv({ cls: "iris-card iris-author-card" });
    this.currentCardEl = card;

    // Laid out like the Create card / Edit card modals, which host the same
    // form: a title saying what to do, then the content, then the form with
    // just the type picker and Save in its footer. Later/trash are about this
    // card in the queue, not the question being written, so they sit by the
    // title — where a modal keeps its close button — not in the Save row.
    const titleRow = card.createDiv({ cls: "iris-author-titlerow" });
    const titleEl = titleRow.createDiv({ cls: "iris-author-title" });
    const headerBtns = titleRow.createDiv({ cls: "iris-author-header-btns" });
    const laterBtn = headerBtns.createEl("button", { cls: "iris-author-later", text: "Later" });

    // A junk capture shouldn't cycle forever — trash it here. Two clicks so a
    // stray tap can't delete a fact.
    const trashBtn = headerBtns.createEl("button", {
      cls: "iris-author-later iris-author-trash",
      attr: { "aria-label": "Move fact to trash (click again to confirm)" },
    });
    setIcon(trashBtn, "trash-2");
    let trashConfirming = false;
    let trashResetTimer = 0;
    trashBtn.addEventListener("click", async () => {
      if (!trashConfirming) {
        trashConfirming = true;
        trashBtn.addClass("iris-author-trash-confirm");
        trashResetTimer = window.setTimeout(() => {
          trashConfirming = false;
          trashBtn.removeClass("iris-author-trash-confirm");
        }, 3000);
        return;
      }
      window.clearTimeout(trashResetTimer);
      await this.app.fileManager.trashFile(cardFile);
      new Notice("Fact moved to trash.");
      this.plugin.qaCache.delete(cardFile.path);
      this.clearCommit(cardFile.path);
      this.dueCards.shift();
      card.remove();
      this.plugin.updateBadge();
      await this.showNextCard();
    });

    let factBody = "";
    let variants: QAVariant[] = [];
    try {
      const parsed = await getParsedCached(this.app, cardFile);
      factBody = parsed.body;
      variants = parsed.variants;
    } catch { /* body and variants stay empty */ }
    // A card lands here with questions when none are reviewable: flagged for a
    // rewrite (the Cheated button, with no AI to do it) or all suspended.
    const flagged = variants.filter(v => v.rephrase && !v.suspended);
    // The "(Context: …)" breadcrumb is separated from the fact itself: it
    // orients you no matter which type is selected, while the sentence below
    // it is what Cloze takes over.
    const isContext = (l: string) => /^\s*\(Context:/i.test(l);
    const contextLines = factBody.split("\n").filter(isContext);
    const factRest = factBody.split("\n").filter(l => !isContext(l)).join("\n").trim();
    const seedText = factSentence(factRest);
    // With no fact text, an existing question is the only record of what the
    // card is about — show one so there's something to write from. The
    // flagged one first: it's the question being replaced.
    let example: string | null = null;
    if (!factRest) {
      for (const v of [...flagged, ...variants.filter(v => !flagged.includes(v))]) {
        example = variantFactText(this.app, this.plugin, v);
        if (example) break;
      }
    }
    titleEl.setText(
      flagged.length > 0 ? "Write a replacement question"
      : variants.length > 0 ? "Write a new question"
      : "Write a question");
    if (contextLines.length > 0) {
      const ctxEl = card.createDiv({ cls: "iris-author-context" });
      await MarkdownRenderer.render(this.app, contextLines.join("\n"), ctxEl, cardFile.path, this);
    }
    let factEl: HTMLElement | null = null;
    if (factRest) {
      factEl = card.createDiv({ cls: "iris-author-fact" });
      await MarkdownRenderer.render(this.app, factRest, factEl, cardFile.path, this);
    } else if (example) {
      const exEl = card.createDiv({ cls: "iris-author-fact iris-author-example" });
      exEl.createDiv({ cls: "iris-author-example-label", text: flagged.length > 0 ? "Question to replace" : "Existing question" });
      const exBody = exEl.createDiv();
      await MarkdownRenderer.render(this.app, example, exBody, cardFile.path, this);
    }

    buildCardAuthorForm(card, {
      app: this.app,
      plugin: this.plugin,
      initialTypeId: this.plugin.settings.authorLastType,
      onTypeChange: (id) => {
        void this.plugin.updateSetting("authorLastType", id);
        // Cloze shows the fact's own sentence as its editable surface, so the
        // rendered fact above it would be the same sentence twice. Only hide it
        // when it really is just that sentence — a fact that also carries an
        // image keeps its block, since the image isn't in the cloze surface.
        factEl?.toggleClass("iris-hidden", id === "cloze" && factRest === seedText);
      },
      // The fact's own sentence, minus the "(Context: …)" breadcrumb, so a
      // Cloze starts as the fact itself rather than an empty box.
      seedText,
      onSave: async (authored) => {
        await this.plugin.cardStore.updateVariants(cardFile, (vs) => { vs.push(authored.variant); });
        invalidateParsedCache(cardFile.path);
        this.plugin.qaCache.delete(cardFile.path);
        this.clearCommit(cardFile.path);
        card.remove();
        await this.showNextCard();
      },
    });

    laterBtn.addEventListener("click", async () => {
      const c = this.dueCards.shift();
      if (c) this.dueCards.push(c);
      this.clearCommit(cardFile.path);
      card.remove();
      await this.showNextCard();
    });

    this.scrollToCenter(card);
  }

  private getOrCreateAudioCtx(): AudioContext {
    if (!this.audioCtx) {
      const Ctx = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
      this.audioCtx = new Ctx();
    }
    return this.audioCtx;
  }

  playFeedback(correct: boolean, record?: boolean): void {
    if (this.plugin.settings.soundFeedback) {
      playFeedbackSound(this.getOrCreateAudioCtx(), correct);
    }

    if (this.plugin.settings.flashFeedback) {
      const flash = this.contentEl.createDiv({ cls: "iris-flash" });
      flash.addClass(record ? "iris-flash-record" : correct ? "iris-flash-correct" : "iris-flash-incorrect");
      setTimeout(() => flash.remove(), 500);
    }

    if (record && this.currentCardEl) {
      const icon = this.currentCardEl.createDiv({ cls: "iris-record-icon" });
      setIcon(icon, "zap");
      setTimeout(() => icon.remove(), 500);
    }
  }

  /**
   * Freeze the current card as answered — disable interactions, keep the answer
   * visible. The card is replaced as soon as the next one renders; this covers
   * the window while the review is still being written to disk.
   */
  private freezeCurrentCard(): void {
    if (!this.currentCardEl) return;
    this.currentCardEl.addClass("iris-card-answered");
    // Reveal answer in manual mode
    this.currentCardEl.querySelectorAll(".iris-answer").forEach(el => el.removeClass("iris-hidden"));
    // Remove elements that no longer apply
    this.currentCardEl.querySelectorAll(".iris-actions, .iris-show-btn").forEach(el => el.remove());
    this.currentCardEl.querySelectorAll<HTMLInputElement>(".iris-answer-input").forEach(el => { el.disabled = true; });
  }

  /** Shared post-rating queue advance: rotate (infinite) or drop the head,
   * optionally bury the rated fact's siblings, then show what's next. */
  private async advanceAfterRate(buryFor?: TFile): Promise<void> {
    if (this.infiniteMode) {
      const item = this.dueCards.shift();
      if (item) this.dueCards.push(item);
      if (this.dueCards.length === 0) {
        this.shownVariants.clear();
        await this.loadDueCards();
        return;
      }
    } else {
      this.dueCards.shift();
    }

    if (buryFor) this.burySiblings(buryFor);
    this.plugin.updateBadge();
    await this.showNextCard();
  }

  async rateCard(file: TFile, correct: boolean, userAnswer?: string, questionShown?: string, elapsedMs?: number, gapTerm?: string, grade?: number): Promise<void> {
    this.freezeCurrentCard();

    this.plugin.qaCache.delete(file.path);
    this.clearCommit(file.path);
    if (questionShown) this.renderStateCache.delete(file.path + "\0" + questionShown);

    // Skip recording only when the user peeked (not a genuine review). Infinite
    // mode records like any review: FSRS discounts early reviews itself, so
    // cramming gains little stability while the extra data still sharpens it.
    if (!this.peekedAnswer) {
      try {
        await this.plugin.cardStore.recordReview(file, correct, questionShown, userAnswer, elapsedMs, gapTerm, grade, this.plugin.settings.cardsFolder, this.plugin.settings.desiredRetention, this.plugin.settings.scheduler);
        for (const other of this.plugin.reviewViews) {
          if (other !== this) other.handleExternalRate(file);
        }
      } catch (e) {
        // A card that can't be written — unparseable frontmatter after a sync
        // conflict merged two copies of it, a permissions problem — used to end
        // the session: the throw escaped before the queue advanced, leaving the
        // answered card frozen with its buttons already stripped and no way
        // forward. It came back due next session and froze again. Name the file
        // and move on; one bad card must not be able to stop a review.
        console.error("[iris-cards] failed to record review", file.path, e);
        new Notice(`Couldn't record this review — ${file.basename} may be malformed. Skipping it.\nRun "Check card health" to see the details.`, 8000);
      }
    }

    await this.advanceAfterRate(file);
  }

  private burySiblings(reviewedFile: TFile): void {
    const cache = this.app.metadataCache.getFileCache(reviewedFile);
    const parentNote = getParentNoteName(cache?.frontmatter);
    if (!parentNote) return;
    // The item now at position 0 is the committed next (rateCard shifted the
    // rated one off before calling us) — its question is already
    // pregenerated, so never bury it, even when it's a sibling of the card
    // just rated.
    const head = this.dueCards.slice(0, 1);
    const others: ReviewItem[] = [];
    const siblings: ReviewItem[] = [];
    for (const item of this.dueCards.slice(1)) {
      const fm = this.app.metadataCache.getFileCache(item.file)?.frontmatter;
      if (getParentNoteName(fm) === parentNote) {
        siblings.push(item);
      } else {
        others.push(item);
      }
    }
    if (siblings.length > 0 && others.length > 0) {
      this.dueCards = [...head, ...others, ...siblings];
    }
  }

  /** Another ReviewView just recorded a review for this file — drop it from our queue. */
  async handleExternalRate(file: TFile): Promise<void> {
    this.plugin.qaCache.delete(file.path);
    this.clearCommit(file.path);
    const idx = this.dueCards.findIndex(i => i.file.path === file.path);
    if (idx === -1) return;
    if (idx === 0 && this.currentItem && this.currentItem.file.path === file.path) {
      this.dueCards.shift();
      this.plugin.updateBadge();
      await this.showNextCard();
    } else {
      this.dueCards.splice(idx, 1);
      this.plugin.updateBadge();
    }
  }
}

