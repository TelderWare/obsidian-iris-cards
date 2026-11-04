import { Editor, Keymap, MarkdownView, MarkdownFileInfo, Modal, TFile, Notice } from "obsidian";
import { stripMarkdown } from "./utils";
import type IrisCardsPlugin from "../main";
import { ImageOcclusionEditor } from "../widgets/image-occlusion-editor";
import { ImageSuggestModal, IMAGE_EXTS } from "../widgets/image-suggest";
import { encodeImageOcclusion, extractImagePath, type OcclusionRegion } from "../types/image-occlusion";
import { buildQABlock, parseQABlock } from "../types/qa-block";
import { buildCardAuthorForm, type AuthoredCard } from "../review/card-author";
import { getGroupOrders, getParentNoteName } from "../scheduler";

/** How many card links a toast lists before summarising the rest. */
const NOTICE_MAX_LINKS = 5;

/**
 * Toast about captured cards, with a link to each card file. Card files are
 * named by timestamp, so each link reads as the start of the card's own text.
 */
function notifyCards(plugin: IrisCardsPlugin, message: string, cards: { file: TFile; text: string }[]): void {
  const notice = new Notice(message, 8000);
  for (const card of cards.slice(0, NOTICE_MAX_LINKS)) {
    const label = card.text.split("\n").map(l => l.trim()).find(Boolean) ?? card.file.basename;
    const link = notice.messageEl.createEl("a", {
      cls: "iris-notice-link",
      text: label.length > 60 ? label.slice(0, 59).trimEnd() + "…" : label,
      href: card.file.path,
    });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void plugin.app.workspace.getLeaf(Keymap.isModEvent(e)).openFile(card.file);
      notice.hide();
    });
  }
  if (cards.length > NOTICE_MAX_LINKS) {
    notice.messageEl.createDiv({ cls: "iris-notice-more", text: `and ${cards.length - NOTICE_MAX_LINKS} more` });
  }
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
      text: `${this.factCount} ${this.factCount === 1 ? "fact" : "facts"}. Grouped facts are introduced one at a time — you start each next one when you're ready.`,
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

/** What makes two captures the same fact: their text, ignoring the context
 * breadcrumb, letter case and spacing. */
