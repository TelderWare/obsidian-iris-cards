import { Editor, MarkdownView, MarkdownFileInfo, Modal, Setting, TFile, Notice } from "obsidian";
import { stripMarkdown } from "./utils";
import type IrisCardsPlugin from "../main";
import { ImageOcclusionEditor } from "../widgets/image-occlusion-editor";
import { ImageSuggestModal, IMAGE_EXTS } from "../widgets/image-suggest";
import { encodeImageOcclusion, extractImagePath, type OcclusionRegion } from "../types/image-occlusion";
import { buildQABlock } from "../types/qa-block";
import { buildCardAuthorForm, type AuthoredCard } from "../review/card-author";
import { getGroupOrders } from "../scheduler";
import { encodePairs } from "../generators/pairs";
import { parseMarkdownTable, tableRowsToPairs, defaultRoles, type ColumnRole } from "../generators/table";

// Toast that, when clicked, opens the card it announces.
function notifyCardSaved(plugin: IrisCardsPlugin, file: TFile, message = "You'll be quizzed on this."): void {
  const notice = new Notice(message);
  notice.noticeEl.addClass("iris-notice-clickable");
  notice.noticeEl.addEventListener("click", () => {
    void plugin.app.workspace.getLeaf(false).openFile(file);
    notice.hide();
  });
}

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

/**
 * Asks what a bulk capture's group should be called — the name carries the
 * meaning, so it comes from the user, never inferred. Autocompletes from
 * existing group names so new facts can join a group. Resolves to null
 * (capture ungrouped) on "Don't group", empty input, or Esc.
 */
class GroupNameModal extends Modal {
  private done = false;

