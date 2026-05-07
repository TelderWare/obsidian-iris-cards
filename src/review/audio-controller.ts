import { Notice, TFile } from "obsidian";
import type IrisCardsPlugin from "../main";
import { type QAVariant } from "../types/exercises";
import { elevenLabsTTS, elevenLabsSTT } from "../api/elevenlabs";
import { questionTextForAudio, answerTextForAudio } from "./audio-text";

function getRelay(plugin: IrisCardsPlugin): any {
  const relay = (plugin.app as any).irisRelay;
  return relay?.isElevenLabsConfigured?.() ? relay : null;
}

function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(input.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buf;
}
import { normalizeAnswer } from "./review-view";
import { markAnswer } from "../generators/qa";
import { decodeList, markList } from "../generators/list";
import { parseClozeTerms, occludeCloze } from "../generators/cloze";
import { decodeTFPair } from "../generators/true-false";

type AudioState =
  | "idle"
  | "speaking-question"
  | "listening"
  | "speaking-result"
  | "speaking-answer"
  | "advancing";

interface STTStreamHandlers {
  onPartial?: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (err: Error) => void;
  onClose?: () => void;
}

interface STTStreamSession {
  sendAudio(pcm16le: ArrayBuffer): void;
  end(): void;
  close(): void;
}

type AnswerFn = (correct: boolean, userAnswer?: string, gapTerm?: string) => Promise<void>;
type PrewarmNextFn = () => string | null | Promise<string | null>;

const TTS_CACHE_MAX = 50;

interface CacheEntry {
  /** Decoded audio buffer — ready to play, no decode cost. */
  audioBuffer: AudioBuffer | null;
  /** Pending decode promise, when first play is in flight. */
  pending?: Promise<AudioBuffer>;
}

export class AudioReviewController {
  private plugin: IrisCardsPlugin;
  state: AudioState = "idle";
  private aborted = false;
  private micStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  /** Cache of decoded TTS audio keyed by exact spoken text. */
  private ttsCache = new Map<string, CacheEntry>();
  private currentSource: AudioBufferSourceNode | null = null;
  private statusEl: HTMLElement | null = null;
  // Reused 16 kHz capture pipeline — created lazily, kept alive across cards.
  private captureCtx: AudioContext | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private captureProcessor: ScriptProcessorNode | null = null;
  onStateChange: ((state: AudioState) => void) | null = null;

  constructor(plugin: IrisCardsPlugin) {
    this.plugin = plugin;
  }

  private setState(state: AudioState): void {
    this.state = state;
    this.onStateChange?.(state);
  }

  private get apiKey(): string {
    return this.plugin.settings.elevenLabsApiKey;
  }

  private get voiceId(): string {
    return this.plugin.settings.elevenLabsVoiceId;
  }

  private getAudioCtx(): AudioContext {
    if (!this.audioCtx) {
      const Ctx = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
      this.audioCtx = new Ctx();
    }
    return this.audioCtx;
  }

  async start(
    variant: QAVariant,
    cardFile: TFile,
    answerFn: AnswerFn,
    renderState: Record<string, unknown>,
    statusEl: HTMLElement,
    prewarmNext?: PrewarmNextFn,
  ): Promise<void> {
    this.aborted = false;
    this.statusEl = statusEl;

    const questionText = questionTextForAudio(variant, renderState);
    if (questionText === null) return; // Image Occlusion — skip

    // Acquire mic on first use
    if (!this.micStream) {
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        new Notice("Microphone access denied. Audio mode requires a microphone.");
        return;
      }
    }

    if (this.aborted) return;

    // Kick off STT-token prewarm in parallel with TTS playback. The token POST
    // is ~200ms and is the main per-card latency; hiding it behind speakText()
    // makes the listening phase start instantly.
    const relay = getRelay(this.plugin);
    if (relay?.prewarmSTT) {
      void relay.prewarmSTT().catch(() => { /* best effort */ });
    }

    // Speak question
    this.setState("speaking-question");
    this.setStatus("Speaking question…");
    try {
      await this.speakText(questionText);
    } catch (e) {
      console.error("[iris-cards] TTS failed", e);
      new Notice("TTS failed — falling back to visual mode for this card.");
      this.setState("idle");
      return;
    }

    if (this.aborted) return;

    // Prewarm both possible result TTS clips in the background while the user
    // speaks. By the time we know correct/incorrect, the audio is decoded and
    // ready.
    const correctAnswerText = `The answer is: ${answerTextForAudio(variant)}`;
    this.prewarmTTS("Correct!");
    this.prewarmTTS("Incorrect.");
    this.prewarmTTS(correctAnswerText);

