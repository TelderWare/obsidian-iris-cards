import { BasesView, Menu, Notice, TFile, type QueryController } from "obsidian";
import type IrisCardsPlugin from "../main";
import { parseQABlock } from "../types/qa-block";

/**
 * The card library is a plain Obsidian base over the cards folder. Search,
 * filters, sorting, grouping, columns, inline property edits, and the file
 * context menu (delete, review, group) are all Bases' own. The one thing a
 * stock view can't show is a card's fact text — it lives in the note body,
 * not a property — so the base's default view is this small custom one: the
 * fact, then whichever properties the base is set to show.
 */
export const FACTS_VIEW_TYPE = "iris-facts";
const LIBRARY_NAME = "Card library.base";

export function registerCardLibrary(plugin: IrisCardsPlugin): void {
  ensureFactsView(plugin);
  // registerBasesView is a silent no-op while the Bases core plugin is off, and
  // turning Bases on later doesn't replay it — the library then fails with
  // "unknown view type". Retry whenever a file opens (which covers opening the
  // base itself), not just once at load.
  plugin.app.workspace.onLayoutReady(() => ensureFactsView(plugin));
  plugin.registerEvent(plugin.app.workspace.on("file-open", () => ensureFactsView(plugin)));
}

let blindRegistered = false;

/** Register the Facts view with Bases if Bases is on and doesn't have it yet.
 * Returns true when this call did the registering. */
function ensureFactsView(plugin: IrisCardsPlugin): boolean {
  const bases = basesPlugin(plugin);
  if (!bases) return false;
  if (typeof bases.getRegistration === "function") {
    if (bases.getRegistration(FACTS_VIEW_TYPE)) return false;
  } else if (blindRegistered) {
    // Can't ask Bases what it has — only try once, or every file-open would
    // trip its "view already registered" error.
    return false;
  }
  blindRegistered = true;
  return plugin.registerBasesView(FACTS_VIEW_TYPE, {
    name: "Facts",
    icon: "book-open",
    factory: (controller, containerEl) => new FactsView(controller, containerEl, plugin),
  });
}

/** Open the card library base, creating it on first use. Never overwrites an
 * existing one — it's the user's to edit like any other base. */
export async function openCardLibrary(plugin: IrisCardsPlugin): Promise<void> {
  const { app } = plugin;
  // With the Bases core plugin off, nothing in Obsidian can open a .base file
  // and openFile hands it to the OS default app instead (Notepad on Windows).
  if (basesPlugin(plugin) === null) {
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
  const justRegistered = ensureFactsView(plugin);
  const open = app.workspace.getLeavesOfType("bases").find(l => (l.view as { file?: TFile }).file?.path === file.path);
  if (open && justRegistered) {
    // Already open, but rendered before the Facts view existed (showing the
    // unknown-view error) — reload it so it picks the view up.
    await open.openFile(file);
    app.workspace.revealLeaf(open);
    return;
  }
  if (open) {
    app.workspace.revealLeaf(open);
    return;
  }
  await app.workspace.getLeaf("tab").openFile(file);
}

interface BasesInstance { getRegistration?: (id: string) => unknown }

/** The Bases core plugin's instance, or null when it's off. Not in the public
 * API; if the internals ever move, report it as on (an empty instance) rather
 * than lock the library out — registerBasesView then does its own check. */
function basesPlugin(plugin: IrisCardsPlugin): BasesInstance | null {
  const internal = (plugin.app as unknown as {
    internalPlugins?: { getEnabledPluginById?: (id: string) => BasesInstance | null };
  }).internalPlugins;
  if (typeof internal?.getEnabledPluginById !== "function") return {};
  return internal.getEnabledPluginById("bases") ?? null;
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
    `  - type: ${FACTS_VIEW_TYPE}`,
    "    name: Facts",
    "    order:",
    "      - note.parent-note",
    "      - note.group",
    "      - note.next-due",
    "    sort:",
    "      - property: note.last-reviewed",
    "        direction: DESC",
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

class FactsView extends BasesView {
  type = FACTS_VIEW_TYPE;
  /** Fact text by path, keyed to mtime so edits show and unchanged cards
   * aren't re-read on every data update. */
  private bodies = new Map<string, { mtime: number; text: string }>();
  private renderSeq = 0;

  constructor(controller: QueryController, private containerEl: HTMLElement, private plugin: IrisCardsPlugin) {
    super(controller);
    containerEl.addClass("iris-facts-view");
  }

  onDataUpdated(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    const seq = ++this.renderSeq;
    const groups = this.data.groupedData;
    const bodies = new Map<string, string>();
    for (const g of groups) {
      for (const e of g.entries) bodies.set(e.file.path, await this.factText(e.file));
    }
    // A newer update landed while we were reading — let it render instead.
    if (seq !== this.renderSeq) return;

    const el = this.containerEl;
    el.empty();
    if (groups.every(g => g.entries.length === 0)) {
      el.createDiv({ cls: "iris-facts-empty", text: "No cards match." });
      return;
    }
    const props = this.config.getOrder();
    for (const group of groups) {
      if (group.entries.length === 0) continue;
      if (group.hasKey()) {
        el.createDiv({ cls: "iris-facts-group", text: group.key?.toString() ?? "" });
      }
      for (const entry of group.entries) {
        const row = el.createDiv({ cls: "iris-facts-row" });
        row.createDiv({ cls: "iris-facts-body", text: bodies.get(entry.file.path) || entry.file.basename });
        const meta = row.createDiv({ cls: "iris-facts-meta" });
        for (const prop of props) {
          const value = entry.getValue(prop);
          if (!value || !value.isTruthy()) continue;
          const item = meta.createSpan({ cls: "iris-facts-prop", attr: { "aria-label": this.config.getDisplayName(prop) } });
          value.renderTo(item, this.app.renderContext);
        }
        row.addEventListener("click", (e) => {
          // Links rendered inside a property handle their own clicks.
          if ((e.target as HTMLElement).closest("a")) return;
          void this.openFact(entry.file);
        });
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const menu = new Menu();
          this.app.workspace.trigger("file-menu", menu, entry.file, "iris-card-library");
          menu.showAtMouseEvent(e);
        });
      }
    }
  }

  private async factText(file: TFile): Promise<string> {
    const hit = this.bodies.get(file.path);
    if (hit && hit.mtime === file.stat.mtime) return hit.text;
    let text = "";
    try {
      // The "(Context: …)" line capture prepends is for question generation,
      // not for reading — the parent note is already a property.
      text = parseQABlock(await this.app.vault.cachedRead(file)).body
        .replace(/^\s*\(Context:[^\n]*\)\s*/, "")
        .replace(/\n+/g, " ")
        .trim();
    } catch { /* unreadable card — falls back to its file name */ }
    this.bodies.set(file.path, { mtime: file.stat.mtime, text });
    return text;
  }

  /** A card is read in context: open its parent note, or the card itself
   * when it has none. Always in a new tab, so the library stays open. */
  private async openFact(card: TFile): Promise<void> {
    const parent = this.app.metadataCache.getFileCache(card)?.frontmatter?.["parent-note"];
    const m = typeof parent === "string" ? parent.match(/^\[\[([^\]|#]+)/) : null;
    const dest = m ? this.app.metadataCache.getFirstLinkpathDest(m[1], card.path) : null;
    await this.app.workspace.getLeaf("tab").openFile(dest ?? card);
  }
}
