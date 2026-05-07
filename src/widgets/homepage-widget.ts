import { type App, Component, Menu, TFile, type EventRef } from "obsidian";
import type IrisCardsPlugin from "../main";
import { getDueCards } from "../leitner";
import type { ParsedQA, QAVariant } from "../types/exercises";
import {
  type RenderContext,
  getParsedCached,
  invalidateParsedCache,
  renderVariantInto,
} from "../review/renderers";

interface IrisHomepageContext {
  containerEl: HTMLElement;
}

interface IrisHomepageWidgetHandle {
  destroy(): void;
  onResize?(): void;
  onConfigChange?(config: unknown): void;
}

interface IrisHomepageWidgetDescriptor {
  type: string;
  label: string;
  icon: string;
  defaultSizePx: { width: number; height: number };
  minSizePx?: { width: number; height: number };
  create(ctx: IrisHomepageContext): IrisHomepageWidgetHandle;
}

function pickVariant(variants: QAVariant[]): QAVariant | null {
  const active = variants.filter(v => !v.suspended);
  if (active.length === 0) return null;
  const qa = active.find(v => v.exerciseType === "Q&A");
  return qa ?? active[0];
}

/**
 * Minimal Component implementing the renderers' `RenderContext` surface. Owns
 * a per-variant render-state cache (so re-rendering within a card keeps the
 * same T/F polarity, cloze term, randomized knowns, …) and handles audio/flash
 * feedback on the widget's own root element.
 */
class WidgetRenderContext extends Component implements RenderContext {
  peekedAnswer = false;
  private renderStates = new Map<string, Record<string, unknown>>();
  private audioCtx: AudioContext | null = null;

  constructor(
    readonly app: App,
    readonly plugin: IrisCardsPlugin,
    private readonly flashHost: HTMLElement,
  ) {
    super();
  }

  getRenderState(cardFile: TFile, variant: QAVariant): Record<string, unknown> {
    const key = cardFile.path + "\0" + variant.question;
    let state = this.renderStates.get(key);
    if (!state) {
      state = {};
      this.renderStates.set(key, state);
    }
    return state;
  }

  /**
   * Clear all cached render state. The widget shows one card at a time, so
   * advancing to a new card makes every prior state unreachable — a simple
   * `.clear()` both prevents unbounded growth and avoids the
   * prefix-scan-and-delete pass of the old implementation.
   */
  clearRenderState(): void {
    this.renderStates.clear();
  }

  playFeedback(correct: boolean, record = false): void {
    const s = this.plugin.settings;
    if (s.soundFeedback) this.playTone(correct);
    if (s.flashFeedback) {
      const flash = this.flashHost.createDiv({ cls: "iris-flash" });
      flash.addClass(record ? "iris-flash-record" : correct ? "iris-flash-correct" : "iris-flash-incorrect");
      setTimeout(() => flash.remove(), 500);
    }
  }

  /**
   * Oscillator-based tones. Self-contained (no WAV data-URL dependency), so the
   * widget works even if the full review view's audio assets aren't loaded.
   * Correct: short high chirp. Incorrect: low square-wave buzz.
   */
  private playTone(correct: boolean): void {
    try {
      if (!this.audioCtx) {
        const Ctx = window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.audioCtx = new Ctx();
      }
      const ctx = this.audioCtx;
      const now = ctx.currentTime;
      const dur = correct ? 0.08 : 0.12;
      const osc = ctx.createOscillator();
      osc.type = correct ? "sine" : "square";
      osc.frequency.value = correct ? 880 : 220;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(correct ? 0.2 : 0.25, now + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + dur);
    } catch { /* ignore */ }
  }
}

/** Entries older than this are ignored — safety net in case the metadataCache
 *  event never fires for a write we made (so we don't suppress forever). */
const SELF_WRITE_TTL_MS = 2000;

class ReviewWidget {
  private root: HTMLElement;
  private cardEl: HTMLElement | null = null;
  private container: HTMLElement;
  private cardHost: HTMLElement | null;
  private renderCtx: WidgetRenderContext;
  private metaEventRef: EventRef | null = null;
  private dueCards: TFile[] = [];
  private currentCard: TFile | null = null;
  private currentVariant: QAVariant | null = null;
  private answering = false;
  private startedAt = 0;
  private disposed = false;
  private reloadTimer: number | null = null;
  /** Debounced reload got shelved because we were mid-answer — consume on advance. */
  private pendingReload = false;
  /** Files we just wrote (e.g. via recordReview) → expiry timestamp.
   *  Metadata-cache "changed" events for these are suppressed so our own
   *  writes don't trigger a redundant getDueCards folder scan. */
  private selfWrittenPaths = new Map<string, number>();
  /** Parsed content of the next due card, fetched in the background during
   *  the current card's answer so advance() doesn't block on file I/O. */
  private nextPrefetch: { file: TFile; parsed: Promise<ParsedQA | null> } | null = null;

