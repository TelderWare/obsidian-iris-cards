import {
  Notice,
  Plugin,
  TFile,
  TFolder,
  WorkspaceLeaf,
} from "obsidian";
import { IrisCardsSettingTab, DEFAULT_SETTINGS, FSRS_MIN_SAMPLES, FSRS_AUTO_REFIT_NEW_SAMPLES } from "./settings";
import type { IrisCardsSettings } from "./settings";
import { ReviewView, VIEW_TYPE_REVIEW, type ReviewScope } from "./review/review-view";
import { BrowseView, VIEW_TYPE_BROWSE } from "./review/browse-view";
import { AudioReviewView, VIEW_TYPE_AUDIO } from "./review/audio-view";
import { countDueFromCache, estimateDueMinutes, getParentNoteName, setFSRSWeights } from "./scheduler";
import { collectCardLogs, countSamples, optimizeFSRS } from "./fsrs-optimizer";
import { CardStore } from "./card-store";
import { TableStore } from "./table-store";
import { type QAVariant } from "./types/exercises";
import { setRelayApp } from "./api/client";
import { encryptSecret, decryptSecret } from "./commands/utils";
import { PregenManager } from "./commands/pregeneration";
import { makeFlashcard, createImageOcclusionCard, createCardManually } from "./commands/note-creation";
import { buildIrisCardsHomepageWidgets } from "./widgets/homepage-widget";
import { syncFlashcardTask } from "./tasks-bridge";

const HOTKEYS_PATH = ".obsidian/hotkeys.json";

export default class IrisCardsPlugin extends Plugin {
  settings: IrisCardsSettings = DEFAULT_SETTINGS;
  qaCache: Map<string, Promise<QAVariant[]>> = new Map();
  cardStore!: CardStore;
  tableStore!: TableStore;
  pregen!: PregenManager;
  reviewViews: Set<ReviewView> = new Set();
  private ribbonIconEl: HTMLElement | null = null;
  private badgeEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    setRelayApp(this.app);
    this.cardStore = new CardStore(this.app);
    this.tableStore = new TableStore(this.app);
    this.pregen = new PregenManager(this);
    await this.configureHotkeys();

    this.registerView(
      VIEW_TYPE_REVIEW,
      (leaf: WorkspaceLeaf) => new ReviewView(leaf, this),
    );

    this.registerView(
      VIEW_TYPE_BROWSE,
      (leaf: WorkspaceLeaf) => new BrowseView(leaf, this),
    );

    this.registerView(
      VIEW_TYPE_AUDIO,
      (leaf: WorkspaceLeaf) => new AudioReviewView(leaf, this),
    );

    this.addCommand({
      id: "make-flashcard",
      name: "Make flashcard",
      editorCallback: (editor, ctx) => makeFlashcard(this, editor, ctx),
    });

    this.addCommand({
      id: "open-review",
      name: "Review due cards",
      callback: () => this.activateReviewView(),
    });

    this.addCommand({
      id: "open-browse",
      name: "Browse facts",
      callback: () => this.activateBrowseView(),
    });

    // Audio-only review is its own process (experimental) — a separate view,
    // not a toggle inside the visual review.
    this.addCommand({
      id: "open-audio-review",
      name: "Audio review",
      icon: "headphones",
      checkCallback: (checking: boolean) => {
        if (!this.settings.experimentalMode) return false;
        if (!checking) void this.activateAudioReview();
        return true;
      },
    });

