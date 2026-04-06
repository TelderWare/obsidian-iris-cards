import { Editor, MarkdownView, MarkdownFileInfo, TFile, TFolder, Notice, normalizePath } from "obsidian";
import { toTitleCase, stripMarkdown, sanitizeFileName } from "./utils";
import type IrisCardsPlugin from "../main";

function buildContextLine(plugin: IrisCardsPlugin, sourceFile: TFile, editor: Editor): string {
  const cache = plugin.app.metadataCache.getFileCache(sourceFile);
  const fm = cache?.frontmatter;
  const noteTitle = fm?.["displayTitle"] ?? fm?.["title"] ?? sourceFile.basename;

  const parts: string[] = [noteTitle];

  const headings = cache?.headings;
  if (headings && headings.length > 0) {
    const selLine = editor.getCursor("from").line;
    const ancestors: { level: number; heading: string }[] = [];
    for (const h of headings) {
      if (h.position.start.line >= selLine) break;
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

function getStripPrefixes(plugin: IrisCardsPlugin): string[] {
  if (!plugin.settings.useAutoStripPrefixes) {
    return plugin.settings.stripPrefixes;
  }
  return plugin.app.vault
    .getRoot()
    .children.filter((child): child is TFolder => child instanceof TFolder)
    .map((folder) => folder.name);
}

function computeTargetPath(plugin: IrisCardsPlugin, sourceFilePath: string, noteTitle: string): string {
  const parts = sourceFilePath.split("/");
  parts.pop();

  const stripPrefixes = getStripPrefixes(plugin);
  if (parts.length > 0 && stripPrefixes.includes(parts[0])) {
    parts.shift();
  }

  const targetPrefix = plugin.settings.targetPrefix.trim();
  if (targetPrefix) {
    parts.unshift(targetPrefix);
  }

  const fileName = sanitizeFileName(noteTitle);
  parts.push(fileName + ".md");

  return normalizePath(parts.join("/"));
}

export async function createNoteFromSelection(plugin: IrisCardsPlugin): Promise<void> {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  const selection = view?.editor.getSelection().trim() ?? "";
  const sourceFile = view?.file ?? plugin.app.workspace.getActiveFile();

  if (!selection) {
    const folder = plugin.settings.noSelectionUseTargetPrefix
      ? plugin.settings.targetPrefix.trim()
      : "";
    if (folder) {
      await plugin.cardStore.ensureFolderExists(folder);
    }

    const baseName = "Untitled";
    let targetPath = normalizePath(folder ? `${folder}/${baseName}.md` : `${baseName}.md`);

    let counter = 1;
    while (plugin.app.vault.getAbstractFileByPath(targetPath)) {
      targetPath = normalizePath(
        folder ? `${folder}/${baseName} ${counter}.md` : `${baseName} ${counter}.md`,
      );
      counter++;
    }

    const newFile = await plugin.app.vault.create(targetPath, "");

    await plugin.app.fileManager.processFrontMatter(newFile, (fm) => {
      if (plugin.settings.noSelectionAddParentNote && sourceFile) {
        fm["parent-note"] = `[[${sourceFile.basename}]]`;
      }
      if (sourceFile) {
        const srcModule = plugin.app.metadataCache.getFileCache(sourceFile)?.frontmatter?.["module"];
        if (srcModule != null) fm["module"] = srcModule;
      }
    });

    const leaf = plugin.app.workspace.getLeaf(false);
    await leaf.openFile(newFile);
    return;
  }

  if (!sourceFile) {
    new Notice("Could not determine the current file.");
    return;
  }

  const noteTitle = toTitleCase(selection);
  const targetPath = computeTargetPath(plugin, sourceFile.path, noteTitle);

  const existingFile = plugin.app.vault.getAbstractFileByPath(targetPath);
  if (existingFile instanceof TFile) {
    const leaf = plugin.app.workspace.getLeaf(false);
    await leaf.openFile(existingFile);
    return;
  }

  const lastSlash = targetPath.lastIndexOf("/");
  if (lastSlash > 0) {
    await plugin.cardStore.ensureFolderExists(targetPath.substring(0, lastSlash));
  }

  const newFile = await plugin.app.vault.create(targetPath, "");

  await plugin.app.fileManager.processFrontMatter(newFile, (fm) => {
    if (plugin.settings.withSelectionAddParentNote) {
      fm["parent-note"] = `[[${sourceFile.basename}]]`;
    }
    const srcModule = plugin.app.metadataCache.getFileCache(sourceFile)?.frontmatter?.["module"];
    if (srcModule != null) fm["module"] = srcModule;
  });

  const leaf = plugin.app.workspace.getLeaf(false);
  await leaf.openFile(newFile);

  new Notice(`Created: ${noteTitle}`);
}

export async function memorizeSelection(
  plugin: IrisCardsPlugin,
  editor: Editor,
  ctx: MarkdownView | MarkdownFileInfo,
): Promise<void> {
  const rawSelection = editor.getSelection().trim();
  if (!rawSelection) {
    new Notice("Select text to memorize.");
    return;
  }

  const selection = stripMarkdown(rawSelection);
  const sourceFile = ctx.file;
  const cardsFolder = plugin.settings.cardsFolder.trim() || "Iris Cards";

  const apiKey = plugin.settings.anthropicApiKey;
  const contextLine = sourceFile ? buildContextLine(plugin, sourceFile, editor) : "";
  const cardBody = contextLine ? `${contextLine}\n\n${selection}` : selection;

  const srcFm = sourceFile ? plugin.app.metadataCache.getFileCache(sourceFile)?.frontmatter : undefined;
  const newFile = await plugin.cardStore.createCard(cardsFolder, cardBody, sourceFile ? {
    file: sourceFile,
    module: srcFm?.["module"] ?? undefined,
    date: srcFm?.["date"] ?? undefined,
  } : undefined);

  if (apiKey) plugin.pregen.pregenerateQA(newFile, apiKey);

  const ref = plugin.app.metadataCache.on("resolved", () => {
    plugin.app.metadataCache.offref(ref);
    plugin.updateBadge();
  });
  new Notice("Saved as card.");
}