  constructor(
    app: IrisCardsPlugin["app"],
    private factCount: number,
    private existingGroups: string[],
    private onDone: (name: string | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("iris-group-name-modal");
    this.setTitle("Group these facts?");
    contentEl.createEl("p", {
      cls: "iris-group-name-desc",
      text: `${this.factCount} facts. Grouped facts are introduced one at a time — you start each next one when you're ready.`,
    });

    const input = contentEl.createEl("input", {
      type: "text",
      cls: "iris-group-name-input",
      attr: { placeholder: "Group name", list: "iris-group-name-options" },
    });
    const options = contentEl.createEl("datalist", { attr: { id: "iris-group-name-options" } });
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
    const skipBtn = buttons.createEl("button", { text: "Don't group" });
    skipBtn.addEventListener("click", () => finish(null));
    const groupBtn = buttons.createEl("button", { cls: "mod-cta", text: "Group" });
    groupBtn.addEventListener("click", () => finish(input.value.trim() || null));

    window.setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    // Esc (or clicking away) still saves the facts — just ungrouped.
    if (!this.done) {
      this.done = true;
      this.onDone(null);
    }
    this.contentEl.empty();
  }
}

function askGroupName(plugin: IrisCardsPlugin, factCount: number): Promise<string | null> {
  const existing = [...getGroupOrders(plugin.app, plugin.settings.cardsFolder.trim() || "Iris Cards").keys()].sort();
  return new Promise((resolve) => {
    new GroupNameModal(plugin.app, factCount, existing, resolve).open();
  });
}

// Detect multiple structured fact lines — each non-empty line must match the same separator.
// Checked in specificity order so "::" doesn't fall through to ":".
function parseBulkFacts(text: string): string[] | null {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return null;
  const patterns = [
    /^[^:]+::\s*.+$/,  // term :: definition
    /^[^\t]+\t.+$/,    // term<tab>definition
    /^[^:]+:\s*.+$/,   // term: definition
  ];
  if (patterns.some(p => lines.every(l => p.test(l)))) return lines;
  return null;
}

// Detect a hand-authored "Q: ... A: ..." selection. Tolerant of multi-line Q
// (e.g. MC option lists), leading whitespace, and `Q :` spacing.
function parseQAShortcut(text: string): { question: string; answer: string } | null {
  const m = text.match(/^\s*Q\s*:\s*([\s\S]*?)\n\s*A\s*:\s*([\s\S]+?)\s*$/);
  if (!m) return null;
  const question = m[1].trim();
  const answer = m[2].trim();
  if (!question || !answer) return null;
  return { question, answer };
}

export async function makeFlashcard(
  plugin: IrisCardsPlugin,
  editor: Editor,
  ctx: MarkdownView | MarkdownFileInfo,
): Promise<void> {
  const sourceFile = ctx.file;
  const srcFm = sourceFile ? plugin.app.metadataCache.getFileCache(sourceFile)?.frontmatter : undefined;
  const source = sourceFile ? {
    file: sourceFile,
    module: srcFm?.["module"] ?? undefined,
    date: srcFm?.["date"] ?? undefined,
  } : undefined;

  // Image embed selected (or sitting under the cursor) → open the occlusion
  // editor instead of making a text card. Checked before the empty-selection
  // guard because clicking an image in Live Preview leaves getSelection() empty.
  const imageFile = findImageInSelection(plugin, editor, sourceFile);
  if (imageFile) {
    await openOcclusionEditorForImage(plugin, imageFile, source);
    return;
  }

  // Nothing selected → make a flashcard from scratch: open the authoring
  // modal instead. (The modal attaches to the active note the same way, so
  // parent-note/module wiring is identical.)
  const rawSelection = editor.getSelection().trim();
  if (!rawSelection) {
    createCardManually(plugin);
    return;
  }

  const selection = stripMarkdown(rawSelection);
  const cardsFolder = plugin.settings.cardsFolder.trim() || "Iris Cards";

  const apiKey = plugin.settings.anthropicApiKey;
  const contextLine = sourceFile ? buildContextLine(plugin, sourceFile, editor) : "";

  // A Markdown table → one double-sided card per row. Parsed from the raw
  // selection: cells keep their own markdown, and stripMarkdown would mangle
  // escaped pipes.
  const table = parseMarkdownTable(rawSelection);
  if (table) {
    await createTableCards(plugin, table, contextLine, source);
    return;
  }
  const cardBody = contextLine ? `${contextLine}\n\n${selection}` : selection;

  // Fast path: selection is already a Q:/A: pair — store it verbatim, no LLM.
  // Eligible: Q&A is set so pregeneration sees the single Q&A variant as full
  // coverage and won't re-classify or generate alternates.
  const shortcut = parseQAShortcut(selection);
  if (shortcut) {
    const newFile = await plugin.cardStore.createCard(cardsFolder, cardBody, source);
    const variant = {
      exerciseType: "Q&A" as const,
      question: shortcut.question,
      answer: shortcut.answer,
      acceptedAnswers: [],
      knownIncorrect: [],
      lastReviewed: null,
      suspended: false,
      recordMs: null,
      difficulty: null,
    };
    await plugin.app.vault.process(newFile, (content) => content + buildQABlock([variant], ["Q&A"]));
    plugin.qaCache.delete(newFile.path);

    const ref = plugin.app.metadataCache.on("resolved", () => {
      plugin.app.metadataCache.offref(ref);
      plugin.updateBadge();
    });
    notifyCardSaved(plugin, newFile);
    return;
  }

  // Bulk facts: multiple "term: definition" lines → one card per line. The
  // user names the group (or declines). In a group, only the first fact
  // starts reviewable; the rest wait to be started one at a time, so
  // confusable facts aren't learned simultaneously. Naming an existing group
  // appends to it (new facts queue behind its current members).
  const facts = parseBulkFacts(selection);
  if (facts) {
    const groupName = await askGroupName(plugin, facts.length);
    const priorOrders = groupName ? getGroupOrders(plugin.app, cardsFolder) : null;
    const startOrder = priorOrders?.get(groupName!) ?? 0;
    let order = startOrder;
    for (const fact of facts) {
      order++;
      const factBody = contextLine ? `${contextLine}\n\n${fact}` : fact;
      const group = groupName ? { name: groupName, order, waiting: order > 1 } : undefined;
      const factFile = await plugin.cardStore.createCard(cardsFolder, factBody, source, group);
      // Waiting facts get their variants generated when they're started
      // (pregenerateAll covers newly due cards) — no API spend up front.
      const reviewableNow = !group || !group.waiting;
      if (reviewableNow && (apiKey || (plugin.app as any).irisRelay)) plugin.pregen.pregenerateQA(factFile, apiKey);
    }
    const ref = plugin.app.metadataCache.on("resolved", () => {
      plugin.app.metadataCache.offref(ref);
      plugin.updateBadge();
    });
    new Notice(groupName
      ? `You'll be quizzed on these ${facts.length} facts, one at a time — "${groupName}".`
      : `You'll be quizzed on these ${facts.length} facts.`);
    return;
  }

  const newFile = await plugin.cardStore.createCard(cardsFolder, cardBody, source);

  if (apiKey || (plugin.app as any).irisRelay) plugin.pregen.pregenerateQA(newFile, apiKey);

  const ref = plugin.app.metadataCache.on("resolved", () => {
    plugin.app.metadataCache.offref(ref);
    plugin.updateBadge();
  });
  notifyCardSaved(plugin, newFile);
}

// ─── Tables ─────────────────────────────────────────────────────────

type ParsedTableT = NonNullable<ReturnType<typeof parseMarkdownTable>>;

const ROLE_LABELS: Record<ColumnRole, string> = {
  prompt: "Prompt or answer",
  answer: "Answer only",
  omit: "Leave out",
};

/**
 * Set up a table capture: each column's role (defaulting to the inferred
 * one — unique columns prompt, repeating ones are answer-only) and an
 * optional group name. Resolves to null on Cancel or Esc: nothing is made.
 */
class TableCardsModal extends Modal {
  private done = false;
  private roles: ColumnRole[];

