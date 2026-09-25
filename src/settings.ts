import { App, DropdownComponent, Notice, PluginSettingTab, Setting } from "obsidian";
import type IrisCardsPlugin from "./main";
import { collectCardLogs, countSamples, optimizeFSRS } from "./fsrs-optimizer";
import { setFSRSWeights, LEITNER_INTERVALS } from "./scheduler";
import { describeVoice, elevenLabsTTS, fetchVoices, type ElevenLabsVoice } from "./api/elevenlabs";

export type BadgePosition = "top-right" | "top-left" | "bottom-right" | "bottom-left" | "off";
export type SchedulerAlgorithm = "fsrs" | "leitner";

export interface IrisCardsSettings {
  // Cards
  cardsFolder: string;
  // Master switch for every AI-backed feature (generation, LLM marking,
  // classification). Off by default — the plugin works fully AI-independent.
  aiFeatures: boolean;
  // Experimental features (currently: audio-only review mode).
  experimentalMode: boolean;
  // Scheduling algorithm: FSRS (default) or a standard Leitner box system.
  scheduler: SchedulerAlgorithm;
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
  // Re-fit weights automatically on load once enough new reviews accumulate.
  fsrsAutoOptimize: boolean;
  // Review view — persisted module filter (module codes).
  reviewModuleFilter: string[];
  // Review view — persisted exercise-type filter (empty = all types).
  reviewTypeFilter: string[];
  // Tables — when on, a table's order-by column (a sort key like Mass) is used
  // only for ordering row introduction, never shown or asked in review.
  noQuizOrderColumn: boolean;
  // Internal
  // Last-used type chip in the card-authoring form, restored on next open.
  authorLastType: string;
  hotkeysConfiguredV4: boolean;
  displayTitleBackfillV1: boolean;
}

export const DEFAULT_SETTINGS: IrisCardsSettings = {
  cardsFolder: "Iris Cards",
  aiFeatures: false,
  experimentalMode: false,
  scheduler: "fsrs",
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
  fsrsAutoOptimize: true,
  reviewModuleFilter: [],
  reviewTypeFilter: [],
  noQuizOrderColumn: true,
  authorLastType: "qa",
  hotkeysConfiguredV4: false,
  displayTitleBackfillV1: false,
};

export const FSRS_MIN_SAMPLES = 500;

// Auto re-fit only after this many *new* post-first reviews have accumulated
// since the last fit (or since zero, if never fit). Keeps the on-load refit
// from running on trivial deltas — and because each fit updates fsrsFitSamples
// to the current count, it won't re-trigger until another batch accrues.
export const FSRS_AUTO_REFIT_NEW_SAMPLES = 200;

const VOICE_PREVIEW_TEXT = "Here's how your review questions will sound.";

export class IrisCardsSettingTab extends PluginSettingTab {
  plugin: IrisCardsPlugin;
  // Kept across re-renders so toggling a setting doesn't refetch the voice list.
  private cachedVoices: ElevenLabsVoice[] | null = null;
  private previewAudio: HTMLAudioElement | null = null;
  private previewUrl: string | null = null;

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

    // ─── Cards ──────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Cards" });
    addText("Cards folder", "Folder where Iris Cards are stored.", "cardsFolder", "Iris Cards");
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

    addToggle(
      "Don't quiz a table's ordering column",
      "A table's order-by column (a sort key like Mass) sequences how rows are introduced. With this on it's used only for ordering — never shown or asked in review. A table's own no-quiz: still applies on top.",
      "noQuizOrderColumn",
    );

    // ─── Scheduling ─────────────────────────────────────────
    containerEl.createEl("h3", { text: "Scheduling" });

    new Setting(containerEl).setName("Algorithm").setDesc("FSRS adapts intervals to your memory model. Leitner is a standard box system: correct moves a card up a box, incorrect sends it back to box 1.").addDropdown(d =>
      d.addOption("fsrs", "FSRS")
        .addOption("leitner", "Leitner boxes")
        .setValue(s.scheduler).onChange(async (v) => {
          s.scheduler = v as SchedulerAlgorithm;
          await save();
          this.plugin.updateBadge();
          this.display();
        }));