    // Stream answer via WebSocket STT
    this.setState("listening");
    this.setStatus("Listening…");
    let spoken: string;
    try {
      spoken = await this.streamSTT();
    } catch (e) {
      if (this.aborted) return;
      console.error("[iris-cards] STT stream failed", e);
      new Notice("Speech-to-text failed — falling back to visual mode for this card.");
      this.setStatus("");
      this.setState("idle");
      return;
    }

    if (this.aborted) return;

    // Evaluate answer
    const result = await this.evaluateAnswer(spoken, variant, cardFile, renderState);

    if (this.aborted) return;

    // Kick off the next-card TTS prewarm now so it overlaps with the result
    // speaking that follows. By the time we hand off to the next card via
    // answerFn, its question audio is decoded and ready.
    if (prewarmNext) {
      Promise.resolve()
        .then(() => prewarmNext())
        .then(nextText => { if (nextText) this.prewarmTTS(nextText); })
        .catch(() => { /* best effort */ });
    }

    // IMPORTANT: speak the result + correct answer BEFORE calling answerFn.
    // answerFn -> rateCard -> showNextCard -> next card's start() begins, and
    // we need the current card's speech to be fully done first or the two
    // cards' TTS will overlap on the same AudioContext.
    this.setState("speaking-result");
    const resultText = result.correct ? "Correct!" : "Incorrect.";
    this.setStatus(resultText);
    try {
      await this.speakText(resultText);
    } catch { /* non-fatal */ }

    if (this.aborted) return;

    if (!result.correct) {
      this.setState("speaking-answer");
      this.setStatus(correctAnswerText);
      try {
        await this.speakText(correctAnswerText);
      } catch { /* non-fatal */ }
    }

    if (this.aborted) return;

    // Brief beat between "Correct!" and the next question, for cadence.
    this.setState("advancing");
    this.setStatus("");
    await new Promise(r => setTimeout(r, this.plugin.settings.audioAutoAdvanceMs));

    if (this.aborted) return;