  constructor(
    app: IrisCardsPlugin["app"],
    private table: ParsedTableT,
    private existingGroups: string[],
    private onDone: (result: { roles: ColumnRole[]; groupName: string | null } | null) => void,
  ) {
    super(app);
    this.roles = defaultRoles(table);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("iris-table-cards-modal");
    this.setTitle("Make cards from table");
    contentEl.createEl("p", {
      cls: "iris-group-name-desc",
      text: "One card per row. Each review shows a prompt column and asks for another column. "
        + "Answer-only columns are asked for but never shown. Columns whose values repeat start as answer-only.",
    });

    const status = contentEl.createEl("p", { cls: "iris-table-cards-status" });
    let createBtn: HTMLButtonElement | null = null;
    const refresh = () => {
      const perRow = tableRowsToPairs(this.table, this.roles);
      const made = perRow.filter(f => f !== null).length;
      const skipped = perRow.length - made;
      const anyPrompt = this.roles.includes("prompt");
      status.setText(!anyPrompt
        ? "Pick at least one prompt column."
        : `${made} card${made === 1 ? "" : "s"}` + (skipped > 0
          ? ` — ${skipped} row${skipped === 1 ? "" : "s"} skipped (no prompt cell, or fewer than two sides).`
          : "."));
      status.toggleClass("mod-warning", !anyPrompt || made === 0);
      if (createBtn) {
        createBtn.disabled = made === 0;
        createBtn.setText(made === 0 ? "Create cards" : `Create ${made} card${made === 1 ? "" : "s"}`);
      }
    };

    this.table.columns.forEach((col, i) => {
      const values = this.table.rows.map(r => r[i]).filter(v => v !== "");
      const sample = [...new Set(values)].slice(0, 3).join(", ");
      const setting = new Setting(contentEl)
        .setName(col.header)
        .setDesc(`${sample}${new Set(values).size > 3 ? ", …" : ""}`
          + (col.identifying ? "" : " — values repeat"));
      setting.addDropdown(dd => {
        for (const role of ["prompt", "answer", "omit"] as ColumnRole[]) dd.addOption(role, ROLE_LABELS[role]);
        dd.setValue(this.roles[i]);
        dd.onChange(v => { this.roles[i] = v as ColumnRole; refresh(); });
      });
    });

    const groupInput = contentEl.createEl("input", {
      type: "text",
      cls: "iris-group-name-input",
      attr: { placeholder: "Group name (optional — rows are then introduced one at a time)", list: "iris-table-group-options" },
    });
    const options = contentEl.createEl("datalist", { attr: { id: "iris-table-group-options" } });
    for (const name of this.existingGroups) options.createEl("option", { attr: { value: name } });

    const finish = (create: boolean) => {
      if (this.done) return;
      if (create && createBtn?.disabled) return;
      this.done = true;
      this.onDone(create ? { roles: [...this.roles], groupName: groupInput.value.trim() || null } : null);
      this.close();
    };
    groupInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
    });

