import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type IrisCardsPlugin from "./main";
import { collectCardLogs, countSamples, optimizeFSRS } from "./fsrs-optimizer";
import { setFSRSWeights } from "./leitner";
import { fetchVoices, type ElevenLabsVoice } from "./api/elevenlabs";

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
  desiredRetention: number;
  // Audio review
  elevenLabsApiKey: string;
  elevenLabsVoiceId: string;
  audioAutoAdvanceMs: number;
  audioSilenceMs: number;
  // FSRS optimizer — null means use the built-in defaults.
  fsrsWeights: number[] | null;
  fsrsFitLoss: number | null;
  fsrsFitBaselineLoss: number | null;
  fsrsFitDate: string | null;
  fsrsFitSamples: number | null;
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
  desiredRetention: 0.9,
  elevenLabsApiKey: "",
  elevenLabsVoiceId: "",
  audioAutoAdvanceMs: 2000,
  audioSilenceMs: 1500,
  fsrsWeights: null,
  fsrsFitLoss: null,
  fsrsFitBaselineLoss: null,
  fsrsFitDate: null,
  fsrsFitSamples: null,
  hotkeysConfigured: false,
};

export const FSRS_MIN_SAMPLES = 500;

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

    type BoolKey = { [K in keyof IrisCardsSettings]: IrisCardsSettings[K] extends boolean ? K : never }[keyof IrisCardsSettings];
    type StrKey = { [K in keyof IrisCardsSettings]: IrisCardsSettings[K] extends string ? K : never }[keyof IrisCardsSettings];

    const addToggle = (name: string, desc: string, key: BoolKey, onChange?: () => void) =>
      new Setting(containerEl).setName(name).setDesc(desc).addToggle(t =>
        t.setValue(s[key]).onChange(async (v) => { (s as unknown as Record<string, unknown>)[key] = v; await save(); onChange?.(); }));

    const addText = (name: string, desc: string, key: StrKey, placeholder: string) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText(t =>
        t.setPlaceholder(placeholder).setValue(s[key]).onChange(async (v) => { (s as unknown as Record<string, unknown>)[key] = v.trim(); await save(); }));

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
      }).setValue(s.badgePosition).onChange(async (v) => { s.badgePosition = v as BadgePosition; await save(); this.plugin.updateBadge(); }));

    new Setting(containerEl).setName("Desired retention").setDesc("Target probability of remembering a card when it comes due (0.70–0.97). Higher = more frequent reviews.").addSlider(sl =>
      sl.setLimits(0.70, 0.97, 0.01).setValue(s.desiredRetention).setDynamicTooltip().onChange(async (v) => { s.desiredRetention = v; await save(); this.plugin.updateBadge(); }));

    new Setting(containerEl).setName("Claude model").setDesc("Model used for generating review questions.").addDropdown(d =>
      d.addOption("claude-opus-4-6", "Claude Opus 4.6")
        .addOption("claude-sonnet-4-6", "Claude Sonnet 4.6")
        .addOption("claude-haiku-4-5-20251001", "Claude Haiku 4.5")
        .setValue(s.claudeModel).onChange(async (v) => { s.claudeModel = v; await save(); }));

    // ─── Audio review ────────────────────────────────────────
    containerEl.createEl("h3", { text: "Audio review" });

    new Setting(containerEl).setName("ElevenLabs API key").setDesc("API key for text-to-speech and speech-to-text.").addText(t => {
      t.inputEl.type = "password";
      t.setPlaceholder("xi-...").setValue(s.elevenLabsApiKey).onChange(async (v) => { s.elevenLabsApiKey = v.trim(); await save(); });
    });

    {
      const voiceSetting = new Setting(containerEl).setName("Voice").setDesc("ElevenLabs voice for reading questions.");
      let cachedVoices: ElevenLabsVoice[] | null = null;
      voiceSetting.addDropdown(d => {
        if (s.elevenLabsVoiceId) {
          d.addOption(s.elevenLabsVoiceId, s.elevenLabsVoiceId);
        }
        d.setValue(s.elevenLabsVoiceId);
        d.onChange(async (v) => { s.elevenLabsVoiceId = v; await save(); });
        d.selectEl.addEventListener("focus", async () => {
          if (cachedVoices) return;
          const relay = (this.plugin.app as any).irisRelay;
          const useRelay = relay?.isElevenLabsConfigured?.();
          if (!useRelay && !s.elevenLabsApiKey) return;
          try {
            const voices: ElevenLabsVoice[] = useRelay
              ? await relay.elevenLabsVoices()
              : await fetchVoices(s.elevenLabsApiKey);
            cachedVoices = voices;
            const current = d.getValue();
            d.selectEl.empty();
            d.addOption("", "— select —");
            for (const v of voices) d.addOption(v.voice_id, v.name);
            d.setValue(current);
          } catch {
            new Notice("Failed to load ElevenLabs voices. Check your API key.");
          }
        }, { once: true });
      });
    }

    new Setting(containerEl).setName("Auto-advance delay").setDesc("Milliseconds to wait after feedback before showing the next card.").addSlider(sl =>
      sl.setLimits(1000, 5000, 500).setValue(s.audioAutoAdvanceMs).setDynamicTooltip().onChange(async (v) => { s.audioAutoAdvanceMs = v; await save(); }));

    new Setting(containerEl).setName("Silence threshold").setDesc("Milliseconds of silence before recording stops automatically.").addSlider(sl =>
      sl.setLimits(1000, 3000, 250).setValue(s.audioSilenceMs).setDynamicTooltip().onChange(async (v) => { s.audioSilenceMs = v; await save(); }));

    // ─── FSRS optimizer ─────────────────────────────────────
    containerEl.createEl("h3", { text: "FSRS scheduler" });
    this.renderFSRSStatus(containerEl);

  }

  private renderFSRSStatus(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    const statusEl = containerEl.createDiv({ cls: "iris-fsrs-status" });
    const renderStatus = () => {
      statusEl.empty();
      const lines: string[] = [];
      if (s.fsrsWeights) {
        const date = s.fsrsFitDate ? new Date(s.fsrsFitDate).toLocaleString() : "?";
        const loss = s.fsrsFitLoss != null ? s.fsrsFitLoss.toFixed(5) : "?";
        const base = s.fsrsFitBaselineLoss != null ? s.fsrsFitBaselineLoss.toFixed(5) : "?";
        const n = s.fsrsFitSamples ?? "?";
        lines.push(`Using fitted weights — fit on ${n} samples on ${date}.`);
        lines.push(`Loss: ${loss} (default-weights baseline: ${base}).`);
      } else {
        lines.push("Using built-in default FSRS-6 weights.");
      }
      for (const line of lines) statusEl.createDiv({ text: line });
    };
    renderStatus();

    let abortController: AbortController | null = null;

    const setting = new Setting(containerEl)
      .setName("Optimize FSRS weights")
      .setDesc(`Fit per-user FSRS weights from your review log via CMA-ES. Needs ≥${FSRS_MIN_SAMPLES} reviews after a card's first.`);

    setting.addButton(b => {
      b.setButtonText("Optimize")
        .onClick(async () => {
          if (abortController) {
            abortController.abort();
            return;
          }
          const cards = collectCardLogs(this.plugin.app, s.cardsFolder);
          const samples = countSamples(cards);
          if (samples < FSRS_MIN_SAMPLES) {
            new Notice(`Not enough review data: ${samples}/${FSRS_MIN_SAMPLES} samples.`);
            return;
          }
          abortController = new AbortController();
          b.setButtonText("Stop");
          new Notice(`Fitting on ${samples} samples — this may take a minute.`);
          try {
            const result = await optimizeFSRS(cards, {
              signal: abortController.signal,
              onProgress: (gen, bestF) => {
                b.setButtonText(`Stop (gen ${gen}, loss ${bestF.toFixed(5)})`);
              },
            });
            if (result.stopped === "aborted") {
              new Notice("Optimization aborted.");
              return;
            }
            s.fsrsWeights = result.weights;
            s.fsrsFitLoss = result.loss;
            s.fsrsFitBaselineLoss = result.baselineLoss;
            s.fsrsFitDate = new Date().toISOString();
            s.fsrsFitSamples = result.samples;
            await save();
            setFSRSWeights(result.weights);
            this.plugin.updateBadge();
            new Notice(`Fit complete — loss ${result.loss.toFixed(5)} vs baseline ${result.baselineLoss.toFixed(5)}.`);
            renderStatus();
          } catch (e) {
            console.error("[iris-cards] FSRS optimize failed", e);
            new Notice("FSRS optimization failed — see console.");
          } finally {
            abortController = null;
            b.setButtonText("Optimize");
          }
        });
    });

    setting.addButton(b => {
      b.setButtonText("Reset to defaults")
        .onClick(async () => {
          s.fsrsWeights = null;
          s.fsrsFitLoss = null;
          s.fsrsFitBaselineLoss = null;
          s.fsrsFitDate = null;
          s.fsrsFitSamples = null;
          await save();
          setFSRSWeights(null);
          this.plugin.updateBadge();
          renderStatus();
        });
    });
  }
}
