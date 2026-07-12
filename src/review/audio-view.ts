import { ItemView, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type IrisCardsPlugin from "../main";
import { getDueCards, getAllCards, weightedForgettingPick } from "../scheduler";
import { type QAVariant } from "../types/exercises";
import { getParsedCached } from "./renderers";
import { AudioReviewController } from "./audio-controller";
import { questionTextForAudio } from "./audio-text";

export const VIEW_TYPE_AUDIO = "iris-cards-audio-review";

/**
 * Audio-only review — its own process, separate from the visual review view.
 * Handles basic Q&A cards exclusively: each due card's stored variants are
 * read from disk, the active Q&A variant (if any) is spoken via TTS, the
 * answer is taken by speech-to-text, and the card is graded and recorded like
 * any other review. Cards with no active Q&A variant are skipped.
 *
 * No visual card rendering, no pregeneration, no toggles — opening the view
 * starts the session; closing it ends the session and releases the mic.
 */
export class AudioReviewView extends ItemView {
  plugin: IrisCardsPlugin;
  private dueCards: TFile[] = [];
  private controller: AudioReviewController | null = null;
  private statusEl!: HTMLElement;
  private questionEl!: HTMLElement;
  private progressEl!: HTMLElement;
  private sessionDone = 0;
  private closed = false;
  infiniteMode = false;
  /** Per-card show count within the current infinite session — same
   * exponential deprioritization as the visual review view. */
  private sessionShowCount = new Map<string, number>();
  /** Card locked in as dueCards[1] by the previous pick, so the question
   * audio prewarmed for it is the one that actually plays next. */
  private committedNextPath: string | null = null;
  /** Bumped when the infinite toggle restarts the session; stale card
   * callbacks from the previous session check it and bail. */
  private session = 0;

  constructor(leaf: WorkspaceLeaf, plugin: IrisCardsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_AUDIO;
  }

  getDisplayText(): string {
    return "Audio review";
  }

  getIcon(): string {
    return "headphones";
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    const container = this.contentEl;
    container.empty();
    container.addClass("iris-audio-view");

    // Infinite mode toggle — same semantics as the visual review view:
    // pool of all cards, forgetting-priority sampling, nothing recorded.
    const header = container.createDiv({ cls: "iris-audio-header" });
    const infBtn = header.createEl("button", { cls: "iris-toggle clickable-icon", attr: { "aria-label": "Infinite mode" } });
    setIcon(infBtn, "infinity");
    infBtn.toggleClass("is-active", this.infiniteMode);
    infBtn.addEventListener("click", () => void this.toggleInfinite(infBtn));

    this.questionEl = container.createDiv({ cls: "iris-audio-question" });
    this.statusEl = container.createDiv({ cls: "iris-audio-status" });
    this.progressEl = container.createDiv({ cls: "iris-audio-progress" });

    const relay = (this.plugin.app as any).irisRelay;
    const hasElevenLabs = relay?.isElevenLabsConfigured?.() || this.plugin.settings.elevenLabsApiKey;
    if (!hasElevenLabs) {
      this.questionEl.setText("Audio review needs an ElevenLabs API key — see Iris Cards settings (Experimental).");
      return;
    }
    if (!this.plugin.settings.elevenLabsVoiceId) {
      this.questionEl.setText("Audio review needs a voice — see Iris Cards settings (Experimental).");
      return;
    }

    this.loadQueue();
    this.controller = new AudioReviewController(this.plugin);
    await this.next();
  }

  private loadQueue(): void {
    const mf = this.plugin.settings.reviewModuleFilter.length > 0
      ? new Set(this.plugin.settings.reviewModuleFilter)
      : undefined;
    this.dueCards = this.infiniteMode
      ? getAllCards(this.app, this.plugin.settings.cardsFolder, mf, undefined, true)
      : getDueCards(this.app, this.plugin.settings.cardsFolder, 0, mf, this.plugin.settings.desiredRetention);
    this.sessionShowCount.clear();
    this.committedNextPath = null;
  }

  /** Restart the session in the other mode. The old controller is destroyed
   * (aborting any in-flight TTS/STT) and stale callbacks are fenced off by
   * the session counter, so the new session owns the audio timeline alone. */
  private async toggleInfinite(btn: HTMLElement): Promise<void> {
    this.infiniteMode = !this.infiniteMode;
    btn.toggleClass("is-active", this.infiniteMode);
    this.session++;
    this.controller?.destroy();
    this.controller = new AudioReviewController(this.plugin);
    this.loadQueue();
    await this.next();
  }

  /**
   * Rotate a weighted pick to the queue head (unless the previous pick already
   * committed the head), then lock in dueCards[1] with a second pick so the
   * prewarmed next-question audio matches the card that actually plays next.
   * Mirror of the visual view's pickByPriority.
   */
  private pickInfiniteHead(): void {
    if (this.dueCards.length === 0) {
      this.committedNextPath = null;
      return;
    }
    const honorCommitted = this.committedNextPath !== null
      && this.dueCards[0]?.path === this.committedNextPath;
    if (!honorCommitted) {
      const picked = weightedForgettingPick(this.app, this.dueCards, this.sessionShowCount);
      if (picked) {
        const idx = this.dueCards.indexOf(picked);
        if (idx > 0) {
          this.dueCards.splice(idx, 1);
          this.dueCards.unshift(picked);
        }
      }
    }
    if (this.dueCards.length >= 2) {
      const next = weightedForgettingPick(this.app, this.dueCards.slice(1), this.sessionShowCount);
      if (next) {
        const idx = this.dueCards.indexOf(next);
        if (idx > 1) {
          this.dueCards.splice(idx, 1);
          this.dueCards.splice(1, 0, next);
        }
        this.committedNextPath = next.path;
      } else {
        this.committedNextPath = null;
      }
    } else {
      this.committedNextPath = null;
    }
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.controller?.destroy();
    this.controller = null;
    this.contentEl.empty();
  }

  /** Active Q&A variant of a card, or null (→ the card is skipped). */
  private async qaVariantOf(file: TFile): Promise<QAVariant | null> {
    try {
      const parsed = await getParsedCached(this.app, file);
      return parsed.variants.find(v => v.exerciseType === "Q&A" && !v.suspended) ?? null;
    } catch {
      return null;
    }
  }

  private async next(): Promise<void> {
    if (this.closed || !this.controller) return;
    const session = this.session;

    if (this.infiniteMode) this.pickInfiniteHead();

    // Find the next due card with an active Q&A variant.
    let variant: QAVariant | null = null;
    let cardFile: TFile | null = null;
    while (this.dueCards.length > 0) {
      const head = this.dueCards[0];
      if (this.app.vault.getAbstractFileByPath(head.path)) {
        variant = await this.qaVariantOf(head);
        if (variant) { cardFile = head; break; }
      }
      this.dueCards.shift();
    }

    // A toggle mid-parse restarted the session; its own next() owns the queue now.
    if (this.closed || session !== this.session) return;

    if (!variant || !cardFile) {
      this.questionEl.setText(this.infiniteMode ? "No Q&A cards available." : "No Q&A cards due.");
      this.statusEl.setText("");
      this.progressEl.setText(this.sessionDone > 0 ? `${this.sessionDone} reviewed this session.` : "");
      return;
    }

    this.sessionShowCount.set(cardFile.path, (this.sessionShowCount.get(cardFile.path) ?? 0) + 1);
    this.questionEl.setText(variant.question);
    this.progressEl.setText(this.infiniteMode ? `Infinite · ${this.sessionDone} reviewed` : `${this.dueCards.length} in queue`);

    const v = variant;
    const file = cardFile;
    const answerFn = async (correct: boolean, userAnswer?: string) => {
      if (this.closed || session !== this.session) return;
      // Infinite mode is for practice; nothing feeds back into FSRS (same
      // contract as the visual review view). Answered cards rotate to the
      // back of the pool instead of leaving the queue.
      if (this.infiniteMode) {
        const done = this.dueCards.shift();
        if (done) this.dueCards.push(done);
      } else {
        await this.plugin.cardStore.recordReview(
          file, correct, v.question, userAnswer, undefined, undefined,
          undefined, this.plugin.settings.cardsFolder,
          this.plugin.settings.desiredRetention, this.plugin.settings.scheduler,
        );
        this.plugin.qaCache.delete(file.path);
        this.dueCards.shift();
        this.plugin.updateBadge();
      }
      this.sessionDone++;
      await this.next();
    };

    // Best-effort prewarm of the next Q&A card's question audio.
    const prewarmNext = async (): Promise<string | null> => {
      for (const candidate of this.dueCards.slice(1, 4)) {
        const cv = await this.qaVariantOf(candidate);
        if (cv) return questionTextForAudio(cv);
      }
      return null;
    };

    try {
      await this.controller.start(v, answerFn, this.statusEl, prewarmNext);
    } catch (e) {
      // Marking backend failure mid-card: report and stop rather than record
      // a verdict that never happened.
      console.error("[iris-cards] audio review failed", e);
      if (!this.closed && session === this.session) this.statusEl.setText("Audio review stopped — marking failed. Reopen to retry.");
    }
  }
}