    this.addCommand({
      id: "review-note-cards",
      name: "Review cards from this note",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.noteHasCards(file.basename)) return false;
        if (!checking) this.activateNoteReview(file.basename);
        return true;
      },
    });

    this.addCommand({
      id: "create-image-occlusion-card",
      name: "Create image occlusion card",
      callback: () => createImageOcclusionCard(this),
    });

    this.addCommand({
      id: "create-card-manually",
      name: "Create card manually",
      callback: () => createCardManually(this),
    });

    // Tables are hand-edited markdown — the command just scaffolds the shape.
    this.addCommand({
      id: "create-table",
      name: "Create table",
      callback: () => void this.createTableFile(),
    });

    this.addCommand({
      id: "optimize-fsrs-weights",
      name: "Optimize FSRS scheduler weights",
      callback: () => this.optimizeFSRSWeights(),
    });

    this.ribbonIconEl = this.addRibbonIcon("loader", "Cards", () => {
      this.activateReviewView();
    });
    this.ribbonIconEl.addClass("iris-ribbon-icon");

    this.app.workspace.onLayoutReady(() => {
      this.updateBadge();
      this.pregen.pregenerateAll();
      void this.backfillDisplayTitlesOnce();
      this.maybeAutoOptimizeFSRS();
      // Catch up on parent-note tag changes made while the plugin was off.
      void this.cardStore.syncInheritedTags(this.settings.cardsFolder);
      // Warm the table cache so the badge can count due rows synchronously.
      void this.tableStore.getTables(this.settings.cardsFolder).then(() => this.updateBadge());
    });

    const invalidateCache = (file: unknown) => { if (file instanceof TFile) this.qaCache.delete(file.path); };
    this.registerEvent(this.app.vault.on("modify", invalidateCache));
    this.registerEvent(this.app.vault.on("delete", invalidateCache));

    // Right-click in the file explorer (and other file menus): start a
    // filtered practice review of the note's, folder's, or card's cards.
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      const cardsFolder = this.settings.cardsFolder.trim() || "Iris Cards";
      if (file instanceof TFile && file.extension === "md") {
        if (this.tableStore.isTableFile(file)) {
          menu.addItem(item => item
            .setTitle("Review this table")
            .setIcon("loader")
            .onClick(() => void this.activateTableReview(file)));
        } else if (this.tableStore.isStateFile(file)) {
          // State files aren't reviewable — no menu entry.
        } else if (file.path.startsWith(cardsFolder + "/")) {
          menu.addItem(item => item
            .setTitle("Review this card")
            .setIcon("loader")
            .onClick(() => void this.activateCardReview(file.path)));
        } else if (this.noteHasCards(file.basename)) {
          menu.addItem(item => item
            .setTitle("Review cards from this note")
            .setIcon("loader")
            .onClick(() => void this.activateNoteReview(file.basename)));
        }
      } else if (file instanceof TFolder && !file.isRoot() && file.path !== cardsFolder) {
        if (this.folderHasCards(file.path)) {
          menu.addItem(item => item
            .setTitle("Review cards from this folder")
            .setIcon("loader")
            .onClick(() => void this.activateFolderReview(file.path)));
        }
      }
    }));

    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      const folder = this.settings.cardsFolder.trim() || "Iris Cards";
      if (file.path.startsWith(folder + "/")) {
        if (this.tableStore.isTableFile(file)) {
          // Re-parse (the mtime-keyed cache invalidates itself), then recount.
          void this.tableStore.getTable(file).then(() => this.updateBadge());
        } else if (this.tableStore.isStateFile(file)) {
          // A state-file edit (hand-fix or another device's sync) changes the
          // paired table's row state — re-parse that table, then recount.
          const table = this.tableStore.pairedTable(file);
          if (table) void this.tableStore.getTable(table).then(() => this.updateBadge());
        }
        this.updateBadge();
      } else if (file.extension === "md") {
        // Cards inherit tags live from their parent note — resync this
        // note's children once its metadata settles.
        this.scheduleTagSync(file.basename);
      }
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
    if (this.settings.hotkeysConfiguredV4) return;
    try {
      const adapter = this.app.vault.adapter;
      let hotkeys: Record<string, unknown[]> = {};
      if (await adapter.exists(HOTKEYS_PATH)) {
        hotkeys = JSON.parse(await adapter.read(HOTKEYS_PATH));
      }

      // Drop orphaned bindings from previous versions (command moved to
      // iris-editor; memorize-selection / capture-selection renamed to
      // make-flashcard).
      delete hotkeys["iris-cards:create-iris-cards-note"];
      delete hotkeys["iris-cards:memorize-selection"];
      delete hotkeys["iris-cards:capture-selection"];

      const irisBindings: Array<{ modifiers: string[]; key: string }> = [
        { modifiers: ["Mod"], key: "N" },
        { modifiers: ["Mod"], key: "M" },
      ];
      const keepKey = (cmd: string) =>
        cmd === "iris-editor:create-note" || cmd === "iris-cards:make-flashcard";
      for (const [cmd, bindings] of Object.entries(hotkeys)) {
        if (keepKey(cmd)) continue;
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
      hotkeys["iris-editor:create-note"] = [{ modifiers: ["Mod"], key: "N" }];
      hotkeys["iris-cards:make-flashcard"] = [{ modifiers: ["Mod"], key: "M" }];

      await adapter.write(HOTKEYS_PATH, JSON.stringify(hotkeys, null, 2));
      this.settings.hotkeysConfiguredV4 = true;
      await this.saveSettings();
    } catch {
      // Non-fatal: hotkeys can be configured manually
    }
  }

  /** Scaffold a table file in the cards folder and open it for editing. Rows
   * are introduced from the review view's done screen once the table has
   * content — see table-store.ts for the format. */
  private async createTableFile(): Promise<void> {
    const cardsFolder = this.settings.cardsFolder.trim() || "Iris Cards";
    await this.cardStore.ensureFolderExists(cardsFolder);
    const template = [
      "---",
      "kind: table",
      "table: New table",
      "order-by: ",
      "---",
      "",
      "| Name | Value |",
      "| ---- | ----- |",
      "| Example | 1 |",
      "",
    ].join("\n");
    const file = await this.app.vault.create(`${cardsFolder}/Table ${Date.now()}.md`, template);
    await this.app.workspace.getLeaf("tab").openFile(file);
    new Notice("Fill in the table, name it, and set order-by to the column that decides introduction order.");
  }

  private tagSyncTimers = new Map<string, number>();

  /** Debounced per-note tag resync — note edits fire `changed` in bursts. */
  private scheduleTagSync(parentName: string): void {
    window.clearTimeout(this.tagSyncTimers.get(parentName));
    this.tagSyncTimers.set(parentName, window.setTimeout(() => {
      this.tagSyncTimers.delete(parentName);
      void this.cardStore.syncInheritedTags(this.settings.cardsFolder, parentName);
    }, 500));
  }

  private async backfillDisplayTitlesOnce(): Promise<void> {
    if (this.settings.displayTitleBackfillV1) return;
    try {
      await this.cardStore.backfillDisplayTitles(this.settings.cardsFolder);
      this.settings.displayTitleBackfillV1 = true;
      await this.saveSettings();
    } catch (e) {
      console.error("[iris-cards] displayTitle backfill failed", e);
    }
  }

  fsrsOptimizing = false;

  /** Fire a quiet background re-fit on load once enough new reviews have
   * accumulated since the last fit. No-op when disabled, below the minimum, or
   * when the delta since the last fit is too small to be worth a refit. */
  private maybeAutoOptimizeFSRS(): void {
    if (!this.settings.fsrsAutoOptimize) return;
    const cards = collectCardLogs(this.app, this.settings.cardsFolder);
    const samples = countSamples(cards);
    if (samples < FSRS_MIN_SAMPLES) return;
    const lastFit = this.settings.fsrsFitSamples ?? 0;
    if (samples - lastFit < FSRS_AUTO_REFIT_NEW_SAMPLES) return;
    void this.optimizeFSRSWeights({ silent: true });
  }

  async optimizeFSRSWeights(opts: { silent?: boolean } = {}): Promise<void> {
    const { silent = false } = opts;
    if (this.fsrsOptimizing) {
      if (!silent) new Notice("FSRS optimization already in progress.");
      return;
    }
    const cards = collectCardLogs(this.app, this.settings.cardsFolder);
    const samples = countSamples(cards);
    if (samples < FSRS_MIN_SAMPLES) {
      if (!silent) new Notice(`Not enough review data: ${samples}/${FSRS_MIN_SAMPLES} samples.`);
      return;
    }
    this.fsrsOptimizing = true;
    const notice = silent ? null : new Notice(`Fitting FSRS weights on ${samples} samples…`, 0);
    try {
      const result = await optimizeFSRS(cards, {
        onProgress: silent ? undefined : (gen, bestF) => {
          notice?.setMessage(`Fitting FSRS weights — gen ${gen}, loss ${bestF.toFixed(5)}`);
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
      notice?.hide();
      if (!silent) {
        new Notice(`FSRS fit complete — loss ${result.loss.toFixed(5)} vs baseline ${result.baselineLoss.toFixed(5)}.`, 8000);
      }
    } catch (e) {
      console.error("[iris-cards] FSRS optimize failed", e);
      notice?.hide();
      if (!silent) new Notice("FSRS optimization failed — see console.");
    } finally {
      this.fsrsOptimizing = false;
    }
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_REVIEW);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_BROWSE);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_AUDIO);
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
    const mf = this.settings.reviewModuleFilter.length > 0 ? new Set(this.settings.reviewModuleFilter) : undefined;
    const count = knownCount
      ?? countDueFromCache(this.app, this.settings.cardsFolder, 0, this.settings.desiredRetention, mf)
        + this.tableStore.cachedDueRowCount(this.settings.cardsFolder, this.settings.desiredRetention, mf);
    syncFlashcardTask(this.app, count, estimateDueMinutes(this.app, this.settings.cardsFolder, count, mf));
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

  async activateBrowseView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_BROWSE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_BROWSE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async activateAudioReview(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_AUDIO);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_AUDIO, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  /** Iterate the markdown files in the cards folder. */
  private *cardFiles(): Generator<TFile> {
    const folder = this.app.vault.getAbstractFileByPath(this.settings.cardsFolder.trim() || "Iris Cards");
    if (!(folder instanceof TFolder)) return;
    for (const c of folder.children) {
      if (c instanceof TFile && c.extension === "md") yield c;
    }
  }

  private noteHasCards(noteName: string): boolean {
    for (const c of this.cardFiles()) {
      const fm = this.app.metadataCache.getFileCache(c)?.frontmatter;
      if (getParentNoteName(fm) === noteName) return true;
    }
    return false;
  }

  private folderHasCards(folderPath: string): boolean {
    for (const c of this.cardFiles()) {
      const parent = getParentNoteName(this.app.metadataCache.getFileCache(c)?.frontmatter);
      if (!parent) continue;
      const dest = this.app.metadataCache.getFirstLinkpathDest(parent, c.path);
      if (dest && dest.path.startsWith(folderPath + "/")) return true;
    }
    return false;
  }

  /** Open the review view scoped to a subset of cards, in infinite (practice)
   * mode so nothing feeds back into the schedule. */
  private async activateScopedReview(scope: ReviewScope): Promise<void> {
    await this.activateReviewView();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW)[0];
    if (!leaf) return;
    const view = leaf.view as ReviewView;
    view.infiniteMode = true;
    await view.setScope(scope);
  }

  async activateNoteReview(noteName: string): Promise<void> {
    await this.activateScopedReview({ kind: "note", value: noteName, label: noteName });
  }

  /** Practice-review a single card (from the browse view / explorer). */
  async activateCardReview(path: string): Promise<void> {
    const fm = this.app.metadataCache.getCache(path)?.frontmatter;
    const label = typeof fm?.["displayTitle"] === "string" && fm["displayTitle"].trim()
      ? fm["displayTitle"].trim()
      : path.split("/").pop() ?? path;
    await this.activateScopedReview({ kind: "card", value: path, label });
  }

  /** Review every card whose inherited tags include `tag` (nested tags match).
   * Called by Iris Nav's tag explorer via the plugin registry. */
  async activateTagReview(tag: string): Promise<void> {
    const clean = tag.replace(/^#/, "");
    await this.activateScopedReview({ kind: "tag", value: clean, label: `#${clean}` });
  }

  /** Review every card whose parent note lives under `folderPath`. */
  async activateFolderReview(folderPath: string): Promise<void> {
    await this.activateScopedReview({ kind: "folder", value: folderPath, label: folderPath.split("/").pop() ?? folderPath });
  }

  /** Practice-review the introduced rows of one table. */
  async activateTableReview(file: TFile): Promise<void> {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const label = typeof fm?.["table"] === "string" && fm["table"].trim() ? fm["table"].trim() : file.basename;
    await this.activateScopedReview({ kind: "table", value: file.path, label });
  }
}
