import { App, Modal, Notice, TFile, setIcon } from "obsidian";
import { parseQABlock } from "../types/qa-block";
import { getAllCards } from "../leitner";

interface CardEntry {
  file: TFile;
  body: string;
  lastReviewed: string | null;
  variantCount: number;
  searchText: string;
}

export class BrowseModal extends Modal {
  private entries: CardEntry[] = [];
  private listEl!: HTMLDivElement;
  private cardsFolder: string;

  constructor(app: App, cardsFolder: string) {
    super(app);
    this.cardsFolder = cardsFolder;
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass("iris-browse-modal-wrap");
    const { contentEl } = this;
    contentEl.addClass("iris-browse-modal");

    const search = contentEl.createEl("input", {
      cls: "iris-browse-search",
      attr: { type: "text", placeholder: "Search facts..." },
    });

    this.listEl = contentEl.createDiv({ cls: "iris-browse-list" });

    await this.loadEntries();
    this.renderList("");

    search.addEventListener("input", () => {
      this.renderList(search.value);
    });
    search.focus();
  }

  private async loadEntries(): Promise<void> {
    const files = getAllCards(this.app, this.cardsFolder);
    const entries: CardEntry[] = [];
    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      const parsed = parseQABlock(content);
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const lastReviewed = (fm?.["last-reviewed"] as string) ?? null;
      const body = parsed.body.trim();
      const variantParts = parsed.variants.map(v => `${v.question} ${v.answer}`).join(" ");
      entries.push({
        file,
        body,
        lastReviewed,
        variantCount: parsed.variants.length,
        searchText: `${body} ${variantParts}`.toLowerCase(),
      });
    }
    entries.sort((a, b) => {
      if (!a.lastReviewed && !b.lastReviewed) return 0;
      if (!a.lastReviewed) return 1;
      if (!b.lastReviewed) return -1;
      return b.lastReviewed.localeCompare(a.lastReviewed);
    });
    this.entries = entries;
  }

  private renderList(query: string): void {
    this.listEl.empty();
    const q = query.toLowerCase().trim();
    const filtered = q
      ? this.entries.filter(e => e.searchText.includes(q))
      : this.entries;

    if (filtered.length === 0) {
      this.listEl.createDiv({ cls: "iris-browse-empty", text: q ? "No matching facts" : "No facts yet" });
      return;
    }

    for (const entry of filtered) {
      const row = this.listEl.createDiv({ cls: "iris-browse-row" });

      const main = row.createDiv({ cls: "iris-browse-main" });
      const bodyEl = main.createDiv({ cls: "iris-browse-body" });
      bodyEl.setText(truncate(entry.body, 120));

      const meta = main.createDiv({ cls: "iris-browse-meta" });
      if (entry.lastReviewed) {
        meta.createSpan({ text: formatDate(entry.lastReviewed) });
      }
      if (entry.variantCount > 0) {
        meta.createSpan({ text: `${entry.variantCount} variant${entry.variantCount !== 1 ? "s" : ""}` });
      }

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
          row.remove();
          new Notice("Fact moved to trash");
        } catch (err) {
          new Notice("Failed to delete fact");
          console.error(err);
        }
      });

      main.addEventListener("click", () => {
        this.close();
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
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\n+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "..." : oneLine;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
