import { App, Modal, Notice, TFile } from "obsidian";
import type IrisCardsPlugin from "../main";
import { getGroupOrders } from "../scheduler";

/**
 * Group existing cards after the fact — from the file menu on one card, or
 * the multi-select menu in the file explorer. Asks for a group name, then
 * stamps the cards in, in the order given.
 */
export function groupCards(plugin: IrisCardsPlugin, files: TFile[]): void {
  if (files.length === 0) return;
  const cardsFolder = plugin.settings.cardsFolder.trim() || "Iris Cards";
  const existing = [...getGroupOrders(plugin.app, cardsFolder).keys()].sort();
  new GroupAssignModal(plugin.app, files.length, existing, (name) => {
    if (name) void assignToGroup(plugin, files, name);
  }).open();
}

/**
 * Stamp `files` into `name`, in order, appending after the group's current
 * members. Cards already reviewed count as introduced and stay reviewable;
 * never-reviewed cards wait to be started one at a time — except the first
 * card of a brand-new group, which starts reviewable, same as bulk capture.
 */
async function assignToGroup(plugin: IrisCardsPlugin, files: TFile[], name: string): Promise<void> {
  const cardsFolder = plugin.settings.cardsFolder.trim() || "Iris Cards";
  const orders = getGroupOrders(plugin.app, cardsFolder);
  const isNewGroup = !orders.has(name);
  let order = orders.get(name) ?? 0;
  let waitingCount = 0;
  for (let i = 0; i < files.length; i++) {
    order++;
    const first = isNewGroup && i === 0;
    await plugin.app.fileManager.processFrontMatter(files[i], (fm) => {
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
  const n = files.length;
  new Notice(waitingCount > 0
    ? `Grouped ${n} card${n === 1 ? "" : "s"} into "${name}" — ${waitingCount} waiting to be started.`
    : `Grouped ${n} card${n === 1 ? "" : "s"} into "${name}".`);
}

/**
 * Names the group. Mirrors the bulk-capture group dialog: free text with
 * autocomplete over existing group names, Enter or the Group button confirms.
 * Cancel / Esc does nothing.
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
    this.setTitle(this.cardCount === 1 ? "Add to group" : "Group these cards");
    contentEl.createEl("p", {
      cls: "iris-group-name-desc",
      text: `${this.cardCount} card${this.cardCount === 1 ? "" : "s"}. Unreviewed cards wait to be started one at a time; naming an existing group appends to it.`,
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