function factKey(body: string): string {
  return body
    .split("\n")
    .filter(l => !/^\s*\(Context:/i.test(l))
    .join(" ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * The cards already captured from `sourceFile`, by fact. Limited to that note:
 * the same words in another note can mean something else there, whereas the
 * same words twice from one note are a repeated capture.
 *
 * A card whose metadata hasn't been indexed yet is still read, so one captured
 * moments ago counts.
 */
async function capturedFacts(plugin: IrisCardsPlugin, cardsFolder: string, sourceFile: TFile | null): Promise<Map<string, TFile>> {
  const facts = new Map<string, TFile>();
  const prefix = cardsFolder + "/";
  const reads = plugin.app.vault.getMarkdownFiles()
    .filter(f => f.path.startsWith(prefix))
    .filter(f => {
      const fm = plugin.app.metadataCache.getFileCache(f)?.frontmatter;
      return !fm || getParentNoteName(fm) === sourceFile?.basename;
    })
    .map(async (f) => {
      try {
        const key = factKey(parseQABlock(await plugin.app.vault.cachedRead(f)).body);
        if (key) facts.set(key, f);
      } catch { /* an unreadable card can't be matched */ }
    });
  await Promise.all(reads);
  return facts;
}

/** Each capture finishes before the next starts, so a repeated press sees the
 * card the press before it made. */
let captureQueue: Promise<void> = Promise.resolve();

export function makeFlashcard(
  plugin: IrisCardsPlugin,
  editor: Editor,
  ctx: MarkdownView | MarkdownFileInfo,
): Promise<void> {
  // The editor is read now: by the queue's turn the selection may have moved.
  const capture = prepareCapture(plugin, editor, ctx);
  const run = captureQueue.then(capture);
  captureQueue = run.catch(() => {});
  return run;
}

const ALREADY_CAPTURED = "Already a card, so not saved again.";

function prepareCapture(
  plugin: IrisCardsPlugin,
  editor: Editor,
  ctx: MarkdownView | MarkdownFileInfo,
): () => Promise<void> {
  const sourceFile = ctx.file;
  const srcFm = sourceFile ? plugin.app.metadataCache.getFileCache(sourceFile)?.frontmatter : undefined;
  const source = sourceFile ? {
    file: sourceFile,
    module: srcFm?.["module"] ?? undefined,
    date: srcFm?.["date"] ?? undefined,
  } : undefined;

  // Image embed selected (or sitting under the cursor) → capture it as a fact,
  // like any other selection; its card gets written when the fact comes due.
  // Checked before the empty-selection guard because clicking an image in Live
  // Preview leaves getSelection() empty.
  const cardsFolder = plugin.settings.cardsFolder.trim() || "Iris Cards";
  const contextLine = sourceFile ? buildContextLine(plugin, sourceFile, editor) : "";

  const imageFile = findImageInSelection(plugin, editor, sourceFile);
  if (imageFile) {
    return async () => {
      const embed = `![[${imageFile.path}]]`;
      const existing = (await capturedFacts(plugin, cardsFolder, sourceFile)).get(factKey(embed));
      if (existing) {
        notifyCards(plugin, ALREADY_CAPTURED, [{ file: existing, text: imageFile.basename }]);
        return;
      }
      const newFile = await plugin.cardStore.createCard(cardsFolder, contextLine ? `${contextLine}\n\n${embed}` : embed, source);
      const ref = plugin.app.metadataCache.on("resolved", () => {
        plugin.app.metadataCache.offref(ref);
        plugin.updateBadge();
      });
      notifyCards(plugin, "Card saved.", [{ file: newFile, text: imageFile.basename }]);
    };
  }

  // Nothing selected → make a flashcard from scratch: open the authoring
  // modal instead. (The modal attaches to the active note the same way, so
  // parent-note/module wiring is identical.)
  const rawSelection = editor.getSelection().trim();
  if (!rawSelection) {
    return async () => createCardManually(plugin);
  }

  const selection = stripMarkdown(rawSelection);
  return () => captureSelection(plugin, selection, contextLine, cardsFolder, sourceFile, source);
}

async function captureSelection(
  plugin: IrisCardsPlugin,
  selection: string,
  contextLine: string,
  cardsFolder: string,
  sourceFile: TFile | null,
  source: { file: TFile; module?: string; date?: string } | undefined,
): Promise<void> {
  const apiKey = plugin.settings.anthropicApiKey;
  const cardBody = contextLine ? `${contextLine}\n\n${selection}` : selection;
  const captured = await capturedFacts(plugin, cardsFolder, sourceFile);

  const existing = captured.get(factKey(selection));
  if (existing) {
    notifyCards(plugin, ALREADY_CAPTURED, [{ file: existing, text: selection }]);
    return;
  }

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
    notifyCards(plugin, "Card saved.", [{ file: newFile, text: shortcut.question }]);
    return;
  }

  // Bulk facts: multiple "term: definition" lines → one card per line. The
  // user names the group (or declines). In a group, only the first fact
  // starts reviewable; the rest wait to be started one at a time, so
  // confusable facts aren't learned simultaneously. Naming an existing group
  // appends to it (new facts queue behind its current members).
  const lines = parseBulkFacts(selection);
  if (lines) {
    // Only the new lines become cards, so re-capturing a list that has grown
    // adds just what's new.
    const seen = new Set<string>();
    const facts: string[] = [];
    const repeats: { file: TFile; text: string }[] = [];
    for (const line of lines) {
      const key = factKey(line);
      const found = captured.get(key);
      if (found) repeats.push({ file: found, text: line });
      else if (!seen.has(key)) facts.push(line);
      seen.add(key);
    }
    if (facts.length === 0) {
      notifyCards(plugin, "All of these are already cards, so none were saved again.", repeats);
      return;
    }
    const groupName = await askGroupName(plugin, facts.length);
    const priorOrders = groupName ? getGroupOrders(plugin.app, cardsFolder) : null;
    const startOrder = priorOrders?.get(groupName!) ?? 0;
    let order = startOrder;
    const saved: { file: TFile; text: string }[] = [];
    for (const fact of facts) {
      order++;
      const factBody = contextLine ? `${contextLine}\n\n${fact}` : fact;
      const group = groupName ? { name: groupName, order, waiting: order > 1 } : undefined;
      const factFile = await plugin.cardStore.createCard(cardsFolder, factBody, source, group);
      saved.push({ file: factFile, text: fact });
      // Waiting facts get their variants generated when they're started
      // (pregenerateAll covers newly due cards) — no API spend up front.
      const reviewableNow = !group || !group.waiting;
      if (reviewableNow && (apiKey || (plugin.app as any).irisRelay)) plugin.pregen.pregenerateQA(factFile, apiKey);
    }
    const ref = plugin.app.metadataCache.on("resolved", () => {
      plugin.app.metadataCache.offref(ref);
      plugin.updateBadge();
    });
    const count = `${facts.length} card${facts.length === 1 ? "" : "s"}`;
    const skipped = repeats.length > 0 ? ` ${repeats.length} already existed.` : "";
    notifyCards(plugin, (groupName
      ? `${count} saved to "${groupName}", introduced one at a time.`
      : `${count} saved.`) + skipped, saved);
    return;
  }

  const newFile = await plugin.cardStore.createCard(cardsFolder, cardBody, source);

  if (apiKey || (plugin.app as any).irisRelay) plugin.pregen.pregenerateQA(newFile, apiKey);

  const ref = plugin.app.metadataCache.on("resolved", () => {
    plugin.app.metadataCache.offref(ref);
    plugin.updateBadge();
  });
  notifyCards(plugin, "Card saved.", [{ file: newFile, text: selection }]);
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
    notifyCards(plugin, `Image occlusion card saved (${regions.length} regions).`, [{ file: newFile, text: imageFile.basename }]);
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
  notifyCards(plugin, "Card saved.", [{ file: newFile, text: authored.factText }]);
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
