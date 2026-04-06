import { App, requestUrl } from "obsidian";

// ─── Relay integration ─────────────────────────────────────────

let _app: App | undefined;
export function setRelayApp(app: App): void { _app = app; }

/** Relay priority for the current batch (0-10, lower = first). Default 5. */
let _relayPriority: number | undefined;
export function setRelayPriority(p: number | undefined): void { _relayPriority = p; }

// ─── Shared API Helpers ─────────────────────────────────────────

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 1_000;

export const TITLE_HINT =
  " The input may start with a parenthetical like (Context: Note Title, Section, Subsection) identifying the source topic and its heading hierarchy. Only reference this context in your output when the fact itself lacks enough context to be unambiguous — do not gratuitously name-drop it.";

function apiHeaders(apiKey: string) {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": API_VERSION,
  };
}

async function apiRequest(apiKey: string, body: object, relayPriority?: number): Promise<Record<string, unknown>> {
  // Route through Iris Relay when available
  const relay = (_app as any)?.irisRelay;
  if (relay) return relay.request(body, relayPriority ?? _relayPriority);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1)));
    }
    try {
      const response = await Promise.race([
        requestUrl({
          url: API_URL,
          method: "POST",
          headers: apiHeaders(apiKey),
          body: JSON.stringify(body),
          throw: false,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Request timed out")), REQUEST_TIMEOUT_MS),
        ),
      ]);
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(response.json?.error?.message ?? `API ${response.status}`);
        continue;
      }
      if (response.status >= 400) {
        const msg = response.json?.error?.message ?? `API ${response.status}`;
        throw new Error(msg);
      }
      return response.json;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < MAX_RETRIES && (
        lastError.message.includes("timed out") ||
        lastError.message.includes("429") ||
        /\b5\d{2}\b/.test(lastError.message)
      )) {
        continue;
      }
      throw lastError;
    }
  }
  throw lastError || new Error("All retries exhausted");
}

/** Call Claude with a tool and return the tool_use input block. */
export async function callClaudeTool<T>(
  apiKey: string, model: string, system: string,
  content: string, tool: object, maxTokens: number,
): Promise<T> {
  const toolName = (tool as { name: string }).name;
  const json = await apiRequest(apiKey, {
    model, max_tokens: maxTokens, system,
    messages: [{ role: "user", content }],
    tools: [tool],
    tool_choice: { type: "tool", name: toolName },
  });
  const block = (json?.content as { type: string; input?: T }[] | undefined)?.find(
    (b) => b.type === "tool_use",
  );
  if (!block?.input) throw new Error("No tool response from Claude.");
  return block.input;
}

/** Call Claude and return the text response. */
export async function callClaudeText(
  apiKey: string, model: string, system: string,
  content: string, maxTokens: number,
): Promise<string> {
  const json = await apiRequest(apiKey, {
    model, max_tokens: maxTokens, system,
    messages: [{ role: "user", content }],
  });
  return (json?.content as { text?: string }[] | undefined)?.[0]?.text ?? "";
}
