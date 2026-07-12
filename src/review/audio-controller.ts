import { Notice } from "obsidian";
import type IrisCardsPlugin from "../main";
import { type QAVariant } from "../types/exercises";
import { elevenLabsTTS, elevenLabsTTSStream, elevenLabsSTT } from "../api/elevenlabs";
import { questionTextForAudio, answerTextForAudio, keytermsForAudio } from "./audio-text";

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

/**
 * Linear-interpolation downsample from `srcRate` Hz to `dstRate` Hz.
 * Used when the capture AudioContext can't be opened at 16 kHz directly
 * (older Safari, some Android browsers) — without this, audio at the
 * device's native rate is sent to STT mislabeled as 16 kHz, which
 * produces chipmunk-speed garbled transcripts.
 */
function downsampleFloat(input: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return input;
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = srcIdx - lo;
    out[i] = input[lo] * (1 - frac) + input[hi] * frac;
  }
  return out;
}
import { normalizeAnswer } from "../utils/text";
import { aiEnabled } from "../ai";
import { markAnswer } from "../generators/qa";

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

type AnswerFn = (correct: boolean, userAnswer?: string) => Promise<void>;
type PrewarmNextFn = () => string | null | Promise<string | null>;

const TTS_CACHE_MAX = 50;

/** Spoken feedback for a correct answer — one is picked at random per card.
 * Kept short: each distinct phrase costs TTS credits once per session before
 * the cache takes over. */
