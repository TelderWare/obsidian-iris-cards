import { Notice, TFile } from "obsidian";
import type IrisCardsPlugin from "../main";

/**
 * The card library is a plain Obsidian base over the cards folder. Search,
 * filters, sorting, grouping, columns, inline property edits, and the file
 * context menu (delete, review, group) are all Bases' own.
 */
const LIBRARY_NAME = "Card library.base";

/** Open the card library base, creating it on first use. Never overwrites an
 * existing one — it's the user's to edit like any other base. */
export async function openCardLibrary(plugin: IrisCardsPlugin): Promise<void> {
  const { app } = plugin;
  // With the Bases core plugin off, nothing in Obsidian can open a .base file
  // and openFile hands it to the OS default app instead (Notepad on Windows).
  if (!basesEnabled(plugin)) {
    new Notice("The card library is a base. Turn on Bases in Settings → Core plugins, then try again.", 8000);
    return;
  }
  const cardsFolder = plugin.settings.cardsFolder.trim() || "Iris Cards";
  const path = `${cardsFolder}/${LIBRARY_NAME}`;
  let file = app.vault.getAbstractFileByPath(path);
  if (!file) {
    await plugin.cardStore.ensureFolderExists(cardsFolder);
    file = await app.vault.create(path, libraryBase(cardsFolder));
  }
  if (!(file instanceof TFile)) {
    new Notice(`${path} exists but isn't a file.`);
    return;
  }
  if ((await app.vault.cachedRead(file)).includes("iris-facts")) await app.vault.process(file, dropFactsView);
  const open = app.workspace.getLeavesOfType("bases").find(l => (l.view as { file?: TFile }).file?.path === file.path);
  if (open) {
    app.workspace.revealLeaf(open);
    return;
  }
  await app.workspace.getLeaf("tab").openFile(file);
}

/**
 * Earlier builds made the library's default view a custom "Facts" view, since
 * removed. Strip it from an existing base so it opens on its remaining views
 * rather than an unknown-view error. Leaves everything else as the user set it.
 */
function dropFactsView(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex(l => /^\s*- type: iris-facts\s*$/.test(l));
  if (start < 0) return text;
  const indent = lines[start].search(/\S/);
  let end = start + 1;
  // The view's own keys are indented past its "- "; the next view (or the
  // next top-level key) ends it.
  while (end < lines.length && (lines[end].trim() === "" || lines[end].search(/\S/) > indent)) end++;
  lines.splice(start, end - start);
  return lines.join("\n");
}

/** Whether the Bases core plugin is on. Not in the public API; if the
 * internals ever move, report it as on rather than lock the library out. */
function basesEnabled(plugin: IrisCardsPlugin): boolean {
  const internal = (plugin.app as unknown as {
    internalPlugins?: { getEnabledPluginById?: (id: string) => unknown };
  }).internalPlugins;
  if (typeof internal?.getEnabledPluginById !== "function") return true;
  return !!internal.getEnabledPluginById("bases");
}

function libraryBase(cardsFolder: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return [
    "filters:",
    "  and:",
    `    - ${q(`file.inFolder(${JSON.stringify(cardsFolder)})`)}`,
    `    - ${q(`file.ext == "md"`)}`,
    `    - ${q(`!file.name.contains("Conflicted copy")`)}`,
    `    - ${q(`note["ai-selected"] != true`)}`,
    "properties:",
    "  note.parent-note:",
    "    displayName: Note",
    "  note.group-order:",
    "    displayName: Order",
    "  note.last-reviewed:",
    "    displayName: Last reviewed",
    "  note.next-due:",
    "    displayName: Due",
    "views:",
    "  - type: table",
    "    name: Table",
    "    order:",
    "      - file.name",
    "      - note.parent-note",
    "      - note.group",
    "      - note.group-order",
    "      - note.waiting",
    "      - note.last-reviewed",
    "      - note.next-due",
    "      - note.repetitions",
    "      - note.tags",
    "    sort:",
    "      - property: note.last-reviewed",
    "        direction: DESC",
    "",
  ].join("\n");
}