    if (s.scheduler === "fsrs") {
      new Setting(containerEl).setName("Desired retention").setDesc("Target probability of remembering a card when it comes due (0.70–0.97). Higher = more frequent reviews.").addSlider(sl =>
        sl.setLimits(0.70, 0.97, 0.01).setValue(s.desiredRetention).setDynamicTooltip().onChange(async (v) => { s.desiredRetention = v; await save(); this.plugin.updateBadge(); }));

      this.renderFSRSStatus(containerEl);
    } else {
      containerEl.createDiv({
        cls: "setting-item-description",
        text: `Box intervals: ${LEITNER_INTERVALS.join(", ")} days. Cards keep their FSRS history, so you can switch back at any time.`,
      });
    }

    // ─── AI features ────────────────────────────────────────
    containerEl.createEl("h3", { text: "AI features" });

    addToggle("Enable AI features", "Generate exercise variants and mark typed answers with Claude. Off by default — everything works without it; you write your own cards.", "aiFeatures", () => this.display());

    if (s.aiFeatures) {
      new Setting(containerEl).setName("Anthropic API key").setDesc("API key for Claude-generated review questions.").addText(t => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-ant-...").setValue(s.anthropicApiKey).onChange(async (v) => { s.anthropicApiKey = v.trim(); await save(); });
      });

      new Setting(containerEl).setName("Claude model").setDesc("Model used for generating review questions.").addDropdown(d =>
        d.addOption("claude-opus-4-6", "Claude Opus 4.6")
          .addOption("claude-sonnet-4-6", "Claude Sonnet 4.6")
          .addOption("claude-haiku-4-5-20251001", "Claude Haiku 4.5")
          .setValue(s.claudeModel).onChange(async (v) => { s.claudeModel = v; await save(); }));