    // Hand off to the next card. answerFn -> rateCard -> showNextCard, which
    // recursively invokes start() for the next card. By returning right after,
    // we let the outer call own the audio timeline; nothing of ours follows.
    this.setState("idle");
    await answerFn(result.correct, spoken, result.gapTerm);
  }

  stop(): void {
    this.aborted = true;
    this.stopPlayback();
    this.setState("idle");
  }

  destroy(): void {
    this.stop();
    if (this.captureProcessor) {
      this.captureProcessor.onaudioprocess = null;
      try { this.captureProcessor.disconnect(); } catch { /* */ }
      this.captureProcessor = null;
    }
    if (this.captureSource) {
      try { this.captureSource.disconnect(); } catch { /* */ }
      this.captureSource = null;
    }
    if (this.captureCtx) {
      this.captureCtx.close().catch(() => {});
      this.captureCtx = null;
    }
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) track.stop();
      this.micStream = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    this.ttsCache.clear();
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  private stopPlayback(): void {
    try {
      this.currentSource?.stop();
    } catch { /* already stopped */ }
    this.currentSource = null;
  }

  // ─── TTS ──────────────────────────────────────────────────────────

  private async speakText(text: string): Promise<void> {
    const audioBuffer = await this.getDecodedTTS(text);
    await this.playAudioBuffer(audioBuffer);
  }

  /**
   * Fire-and-forget cache warmer. Idempotent — safe to call repeatedly with
   * the same text. Used to pipeline TTS fetch + decode behind earlier work.
   */
  prewarmTTS(text: string): void {
    if (!text) return;
    void this.getDecodedTTS(text).catch(() => {
      // Pre-warming is best-effort. The real call will surface any error.
    });
  }

  private async getDecodedTTS(text: string): Promise<AudioBuffer> {
    const existing = this.ttsCache.get(text);
    if (existing?.audioBuffer) return existing.audioBuffer;
    if (existing?.pending) return existing.pending;

    // LRU eviction before insert.
    if (!existing && this.ttsCache.size >= TTS_CACHE_MAX) {
      const oldest = this.ttsCache.keys().next().value;
      if (oldest !== undefined) this.ttsCache.delete(oldest);
    }

    const ctx = this.getAudioCtx();
    if (ctx.state === "suspended") await ctx.resume();

    const pending = (async () => {
      const relay = getRelay(this.plugin);
      const encoded: ArrayBuffer = relay
        ? await relay.elevenLabsTTS(text, this.voiceId)
        : await elevenLabsTTS(text, this.apiKey, this.voiceId);
      // decodeAudioData transfers the buffer; pass the original since we don't reuse it.
      const decoded = await ctx.decodeAudioData(encoded.slice(0));
      const entry = this.ttsCache.get(text);
      if (entry) {
        entry.audioBuffer = decoded;
        entry.pending = undefined;
      } else {
        this.ttsCache.set(text, { audioBuffer: decoded });
      }
      return decoded;
    })();

    this.ttsCache.set(text, { audioBuffer: null, pending });
    return pending;
  }

  private async playAudioBuffer(audioBuffer: AudioBuffer): Promise<void> {
    const ctx = this.getAudioCtx();
    if (ctx.state === "suspended") await ctx.resume();
    return new Promise((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      this.currentSource = source;
      source.onended = () => {
        this.currentSource = null;
        resolve();
      };
      source.start();
    });
  }

  // ─── Streaming STT ────────────────────────────────────────────────

  /**
   * Lazily build the 16 kHz capture pipeline (mic → ScriptProcessor → muted
   * destination) and keep it alive across cards. Only the onaudioprocess
   * handler is swapped per question.
   */
  private ensureCapturePipeline(): ScriptProcessorNode {
    if (this.captureProcessor && this.captureCtx?.state !== "closed") {
      return this.captureProcessor;
    }

    const Ctx = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    let ctx: AudioContext;
    try {
      ctx = new Ctx({ sampleRate: 16000 });
    } catch {
      ctx = new Ctx();
    }

    const sourceNode = ctx.createMediaStreamSource(this.micStream!);
    // ScriptProcessorNode is deprecated but universally supported and avoids
    // the per-plugin worklet-module-loading dance. Buffer of 4096 ≈ 256 ms at 16 kHz.
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    sourceNode.connect(processor);
    // Must connect to destination for onaudioprocess to fire; route through
    // a muted gain so we don't feed mic back into the speakers.
    const muted = ctx.createGain();
    muted.gain.value = 0;
    processor.connect(muted);
    muted.connect(ctx.destination);

    this.captureCtx = ctx;
    this.captureSource = sourceNode;
    this.captureProcessor = processor;
    return processor;
  }

  private async streamSTT(): Promise<string> {
    if (!this.micStream) throw new Error("No mic stream");

    const relay = getRelay(this.plugin);
    if (!relay?.elevenLabsSTTStream) {
      // Fallback to non-streaming if relay too old or absent.
      return this.recordAndTranscribeFallback();
    }

    const processor = this.ensureCapturePipeline();

    return new Promise<string>(async (resolve, reject) => {
      let session: STTStreamSession | null = null;
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        // Detach the audio handler but keep the pipeline alive for next card.
        processor.onaudioprocess = null;
        try { session?.close(); } catch { /* */ }
        fn();
      };

      // Hard cap so a stuck stream can't hang forever.
      const maxDuration = setTimeout(() => {
        if (session) session.end();
        else settle(() => reject(new Error("STT stream timeout")));
      }, 30_000);

      // Throttle partial-transcript DOM writes to ~10 Hz. Scribe sends partials
      // quickly during continuous speech; coalescing keeps the layout calm.
      let lastPartialAt = 0;
      let pendingPartial: string | null = null;
      let partialTimer: ReturnType<typeof setTimeout> | null = null;
      const flushPartial = () => {
        partialTimer = null;
        if (pendingPartial !== null && !settled) {
          this.setStatus(`Listening… "${pendingPartial}"`);
          lastPartialAt = Date.now();
          pendingPartial = null;
        }
      };

      const handlers: STTStreamHandlers = {
        onPartial: (text) => {
          if (!text) return;
          pendingPartial = text;
          const sinceLast = Date.now() - lastPartialAt;
          if (sinceLast >= 100) flushPartial();
          else if (partialTimer === null) partialTimer = setTimeout(flushPartial, 100 - sinceLast);
        },
        onFinal: (text) => {
          if (partialTimer !== null) { clearTimeout(partialTimer); partialTimer = null; }
          clearTimeout(maxDuration);
          settle(() => resolve(text));
        },
        onError: (err) => {
          if (partialTimer !== null) { clearTimeout(partialTimer); partialTimer = null; }
          clearTimeout(maxDuration);
          settle(() => reject(err));
        },
      };

      try {
        session = await relay.elevenLabsSTTStream(handlers);
      } catch (e) {
        clearTimeout(maxDuration);
        settle(() => reject(e instanceof Error ? e : new Error(String(e))));
        return;
      }

      if (this.aborted) {
        clearTimeout(maxDuration);
        settle(() => reject(new Error("Aborted")));
        return;
      }

      processor.onaudioprocess = (e) => {
        if (settled) return;
        const input = e.inputBuffer.getChannelData(0);
        session!.sendAudio(floatTo16BitPCM(input));
      };

      // Expose manual stop so the controller can flush + commit on demand.
      (this as any)._stopRecording = () => session?.end();
    }).finally(() => {
      (this as any)._stopRecording = null;
    });
  }

  /** Manually flush the in-flight STT stream (commit + close). */
  stopRecordingManually(): void {
    const fn = (this as any)._stopRecording;
    if (typeof fn === "function") fn();
  }

  /**
   * Fallback when no relay-streaming method is available: record a webm clip
   * via VAD-less manual stop, then call the one-shot REST STT. Kept simple —
   * the streaming path is the supported one; this is purely for older relays.
   */
  private async recordAndTranscribeFallback(): Promise<string> {
    if (!this.micStream) throw new Error("No mic stream");
    const recorder = new MediaRecorder(this.micStream, { mimeType: "audio/webm" });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    const blob: Blob = await new Promise((resolve, reject) => {
      const stop = () => { if (recorder.state === "recording") recorder.stop(); };
      const maxDur = setTimeout(stop, 15_000);
      (this as any)._stopRecording = stop;
      recorder.onstop = () => { clearTimeout(maxDur); resolve(new Blob(chunks, { type: "audio/webm" })); };
      recorder.onerror = (e) => { clearTimeout(maxDur); reject(e); };
      recorder.start();
    });
    (this as any)._stopRecording = null;

    const relay = getRelay(this.plugin);
    return relay
      ? await relay.elevenLabsSTT(blob)
      : await elevenLabsSTT(blob, this.apiKey);
  }

  // ─── Answer Evaluation ────────────────────────────────────────────

  private async evaluateAnswer(
    spoken: string,
    variant: QAVariant,
    cardFile: TFile,
    renderState: Record<string, unknown>,
  ): Promise<{ correct: boolean; gapTerm?: string }> {
    const normalized = normalizeAnswer(spoken);
    const apiKey = this.plugin.settings.anthropicApiKey;
    const model = this.plugin.settings.claudeModel;

    // Unsupported exercise types are skipped before reaching this point
    // (see review-view.ts startAudioForCurrentCard + isAudioSupported).
    switch (variant.exerciseType) {
      case "True/False": {
        const tf = decodeTFPair(variant.question, variant.answer);
        if (!tf) return this.fallbackEval(spoken, variant, apiKey, model);
        const pick = renderState.tfPick as boolean;
        // Accept yes/no in addition to true/false — natural spoken responses.
        let said: boolean | null = null;
        if (/\b(true|yes|correct|right)\b/.test(normalized)) said = true;
        else if (/\b(false|no|wrong|incorrect)\b/.test(normalized)) said = false;
        if (said === null) return this.fallbackEval(spoken, variant, apiKey, model);
        return { correct: said === pick };
      }

      case "Cloze": {
        const source = variant.question;
        const terms = parseClozeTerms(source);
        const idx = renderState.clozeIdx as number ?? 0;
        if (idx >= terms.length) return { correct: false };
        const { answer: gap } = occludeCloze(source, idx);
        const allAccepted = [gap, ...variant.acceptedAnswers];
        if (allAccepted.some(a => normalizeAnswer(a) === normalized)) {
          return { correct: true, gapTerm: gap };
        }
        if (apiKey && this.plugin.settings.autoMark) {
          const correct = await markAnswer(variant.question, gap, spoken, apiKey, model);
          return { correct, gapTerm: gap };
        }
        return { correct: false, gapTerm: gap };
      }

      case "List": {
        const l = decodeList(variant.question, variant.answer);
        if (!l) return this.fallbackEval(spoken, variant, apiKey, model);
        const parts = spoken.split(/[,;.]|\band\b/i)
          .map(s => s.trim()).filter(Boolean);
        if (apiKey && this.plugin.settings.autoMark) {
          const results = await markList(variant.question, l.items, parts, apiKey, model);
          return { correct: results.every(Boolean) };
        }
        // Exact match fallback
        const matched = new Set<number>();
        for (const p of parts) {
          const idx = l.items.findIndex((item, i) =>
            !matched.has(i) && normalizeAnswer(item) === normalizeAnswer(p),
          );
          if (idx >= 0) matched.add(idx);
        }
        return { correct: matched.size === l.items.length };
      }

      // Q&A and Correct the Mistake fall through to fallbackEval.
      default:
        return this.fallbackEval(spoken, variant, apiKey, model);
    }
  }

  private async fallbackEval(
    spoken: string,
    variant: QAVariant,
    apiKey: string,
    model: string,
  ): Promise<{ correct: boolean }> {
    const normalized = normalizeAnswer(spoken);
    const allAccepted = [variant.answer, ...variant.acceptedAnswers];
    if (allAccepted.some(a => normalizeAnswer(a) === normalized)) {
      return { correct: true };
    }
    if (apiKey && this.plugin.settings.autoMark) {
      const correct = await markAnswer(variant.question, variant.answer, spoken, apiKey, model);
      return { correct };
    }
    return { correct: false };
  }
}
