import {
  Plugin,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { IrisCardsSettingTab, DEFAULT_SETTINGS } from "./settings";
import type { IrisCardsSettings } from "./settings";
import { ReviewView, VIEW_TYPE_REVIEW } from "./review/review-view";
import { countDueFromCache } from "./leitner";
import { CardStore } from "./card-store";
import { type QAVariant } from "./types/exercises";
import { setRelayApp } from "./api/client";
import { encryptSecret, decryptSecret } from "./commands/utils";
import { PregenManager } from "./commands/pregeneration";
import { createNoteFromSelection, memorizeSelection } from "./commands/note-creation";

const HOTKEYS_PATH = ".obsidian/hotkeys.json";

export default class IrisCardsPlugin extends Plugin {
  settings: IrisCardsSettings = DEFAULT_SETTINGS;
  qaCache: Map<string, Promise<QAVariant[]>> = new Map();
  cardStore!: CardStore;
  pregen!: PregenManager;
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

    this.ribbonIconEl = this.addRibbonIcon("brain", "Iris Cards", () => {
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
  }

  async saveSettings(): Promise<void> {
    const toSave = { ...this.settings };
    if (toSave.anthropicApiKey && !toSave.anthropicApiKey.startsWith("enc:")) {
      toSave.anthropicApiKey = encryptSecret(toSave.anthropicApiKey);
    }
    await this.saveData(toSave);
  }

  async updateSetting<K extends keyof IrisCardsSettings>(key: K, value: IrisCardsSettings[K]): Promise<void> {
    this.settings[key] = value;
    await this.saveSettings();
  }

  updateBadge(): void {
    if (!this.ribbonIconEl) return;
    const pos = this.settings.badgePosition;
    const count = countDueFromCache(this.app, this.settings.cardsFolder, 0, this.settings.desiredRetention);
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

  async activateReviewView(): Promise<{ reused: boolean }> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return { reused: true };
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_REVIEW, active: true });
    this.app.workspace.revealLeaf(leaf);
    return { reused: false };
  }
}
