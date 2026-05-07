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

export async function elevenLabsSTT(audioBlob: Blob, apiKey: string): Promise<string> {
  return retryable(async () => {
    const boundary = "----IrisCards" + Date.now().toString(36);
    const audioBytes = new Uint8Array(await audioBlob.arrayBuffer());

    const encoder = new TextEncoder();
    const preamble = encoder.encode(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model_id"\r\n\r\nscribe_v2\r\n` +
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
    (v: { voice_id: string; name: string }) => ({ voice_id: v.voice_id, name: v.name }),
  );
  return voices;
}