const CORRECT_MESSAGES = [
  "Correct!",
  "That's right!",
  "Exactly.",
  "Well done!",
  "Spot on.",
  "Nailed it.",
  "Perfect.",
  "Yes, that's it.",
];

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
  /** Gain node owning all chunks of an in-flight streaming TTS utterance.
   * Disconnecting it on abort cuts all queued chunks at once. */
  private currentStreamGain: GainNode | null = null;
  /** Abort controller for the in-flight TTS fetch (streaming path only). */
  private currentTTSAbort: AbortController | null = null;
  private statusEl: HTMLElement | null = null;
  // Reused 16 kHz capture pipeline — created lazily, kept alive across cards.
  private captureCtx: AudioContext | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private captureProcessor: ScriptProcessorNode | null = null;
  /** In-flight STT session, exposed on the instance so stop()/destroy() can end it
   * instead of leaking the WebSocket until the 30 s hard cap. */
  private activeSession: STTStreamSession | null = null;
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
    answerFn: AnswerFn,
    statusEl: HTMLElement,
    prewarmNext?: PrewarmNextFn,
  ): Promise<void> {
    this.aborted = false;
    this.statusEl = statusEl;

    const questionText = questionTextForAudio(variant);
    if (questionText === null) {
      // Defensive: the audio view only feeds Q&A variants in here. If we ever
      // do get a non-Q&A card, advance the loop rather than freezing on a
      // card with no audio and no way out.
      await answerFn(false);
      return;
    }

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
      void relay.prewarmSTT({ callerId: "iris-cards:stt" }).catch(() => { /* best effort */ });
    }

    // Speak question
    this.setState("speaking-question");
    this.setStatus("Speaking question…");
    try {
      await this.speakText(questionText);
    } catch (e) {
      console.error("[iris-cards] TTS failed", e);
      new Notice("TTS failed — audio review stopped.");
      this.setStatus("Audio review stopped — TTS failed. Reopen to retry.");
      this.setState("idle");
      return;
    }

    if (this.aborted) return;

    // Prewarm both possible result TTS clips in the background while the user
    // speaks. By the time we know correct/incorrect, the audio is decoded and
    // ready. The correct message is picked per card, before prewarming, so the
    // clip fetched is the one that plays.
    const correctAnswerText = `The answer is: ${answerTextForAudio(variant)}`;
    const correctText = CORRECT_MESSAGES[Math.floor(Math.random() * CORRECT_MESSAGES.length)];
    this.prewarmTTS(correctText);
    this.prewarmTTS("Incorrect.");
    this.prewarmTTS(correctAnswerText);

    // Stream answer via WebSocket STT.
    this.setState("listening");
    const maxMs = 30_000;

    // Bias the recognizer toward the expected vocabulary for this card. Without
    // this, domain-specific terms (Greek roots, drug names, biochem) lose to
    // common-English homophones — see keytermsForAudio for what's collected.
    const keyterms = keytermsForAudio(variant);

    let spoken = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      this.setStatus(attempt === 0 ? "Listening…" : "Didn't catch that — try again…");
      try {
        spoken = await this.streamSTT(maxMs, keyterms);
      } catch (e) {
        if (this.aborted) return;
        console.error("[iris-cards] STT stream failed", e);
        new Notice("Speech-to-text failed — audio review stopped.");
        this.setStatus("Audio review stopped — speech-to-text failed. Reopen to retry.");
        this.setState("idle");
        return;
      }
      if (this.aborted) return;
      if (spoken.trim()) break;
    }

    // Evaluate answer
    const result = await this.evaluateAnswer(spoken, variant);

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
    const resultText = result.correct ? correctText : "Incorrect.";
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

    // Hand off to the next card: answerFn records the review and invokes
    // start() for the next card. By returning right after, we let the outer
    // call own the audio timeline; nothing of ours follows.
    this.setState("idle");
    await answerFn(result.correct, spoken);
  }

  stop(): void {
    this.aborted = true;
    this.stopPlayback();
    // End any in-flight STT stream so the relay WebSocket closes immediately
    // instead of being held open until the 30 s hard cap. The settle() path
    // inside streamSTT clears activeSession; this is just the fast path.
    try { this.activeSession?.end(); } catch { /* */ }
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
    try { this.currentSource?.stop(); } catch { /* already stopped */ }
    this.currentSource = null;
    try { this.currentStreamGain?.disconnect(); } catch { /* */ }
    this.currentStreamGain = null;
    try { this.currentTTSAbort?.abort(); } catch { /* */ }
    this.currentTTSAbort = null;
  }

  // ─── TTS ──────────────────────────────────────────────────────────

  private async speakText(text: string): Promise<void> {
    // Cache hit — play decoded buffer instantly, no fetch.
    const cached = this.ttsCache.get(text);
    if (cached?.audioBuffer) {
      this.ttsCache.delete(text);
      this.ttsCache.set(text, cached);
      return this.playAudioBuffer(cached.audioBuffer);
    }
    // A prewarm fetch (non-streaming) is already in flight — wait for it.
    if (cached?.pending) {
      const buf = await cached.pending;
      return this.playAudioBuffer(buf);
    }

    // Relay proxies the non-streaming endpoint; it has no ReadableStream
    // surface. Fall back to fetch-then-decode for that path.
    const relay = getRelay(this.plugin);
    if (relay) {
      const buf = await this.getDecodedTTS(text);
      return this.playAudioBuffer(buf);
    }

    await this.streamAndPlay(text);
  }

  /**
   * Stream PCM directly from ElevenLabs and schedule each chunk on the
   * AudioContext as it arrives, so playback starts before the full clip is
   * downloaded. Caches the assembled buffer for cheap replay.
   */
  private async streamAndPlay(text: string): Promise<void> {
    const ctx = this.getAudioCtx();
    if (ctx.state === "suspended") await ctx.resume();

    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    this.currentStreamGain = gain;

    const abort = new AbortController();
    this.currentTTSAbort = abort;

    const chunks: Float32Array[] = [];
    let chunkSampleRate = 22050;
    let nextStart = 0;
    let scheduled = false;
    let lastSource: AudioBufferSourceNode | null = null;

    const onSamples = (samples: Float32Array, sampleRate: number) => {
      if (this.aborted || this.currentStreamGain !== gain) return;
      chunkSampleRate = sampleRate;
      chunks.push(samples);
      const buf = ctx.createBuffer(1, samples.length, sampleRate);
      buf.getChannelData(0).set(samples);
      const source = ctx.createBufferSource();
      source.buffer = buf;
      source.connect(gain);
      if (!scheduled) {
        nextStart = ctx.currentTime;
        scheduled = true;
      }
      const startAt = Math.max(nextStart, ctx.currentTime);
      source.start(startAt);
      nextStart = startAt + samples.length / sampleRate;
      lastSource = source;
    };

    try {
      await elevenLabsTTSStream(text, this.apiKey, this.voiceId, onSamples, { signal: abort.signal });
    } catch (e) {
      try { gain.disconnect(); } catch { /* */ }
      if (this.currentStreamGain === gain) this.currentStreamGain = null;
      if (this.currentTTSAbort === abort) this.currentTTSAbort = null;
      if (abort.signal.aborted || this.aborted) return;
      throw e;
    }

    if (this.currentTTSAbort === abort) this.currentTTSAbort = null;

    // Assemble cached buffer for next replay.
    const total = chunks.reduce((n, s) => n + s.length, 0);
    if (total > 0) {
      const full = ctx.createBuffer(1, total, chunkSampleRate);
      const channel = full.getChannelData(0);
      let off = 0;
      for (const s of chunks) { channel.set(s, off); off += s.length; }
      if (this.ttsCache.size >= TTS_CACHE_MAX) {
        const oldest = this.ttsCache.keys().next().value;
        if (oldest !== undefined && oldest !== text) this.ttsCache.delete(oldest);
      }
      this.ttsCache.set(text, { audioBuffer: full });
    }

    // Wait for the last scheduled chunk to actually finish (onended fires from
    // the audio thread). A wall-clock setTimeout based on `nextStart` can fire
    // before the audio has truly drained — if the audio context falls behind
    // real time, the function returns early and the next utterance overlaps the
    // tail of this one.
    if (lastSource) {
      await new Promise<void>(resolve => {
        (lastSource as AudioBufferSourceNode).onended = () => resolve();
      });
    }
    try { gain.disconnect(); } catch { /* */ }
    if (this.currentStreamGain === gain) this.currentStreamGain = null;
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
    if (existing?.audioBuffer) {
      // Move to end so frequently-reused clips (Correct!/Incorrect.) survive eviction.
      this.ttsCache.delete(text);
      this.ttsCache.set(text, existing);
      return existing.audioBuffer;
    }
    if (existing?.pending) return existing.pending;

    // LRU eviction before insert.
    if (!existing && this.ttsCache.size >= TTS_CACHE_MAX) {
      const oldest = this.ttsCache.keys().next().value;
      if (oldest !== undefined) this.ttsCache.delete(oldest);
    }

    const ctx = this.getAudioCtx();
    if (ctx.state === "suspended") await ctx.resume();

    const pending = (async () => {
      try {
        const relay = getRelay(this.plugin);
        const encoded: ArrayBuffer = relay
          ? await relay.elevenLabsTTS(text, this.voiceId, { callerId: "iris-cards:tts" })
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
      } catch (e) {
        // A failed fetch/decode must not stay cached, or every later play of
        // this text (e.g. a prewarmed next question) fails without retrying.
        const entry = this.ttsCache.get(text);
        if (entry && !entry.audioBuffer) this.ttsCache.delete(text);
        throw e;
      }
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
    // Suspend immediately — only resume while actively recording.
    // A 16 kHz context connected to device output causes audible hiss
    // even through gain=0, because the OS resampler mixes it in.
    ctx.suspend();
    return processor;
  }

  private async streamSTT(maxMs: number, keyterms: string[] = []): Promise<string> {
    if (!this.micStream) throw new Error("No mic stream");

    const relay = getRelay(this.plugin);
    if (!relay?.elevenLabsSTTStream) {
      // Fallback to non-streaming if relay too old or absent.
      return this.recordAndTranscribeFallback(keyterms);
    }

    const processor = this.ensureCapturePipeline();
    if (this.captureCtx?.state === "suspended") {
      await this.captureCtx.resume();
    }
    const captureRate = this.captureCtx?.sampleRate ?? 16000;

    // Deferred promise so resolve/reject are visible to the handlers below
    // without nesting them inside an async Promise executor (which would
    // swallow synchronous throws).
    let resolveFn!: (v: string) => void;
    let rejectFn!: (e: Error) => void;
    const result = new Promise<string>((res, rej) => { resolveFn = res; rejectFn = rej; });

    let session: STTStreamSession | null = null;
    let settled = false;
    let partialTimer: ReturnType<typeof setTimeout> | null = null;
    const clearPartial = () => {
      if (partialTimer !== null) { clearTimeout(partialTimer); partialTimer = null; }
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      processor.onaudioprocess = null;
      this.captureCtx?.suspend();
      clearPartial();
      try { session?.close(); } catch { /* */ }
      if (this.activeSession === session) this.activeSession = null;
      fn();
    };

    const maxDuration = setTimeout(() => {
      // Try a graceful flush first; if STT never responds, settle ourselves.
      try { session?.end(); } catch { /* */ }
      setTimeout(() => settle(() => rejectFn(new Error("STT stream timeout"))), 1500);
    }, maxMs);

    // Throttle partial-transcript DOM writes to ~10 Hz. Scribe sends partials
    // quickly during continuous speech; coalescing keeps the layout calm.
    let lastPartialAt = 0;
    let pendingPartial: string | null = null;
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
        clearTimeout(maxDuration);
        settle(() => resolveFn(text));
      },
      onError: (err) => {
        clearTimeout(maxDuration);
        settle(() => rejectFn(err));
      },
    };

    try {
      // Pass keyterms as an options object — older relays that ignore extra
      // args degrade to unbiased STT (same behavior as before this change).
      session = await relay.elevenLabsSTTStream(handlers, { keyterms, callerId: "iris-cards:stt" });
    } catch (e) {
      clearTimeout(maxDuration);
      settle(() => rejectFn(e instanceof Error ? e : new Error(String(e))));
      return result;
    }

    // If a handler fired synchronously during setup (e.g. immediate WS error),
    // settled is already true — close the now-orphaned session and bail.
    if (settled) {
      try { session?.close(); } catch { /* */ }
      return result;
    }

    if (this.aborted) {
      clearTimeout(maxDuration);
      settle(() => rejectFn(new Error("Aborted")));
      return result;
    }

    this.activeSession = session;

    processor.onaudioprocess = (e) => {
      if (settled) return;
      const input = e.inputBuffer.getChannelData(0);
      const resampled = downsampleFloat(input, captureRate, 16000);
      try { session!.sendAudio(floatTo16BitPCM(resampled)); } catch { /* session closed */ }
    };

    return result;
  }

  /**
   * Fallback when no relay-streaming method is available: record a webm clip
   * via VAD-less manual stop, then call the one-shot REST STT. Kept simple —
   * the streaming path is the supported one; this is purely for older relays.
   */
  private async recordAndTranscribeFallback(keyterms: string[] = []): Promise<string> {
    if (!this.micStream) throw new Error("No mic stream");
    const recorder = new MediaRecorder(this.micStream, { mimeType: "audio/webm" });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    const blob: Blob = await new Promise((resolve, reject) => {
      const stop = () => { if (recorder.state === "recording") recorder.stop(); };
      const maxDur = setTimeout(stop, 15_000);
      recorder.onstop = () => { clearTimeout(maxDur); resolve(new Blob(chunks, { type: "audio/webm" })); };
      recorder.onerror = (e) => { clearTimeout(maxDur); reject(e); };
      recorder.start();
    });

    const relay = getRelay(this.plugin);
    return relay
      ? await relay.elevenLabsSTT(blob, { keyterms, callerId: "iris-cards:stt" })
      : await elevenLabsSTT(blob, this.apiKey, { keyterms });
  }

  // ─── Answer Evaluation ────────────────────────────────────────────

  /** Q&A marking: exact/accepted match first, then optional LLM fallback. */
  private async evaluateAnswer(spoken: string, variant: QAVariant): Promise<{ correct: boolean }> {
    const normalized = normalizeAnswer(spoken);
    const allAccepted = [variant.answer, ...variant.acceptedAnswers];
    if (allAccepted.some(a => normalizeAnswer(a) === normalized)) {
      return { correct: true };
    }
    // Gate on aiEnabled, not llmMarkingEnabled: autoMark is the *typed-answer*
    // preference (visual view offers self-marking instead), but spoken answers
    // have no self-marking path — without LLM marking every non-verbatim
    // answer is wrong. aiEnabled covers backend availability (local key OR
    // relay); markAnswer routes through the relay when mounted, so an empty
    // local key must not disable marking.
    const apiKey = this.plugin.settings.anthropicApiKey;
    if (aiEnabled(this.plugin)) {
      // The audio flow has no UI to surface a marking error, so a failure
      // throws and propagates to the view's catch.
      const mark = await markAnswer(variant.question, variant.answer, spoken, apiKey, this.plugin.settings.claudeModel);
      if (!mark.ok) throw new Error(mark.error);
      return { correct: mark.value };
    }
    return { correct: false };
  }
}
