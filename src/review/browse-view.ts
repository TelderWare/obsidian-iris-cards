import { App, ItemView, Modal, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type IrisCardsPlugin from "../main";
import { parseQABlock } from "../types/qa-block";
import { getAllCards, getGroupOrders, getParentNoteName } from "../scheduler";

export const VIEW_TYPE_BROWSE = "iris-cards-browse";

interface CardEntry {
  file: TFile;
  body: string;
  lastReviewed: string | null;
  variantCount: number;
  parentNote: string | null;
  searchText: string;
}

export class BrowseView extends ItemView {
  plugin: IrisCardsPlugin;
  private entries: CardEntry[] = [];
  private listEl!: HTMLDivElement;
  private countEl!: HTMLSpanElement;
  private searchEl!: HTMLInputElement;
  private currentQuery = "";
  private refreshScheduled = false;
  /** Paths of cards selected for grouping, in selection order (= group order). */
  private selection: string[] = [];
  private rowSelEls = new Map<string, { row: HTMLElement; btn: HTMLElement; badge: HTMLElement }>();
  private groupBtn!: HTMLButtonElement;
  private clearSelBtn!: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf, plugin: IrisCardsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_BROWSE;
  }

  getDisplayText(): string {
    return "Browse facts";
  }

  getIcon(): string {
    return "book-open";
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("iris-browse-view");

    const header = container.createDiv({ cls: "iris-browse-header" });

    const titleRow = header.createDiv({ cls: "iris-browse-titlerow" });
    titleRow.createEl("h2", { cls: "iris-browse-title", text: "Browse facts" });
    this.countEl = titleRow.createEl("span", { cls: "iris-browse-count" });

    const refreshBtn = titleRow.createEl("button", {
      cls: "iris-toggle clickable-icon",
      attr: { "aria-label": "Refresh" },
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => this.refresh());

    // Group-selected action — appears once at least one card is selected.
    this.groupBtn = titleRow.createEl("button", { cls: "iris-browse-group-btn iris-hidden", text: "Group…" });
    this.groupBtn.addEventListener("click", () => this.openGroupModal());
    this.clearSelBtn = titleRow.createEl("button", {
      cls: "iris-toggle clickable-icon iris-hidden",
      attr: { "aria-label": "Clear selection" },
    });
    setIcon(this.clearSelBtn, "x");
    this.clearSelBtn.addEventListener("click", () => {
      this.selection = [];
      this.updateSelectionUI();
    });

    this.searchEl = header.createEl("input", {
      cls: "iris-browse-search",
      attr: { type: "text", placeholder: "Search facts..." },
    });
    this.searchEl.addEventListener("input", () => {
      this.currentQuery = this.searchEl.value;
      this.renderList();
    });

    this.listEl = container.createDiv({ cls: "iris-browse-list" });

    this.registerEvent(this.app.vault.on("create", (f) => {
      if (f instanceof TFile && this.isCardFile(f)) this.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on("delete", (f) => {
      if (f instanceof TFile && this.isCardFile(f)) this.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on("rename", (f) => {
      if (f instanceof TFile && this.isCardFile(f)) this.scheduleRefresh();
    }));
    this.registerEvent(this.app.metadataCache.on("changed", (f) => {
      if (this.isCardFile(f)) this.scheduleRefresh();
    }));

    await this.refresh();
    this.searchEl.focus();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  private isCardFile(file: TFile): boolean {
    const folder = this.plugin.settings.cardsFolder.trim() || "Iris Cards";
    return file.path.startsWith(folder + "/");
  }

  private scheduleRefresh(): void {
    if (this.refreshScheduled) return;
    this.refreshScheduled = true;
    window.setTimeout(() => {
      this.refreshScheduled = false;
      void this.refresh();
    }, 200);
  }

  private async refresh(): Promise<void> {
    const files = getAllCards(this.app, this.plugin.settings.cardsFolder);
    const entries: CardEntry[] = [];
    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      const parsed = parseQABlock(content);
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const lastReviewed = (fm?.["last-reviewed"] as string) ?? null;
      const parentNote = getParentNoteName(fm) ?? null;
      // The "(Context: …)" line capture prepends is for question generation,
      // not for reading — the parent note already appears in the row meta.
      const body = parsed.body.replace(/^\s*\(Context:[^\n]*\)\s*/, "").trim();
      const variantParts = parsed.variants.map(v => `${v.question} ${v.answer}`).join(" ");
      entries.push({
        file,
        body,
        lastReviewed,
        variantCount: parsed.variants.length,
        parentNote,
        searchText: `${body} ${variantParts} ${parentNote ?? ""}`.toLowerCase(),
      });
    }
    entries.sort((a, b) => {
      if (!a.lastReviewed && !b.lastReviewed) return 0;
      if (!a.lastReviewed) return 1;
      if (!b.lastReviewed) return -1;
      return b.lastReviewed.localeCompare(a.lastReviewed);
    });
    this.entries = entries;
    this.selection = this.selection.filter(p => entries.some(e => e.file.path === p));
    this.renderList();
  }

  private renderList(): void {
    this.listEl.empty();
    this.rowSelEls.clear();
    const q = this.currentQuery.toLowerCase().trim();
    const filtered = q
      ? this.entries.filter(e => e.searchText.includes(q))
      : this.entries;

    this.countEl.setText(`${filtered.length} of ${this.entries.length}`);

    if (filtered.length === 0) {
      this.listEl.createDiv({ cls: "iris-browse-empty", text: q ? "No matching facts" : "No facts yet" });
      return;
    }

    for (const entry of filtered) {
      const row = this.listEl.createDiv({ cls: "iris-browse-row" });

      // Selection toggle for after-the-fact grouping; the badge shows the
      // card's position in the selection (= its order within the new group).
      const selBtn = row.createEl("button", {
        cls: "iris-browse-select",
        attr: { "aria-label": "Select for grouping" },
      });
      const badge = selBtn.createSpan({ cls: "iris-browse-select-badge" });
      selBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleSelect(entry.file.path);
      });
      this.rowSelEls.set(entry.file.path, { row, btn: selBtn, badge });

      const main = row.createDiv({ cls: "iris-browse-main" });
      const bodyEl = main.createDiv({ cls: "iris-browse-body" });
      bodyEl.setText(truncate(entry.body, 240));

      const meta = main.createDiv({ cls: "iris-browse-meta" });
      if (entry.parentNote) {
        meta.createSpan({ cls: "iris-browse-meta-note", text: entry.parentNote });
      }
      if (entry.variantCount > 0) {
        meta.createSpan({ text: `${entry.variantCount} variant${entry.variantCount !== 1 ? "s" : ""}` });
      }
      const rowFm = this.app.metadataCache.getFileCache(entry.file)?.frontmatter;
      const group = rowFm?.["group"];
      if (typeof group === "string" && group) {
        meta.createSpan({
          cls: "iris-browse-meta-group",
          text: rowFm?.["waiting"] ? `${group} · waiting` : group,
        });
      }

      const reviewBtn = row.createEl("button", {
        cls: "iris-browse-review",
        attr: { "aria-label": "Review this card" },
      });
      setIcon(reviewBtn, "play");
      reviewBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.plugin.activateCardReview(entry.file.path);
      });

      const deleteBtn = row.createEl("button", {
        cls: "iris-browse-delete",
        attr: { "aria-label": "Delete fact (click again to confirm)" },
      });
      setIcon(deleteBtn, "trash-2");

      let confirming = false;
      let resetTimer: number | null = null;
      const resetConfirm = () => {
        confirming = false;
        deleteBtn.removeClass("iris-browse-delete-confirm");
        if (resetTimer != null) {
          window.clearTimeout(resetTimer);
          resetTimer = null;
        }
      };

      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirming) {
          confirming = true;
          deleteBtn.addClass("iris-browse-delete-confirm");
          resetTimer = window.setTimeout(resetConfirm, 3000);
          return;
        }
        resetConfirm();
        try {
          await this.app.fileManager.trashFile(entry.file);
          this.entries = this.entries.filter(e => e.file.path !== entry.file.path);
          this.selection = this.selection.filter(p => p !== entry.file.path);
          this.rowSelEls.delete(entry.file.path);
          this.updateSelectionUI();
          row.remove();
          this.countEl.setText(`${this.entries.filter(e => !q || e.searchText.includes(q)).length} of ${this.entries.length}`);
          new Notice("Fact moved to trash");
        } catch (err) {
          new Notice("Failed to delete fact");
          console.error(err);
        }
      });

      main.addEventListener("click", () => {
        const fm = this.app.metadataCache.getFileCache(entry.file)?.frontmatter;
        const parentLink = fm?.["parent-note"];
        if (typeof parentLink === "string") {
          const m = parentLink.match(/^\[\[([^\]|]+)/);
          if (m) {
            const dest = this.app.metadataCache.getFirstLinkpathDest(m[1], "");
            if (dest) {
              this.app.workspace.getLeaf("tab").openFile(dest);
              return;
            }
          }
        }
        this.app.workspace.getLeaf("tab").openFile(entry.file);
      });
    }

    this.updateSelectionUI();
  }

  private toggleSelect(path: string): void {
    const idx = this.selection.indexOf(path);
    if (idx === -1) this.selection.push(path);
    else this.selection.splice(idx, 1);
    this.updateSelectionUI();
  }

  private updateSelectionUI(): void {
    for (const [path, els] of this.rowSelEls) {
      const idx = this.selection.indexOf(path);
      els.row.toggleClass("iris-browse-row-selected", idx !== -1);
      els.btn.toggleClass("is-selected", idx !== -1);
      els.badge.setText(idx === -1 ? "" : String(idx + 1));
    }
    const n = this.selection.length;
    this.groupBtn.toggleClass("iris-hidden", n === 0);
    this.groupBtn.setText(`Group ${n} card${n === 1 ? "" : "s"}…`);
    this.clearSelBtn.toggleClass("iris-hidden", n === 0);
  }

  private openGroupModal(): void {
    if (this.selection.length === 0) return;
    const cardsFolder = this.plugin.settings.cardsFolder.trim() || "Iris Cards";
    const existing = [...getGroupOrders(this.app, cardsFolder).keys()].sort();
    new GroupAssignModal(this.app, this.selection.length, existing, (name) => {
      if (name) void this.assignToGroup(name);
    }).open();
  }

  /**
   * Stamp the selected cards into `name`, in selection order, appending after
   * the group's current members. Cards already reviewed count as introduced
   * and stay reviewable; never-reviewed cards wait to be started one at a
   * time — except the first card of a brand-new group, which starts
   * reviewable, same as bulk capture.
   */
  private async assignToGroup(name: string): Promise<void> {
    const cardsFolder = this.plugin.settings.cardsFolder.trim() || "Iris Cards";
    const orders = getGroupOrders(this.app, cardsFolder);
    const isNewGroup = !orders.has(name);
    let order = orders.get(name) ?? 0;
    let waitingCount = 0;
    for (let i = 0; i < this.selection.length; i++) {
      const file = this.app.vault.getAbstractFileByPath(this.selection[i]);
      if (!(file instanceof TFile)) continue;
      order++;
      const first = isNewGroup && i === 0;
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        fm["group"] = name;
        fm["group-order"] = order;
        const reviewed = ((fm["repetitions"] as number | undefined) ?? 0) > 0 || !!fm["last-reviewed"];
        if (!reviewed && !first) {
          fm["waiting"] = true;
          waitingCount++;
        } else {
          delete fm["waiting"];
        }
      });
    }
    const n = this.selection.length;
    new Notice(waitingCount > 0
      ? `Grouped ${n} card${n === 1 ? "" : "s"} into "${name}" — ${waitingCount} waiting to be started.`
      : `Grouped ${n} card${n === 1 ? "" : "s"} into "${name}".`);
    this.selection = [];
    this.updateSelectionUI();
    // The frontmatter writes fire metadata "changed" events, which already
    // schedule a list refresh and badge update.
  }
}

