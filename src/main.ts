import {
  Notice,
  Plugin,
  TFile,
  TFolder,
  WorkspaceLeaf,
} from "obsidian";
import { IrisCardsSettingTab, DEFAULT_SETTINGS, FSRS_MIN_SAMPLES } from "./settings";
import type { IrisCardsSettings } from "./settings";
import { ReviewView, VIEW_TYPE_REVIEW } from "./review/review-view";
import { countDueFromCache, getParentNoteName, setFSRSWeights } from "./leitner";
import { collectCardLogs, countSamples, optimizeFSRS } from "./fsrs-optimizer";
import { CardStore } from "./card-store";
import { type QAVariant } from "./types/exercises";
import { setRelayApp } from "./api/client";
import { encryptSecret, decryptSecret } from "./commands/utils";
import { PregenManager } from "./commands/pregeneration";
import { createNoteFromSelection, memorizeSelection, createImageOcclusionCard } from "./commands/note-creation";
import { buildIrisCardsHomepageWidgets } from "./widgets/homepage-widget";
import { syncFlashcardTask } from "./tasks-bridge";

const HOTKEYS_PATH = ".obsidian/hotkeys.json";

export default class IrisCardsPlugin extends Plugin {
  settings: IrisCardsSettings = DEFAULT_SETTINGS;
  qaCache: Map<string, Promise<QAVariant[]>> = new Map();
  cardStore!: CardStore;
  pregen!: PregenManager;
  reviewViews: Set<ReviewView> = new Set();
  private ribbonIconEl: HTMLElement | null = null;
  private badgeEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    setRelayApp(this.app);
    this.cardStore = new CardStore(this.app);
    this.pregen = new PregenManager(this);
    await this.configureHotkeys();

    this.registerView(
      VIEW_TYPE_REVIEW,
      (leaf: WorkspaceLeaf) => new ReviewView(leaf, this),
    );

    this.addCommand({
      id: "create-iris-cards-note",
      name: "Create note from selection",
      callback: () => createNoteFromSelection(this),
    });

    this.addCommand({
      id: "memorize-selection",
      name: "Memorize selection",
      editorCallback: (editor, ctx) => memorizeSelection(this, editor, ctx),
    });

    this.addCommand({
      id: "open-review",
      name: "Review due cards",
      callback: () => this.activateReviewView(),
    });