    const buttons = contentEl.createDiv({ cls: "iris-group-name-buttons" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => finish(false));
    createBtn = buttons.createEl("button", { cls: "mod-cta" });
    createBtn.addEventListener("click", () => finish(true));
    refresh();
  }

  onClose(): void {
    if (!this.done) {
      this.done = true;
      this.onDone(null);
    }
    this.contentEl.empty();
  }
}

/**
 * One Double-sided card per table row, sides named by column header, with
 * each column's role chosen in TableCardsModal. No LLM: the table is already
 * the structure, so Eligible is locked to Pairs.
 */
async function createTableCards(
  plugin: IrisCardsPlugin,
  table: ParsedTableT,
  contextLine: string,
  source?: { file: TFile; module?: string; date?: string },
): Promise<void> {
  const cardsFolder = plugin.settings.cardsFolder.trim() || "Iris Cards";
  const groupOrders = getGroupOrders(plugin.app, cardsFolder);
  const choice = await new Promise<{ roles: ColumnRole[]; groupName: string | null } | null>((resolve) => {
    new TableCardsModal(plugin.app, table, [...groupOrders.keys()].sort(), resolve).open();
  });
  if (!choice) return;
  const { roles, groupName } = choice;

  const cards = tableRowsToPairs(table, roles).filter((f): f is NonNullable<typeof f> => f !== null);
  if (cards.length === 0) return;

  let order = groupName ? (groupOrders.get(groupName) ?? 0) : 0;
  for (const fields of cards) {
    order++;
    const factText = fields.map(f => `${f.name}: ${f.content}`).join("\n");
    const body = contextLine ? `${contextLine}\n\n${factText}` : factText;
    const group = groupName ? { name: groupName, order, waiting: order > 1 } : undefined;
    const file = await plugin.cardStore.createCard(cardsFolder, body, source, group);
    const e = encodePairs(fields);
    const variant = {
      exerciseType: "Pairs" as const,
      question: e.question,
      answer: e.answer,
      acceptedAnswers: [], knownIncorrect: [],
      lastReviewed: null, suspended: false, recordMs: null, difficulty: null,
    };
    await plugin.app.vault.process(file, (content) => content + buildQABlock([variant], ["Pairs"]));
    plugin.qaCache.delete(file.path);
  }

  const ref = plugin.app.metadataCache.on("resolved", () => {
    plugin.app.metadataCache.offref(ref);
    plugin.updateBadge();
  });
  new Notice(`Made ${cards.length} card${cards.length === 1 ? "" : "s"}${groupName ? ` in "${groupName}"` : ""}.`);
}

// ─── Image Occlusion ────────────────────────────────────────────────

function findImageInSelection(plugin: IrisCardsPlugin, editor: Editor, ctxFile: TFile | null): TFile | null {
  // Prefer the selection; fall back to the cursor's line, since clicking an
  // image embed in Live Preview selects the widget without selecting any text.
  const sel = editor.getSelection().trim();
  const candidate = sel || editor.getLine(editor.getCursor().line).trim();
  const path = extractImagePath(candidate);
  if (!path) return null;
  return plugin.app.metadataCache.getFirstLinkpathDest(path, ctxFile?.path ?? "");
}

async function openOcclusionEditorForImage(
  plugin: IrisCardsPlugin,
  imageFile: TFile,
  source?: { file: TFile; module?: string; date?: string },
): Promise<void> {
  const onSave = async (regions: OcclusionRegion[]) => {
    const cardsFolder = plugin.settings.cardsFolder.trim() || "Iris Cards";
    const { question, answer } = encodeImageOcclusion(`![[${imageFile.path}]]`, regions);
    const variant = {
      exerciseType: "Image Occlusion" as const,
      question, answer,
      acceptedAnswers: [], knownIncorrect: [],
      lastReviewed: null, suspended: false, recordMs: null, difficulty: null,
    };
    const body = `![[${imageFile.path}]]`;
    const newFile = await plugin.cardStore.createCard(cardsFolder, body, source);
    await plugin.app.vault.process(newFile, (content) => content + buildQABlock([variant]));
    plugin.qaCache.delete(newFile.path);

    const ref = plugin.app.metadataCache.on("resolved", () => {
      plugin.app.metadataCache.offref(ref);
      plugin.updateBadge();
    });
    new Notice(`Image occlusion card created (${regions.length} regions).`);
  };

  new ImageOcclusionEditor(plugin.app, plugin, imageFile, [], onSave).open();
}

