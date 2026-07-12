import type IrisCardsPlugin from "./main";
import { hasRelay } from "./api/client";

/**
 * Single source of truth for whether AI-backed features may run. All AI
 * features sit behind the `aiFeatures` master toggle (off by default — the
 * plugin is fully usable without any API), and additionally need a configured
 * backend (local Anthropic key or the Iris Router relay).
 */
export function aiEnabled(plugin: IrisCardsPlugin): boolean {
  return plugin.settings.aiFeatures && (!!plugin.settings.anthropicApiKey || hasRelay());
}

/** Whether typed answers may be marked by the LLM (vs. local match / self-grade). */
export function llmMarkingEnabled(plugin: IrisCardsPlugin): boolean {
  return aiEnabled(plugin) && plugin.settings.autoMark;
}