    this.addCommand({
      id: "review-note-cards",
      name: "Review cards from this note",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        const folder = this.app.vault.getAbstractFileByPath(this.settings.cardsFolder.trim() || "Iris Cards");
        if (!folder || !(folder instanceof TFolder)) return false;
        const noteName = file.basename;
        const hasCards = folder.children.some(c => {
          if (!(c instanceof TFile) || c.extension !== "md") return false;
          const fm = this.app.metadataCache.getFileCache(c)?.frontmatter;
          return getParentNoteName(fm) === noteName;
        });
        if (!hasCards) return false;
        if (!checking) this.activateNoteReview(noteName);
        return true;
      },
    });

    this.addCommand({
      id: "create-image-occlusion-card",
      name: "Create image occlusion card",
      callback: () => createImageOcclusionCard(this),
    });

    this.addCommand({
      id: "optimize-fsrs-weights",
      name: "Optimize FSRS scheduler weights",
      callback: () => this.optimizeFSRSWeights(),
    });

    this.ribbonIconEl = this.addRibbonIcon("loader", "Iris Cards", () => {
      this.activateReviewView();
    });
    this.ribbonIconEl.addClass("iris-ribbon-icon");

    this.app.workspace.onLayoutReady(() => {
      this.updateBadge();
      this.pregen.pregenerateAll();
    });

    const invalidateCache = (file: unknown) => { if (file instanceof TFile) this.qaCache.delete(file.path); };
    this.registerEvent(this.app.vault.on("modify", invalidateCache));
    this.registerEvent(this.app.vault.on("delete", invalidateCache));

    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      const folder = this.settings.cardsFolder.trim() || "Iris Cards";
      if (file.path.startsWith(folder + "/")) this.updateBadge();
    }));

    this.registerInterval(
      window.setInterval(() => {
        this.updateBadge();
        this.pregen.pregenerateAll();
      }, 300000),
    );

    this.addSettingTab(new IrisCardsSettingTab(this.app, this));
  }

  private async configureHotkeys(): Promise<void> {
    if (this.settings.hotkeysConfigured) return;
    try {
      const adapter = this.app.vault.adapter;
      let hotkeys: Record<string, unknown[]> = {};
      if (await adapter.exists(HOTKEYS_PATH)) {
        hotkeys = JSON.parse(await adapter.read(HOTKEYS_PATH));
      }

      const hasCreateNote = Array.isArray(hotkeys["iris-cards:create-iris-cards-note"]) &&
        hotkeys["iris-cards:create-iris-cards-note"].length > 0;
      const hasMemorize = Array.isArray(hotkeys["iris-cards:memorize-selection"]) &&
        hotkeys["iris-cards:memorize-selection"].length > 0;

      if (hasCreateNote && hasMemorize) return;

      const irisBindings: Array<{ modifiers: string[]; key: string }> = [
        { modifiers: ["Mod"], key: "N" },
        { modifiers: ["Mod"], key: "M" },
      ];
      for (const [cmd, bindings] of Object.entries(hotkeys)) {
        if (cmd.startsWith("iris-cards:")) continue;
        if (!Array.isArray(bindings)) continue;
        hotkeys[cmd] = bindings.filter((b: any) =>
          !irisBindings.some(lb =>
            lb.key === b.key &&
            Array.isArray(b.modifiers) &&
            lb.modifiers.length === b.modifiers.length &&
            lb.modifiers.every((m: string) => b.modifiers.includes(m)),
          ),
        );
      }

      hotkeys["file-explorer:new-file"] = [];
      hotkeys["iris-cards:create-iris-cards-note"] = [{ modifiers: ["Mod"], key: "N" }];
      hotkeys["iris-cards:memorize-selection"] = [{ modifiers: ["Mod"], key: "M" }];

      await adapter.write(HOTKEYS_PATH, JSON.stringify(hotkeys, null, 2));
      this.settings.hotkeysConfigured = true;
      await this.saveSettings();
    } catch {
      // Non-fatal: hotkeys can be configured manually
    }
  }

  fsrsOptimizing = false;

  async optimizeFSRSWeights(): Promise<void> {
    if (this.fsrsOptimizing) {
      new Notice("FSRS optimization already in progress.");
      return;
    }
    const cards = collectCardLogs(this.app, this.settings.cardsFolder);
    const samples = countSamples(cards);
    if (samples < FSRS_MIN_SAMPLES) {
      new Notice(`Not enough review data: ${samples}/${FSRS_MIN_SAMPLES} samples.`);
      return;
    }
    this.fsrsOptimizing = true;
    const notice = new Notice(`Fitting FSRS weights on ${samples} samples…`, 0);
    try {
      const result = await optimizeFSRS(cards, {
        onProgress: (gen, bestF) => {
          notice.setMessage(`Fitting FSRS weights — gen ${gen}, loss ${bestF.toFixed(5)}`);
        },
      });
      this.settings.fsrsWeights = result.weights;
      this.settings.fsrsFitLoss = result.loss;
      this.settings.fsrsFitBaselineLoss = result.baselineLoss;
      this.settings.fsrsFitDate = new Date().toISOString();
      this.settings.fsrsFitSamples = result.samples;
      await this.saveSettings();
      setFSRSWeights(result.weights);
      this.updateBadge();
      notice.hide();
      new Notice(`FSRS fit complete — loss ${result.loss.toFixed(5)} vs baseline ${result.baselineLoss.toFixed(5)}.`, 8000);
    } catch (e) {
      console.error("[iris-cards] FSRS optimize failed", e);
      notice.hide();
      new Notice("FSRS optimization failed — see console.");
    } finally {
      this.fsrsOptimizing = false;
    }
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_REVIEW);
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.settings.desiredRetention = Math.max(0.70, Math.min(0.97, this.settings.desiredRetention));
    if (this.settings.anthropicApiKey) {
      this.settings.anthropicApiKey = decryptSecret(this.settings.anthropicApiKey);
    }
    if (this.settings.elevenLabsApiKey) {
      this.settings.elevenLabsApiKey = decryptSecret(this.settings.elevenLabsApiKey);
    }
    setFSRSWeights(this.settings.fsrsWeights);
  }

  async saveSettings(): Promise<void> {
    const toSave = { ...this.settings };
    if (toSave.anthropicApiKey && !toSave.anthropicApiKey.startsWith("enc:")) {
      toSave.anthropicApiKey = encryptSecret(toSave.anthropicApiKey);
    }
    if (toSave.elevenLabsApiKey && !toSave.elevenLabsApiKey.startsWith("enc:")) {
      toSave.elevenLabsApiKey = encryptSecret(toSave.elevenLabsApiKey);
    }
    await this.saveData(toSave);
  }

  async updateSetting<K extends keyof IrisCardsSettings>(key: K, value: IrisCardsSettings[K]): Promise<void> {
    this.settings[key] = value;
    await this.saveSettings();
  }

  updateBadge(knownCount?: number): void {
    const pos = this.settings.badgePosition;
    // Callers that just updated the queue (e.g. the homepage widget after
    // recordReview) pass their in-memory count and let us skip the folder
    // scan. Without a hint we fall back to recomputing from the metadata cache.
    const count = knownCount ?? countDueFromCache(this.app, this.settings.cardsFolder, 0, this.settings.desiredRetention);
    syncFlashcardTask(this.app, count);
    if (!this.ribbonIconEl) return;
    if (pos !== "off" && count > 0) {
      if (!this.badgeEl) {
        this.badgeEl = this.ribbonIconEl.createSpan({ cls: "iris-badge" });
      }
      this.badgeEl.className = `iris-badge iris-badge-${pos}`;
      this.badgeEl.setText(count > 99 ? "99+" : String(count));
      this.badgeEl.style.display = "";
    } else if (this.badgeEl) {
      this.badgeEl.style.display = "none";
    }
  }

  irisHomepageWidgets() {
    return buildIrisCardsHomepageWidgets(this);
  }

  async activateReviewView(): Promise<{ reused: boolean }> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return { reused: true };
    }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_REVIEW, active: true });
    this.app.workspace.revealLeaf(leaf);
    return { reused: false };
  }

  async activateNoteReview(noteName: string): Promise<void> {
    await this.activateReviewView();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW)[0];
    if (!leaf) return;
    const view = leaf.view as ReviewView;
    view.infiniteMode = true;
    await view.setNoteFilter(noteName);
  }
}
