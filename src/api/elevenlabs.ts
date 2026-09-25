import { requestUrl } from "obsidian";

const BASE_URL = "https://api.elevenlabs.io/v1";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 1_000;

function headers(apiKey: string): Record<string, string> {
  return { "xi-api-key": apiKey, "Content-Type": "application/json" };
}

async function retryable<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1)));
    }
    try {
      return await fn();
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      const msg = lastError.message;
      if (attempt < MAX_RETRIES && (msg.includes("429") || /\b5\d{2}\b/.test(msg) || msg.includes("timed out"))) {
        continue;
      }
      throw lastError;
    }
  }
  throw lastError || new Error("All retries exhausted");
}

export async function elevenLabsTTS(
  text: string, apiKey: string, voiceId: string, modelId = "eleven_v3",
): Promise<ArrayBuffer> {
  return retryable(async () => {
    const response = await Promise.race([
      requestUrl({
        url: `${BASE_URL}/text-to-speech/${voiceId}`,
        method: "POST",
        headers: headers(apiKey),
        body: JSON.stringify({
          text,
          model_id: modelId,
          output_format: "mp3_44100_128",
        }),
        throw: false,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out")), REQUEST_TIMEOUT_MS),
      ),
    ]);
    if (response.status === 429 || response.status >= 500) {
      throw new Error(`ElevenLabs TTS ${response.status}`);
    }
    if (response.status >= 400) {
      const msg = typeof response.json?.detail === "string"
        ? response.json.detail
        : `ElevenLabs TTS ${response.status}`;
      throw new Error(msg);
    }
    return response.arrayBuffer;
  });
}

/**
 * Stream TTS as raw PCM. Calls `onSamples` with Float32 chunks as they arrive
 * so the controller can schedule playback before the full clip is downloaded.
 * Resolves once the response stream ends.
 *
 * Uses fetch() (not Obsidian's requestUrl) because we need ReadableStream
 * access on the response body — requestUrl buffers the entire response.
 * Defaults to eleven_flash_v2_5 for ~75 ms time-to-first-byte.
 */
export async function elevenLabsTTSStream(
  text: string,
  apiKey: string,
  voiceId: string,
  onSamples: (samples: Float32Array, sampleRate: number) => void,
  options?: { modelId?: string; signal?: AbortSignal },
): Promise<void> {
  const modelId = options?.modelId ?? "eleven_flash_v2_5";
  const sampleRate = 22050;
  const response = await fetch(
    `${BASE_URL}/text-to-speech/${voiceId}/stream?output_format=pcm_${sampleRate}`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: modelId }),
      signal: options?.signal,
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`ElevenLabs TTS stream ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  if (!response.body) throw new Error("ElevenLabs TTS stream returned no body");

  const reader = response.body.getReader();
  // PCM s16le: 2 bytes per sample. Network chunks can split samples, so we
  // hold any odd trailing byte over to the next iteration.
  let leftover: Uint8Array | null = null;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;

      let chunk: Uint8Array;
      if (leftover) {
        chunk = new Uint8Array(leftover.length + value.length);
        chunk.set(leftover);
        chunk.set(value, leftover.length);
        leftover = null;
      } else {
        chunk = value;
      }

      const aligned = chunk.length - (chunk.length % 2);
      if (aligned < chunk.length) leftover = chunk.slice(aligned);
      if (aligned === 0) continue;

      const samples = new Float32Array(aligned / 2);
      const view = new DataView(chunk.buffer, chunk.byteOffset, aligned);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = view.getInt16(i * 2, true) / 0x7FFF;
      }
      onSamples(samples, sampleRate);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* */ }
  }
}

/**
 * Sanitize keyterms for ElevenLabs Scribe. The realtime endpoint is the
 * stricter of the two (≤20 chars per term, ≤50 entries); use those limits
 * everywhere so a single sanitizer covers both paths. Disallowed chars
 * (`<>{}[]\`) get stripped; empties dropped; entries deduped.
 */
export function sanitizeKeyterms(input: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const cleaned = raw.replace(/[<>{}[\]\\]/g, "").trim();
    if (!cleaned) continue;
    const truncated = cleaned.length > 20 ? cleaned.slice(0, 20).trim() : cleaned;
    const key = truncated.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(truncated);
    if (out.length >= 50) break;
  }
  return out;
}

export async function elevenLabsSTT(
  audioBlob: Blob,
  apiKey: string,
  options?: { keyterms?: readonly string[] },
): Promise<string> {
  return retryable(async () => {
    const boundary = "----IrisCards" + Date.now().toString(36);
    const audioBytes = new Uint8Array(await audioBlob.arrayBuffer());

    const encoder = new TextEncoder();
    const keyterms = sanitizeKeyterms(options?.keyterms ?? []);
    // Each keyterm is sent as its own form field with the same name — standard
    // multipart convention for array params, matches Scribe's `keyterms: array`.
    const keytermParts = keyterms.map(k =>
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="keyterms"\r\n\r\n${k}\r\n`
    ).join("");

    const preamble = encoder.encode(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model_id"\r\n\r\nscribe_v2\r\n` +
      keytermParts +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="recording.webm"\r\n` +
      `Content-Type: audio/webm\r\n\r\n`,
    );
    const epilogue = encoder.encode(`\r\n--${boundary}--\r\n`);

    const body = new Uint8Array(preamble.length + audioBytes.length + epilogue.length);
    body.set(preamble, 0);
    body.set(audioBytes, preamble.length);
    body.set(epilogue, preamble.length + audioBytes.length);

    const response = await Promise.race([
      requestUrl({
        url: `${BASE_URL}/speech-to-text`,
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body: body.buffer,
        throw: false,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out")), REQUEST_TIMEOUT_MS),
      ),
    ]);
    if (response.status === 429 || response.status >= 500) {
      throw new Error(`ElevenLabs STT ${response.status}`);
    }
    if (response.status >= 400) {
      const detail = typeof response.json?.detail === "string"
        ? response.json.detail
        : `ElevenLabs STT ${response.status}`;
      throw new Error(detail);
    }
    return (response.json?.text as string) ?? "";
  });
}

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  // Optional metadata, used to describe the voice in settings.
  category?: string;
  description?: string;
  labels?: Record<string, string>;
}

/** Short human-readable summary, e.g. "female, young, American, calm, narration". */
export function describeVoice(v: ElevenLabsVoice): string {
  const l = v.labels ?? {};
  const parts = [l.gender, l.age, l.accent, l.description ?? l.descriptive, l.use_case]
    .filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .map(p => p.replace(/_/g, " "));
  if (v.category && v.category !== "premade") parts.push(v.category);
  return parts.join(", ");
}

export async function fetchVoices(apiKey: string): Promise<ElevenLabsVoice[]> {
  const response = await requestUrl({
    url: `${BASE_URL}/voices`,
    method: "GET",
    headers: { "xi-api-key": apiKey },
    throw: false,
  });
  if (response.status >= 400) {
    throw new Error(`ElevenLabs voices ${response.status}`);
  }
  const voices: ElevenLabsVoice[] = (response.json?.voices ?? []).map(
    (v: ElevenLabsVoice) => ({
      voice_id: v.voice_id,
      name: v.name,
      category: v.category,
      description: v.description,
      labels: v.labels,
    }),
  );
  return voices;
}