export async function createImageOcclusionCard(plugin: IrisCardsPlugin): Promise<void> {
  // 1) Active file is an image → use it directly
  const activeFile = plugin.app.workspace.getActiveFile();
  if (activeFile && IMAGE_EXTS.has(activeFile.extension.toLowerCase())) {
    return openOcclusionEditorForImage(plugin, activeFile);
  }

  // 2) Markdown editor with an image embed selected → use that
  const mdView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (mdView) {
    const found = findImageInSelection(plugin, mdView.editor, mdView.file);
    if (found) {
      const srcFm = mdView.file ? plugin.app.metadataCache.getFileCache(mdView.file)?.frontmatter : undefined;
      return openOcclusionEditorForImage(plugin, found, mdView.file ? {
        file: mdView.file,
        module: srcFm?.["module"] ?? undefined,
        date: srcFm?.["date"] ?? undefined,
      } : undefined);
    }
  }

  // 3) Fall back to file picker
  new ImageSuggestModal(plugin.app, (file) => {
    void openOcclusionEditorForImage(plugin, file);
  }).open();
}

// ─── Manual card (no AI) ────────────────────────────────────────────

/**
 * Write a hand-authored card straight to disk — no LLM, no pregeneration.
 * Eligible is locked to the authored type so pregen sees the card as fully
 * covered and never reaches for the API to add alternate exercise types.
 */
async function createManualCard(
  plugin: IrisCardsPlugin,
  authored: AuthoredCard,
): Promise<void> {
  const cardsFolder = plugin.settings.cardsFolder.trim() || "Iris Cards";

  // Attach to the active note (if any) so the card inherits parent-note,
  // module, and displayTitle — same wiring as makeFlashcard. Skip when the
  // active file is itself a card, so we don't make a card a child of a card.
  const activeFile = plugin.app.workspace.getActiveFile();
  const inCardsFolder = activeFile ? activeFile.path.startsWith(cardsFolder + "/") : false;
  const srcFm = activeFile && !inCardsFolder
    ? plugin.app.metadataCache.getFileCache(activeFile)?.frontmatter
    : undefined;
  const source = activeFile && !inCardsFolder ? {
    file: activeFile,
    module: srcFm?.["module"] ?? undefined,
    date: srcFm?.["date"] ?? undefined,
  } : undefined;

  const newFile = await plugin.cardStore.createCard(cardsFolder, authored.factText, source);
  await plugin.app.vault.process(newFile, (content) => content + buildQABlock([authored.variant], [authored.variant.exerciseType]));
  plugin.qaCache.delete(newFile.path);

  const ref = plugin.app.metadataCache.on("resolved", () => {
    plugin.app.metadataCache.offref(ref);
    plugin.updateBadge();
  });
  new Notice("Card created.");
}

class ManualCardModal extends Modal {
  constructor(private plugin: IrisCardsPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("iris-manual-card-modal");
    this.setTitle("Create card");
    this.buildForm();
  }

  /**
   * (Re)build a fresh form. After each save the modal stays open with cleared
   * fields so cards can be made back-to-back; Esc closes when done.
   */
  private buildForm(): void {
    const host = this.contentEl.createDiv();
    buildCardAuthorForm(host, {
      app: this.plugin.app,
      plugin: this.plugin,
      saveLabel: "Create card",
      initialTypeId: this.plugin.settings.authorLastType,
      onTypeChange: (id) => void this.plugin.updateSetting("authorLastType", id),
      onSave: async (authored) => {
        await createManualCard(this.plugin, authored);
        host.remove();
        this.buildForm();
      },
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function createCardManually(plugin: IrisCardsPlugin): void {
  new ManualCardModal(plugin).open();
}
