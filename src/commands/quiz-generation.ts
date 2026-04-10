import { MarkdownView, TFile, TFolder, Notice } from "obsidian";
import { extractFactsFromNote, filterFacts } from "../generators";
import { stripMarkdown } from "./utils";
import type IrisCardsPlugin from "../main";
import { hasRelay } from "../api/client";
import { sortByFilename } from "../leitner";
import { VIEW_TYPE_REVIEW, ReviewView } from "../review/review-view";

function buildContextLineForLine(plugin: IrisCardsPlugin, sourceFile: TFile, line: number): string {
  const cache = plugin.app.metadataCache.getFileCache(sourceFile);
  const fm = cache?.frontmatter;
  const noteTitle = fm?.["displayTitle"] ?? fm?.["title"] ?? sourceFile.basename;

  const parts: string[] = [noteTitle];

  const headings = cache?.headings;
  if (headings && headings.length > 0) {
    const ancestors: { level: number; heading: string }[] = [];
    for (const h of headings) {
      if (h.position.start.line >= line) break;
      while (ancestors.length > 0 && ancestors[ancestors.length - 1].level >= h.level) {
        ancestors.pop();
      }
      ancestors.push({ level: h.level, heading: h.heading });
    }
    for (const a of ancestors) {
      parts.push(a.heading);
    }
  }

  return `(Context: ${parts.join(", ")})`;
}

export async function generateQuiz(plugin: IrisCardsPlugin): Promise<void> {
  const apiKey = plugin.settings.anthropicApiKey;
  if (!apiKey && !(plugin.app as any).irisRelay) {
    new Notice("Set your Anthropic API key in Iris Cards settings (or enable Iris Router).");
    return;
  }

  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (!view?.file) {
    new Notice("Open a note to generate a quiz from.");
    return;
  }

  await runQuizGeneration(plugin, view.file, view.file, apiKey);
}

export async function generateQuizFromLinkedNote(plugin: IrisCardsPlugin): Promise<void> {
  const apiKey = plugin.settings.anthropicApiKey;
  if (!apiKey && !(plugin.app as any).irisRelay) {
    new Notice("Set your Anthropic API key in Iris Cards settings (or enable Iris Router).");
    return;
  }

  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (!view?.file) {
    new Notice("Open a note to generate a quiz from.");
    return;
  }
  const sourceFile = view.file;

  const fieldKey = plugin.settings.linkedNoteField.trim();
  if (!fieldKey) {
    new Notice("Set the linked note field in Iris Cards settings.");
    return;
  }

  const fm = plugin.app.metadataCache.getFileCache(sourceFile)?.frontmatter;
  const raw = fm?.[fieldKey];
  if (!raw) {
    new Notice(`No "${fieldKey}" field found in frontmatter.`);
    return;
  }

  const linkPath = String(raw).replace(/^\[\[|\]\]$/g, "");
  const linkedFile = plugin.app.metadataCache.getFirstLinkpathDest(linkPath, sourceFile.path);
  if (!linkedFile) {
    new Notice(`Linked note not found: ${linkPath}`);
    return;
  }

  await runQuizGeneration(plugin, sourceFile, linkedFile, apiKey);
}

function findCardsForSource(plugin: IrisCardsPlugin, sourceFile: TFile): TFile[] {
  const cardsFolder = plugin.settings.cardsFolder.trim() || "Iris Cards";
  const folder = plugin.app.vault.getAbstractFileByPath(cardsFolder);
  if (!(folder instanceof TFolder)) return [];
  const needle = `[[${sourceFile.basename}]]`;
  const matches: TFile[] = [];
  for (const child of folder.children) {
    if (!(child instanceof TFile) || child.extension !== "md") continue;
    const fm = plugin.app.metadataCache.getFileCache(child)?.frontmatter;
    if (!fm) continue;
    const parent = fm["parent-note"];
    if (typeof parent === "string" && parent === needle) matches.push(child);
  }
  return matches;
}

async function runQuizGeneration(plugin: IrisCardsPlugin, sourceFile: TFile, contentFile: TFile, apiKey: string): Promise<void> {
  const existing = findCardsForSource(plugin, sourceFile);
  if (existing.length > 0) {
    const sorted = sortByFilename(existing);
    new Notice(`Opening quiz: ${sorted.length} cards for ${sourceFile.basename}`);
    plugin.pendingQuizCards = sorted;
    const { reused } = await plugin.activateReviewView();
    if (reused) {
      const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW);
      const view = leaves[0]?.view;
      if (view instanceof ReviewView) {
        (view as unknown as { layoutReady: boolean }).layoutReady = false;
        await view.loadDueCards();
      }
    }
    return;
  }

  const rawContent = await plugin.app.vault.read(contentFile);
  const content = rawContent
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1");

  new Notice("Extracting facts\u2026");
  let facts: string[];
  try {
    facts = await extractFactsFromNote(content, apiKey, plugin.settings.claudeModel);
  } catch (e) {
    new Notice(`Fact extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  if (facts.length === 0) {
    new Notice("No facts found in this note.");
    return;
  }

  const before = facts.length;
  facts = await filterFacts(facts, apiKey);
  if (facts.length < before) {
    new Notice(`Quality gate: ${before - facts.length} vague facts filtered out.`);
  }

  if (facts.length === 0) {
    new Notice("All extracted facts were too vague to make good cards.");
    return;
  }

  const cardsFolder = plugin.settings.cardsFolder.trim() || "Iris Cards";
  const srcFm = plugin.app.metadataCache.getFileCache(sourceFile)?.frontmatter;
  const lines = rawContent.split("\n");

  const existingBodies = new Set<string>();
  const folder = plugin.app.vault.getAbstractFileByPath(cardsFolder);
  if (folder && folder instanceof TFolder) {
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === "md") {
        const c = await plugin.app.vault.read(child);
        existingBodies.add(c.toLowerCase().replace(/\s+/g, " ").trim());
      }
    }
  }

  new Notice(`Found ${facts.length} facts. Creating cards\u2026`);
  let created = 0;
  let skipped = 0;
  const createdFiles: TFile[] = [];

  for (const fact of facts) {
    const normFact = stripMarkdown(fact).toLowerCase().replace(/\s+/g, " ").trim();
    if ([...existingBodies].some(b => b.includes(normFact))) {
      skipped++;
      continue;
    }

    let factLine = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(fact.substring(0, Math.min(40, fact.length)))) {
        factLine = i;
        break;
      }
    }

    const contextLine = buildContextLineForLine(plugin, contentFile, factLine);
    const selection = stripMarkdown(fact);
    const cardBody = contextLine ? `${contextLine}\n\n${selection}` : selection;

    const newFile = await plugin.cardStore.createCard(cardsFolder, cardBody, {
      file: sourceFile,
      contentFile: contentFile !== sourceFile ? contentFile : undefined,
      module: srcFm?.["module"] ?? undefined,
      date: srcFm?.["date"] ?? undefined,
      aiSelected: true,
    });

    plugin.pregen.pregenerateQA(newFile, apiKey);
    createdFiles.push(newFile);
    created++;
  }

  const ref = plugin.app.metadataCache.on("resolved", () => {
    plugin.app.metadataCache.offref(ref);
    plugin.updateBadge();
  });

  const parts = [`Created ${created} cards from ${sourceFile.basename}`];
  if (skipped > 0) parts.push(`(${skipped} duplicates skipped)`);
  new Notice(parts.join(" "));

  if (created > 0) {
    plugin.pendingQuizCards = createdFiles;
    await plugin.activateReviewView();
  }
}