  constructor(private readonly plugin: IrisCardsPlugin, container: HTMLElement) {
    this.container = container;
    // The homepage wraps our containerEl in its own card chrome (resize handles,
    // grid cell). Hiding that parent makes the whole widget disappear when
    // there's nothing to review.
    this.cardHost = container.parentElement;
    this.root = container.createDiv({ cls: "iris-hp-widget-root iris-widget" });
    this.root.addEventListener("contextmenu", (e) => this.openContextMenu(e));

    this.renderCtx = new WidgetRenderContext(this.plugin.app, this.plugin, this.root);
    this.renderCtx.load();

    void this.reload();

    this.metaEventRef = this.plugin.app.metadataCache.on("changed", (file) => {
      const folder = this.plugin.settings.cardsFolder.trim() || "Iris Cards";
      if (!file.path.startsWith(folder + "/")) return;

      // Ignore change events for files we just wrote — the queue already
      // reflects the outcome and scanning the folder again accomplishes
      // nothing. Expire stale entries lazily while we're here.
      const now = Date.now();
      const writeExpiry = this.selfWrittenPaths.get(file.path);
      if (writeExpiry != null) {
        this.selfWrittenPaths.delete(file.path);
        if (writeExpiry > now) return;
      }

      this.scheduleReload();
    });
  }

  private markSelfWrite(path: string): void {
    this.selfWrittenPaths.set(path, Date.now() + SELF_WRITE_TTL_MS);
  }

  private scheduleReload(): void {
    if (this.reloadTimer != null) window.clearTimeout(this.reloadTimer);
    this.reloadTimer = window.setTimeout(() => {
      this.reloadTimer = null;
      if (this.answering || this.currentCard) {
        // Can't reload without yanking the visible card — remember to do it
        // as soon as the current card is resolved (see advance()).
        this.pendingReload = true;
        return;
      }
      void this.reload();
    }, 250);
  }

  private async reload(): Promise<void> {
    if (this.disposed) return;
    this.dueCards = getDueCards(
      this.plugin.app,
      this.plugin.settings.cardsFolder,
      0,
      undefined,
      this.plugin.settings.desiredRetention,
    );
    this.nextPrefetch = null;
    await this.advance();
  }

  /** Start fetching + parsing the NEXT-up card so the next advance() finds it
   *  already resolved. Mtime-keyed cache in renderers.ts dedupes with previews. */
  private schedulePrefetch(): void {
    const next = this.dueCards[1];
    if (!next) { this.nextPrefetch = null; return; }
    // Avoid re-kicking if the same file is already prefetching.
    if (this.nextPrefetch?.file === next) return;
    this.nextPrefetch = {
      file: next,
      parsed: getParsedCached(this.plugin.app, next).catch(() => null),
    };
  }

  private async advance(): Promise<void> {
    if (this.disposed) return;

    this.currentCard = null;
    this.currentVariant = null;

    // If a metadata change landed mid-answer, re-query the due queue before
    // picking the next card (new cards may have become due, or the queue
    // may have been edited externally).
    if (this.pendingReload) {
      this.pendingReload = false;
      this.dueCards = getDueCards(
        this.plugin.app,
        this.plugin.settings.cardsFolder,
        0,
        undefined,
        this.plugin.settings.desiredRetention,
      );
      this.nextPrefetch = null;
    }

    while (this.dueCards.length > 0) {
      const file = this.dueCards[0];
      if (!this.plugin.app.vault.getAbstractFileByPath(file.path)) {
        this.dueCards.shift();
        continue;
      }
      try {
        const parsed =
          this.nextPrefetch?.file === file
            ? await this.nextPrefetch.parsed
            : await getParsedCached(this.plugin.app, file).catch(() => null);
        this.nextPrefetch = null;
        if (!parsed) { this.dueCards.shift(); continue; }
        const variant = pickVariant(parsed.variants);
        if (variant) {
          this.currentCard = file;
          this.currentVariant = variant;
          this.renderCtx.peekedAnswer = false;
          this.renderCtx.clearRenderState();
          this.startedAt = performance.now();
          await this.renderCurrent();
          // Warm the cache for the following card while the user thinks,
          // so the next advance can render it without waiting on disk.
          this.schedulePrefetch();
          return;
        }
      } catch (err) {
        console.error("[iris-cards] Widget: failed to parse card", file.path, err);
      }
      this.dueCards.shift();
    }

    // No cards left — hide the whole widget card.
    this.nextPrefetch = null;
    this.root.empty();
    this.cardEl = null;
    this.setHidden(true);
  }

