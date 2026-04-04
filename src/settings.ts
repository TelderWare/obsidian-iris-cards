import { App, PluginSettingTab, Setting } from "obsidian";
import type IrisCardsPlugin from "./main";

export type BadgePosition = "top-right" | "top-left" | "bottom-right" | "bottom-left" | "off";

export interface IrisCardsSettings {
  // Note creation (with selection)
  targetPrefix: string;
  stripPrefixes: string[];
  useAutoStripPrefixes: boolean;
  withSelectionAddParentNote: boolean;
  // Note creation (no selection)
  noSelectionUseTargetPrefix: boolean;
  noSelectionAddParentNote: boolean;
  // Memorize
  cardsFolder: string;
  anthropicApiKey: string;
  claudeModel: string;
  autoMark: boolean;
  soundFeedback: boolean;
  flashFeedback: boolean;
  badgePosition: BadgePosition;
  // Internal
  hotkeysConfigured: boolean;
}

export const DEFAULT_SETTINGS: IrisCardsSettings = {
  targetPrefix: "Glossary",
  stripPrefixes: [],
  useAutoStripPrefixes: true,
  withSelectionAddParentNote: true,
  noSelectionUseTargetPrefix: false,
  noSelectionAddParentNote: false,
  cardsFolder: "Iris Cards",
  anthropicApiKey: "",
  claudeModel: "claude-sonnet-4-6",
  autoMark: false,
  soundFeedback: true,
  flashFeedback: true,
  badgePosition: "bottom-left",
  hotkeysConfigured: false,
};

export class IrisCardsSettingTab extends PluginSettingTab {
  plugin: IrisCardsPlugin;

  constructor(app: App, plugin: IrisCardsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    const addToggle = (name: string, desc: string, key: keyof IrisCardsSettings, onChange?: () => void) =>
      new Setting(containerEl).setName(name).setDesc(desc).addToggle(t =>
        t.setValue(s[key] as boolean).onChange(async (v) => { (s as any)[key] = v; await save(); onChange?.(); }));

    const addText = (name: string, desc: string, key: keyof IrisCardsSettings, placeholder: string) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText(t =>
        t.setPlaceholder(placeholder).setValue(s[key] as string).onChange(async (v) => { (s as any)[key] = v.trim(); await save(); }));

    // ─── With selection ─────────────────────────────────────
    containerEl.createEl("h3", { text: "Create note (with selection)" });
    addText("Target prefix", "Folder prepended to new note paths when creating from selected text.", "targetPrefix", "Glossary");
    addToggle("Auto-detect strip prefixes", "When enabled, all top-level vault folders are used as strip prefixes. Disable to specify a custom list.", "useAutoStripPrefixes", () => this.display());

    if (!s.useAutoStripPrefixes) {
      new Setting(containerEl)
        .setName("Custom strip prefixes")
        .setDesc("Comma-separated folder names to strip from the start of note paths.")
        .addText(t => t.setPlaceholder("Projects, Areas, Resources").setValue(s.stripPrefixes.join(", "))
          .onChange(async (v) => { s.stripPrefixes = v.split(",").map(x => x.trim()).filter(Boolean); await save(); }));
    }

    addToggle("Add parent note", "Add a parent-note property linking back to the source note.", "withSelectionAddParentNote");

    // ─── Without selection ──────────────────────────────────
    containerEl.createEl("h3", { text: "Create note (no selection)" });
    addToggle("Use target prefix folder", "Create untitled notes in the target prefix folder instead of the vault root.", "noSelectionUseTargetPrefix");
    addToggle("Add parent note", "Add a parent-note property linking back to the source note.", "noSelectionAddParentNote");

    // ─── Memorize ───────────────────────────────────────────
    containerEl.createEl("h3", { text: "Memorize" });
    addText("Cards folder", "Folder where Iris Cards are stored.", "cardsFolder", "Iris Cards");

    new Setting(containerEl).setName("Anthropic API key").setDesc("API key for Claude-generated review questions.").addText(t => {
      t.inputEl.type = "password";
      t.setPlaceholder("sk-ant-...").setValue(s.anthropicApiKey).onChange(async (v) => { s.anthropicApiKey = v.trim(); await save(); });
    });

    addToggle("Auto-mark", "Let Claude mark your typed answer instead of self-marking.", "autoMark");
    addToggle("Sound feedback", "Play a chime for correct and a buzz for incorrect.", "soundFeedback");
    addToggle("Flash feedback", "Flash the screen green or red on correct/incorrect.", "flashFeedback");

    new Setting(containerEl).setName("Badge position").setDesc("Where to show the due-card count badge on the ribbon icon.").addDropdown(d =>
      d.addOptions({
        "top-right": "Top right",
        "top-left": "Top left",
        "bottom-right": "Bottom right",
        "bottom-left": "Bottom left",
        off: "Disabled",
      }).setValue(s.badgePosition).onChange(async (v) => { s.badgePosition = v as any; await save(); this.plugin.updateBadge(); }));

    new Setting(containerEl).setName("Claude model").setDesc("Model used for generating review questions.").addDropdown(d =>
      d.addOption("claude-opus-4-6", "Claude Opus 4.6")
        .addOption("claude-sonnet-4-6", "Claude Sonnet 4.6")
        .addOption("claude-haiku-4-5-20251001", "Claude Haiku 4.5")
        .setValue(s.claudeModel).onChange(async (v) => { s.claudeModel = v; await save(); }));
  }
}