      addToggle("Auto-mark", "Let Claude mark your typed answer instead of self-marking.", "autoMark");
    }

    // ─── Experimental ───────────────────────────────────────
    containerEl.createEl("h3", { text: "Experimental" });

    addToggle("Experimental features", "Enable experimental features: audio-only review mode (text-to-speech questions, spoken answers).", "experimentalMode", () => this.display());

    if (s.experimentalMode) {
      new Setting(containerEl).setName("ElevenLabs API key").setDesc("API key for text-to-speech and speech-to-text.").addText(t => {
        t.inputEl.type = "password";
        t.setPlaceholder("xi-...").setValue(s.elevenLabsApiKey).onChange(async (v) => { s.elevenLabsApiKey = v.trim(); await save(); });
      });

      this.renderVoiceSetting(containerEl);

      new Setting(containerEl).setName("Auto-advance delay").setDesc("Milliseconds to wait after feedback before showing the next card.").addSlider(sl =>
        sl.setLimits(1000, 5000, 500).setValue(s.audioAutoAdvanceMs).setDynamicTooltip().onChange(async (v) => { s.audioAutoAdvanceMs = v; await save(); }));

      new Setting(containerEl).setName("Silence threshold").setDesc("Milliseconds of silence before recording stops automatically.").addSlider(sl =>
        sl.setLimits(1000, 3000, 250).setValue(s.audioSilenceMs).setDynamicTooltip().onChange(async (v) => { s.audioSilenceMs = v; await save(); }));
    }
  }

  hide(): void {
    this.stopPreview();
  }

  private renderVoiceSetting(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const relay = (this.plugin.app as any).irisRelay;
    const useRelay = !!relay?.isElevenLabsConfigured?.();
    const canLoad = useRelay || !!s.elevenLabsApiKey;

    const voiceSetting = new Setting(containerEl).setName("Voice");
    let dropdown: DropdownComponent | null = null;

    // The description always states which voice audio review will use.
    const updateDesc = (status?: string) => {
      const id = s.elevenLabsVoiceId;
      const voice = this.cachedVoices?.find(v => v.voice_id === id);
      voiceSetting.descEl.empty();
      voiceSetting.descEl.appendText("ElevenLabs voice for reading questions.");
      voiceSetting.descEl.createEl("br");
      if (status) {
        voiceSetting.descEl.appendText(status);
      } else if (!id) {
        voiceSetting.descEl.appendText("No voice selected — audio review won't run until you pick one.");
      } else if (voice) {
        const summary = describeVoice(voice);
        voiceSetting.descEl.appendText(`Using ${voice.name}${summary ? ` (${summary})` : ""}.`);
        if (voice.description) {
          voiceSetting.descEl.createEl("br");
          voiceSetting.descEl.appendText(voice.description);
        }
      } else if (this.cachedVoices) {
        voiceSetting.descEl.appendText(`Voice ${id} isn't in your ElevenLabs library — pick another.`);
      } else {
        voiceSetting.descEl.appendText(`Using voice ID ${id}.`);
      }
    };

    const fillOptions = () => {
      if (!dropdown) return;
      const d = dropdown;
      const current = s.elevenLabsVoiceId;
      d.selectEl.empty();
      d.addOption("", "— select —");
      if (this.cachedVoices) {
        for (const v of this.cachedVoices) {
          const summary = describeVoice(v);
          d.addOption(v.voice_id, summary ? `${v.name} — ${summary}` : v.name);
        }
      }
      if (current && !this.cachedVoices?.some(v => v.voice_id === current)) {
        d.addOption(current, this.cachedVoices ? `Unavailable (${current})` : `Voice ID ${current}`);
      }
      d.setValue(current);
    };

    const loadVoices = async () => {
      if (this.cachedVoices || !canLoad) return;
      updateDesc("Loading voices…");
      try {
        this.cachedVoices = useRelay
          ? await relay.elevenLabsVoices({ callerId: "iris-cards:settings" })
          : await fetchVoices(s.elevenLabsApiKey);
        fillOptions();
        updateDesc();
      } catch {
        updateDesc("Couldn't load ElevenLabs voices. Check your API key.");
      }
    };

    voiceSetting.addDropdown(d => {
      dropdown = d;
      d.onChange(async (v) => {
        s.elevenLabsVoiceId = v;
        await this.plugin.saveSettings();
        this.stopPreview();
        updateDesc();
      });
    });
    voiceSetting.addExtraButton(b => b
      .setIcon("play")
      .setTooltip("Preview voice")
      .onClick(() => void this.previewVoice(useRelay ? relay : null)));

    fillOptions();
    updateDesc(canLoad ? undefined : "Add an ElevenLabs API key to see available voices.");
    void loadVoices();
  }

  /** Speak a sample with the selected voice, the same way audio review does. */
  private async previewVoice(relay: any): Promise<void> {
    const s = this.plugin.settings;
    this.stopPreview();
    if (!s.elevenLabsVoiceId) {
      new Notice("Pick a voice first.");
      return;
    }
    if (!relay && !s.elevenLabsApiKey) {
      new Notice("Add an ElevenLabs API key first.");
      return;
    }
    try {
      const encoded: ArrayBuffer = relay
        ? await relay.elevenLabsTTS(VOICE_PREVIEW_TEXT, s.elevenLabsVoiceId, { callerId: "iris-cards:settings" })
        : await elevenLabsTTS(VOICE_PREVIEW_TEXT, s.elevenLabsApiKey, s.elevenLabsVoiceId);
      this.stopPreview();
      this.previewUrl = URL.createObjectURL(new Blob([encoded], { type: "audio/mpeg" }));
      this.previewAudio = new Audio(this.previewUrl);
      this.previewAudio.onended = () => this.stopPreview();
      await this.previewAudio.play();
    } catch (e) {
      new Notice(`Voice preview failed: ${e instanceof Error ? e.message : String(e)}`);
      this.stopPreview();
    }
  }

  private stopPreview(): void {
    this.previewAudio?.pause();
    this.previewAudio = null;
    if (this.previewUrl) {
      URL.revokeObjectURL(this.previewUrl);
      this.previewUrl = null;
    }
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

    new Setting(containerEl)
      .setName("Auto-optimize")
      .setDesc(`Re-fit weights automatically on startup once ${FSRS_AUTO_REFIT_NEW_SAMPLES} new reviews accumulate since the last fit.`)
      .addToggle(t =>
        t.setValue(s.fsrsAutoOptimize).onChange(async (v) => { s.fsrsAutoOptimize = v; await save(); }));

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
