import {
  Plugin,
  Editor,
  MarkdownView,
  MarkdownFileInfo,
  TFile,
  TFolder,
  Notice,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";
import { IrisCardsSettingTab, DEFAULT_SETTINGS } from "./settings";
import type { IrisCardsSettings } from "./settings";
import { ReviewView, VIEW_TYPE_REVIEW } from "./review-view";
import { countDueFromCache, getDueCards } from "./leitner";
import { CardStore } from "./card-store";
import { generateQA, generateVariant, generateCloze, generateMultipleChoice, encodeMC, generateSolveEquation, encodeSolveEquation, generateOrderSteps, encodeOrderSteps, generateCorrectMistake, generateExplainWhy, generateTrueFalse, generateAssembleEquation, encodeAssembleEquation, classifyEligibility, standardizeQuestion, parseQABlock, extractFactsFromNote, TYPE_PRIORITY, type QAVariant, type ExerciseType, setRelayApp, setRelayPriority } from "./claude";

function encryptSecret(key: string): string {
  if (!key) return "";
  try {
    const { safeStorage } = require("electron");
    if (safeStorage.isEncryptionAvailable()) {
      return "enc:" + safeStorage.encryptString(key).toString("base64");
    }
  } catch { /* safeStorage unavailable */ }
  return key;
}

function decryptSecret(stored: string): string {
  if (!stored) return "";
  if (stored.startsWith("enc:")) {
    try {
      const { safeStorage } = require("electron");
      return safeStorage.decryptString(Buffer.from(stored.slice(4), "base64"));
    } catch {
      return "";
    }
  }
  return stored;
}

const MINOR_WORDS = new Set([
  "a", "an", "the", "and", "but", "or", "nor", "for", "yet", "so",
  "in", "on", "at", "to", "by", "of", "up", "as", "is", "if",
]);

function toTitleCase(text: string): string {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((word, i) => {
      if (i === 0 || !MINOR_WORDS.has(word)) {
        return word.charAt(0).toUpperCase() + word.slice(1);
      }
      return word;
    })
    .join(" ");
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2") // [[link|display]] → display, [[link]] → link
    .replace(/\*\*(.+?)\*\*/g, "$1")   // **bold**
    .replace(/__(.+?)__/g, "$1")        // __bold__
    .replace(/\*(.+?)\*/g, "$1")        // *italic*
    .replace(/_(.+?)_/g, "$1")          // _italic_
    .replace(/~~(.+?)~~/g, "$1");       // ~~strikethrough~~
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|#^[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const HOTKEYS_PATH = ".obsidian/hotkeys.json";

export default class IrisCardsPlugin extends Plugin {
  settings: IrisCardsSettings = DEFAULT_SETTINGS;
  qaCache: Map<string, Promise<QAVariant[]>> = new Map();
  cardStore!: CardStore;
  private ribbonIconEl: HTMLElement | null = null;
  private badgeEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    setRelayApp(this.app);
    this.cardStore = new CardStore(this.app);
    await this.configureHotkeys();

    // Register review view
    this.registerView(
      VIEW_TYPE_REVIEW,
      (leaf: WorkspaceLeaf) => new ReviewView(leaf, this),
    );

    // Commands
    this.addCommand({
      id: "create-iris-cards-note",
      name: "Create note from selection",
      callback: () => this.createNoteFromSelection(),
    });

    this.addCommand({
      id: "memorize-selection",
      name: "Memorize selection",
      editorCallback: (editor, ctx) => this.memorizeSelection(editor, ctx),
    });

    this.addCommand({
      id: "open-review",
      name: "Review due cards",
      callback: () => this.activateReviewView(),
    });

    this.addCommand({
      id: "generate-quiz",
      name: "Generate quiz",
      callback: () => this.generateQuiz(),
    });

    this.addCommand({
      id: "generate-quiz-linked",
      name: "Generate quiz from linked note",
      callback: () => this.generateQuizFromLinkedNote(),
    });

    // Ribbon icon
    this.ribbonIconEl = this.addRibbonIcon("brain", "Iris Cards", () => {
      this.activateReviewView();
    });
    this.ribbonIconEl.addClass("iris-ribbon-icon");

    this.app.workspace.onLayoutReady(() => {
      this.updateBadge();
      this.pregenerateAll();
    });

    // Invalidate cached Q&A when card files change or get deleted
    const invalidateCache = (file: unknown) => { if (file instanceof TFile) this.qaCache.delete(file.path); };
    this.registerEvent(this.app.vault.on("modify", invalidateCache));
    this.registerEvent(this.app.vault.on("delete", invalidateCache));

    // Event-driven badge: update immediately when card metadata changes
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      const folder = this.settings.cardsFolder.trim() || "Iris Cards";
      if (file.path.startsWith(folder + "/")) this.updateBadge();
    }));

    // Longer fallback interval for time-based due-ness + background pregeneration
    this.registerInterval(
      window.setInterval(() => {
        this.updateBadge();
        this.pregenerateAll();
      }, 300000), // 5 minutes
    );

    this.addSettingTab(new IrisCardsSettingTab(this.app, this));
  }

  private async configureHotkeys(): Promise<void> {
    if (this.settings.hotkeysConfigured) return;
    try {
      const adapter = this.app.vault.adapter;
      let hotkeys: Record<string, unknown[]> = {};
      if (await adapter.exists(HOTKEYS_PATH)) {
        hotkeys = JSON.parse(await adapter.read(HOTKEYS_PATH));
      }

      // Check if Iris Cards bindings are already present and correct
      const hasCreateNote = Array.isArray(hotkeys["iris-cards:create-iris-cards-note"]) &&
        hotkeys["iris-cards:create-iris-cards-note"].length > 0;
      const hasMemorize = Array.isArray(hotkeys["iris-cards:memorize-selection"]) &&
        hotkeys["iris-cards:memorize-selection"].length > 0;

      if (hasCreateNote && hasMemorize) return;

      // Remove conflicting bindings from other plugins
      const irisBindings: Array<{ modifiers: string[]; key: string }> = [
        { modifiers: ["Mod"], key: "N" },
        { modifiers: ["Mod"], key: "M" },
      ];
      for (const [cmd, bindings] of Object.entries(hotkeys)) {
        if (cmd.startsWith("iris-cards:")) continue;
        if (!Array.isArray(bindings)) continue;
        hotkeys[cmd] = bindings.filter((b: any) =>
          !irisBindings.some(lb =>
            lb.key === b.key &&
            Array.isArray(b.modifiers) &&
            lb.modifiers.length === b.modifiers.length &&
            lb.modifiers.every((m: string) => b.modifiers.includes(m)),
          ),
        );
      }

      // Disable core Ctrl+N (Create new note)
      hotkeys["file-explorer:new-file"] = [];

      // Set Iris Cards hotkeys
      hotkeys["iris-cards:create-iris-cards-note"] = [{ modifiers: ["Mod"], key: "N" }];
      hotkeys["iris-cards:memorize-selection"] = [{ modifiers: ["Mod"], key: "M" }];

      await adapter.write(HOTKEYS_PATH, JSON.stringify(hotkeys, null, 2));
      this.settings.hotkeysConfigured = true;
      await this.saveSettings();
    } catch {
      // Non-fatal: hotkeys can be configured manually
    }
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_REVIEW);
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.settings.desiredRetention = Math.max(0.70, Math.min(0.97, this.settings.desiredRetention));
    if (this.settings.anthropicApiKey) {
      this.settings.anthropicApiKey = decryptSecret(this.settings.anthropicApiKey);
    }
  }

  async saveSettings(): Promise<void> {
    const toSave = { ...this.settings };
    if (toSave.anthropicApiKey && !toSave.anthropicApiKey.startsWith("enc:")) {
      toSave.anthropicApiKey = encryptSecret(toSave.anthropicApiKey);
    }
    await this.saveData(toSave);
  }

  async updateSetting<K extends keyof IrisCardsSettings>(key: K, value: IrisCardsSettings[K]): Promise<void> {
    this.settings[key] = value;
    await this.saveSettings();
  }

  updateBadge(): void {
    if (!this.ribbonIconEl) return;
    const pos = this.settings.badgePosition;
    const count = countDueFromCache(this.app, this.settings.cardsFolder, 0, this.settings.desiredRetention);
    if (pos !== "off" && count > 0) {
      if (!this.badgeEl) {
        this.badgeEl = this.ribbonIconEl.createSpan({ cls: "iris-badge" });
      }
      this.badgeEl.className = `iris-badge iris-badge-${pos}`;
      this.badgeEl.setText(count > 99 ? "99+" : String(count));
      this.badgeEl.style.display = "";
    } else if (this.badgeEl) {
      this.badgeEl.style.display = "none";
    }
  }

  private async activateReviewView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_REVIEW, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  // ─── Q&A Pregeneration ─────────────────────────────────────

  private pregenQueue: { card: TFile; priority: number }[] = [];
  private pregenQueued = new Set<string>();
  private pregenRunning = 0;
  private readonly PREGEN_CONCURRENCY = 3;

  private enqueuePregen(card: TFile, priority: number): void {
    if (this.qaCache.has(card.path)) return;
    if (this.pregenQueued.has(card.path)) {
      // Already queued — bump priority if higher
      const existing = this.pregenQueue.findIndex(e => e.card.path === card.path);
      if (existing === -1 || this.pregenQueue[existing].priority >= priority) return;
      this.pregenQueue.splice(existing, 1);
    }
    this.pregenQueued.add(card.path);
    // Higher priority items first; same priority preserves FIFO order
    const idx = this.pregenQueue.findIndex(e => e.priority < priority);
    if (idx === -1) {
      this.pregenQueue.push({ card, priority });
    } else {
      this.pregenQueue.splice(idx, 0, { card, priority });
    }
  }

  async pregenerateAll(): Promise<void> {
    const apiKey = this.settings.anthropicApiKey;
    if (!apiKey) return;
    const cards = await getDueCards(this.app, this.settings.cardsFolder, 0, undefined, this.settings.desiredRetention);
    for (const card of cards) {
      this.enqueuePregen(card, 0); // background: low priority
    }
    this.drainPregenQueue(apiKey);
  }

  /** Map local pregeneration priority (0=background, 1=normal, 2=user-triggered)
   *  to relay priority (0-10 scale, lower = processed first). */
  private static toRelayPriority(localPriority: number): number {
    if (localPriority >= 2) return 1;  // user is actively reviewing
    if (localPriority <= 0) return 8;  // background bulk
    return 5;                          // normal pregeneration
  }

  private drainPregenQueue(apiKey: string): void {
    while (this.pregenRunning < this.PREGEN_CONCURRENCY && this.pregenQueue.length > 0) {
      const { card, priority: localPriority } = this.pregenQueue.shift()!;
      this.pregenQueued.delete(card.path);
      if (this.qaCache.has(card.path)) continue;
      this.pregenRunning++;
      const promise = (async () => {
        try {
          setRelayPriority(IrisCardsPlugin.toRelayPriority(localPriority));
          const content = await this.app.vault.read(card);
          const parsed = parseQABlock(content);

          let eligible = parsed.eligibleTypes;
          let variants = [...parsed.variants];

          // Classify eligible types if not yet stored
          if (eligible.length === 0) {
            eligible = await classifyEligibility(parsed.body, apiKey, this.settings.claudeModel);
          }

          // Find the next eligible type that has no variant yet (prioritized: cheap types first)
          const coveredTypes = new Set(variants.map(v => v.exerciseType));
          const prioritized = TYPE_PRIORITY.filter(t => eligible.includes(t));
          const nextType = prioritized.find(t => !coveredTypes.has(t));

          if (nextType) {
            try {
              const newVariants = await this.generateForType(nextType, parsed.body, apiKey);
              variants.push(...newVariants);
            } catch { /* single type failure is non-fatal */ }
          }

          // Persist eligibility + any new variants
          if (nextType || parsed.eligibleTypes.length === 0) {
            await this.cardStore.updateVariants(card, (vs, el) => {
              vs.length = 0;
              vs.push(...variants);
              el.length = 0;
              el.push(...eligible);
            });
          }
          await this.cardStore.updateSuspendedFlag(card, variants);
          return variants;
        } finally {
          setRelayPriority(undefined);
          this.pregenRunning--;
          this.drainPregenQueue(apiKey);
        }
      })();
      this.qaCache.set(card.path, promise);
    }
  }

  pregenerateQA(card: TFile, apiKey: string, priority = 1): void {
    this.enqueuePregen(card, priority);
    this.drainPregenQueue(apiKey);
  }

  private async generateForType(
    type: ExerciseType,
    body: string,
    apiKey: string,
  ): Promise<QAVariant[]> {
    const model = this.settings.claudeModel;
    const make = (q: string, a: string): QAVariant => ({
      exerciseType: type,
      question: q,
      answer: a,
      acceptedAnswers: [],
      lastReviewed: null,
      suspended: false,
      recordMs: null,
      difficulty: null,
    });

    // Table-driven generation: each entry returns { q, a } pairs
    const generators: Record<string, () => Promise<QAVariant[]>> = {
      "Q&A": async () => {
        const qa = await generateQA(body, apiKey, model);
        const variants = [make(qa.question, qa.answer)];
        try {
          const alt = await generateVariant(qa.question, qa.answer, apiKey, model);
          variants.push(make(alt.question, alt.answer));
        } catch { /* alternate is optional */ }
        return variants;
      },
      "Multiple Choice": async () => { const e = encodeMC(await generateMultipleChoice(body, apiKey, model)); return [make(e.question, e.answer)]; },
      "Cloze": async () => { const s = await generateCloze(body, apiKey, model); return [make(s, s)]; },
      "Solve Equation": async () => { const e = encodeSolveEquation(await generateSolveEquation(body, apiKey, model)); return [make(e.question, e.answer)]; },
      "Order Steps": async () => { const e = encodeOrderSteps(await generateOrderSteps(body, apiKey, model)); return [make(e.question, e.answer)]; },
      "Correct the Mistake": async () => { const r = await generateCorrectMistake(body, apiKey, model); return [make(r.incorrect, r.corrected)]; },
      "Explain Why": async () => { const r = await generateExplainWhy(body, apiKey, model); return [make(r.question, r.answer)]; },
      "True/False": async () => { const r = await generateTrueFalse(body, apiKey, model); return [make(r.statement, r.answer)]; },
      "Assemble Equation": async () => { const e = encodeAssembleEquation(await generateAssembleEquation(body, apiKey, model)); return [make(e.question, e.answer)]; },
    };

    const gen = generators[type];
    if (!gen) return [];
    let variants = await gen();

    // QC pass — only for free-form Q&A types where rewriting won't destroy encoded formats
    const QC_TYPES: Set<string> = new Set(["Q&A", "Explain Why"]);
    if (QC_TYPES.has(type)) {
      const stdResults = await Promise.allSettled(
        variants.map(v => standardizeQuestion(body, v.question, v.answer, apiKey)),
      );
      for (let i = 0; i < variants.length; i++) {
        const r = stdResults[i];
        if (r.status === "fulfilled" && r.value.question && r.value.answer) {
          if (r.value.reject) {
            variants[i] = { ...variants[i], suspended: true };
          } else {
            variants[i] = { ...variants[i], question: r.value.question, answer: r.value.answer };
          }
        }
      }
    }
    return variants;
  }

  // ─── Shared Utilities ───────────────────────────────────────

  private buildContextLine(sourceFile: TFile, editor: Editor): string {
    const cache = this.app.metadataCache.getFileCache(sourceFile);
    const fm = cache?.frontmatter;
    const noteTitle = fm?.["displayTitle"] ?? fm?.["title"] ?? sourceFile.basename;

    const parts: string[] = [noteTitle];

    // Find ancestor headings at the selection position
    const headings = cache?.headings;
    if (headings && headings.length > 0) {
      const selLine = editor.getCursor("from").line;
      const ancestors: { level: number; heading: string }[] = [];
      for (const h of headings) {
        if (h.position.start.line >= selLine) break;
        // Keep only the deepest heading at each level (pop deeper ones when a shallower appears)
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

  private getStripPrefixes(): string[] {
    if (!this.settings.useAutoStripPrefixes) {
      return this.settings.stripPrefixes;
    }
    return this.app.vault
      .getRoot()
      .children.filter((child): child is TFolder => child instanceof TFolder)
      .map((folder) => folder.name);
  }

  private computeTargetPath(sourceFilePath: string, noteTitle: string): string {
    const parts = sourceFilePath.split("/");
    parts.pop();

    const stripPrefixes = this.getStripPrefixes();
    if (parts.length > 0 && stripPrefixes.includes(parts[0])) {
      parts.shift();
    }

    const targetPrefix = this.settings.targetPrefix.trim();
    if (targetPrefix) {
      parts.unshift(targetPrefix);
    }

    const fileName = sanitizeFileName(noteTitle);
    parts.push(fileName + ".md");

    return normalizePath(parts.join("/"));
  }

  // ─── Create Note from Selection ─────────────────────────────

  private async createNoteFromSelection(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const selection = view?.editor.getSelection().trim() ?? "";
    const sourceFile = view?.file ?? this.app.workspace.getActiveFile();

    if (!selection) {
      const folder = this.settings.noSelectionUseTargetPrefix
        ? this.settings.targetPrefix.trim()
        : "";
      if (folder) {
        await this.cardStore.ensureFolderExists(folder);
      }

      const baseName = "Untitled";
      let targetPath = normalizePath(folder ? `${folder}/${baseName}.md` : `${baseName}.md`);

      let counter = 1;
      while (this.app.vault.getAbstractFileByPath(targetPath)) {
        targetPath = normalizePath(
          folder ? `${folder}/${baseName} ${counter}.md` : `${baseName} ${counter}.md`,
        );
        counter++;
      }

      const newFile = await this.app.vault.create(targetPath, "");

      await this.app.fileManager.processFrontMatter(newFile, (fm) => {
        if (this.settings.noSelectionAddParentNote && sourceFile) {
          fm["parent-note"] = `[[${sourceFile.basename}]]`;
        }
        if (sourceFile) {
          const srcModule = this.app.metadataCache.getFileCache(sourceFile)?.frontmatter?.["module"];
          if (srcModule != null) fm["module"] = srcModule;
        }
      });

      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(newFile);
      return;
    }

    if (!sourceFile) {
      new Notice("Could not determine the current file.");
      return;
    }

    const noteTitle = toTitleCase(selection);
    const targetPath = this.computeTargetPath(sourceFile.path, noteTitle);

    const existingFile = this.app.vault.getAbstractFileByPath(targetPath);
    if (existingFile instanceof TFile) {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(existingFile);
      return;
    }

    const lastSlash = targetPath.lastIndexOf("/");
    if (lastSlash > 0) {
      await this.cardStore.ensureFolderExists(targetPath.substring(0, lastSlash));
    }

    const newFile = await this.app.vault.create(targetPath, "");

    await this.app.fileManager.processFrontMatter(newFile, (fm) => {
      if (this.settings.withSelectionAddParentNote) {
        fm["parent-note"] = `[[${sourceFile.basename}]]`;
      }
      const srcModule = this.app.metadataCache.getFileCache(sourceFile)?.frontmatter?.["module"];
      if (srcModule != null) fm["module"] = srcModule;
    });

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(newFile);

    new Notice(`Created: ${noteTitle}`);
  }

  // ─── Generate Quiz ─────────────────────────────────────────

  private buildContextLineForLine(sourceFile: TFile, line: number): string {
    const cache = this.app.metadataCache.getFileCache(sourceFile);
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

  private async generateQuiz(): Promise<void> {
    const apiKey = this.settings.anthropicApiKey;
    if (!apiKey) {
      new Notice("Set your Anthropic API key in Iris Cards settings.");
      return;
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) {
      new Notice("Open a note to generate a quiz from.");
      return;
    }

    await this.runQuizGeneration(view.file, view.file, apiKey);
  }

  private async generateQuizFromLinkedNote(): Promise<void> {
    const apiKey = this.settings.anthropicApiKey;
    if (!apiKey) {
      new Notice("Set your Anthropic API key in Iris Cards settings.");
      return;
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) {
      new Notice("Open a note to generate a quiz from.");
      return;
    }
    const sourceFile = view.file;

    const fieldKey = this.settings.linkedNoteField.trim();
    if (!fieldKey) {
      new Notice("Set the linked note field in Iris Cards settings.");
      return;
    }

    const fm = this.app.metadataCache.getFileCache(sourceFile)?.frontmatter;
    const raw = fm?.[fieldKey];
    if (!raw) {
      new Notice(`No "${fieldKey}" field found in frontmatter.`);
      return;
    }

    const linkPath = String(raw).replace(/^\[\[|\]\]$/g, "");
    const linkedFile = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourceFile.path);
    if (!linkedFile) {
      new Notice(`Linked note not found: ${linkPath}`);
      return;
    }

    await this.runQuizGeneration(sourceFile, linkedFile, apiKey);
  }

  private async runQuizGeneration(sourceFile: TFile, contentFile: TFile, apiKey: string): Promise<void> {
    const rawContent = await this.app.vault.read(contentFile);
    // Strip frontmatter
    const content = rawContent.replace(/^---\n[\s\S]*?\n---\n?/, "");

    new Notice("Extracting facts\u2026");
    let facts: string[];
    try {
      facts = await extractFactsFromNote(content, apiKey, this.settings.claudeModel);
    } catch (e) {
      new Notice(`Fact extraction failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    if (facts.length === 0) {
      new Notice("No facts found in this note.");
      return;
    }

    const cardsFolder = this.settings.cardsFolder.trim() || "Iris Cards";
    const srcFm = this.app.metadataCache.getFileCache(sourceFile)?.frontmatter;
    const lines = rawContent.split("\n");

    // Load existing card bodies for duplicate detection
    const existingBodies = new Set<string>();
    const folder = this.app.vault.getAbstractFileByPath(cardsFolder);
    if (folder && folder instanceof TFolder) {
      for (const child of folder.children) {
        if (child instanceof TFile && child.extension === "md") {
          const c = await this.app.vault.read(child);
          existingBodies.add(c.toLowerCase().replace(/\s+/g, " ").trim());
        }
      }
    }

    new Notice(`Found ${facts.length} facts. Creating cards\u2026`);
    let created = 0;
    let skipped = 0;

    for (const fact of facts) {
      // Duplicate check: see if any existing card already contains this fact
      const normFact = stripMarkdown(fact).toLowerCase().replace(/\s+/g, " ").trim();
      if ([...existingBodies].some(b => b.includes(normFact))) {
        skipped++;
        continue;
      }

      // Find line number of this fact in the raw content
      let factLine = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(fact.substring(0, Math.min(40, fact.length)))) {
          factLine = i;
          break;
        }
      }

      const contextLine = this.buildContextLineForLine(sourceFile, factLine);
      const selection = stripMarkdown(fact);
      const cardBody = contextLine ? `${contextLine}\n\n${selection}` : selection;

      const newFile = await this.cardStore.createCard(cardsFolder, cardBody, {
        file: sourceFile,
        module: srcFm?.["module"] ?? undefined,
        date: srcFm?.["date"] ?? undefined,
        aiSelected: true,
      });

      this.pregenerateQA(newFile, apiKey);
      created++;
    }

    const ref = this.app.metadataCache.on("resolved", () => {
      this.app.metadataCache.offref(ref);
      this.updateBadge();
    });

    const parts = [`Created ${created} cards from ${sourceFile.basename}`];
    if (skipped > 0) parts.push(`(${skipped} duplicates skipped)`);
    new Notice(parts.join(" "));
  }

  // ─── Memorize Selection ─────────────────────────────────────

  private async memorizeSelection(
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
    const cardsFolder = this.settings.cardsFolder.trim() || "Iris Cards";

    const apiKey = this.settings.anthropicApiKey;
    const contextLine = sourceFile ? this.buildContextLine(sourceFile, editor) : "";
    const cardBody = contextLine ? `${contextLine}\n\n${selection}` : selection;

    const srcFm = sourceFile ? this.app.metadataCache.getFileCache(sourceFile)?.frontmatter : undefined;
    const newFile = await this.cardStore.createCard(cardsFolder, cardBody, sourceFile ? {
      file: sourceFile,
      module: srcFm?.["module"] ?? undefined,
      date: srcFm?.["date"] ?? undefined,
    } : undefined);

    if (apiKey) this.pregenerateQA(newFile, apiKey);

    // Defer badge update until metadata cache has indexed the new file's frontmatter
    const ref = this.app.metadataCache.on("resolved", () => {
      this.app.metadataCache.offref(ref);
      this.updateBadge();
    });
    new Notice("Saved as card.");
  }
}