/**
 * Names the group a browse-view selection joins. Mirrors the bulk-capture
 * group dialog: free text with autocomplete over existing group names, Enter
 * or the Group button confirms. Cancel / Esc does nothing.
 */
class GroupAssignModal extends Modal {
  private done = false;

  constructor(
    app: App,
    private cardCount: number,
    private existingGroups: string[],
    private onDone: (name: string | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("iris-group-name-modal");
    this.setTitle("Group these cards");
    contentEl.createEl("p", {
      cls: "iris-group-name-desc",
      text: `${this.cardCount} card${this.cardCount === 1 ? "" : "s"}, in the order you selected them. Unreviewed cards wait to be started one at a time; naming an existing group appends to it.`,
    });

    const input = contentEl.createEl("input", {
      type: "text",
      cls: "iris-group-name-input",
      attr: { placeholder: "Group name", list: "iris-group-assign-options" },
    });
    const options = contentEl.createEl("datalist", { attr: { id: "iris-group-assign-options" } });
    for (const name of this.existingGroups) options.createEl("option", { attr: { value: name } });

    const finish = (name: string | null) => {
      if (this.done) return;
      this.done = true;
      this.onDone(name);
      this.close();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(input.value.trim() || null);
      }
    });

    const buttons = contentEl.createDiv({ cls: "iris-group-name-buttons" });
    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => finish(null));
    const confirmBtn = buttons.createEl("button", { cls: "mod-cta", text: "Group" });
    confirmBtn.addEventListener("click", () => finish(input.value.trim() || null));

    window.setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    if (!this.done) {
      this.done = true;
      this.onDone(null);
    }
    this.contentEl.empty();
  }
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\n+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "..." : oneLine;
}