  private async renderCurrent(): Promise<void> {
    if (this.disposed || !this.currentCard || !this.currentVariant) return;
    this.setHidden(false);
    this.root.empty();
    this.root.createEl("h6", { cls: "iris-hp-widget-title", text: "Review" });

    this.cardEl = this.root.createDiv({ cls: "iris-card iris-widget-card" });
    await renderVariantInto(
      this.renderCtx,
      this.cardEl,
      this.currentCard,
      this.currentVariant,
      this.makeAnswerFn(this.currentCard, this.currentVariant),
    );
  }

  /**
   * Build the AnswerFn renderers invoke on user response. Mirrors ReviewView's
   * createAnswerHandler: feedback + recordReview + advance, with a re-entrancy
   * guard so double-clicks can't record the same card twice.
   */
  private makeAnswerFn(file: TFile, variant: QAVariant) {
    return async (correct: boolean, userAnswer?: string, gapTerm?: string) => {
      if (this.answering) return;
      this.answering = true;

      const elapsedMs = Math.round(performance.now() - this.startedAt);
      const record = correct && variant.recordMs != null && elapsedMs < variant.recordMs;
      this.renderCtx.playFeedback(correct, record);

      // Suppress the metadata-cache "changed" event this write will fire —
      // our dueCards and badge are already up to date without a rescan.
      this.markSelfWrite(file.path);
      try {
        await this.plugin.cardStore.recordReview(file, correct, variant.question, userAnswer, elapsedMs, gapTerm);
      } catch (err) {
        console.error("[iris-cards] Widget: recordReview failed", err);
      }
      // The file contents changed — drop the parsed cache entry so any later
      // render uses fresh content (cache also rechecks mtime, but this is a
      // defence-in-depth against mtime-granularity quirks).
      invalidateParsedCache(file.path);

      this.dueCards.shift();
      // We know the exact new due count — skip the folder scan updateBadge
      // would otherwise do.
      this.plugin.updateBadge(this.dueCards.length);

      this.answering = false;
      await this.advance();
    };
  }

  private setHidden(hidden: boolean): void {
    const host = this.cardHost ?? this.container;
    host.style.display = hidden ? "none" : "";
  }

  private openContextMenu(e: MouseEvent): void {
    e.preventDefault();
    const s = this.plugin.settings;
    const menu = new Menu();

    const toggle = <K extends "soundFeedback" | "flashFeedback" | "autoMark">(
      key: K,
      label: string,
      icon: string,
    ) => {
      menu.addItem((mi) =>
        mi
          .setTitle(label)
          .setIcon(icon)
          .setChecked(s[key])
          .onClick(async () => {
            await this.plugin.updateSetting(key, !s[key] as IrisCardsPlugin["settings"][K]);
            // Re-render so toggling AI marking swaps between typed input and
            // manual reveal immediately (matches the full review view).
            if (key === "autoMark" && this.currentCard && this.currentVariant && !this.answering) {
              this.startedAt = performance.now();
              await this.renderCurrent();
            }
          }),
      );
    };

    toggle("soundFeedback", "Sound feedback", "volume-2");
    toggle("flashFeedback", "Flash feedback", "zap");
    toggle("autoMark", "AI marking", "brain-circuit");

    menu.showAtMouseEvent(e);
  }

  destroy(): void {
    this.disposed = true;
    if (this.reloadTimer != null) window.clearTimeout(this.reloadTimer);
    if (this.metaEventRef) {
      this.plugin.app.metadataCache.offref(this.metaEventRef);
      this.metaEventRef = null;
    }
    this.renderCtx.unload();
    this.setHidden(false);
    this.root.remove();
  }
}

export function buildIrisCardsHomepageWidgets(
  plugin: IrisCardsPlugin,
): IrisHomepageWidgetDescriptor[] {
  return [
    {
      type: "iris-cards:review",
      label: "Review (Iris Cards)",
      icon: "loader",
      defaultSizePx: { width: 340, height: 320 },
      minSizePx: { width: 220, height: 220 },
      create(ctx) {
        const widget = new ReviewWidget(plugin, ctx.containerEl);
        return {
          destroy: () => widget.destroy(),
        };
      },
    },
  ];
}
