import { App, Modal, Notice, TFile } from "obsidian";
import type IrisCardsPlugin from "../main";
import { type ExerciseType, type QAVariant } from "../types/exercises";
import { encodePairs, decodePairs, type PairsField } from "../generators/pairs";
import { encodeMultiStep, decodeMultiStep, type MultiStep } from "../generators/multi-step";
import { encodeTFPair, decodeTFPair } from "../generators/true-false";
import { encodeMC, decodeMC } from "../generators/multiple-choice";
import { encodeRank, decodeRank } from "../generators/rank";
import { parseClozeTerms } from "../generators/cloze";
import { llmMarkingEnabled } from "../ai";
import { encodeList, decodeList } from "../generators/list";
import { encodeMatch, decodeMatch, DEFAULT_MATCH_PROMPT, MIN_MATCH_PAIRS, type MatchPair } from "../generators/match";
import { encodeOrderSteps, decodeOrderSteps } from "../generators/order-steps";
import { encodeImageOcclusion, decodeImageOcclusion, type OcclusionRegion } from "../types/image-occlusion";
import { ImageOcclusionEditor } from "../widgets/image-occlusion-editor";
import { ImageSuggestModal } from "../widgets/image-suggest";

/**
 * The hand-authored card-writing form ("vanilla cards interface"). One shared
 * builder serves three entry points:
 *
 *   - the review flow, when a captured fact comes due with no variants yet
 *     (AI features off) — you write the card for the fact on the spot;
 *   - the "Create card" command, for authoring a card from scratch;
 *   - CardEditModal, for editing an existing variant pre-filled.
 *
 * Designed so nothing but the card needs attention:
 *   - Enter moves to the next field; when everything after the cursor is
 *     empty and the card is complete, Enter saves. Shift+Enter makes a
 *     newline; Ctrl/Cmd+Enter saves from anywhere. List-entry fields
 *     (Property series items) keep Enter as newline.
 *   - Switching type never loses work — each type's fields persist behind the
 *     picker for the life of the form.
 *   - Textareas grow with their content; list-like types (Pairs, Multi-step)
 *     grow a fresh row as soon as the last one is touched — no add buttons.
 *   - Pasting an image into any field saves it to the vault's attachment
 *     folder and inserts the embed link.
 *   - Image Occlusion has no text fields: it picks a vault image and hands off
 *     to the occlusion editor, which returns regions the form then saves as a
 *     normal card (rather than writing the card itself, as the command does).
 *   - In the Cloze type, the sentence's words render as clickable text below
 *     the box; clicking a word hides it (adjacent hidden words merge into one
 *     gap).
 */

export interface AuthoredCard {
  variant: QAVariant;
  /** Plain-text summary of the fact, used as file body for from-scratch cards. */
  factText: string;
}

function mkVariant(type: ExerciseType, question: string, answer: string): QAVariant {
  return {
    exerciseType: type,
    question,
    answer,
    acceptedAnswers: [],
    knownIncorrect: [],
    lastReviewed: null,
    suspended: false,
    recordMs: null,
    difficulty: null,
  };
}

/** Returns the authored card, or an error message to show the user. */
type Collect = () => AuthoredCard | string;

/**
 * Synonym cards store a plain question/answer, so the authored phrasing is what
 * lets the form recover the term when editing. Generated synonym cards are
 * phrased freely and simply aren't editable here — same as before.
 */
const SYNONYM_Q_RE = /^what is another name for (.+)\?$/i;
const synonymQuestion = (term: string) => `What is another name for ${term}?`;

/** Split a one-per-line list field into trimmed, non-empty entries. */
function lines(value: string): string[] {
  return value.split("\n").map(l => l.trim()).filter(Boolean);
}

/** What a type's fields may reach for beyond the DOM — the vault (image picker,
 * thumbnails) and the plugin (occlusion editor, marking-availability hints). */
interface AuthorCtx {
  app: App;
  plugin: IrisCardsPlugin;
  /**
   * The captured fact's own sentence, when authoring a card for one. Types
   * whose card *is* that sentence (Cloze) start from it instead of asking the
   * author to retype what's already on screen. Absent when creating a card
   * from scratch or editing an existing variant.
   */
  seedText?: string;
}

interface AuthorTypeDef {
  id: string;
  label: string;
  /** Left out of the type picker except when editing a variant of this type. */
  editOnly?: boolean;
  /** Render the type's fields; when `initial` is given, pre-fill from it. */
  build(fields: HTMLElement, initial: QAVariant | undefined, ctx: AuthorCtx): Collect;
}

/**
 * The author-form type id a variant can be edited as, or null when the form
 * has no editor for it (List, Solve Equation, Image Occlusion, legacy
 * single-statement True/False, …).
 */
export function editableTypeId(variant: QAVariant): string | null {
  try {
    switch (variant.exerciseType) {
      case "Q&A": return "qa";
      case "Cloze": return "cloze";
      case "Pairs": decodePairs(variant.question); return "pairs";
      case "True/False": return decodeTFPair(variant.question) ? "tf" : null;
      case "Multiple Choice": return decodeMC(variant.question, variant.answer).options.length >= 2 ? "mc" : null;
      case "Rank": decodeRank(variant.question, variant.answer); return "order";
      case "Multi-step": decodeMultiStep(variant.question); return "multistep";
      case "Match": decodeMatch(variant.question); return "match";
      case "List": decodeList(variant.question, variant.answer); return "list";
      case "Place in Order": decodeOrderSteps(variant.question, variant.answer); return "order";
      case "Correct the Mistake": return "mistake";
      case "Synonym": return SYNONYM_Q_RE.test(variant.question) ? "synonym" : null;
      case "Image Occlusion": decodeImageOcclusion(variant.question, variant.answer); return "occlusion";
      default: return null;
    }
  } catch {
    return null;
  }
}

/**
 * An existing variant as readable text — the fact text the form would write
 * for it — or null when the form can't read its type. Decodes by filling the
 * type's own fields off-screen and collecting them, so every type the form
 * can edit reads back exactly as it would have been written.
 */
export function variantFactText(app: App, plugin: IrisCardsPlugin, variant: QAVariant): string | null {
  const id = editableTypeId(variant);
  const def = id ? TYPE_DEFS.find(d => d.id === id) : undefined;
  if (!def) return null;
  try {
    const result = def.build(createDiv(), variant, { app, plugin })();
    return typeof result === "string" ? null : result.factText.trim() || null;
  } catch {
    return null;
  }
}

// ─── Small form helpers ─────────────────────────────────────────────────

function autoGrow(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

/**
 * Fields carry their own name in the placeholder rather than a bold label
 * above the box. A label + a placeholder + a hint is three pieces of chrome
 * per field, and on a form whose whole job is "type the two halves of a card"
 * they crowd out the only thing worth looking at — the fact. `hint` survives
 * for the few fields whose syntax genuinely can't be guessed (the mistake
 * type's `{6.022|1.000..9.999}` ranges), and shows only once the field has
 * focus.
 */
function addTextArea(parent: HTMLElement, label: string, opts: { placeholder?: string; hint?: string; multiline?: boolean } = {}): HTMLTextAreaElement {
  const field = parent.createDiv({ cls: "iris-author-field" });
  const ta = field.createEl("textarea", { cls: "iris-author-input" });
  ta.rows = 1;
  ta.placeholder = opts.placeholder ?? label;
  ta.setAttr("aria-label", label);
  // List-entry fields keep Enter as newline instead of field-advance.
  if (opts.multiline) ta.dataset.multiline = "1";
  if (opts.hint) field.createDiv({ text: opts.hint, cls: "iris-author-hint" });
  return ta;
}

function addText(parent: HTMLElement, label: string, placeholder = ""): HTMLInputElement {
  const field = parent.createDiv({ cls: "iris-author-field" });
  const input = field.createEl("input", { type: "text", cls: "iris-author-input" });
  input.placeholder = placeholder || label;
  input.setAttr("aria-label", label);
  return input;
}

/**
 * Grow-on-touch row list: whenever the last row gains any content, a fresh
 * empty row appears below it. Trailing empty rows are the norm and are
 * ignored by validation.
 */
function autoAddRows(rowInputs: () => (HTMLInputElement | HTMLTextAreaElement)[][], addRow: () => void): (row: (HTMLInputElement | HTMLTextAreaElement)[]) => void {
  return (row) => {
    for (const input of row) {
      input.addEventListener("input", () => {
        const rows = rowInputs();
        const last = rows[rows.length - 1];
        if (last.some(i => i.value.trim())) addRow();
      });
    }
  };
}

/**
 * Save a pasted image to the vault's attachment folder and insert its embed
 * link at the field's cursor. Lets "paste a molecule on one side" work
 * literally — no detour through a note to get an embed link.
 */
async function insertClipboardImage(app: App, field: HTMLTextAreaElement | HTMLInputElement, image: File): Promise<void> {
  const ext = (image.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "");
  const base = `pasted-${Date.now()}.${ext}`;
  const fm = app.fileManager as unknown as { getAvailablePathForAttachment?: (name: string) => Promise<string> };
  const path = fm.getAvailablePathForAttachment ? await fm.getAvailablePathForAttachment(base) : base;
  const created = await app.vault.createBinary(path, await image.arrayBuffer());
  let link = app.fileManager.generateMarkdownLink(created, "");
  if (!link.startsWith("!")) link = "!" + link;

  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.value = field.value.slice(0, start) + link + field.value.slice(end);
  const caret = start + link.length;
  field.setSelectionRange(caret, caret);
  // Bubbling input keeps auto-grow and grow-on-touch rows in sync.
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
const EMBED_RE = /!\[\[([^\]|#]+)[^\]]*\]\]|!\[[^\]]*\]\(([^)]+)\)/g;

/**
 * Show the images a field embeds directly under it. The fields are plain
 * textareas, so a pasted image otherwise reads as `![[pasted-1234.png]]` and
 * the author can't see what they actually pasted until the card comes up in
 * review. Re-derived from the field text on every edit, so deleting the link
 * removes the thumbnail.
 */
function syncImagePreviews(app: App, field: HTMLTextAreaElement | HTMLInputElement): void {
  const targets = Array.from(field.value.matchAll(EMBED_RE))
    .map(m => decodeURIComponent((m[1] ?? m[2] ?? "").trim()))
    .filter(p => IMAGE_EXT.test(p));

  const sibling = field.nextElementSibling;
  const existing = sibling instanceof HTMLElement && sibling.hasClass("iris-author-previews") ? sibling : null;
  if (targets.length === 0) {
    existing?.remove();
    return;
  }
  const strip = existing ?? createDiv({ cls: "iris-author-previews" });
  if (!existing) field.insertAdjacentElement("afterend", strip);
  strip.empty();
  for (const t of targets) {
    const file = app.metadataCache.getFirstLinkpathDest(t, "");
    if (!file) continue;
    strip.createEl("img", { cls: "iris-author-preview", attr: { src: app.vault.getResourcePath(file) } });
  }
  if (strip.childElementCount === 0) strip.remove();
}

/** A type's text fields, skipping any it has hidden (e.g. Order's unused title or property). */
function visibleInputs(el: HTMLElement): (HTMLInputElement | HTMLTextAreaElement)[] {
  return Array.from(el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"))
    .filter(i => !i.closest(".iris-hidden"));
}

/** Remembered last-used type ids that have since been folded into another type. */
const RETIRED_TYPE_IDS: Record<string, string> = { series: "order", synonym: "pairs" };

// ─── Type definitions ───────────────────────────────────────────────────

const TYPE_DEFS: AuthorTypeDef[] = [
  {
    id: "qa",
    label: "Q&A",
    build(fields, initial) {
      const q = addTextArea(fields, "Question");
      const a = addTextArea(fields, "Answer");
      if (initial) {
        q.value = initial.question;
        a.value = initial.answer;
      }
      return () => {
        const question = q.value.trim();
        const answer = a.value.trim();
        if (!question || !answer) return "Both a question and an answer are required.";
        return { variant: mkVariant("Q&A", question, answer), factText: `Q: ${question}\nA: ${answer}` };
      };
    },
  },
  {
    id: "pairs",
    label: "Double-sided",
    build(fields, initial) {
      const rows: { name: HTMLInputElement; content: HTMLTextAreaElement }[] = [];
      fields.createDiv({
        text: "You'll be shown one side and asked for another. Fill in a third row (or more) for extra sides. Naming sides — e.g. \"structure\" / \"name\" — makes the question say what it's asking for. Images can be pasted straight in.",
        cls: "iris-author-hint",
      });
      const rowsEl = fields.createDiv();
      const wireAutoAdd = autoAddRows(
        () => rows.map(r => [r.name, r.content]),
        () => addRow(),
      );
      const addRow = () => {
        const row = rowsEl.createDiv({ cls: "iris-author-pair-row" });
        const name = row.createEl("input", { type: "text", cls: "iris-author-input iris-author-pair-name" });
        name.placeholder = "Name (optional)";
        const content = row.createEl("textarea", { cls: "iris-author-input iris-author-pair-content" });
        content.rows = 1;
        content.placeholder = rows.length === 0 ? "Front" : rows.length === 1 ? "Back" : "Another side";
        rows.push({ name, content });
        wireAutoAdd([name, content]);
      };
      if (initial) {
        try {
          for (const f of decodePairs(initial.question).fields) {
            addRow();
            const r = rows[rows.length - 1];
            r.name.value = f.name;
            r.content.value = f.content;
          }
        } catch { /* vetted by editableTypeId; fall through to empty rows */ }
      }
      while (rows.length < 2) addRow();
      if (initial && rows[rows.length - 1].content.value) addRow(); // trailing empty row
      return () => {
        const complete: PairsField[] = [];
        for (const r of rows) {
          const name = r.name.value.trim();
          const content = r.content.value.trim();
          if (content) complete.push({ name, content });
          else if (name) return `The "${name}" side has no content.`;
        }
        if (complete.length < 2) return "A double-sided card needs at least two sides.";
        const e = encodePairs(complete);
        return {
          variant: mkVariant("Pairs", e.question, e.answer),
          factText: complete.map(f => f.name ? `${f.name}: ${f.content}` : f.content).join("\n"),
        };
      };
    },
  },
  {
    id: "cloze",
    label: "Cloze",
    build(fields, initial, ctx) {
      // The sentence renders as itself — a line of words you click to hide —
      // instead of an empty box you retype the fact into. When authoring from
      // a captured fact the fact IS the sentence, so a second copy of it in a
      // textarea was pure duplication. The textarea still exists as the source
      // of truth (and as the way to reword), it's just out of the way until
      // asked for.
      const surface = fields.createDiv({ cls: "iris-cloze-surface" });
      const wordsEl = surface.createDiv({ cls: "iris-cloze-words" });
      const s = surface.createEl("textarea", { cls: "iris-author-input iris-cloze-raw iris-hidden" });
      s.rows = 1;
      s.placeholder = "The capital of France is Paris.";
      s.setAttr("aria-label", "Sentence");
      const footer = surface.createDiv({ cls: "iris-cloze-footer" });
      const hintEl = footer.createDiv({ cls: "iris-author-hint" });
      const rewordBtn = footer.createEl("button", { cls: "iris-cloze-reword", text: "Reword" });

      // The textarea is the single source of truth; the words are a visual
      // editor over it — clicking one inserts or removes the asterisks.
      const mergeAdjacentGaps = (t: string): string => {
        let prev;
        do {
          prev = t;
          t = t.replace(/\*([^*]+)\*(\s+)\*([^*]+)\*/, "*$1$2$3*");
        } while (t !== prev);
        return t;
      };

      const setText = (t: string) => {
        s.value = mergeAdjacentGaps(t);
        autoGrow(s);
        renderWords();
      };

      const wrapWord = (start: number, len: number) => {
        const text = s.value;
        const token = text.slice(start, start + len);
        // Keep punctuation outside the gap so the answer is just the word.
        const lead = (token.match(/^["'¿¡([{]*/) ?? [""])[0].length;
        const trail = (token.match(/["').,;:!?\]}]*$/) ?? [""])[0].length;
        if (lead + trail >= token.length) return; // pure punctuation
        const a = start + lead;
        const b = start + len - trail;
        setText(text.slice(0, a) + "*" + text.slice(a, b) + "*" + text.slice(b));
      };

      const unwrapGap = (start: number, len: number, inner: string) => {
        const text = s.value;
        setText(text.slice(0, start) + inner + text.slice(start + len));
      };

      const renderWords = () => {
        wordsEl.empty();
        const text = s.value;
        const gapRe = /\*([^*]+)\*/g;
        // Spacing comes from the original string, so the words read as the
        // sentence rather than as a bag of chips.
        const addPlainChips = (plain: string, offset: number) => {
          // A math span, wikilink or embed is one thing to hide, not a run of
          // whitespace-separated fragments — `$\Delta G < 0$` must gap whole
          // or the stored sentence ends up with an unbalanced `$`.
          const wordRe = /\$[^$]+\$|!?\[\[[^\]]+\]\]|\S+/g;
          let cursor = 0;
          let w;
          while ((w = wordRe.exec(plain))) {
            if (w.index > cursor) wordsEl.appendText(plain.slice(cursor, w.index));
            const start = offset + w.index;
            const len = w[0].length;
            const chip = wordsEl.createEl("button", { text: w[0], cls: "iris-cloze-word" });
            chip.addEventListener("click", (e) => { e.preventDefault(); wrapWord(start, len); });
            cursor = w.index + len;
          }
          if (cursor < plain.length) wordsEl.appendText(plain.slice(cursor));
        };
        let last = 0;
        let m;
        while ((m = gapRe.exec(text))) {
          addPlainChips(text.slice(last, m.index), last);
          const inner = m[1];
          const canonical = inner.split("|")[0].trim() || inner;
          const gapStart = m.index;
          const gapLen = m[0].length;
          const chip = wordsEl.createEl("button", { text: canonical, cls: "iris-cloze-word iris-cloze-gap" });
          chip.addEventListener("click", (e) => { e.preventDefault(); unwrapGap(gapStart, gapLen, inner); });
          last = m.index + m[0].length;
        }
        addPlainChips(text.slice(last), last);

        const gaps = parseClozeTerms(text).length;
        hintEl.setText(
          !text.trim() ? "Write the sentence, then tap the words to hide"
            : gaps === 0 ? "Tap a word to hide it"
            : `${gaps} gap${gaps === 1 ? "" : "s"} — tap to add or undo`,
        );
      };

      // Seeded from the fact being carded (or the variant being edited): the
      // sentence is already written, so start with it on screen.
      s.value = initial?.question ?? ctx.seedText ?? "";

      let rewording = false;
      const setRewording = (on: boolean) => {
        rewording = on;
        s.toggleClass("iris-hidden", !on);
        wordsEl.toggleClass("iris-hidden", on);
        rewordBtn.setText(on ? "Done" : "Reword");
        if (on) {
          autoGrow(s);
          s.focus();
        } else {
          renderWords();
        }
      };
      rewordBtn.addEventListener("click", (e) => { e.preventDefault(); setRewording(!rewording); });
      s.addEventListener("input", () => autoGrow(s));

      renderWords();
      // Nothing to mark up yet (creating from scratch) — open straight into
      // the text so the first keystroke goes somewhere sensible.
      if (!s.value.trim()) setRewording(true);

      return () => {
        const sentence = s.value.trim();
        if (!sentence) return "A sentence is required.";
        if (parseClozeTerms(sentence).length === 0) return "At least one word needs to be hidden — tap it in the sentence.";
        return { variant: mkVariant("Cloze", sentence, ""), factText: sentence };
      };
    },
  },
  {
    id: "tf",
    label: "True/False",
    build(fields, initial) {
      const t = addTextArea(fields, "True statement");
      const f = addTextArea(fields, "False statement", {
        hint: "A plausible false version of the same fact.",
      });
      const pair = initial ? decodeTFPair(initial.question) : null;
      if (pair) {
        t.value = pair.trueStatement;
        f.value = pair.falseStatement;
      }
      return () => {
        const trueS = t.value.trim();
        const falseS = f.value.trim();
        if (!trueS || !falseS) return "Both a true and a false statement are required.";
        if (trueS.toLowerCase() === falseS.toLowerCase()) return "The true and false statements must be different.";
        const e = encodeTFPair(trueS, falseS);
        return { variant: mkVariant("True/False", e.question, e.answer), factText: trueS };
      };
    },
  },
  {
    id: "mc",
    label: "Multiple Choice",
    build(fields, initial) {
      const q = addTextArea(fields, "Question");
      // Options are one list, not a "correct answer" field plus numbered wrong
      // ones: which is right is a property of an option, so it's a mark on the
      // row rather than a separate box whose position you have to remember.
      // Four rows to start, growing on touch — leave rows empty for fewer.
      const rows: { input: HTMLInputElement; mark: HTMLButtonElement }[] = [];
      const optionsEl = fields.createDiv({ cls: "iris-author-options" });
      let correctIdx = 0;
      const paintMarks = () => {
        rows.forEach((r, i) => {
          const isCorrect = i === correctIdx;
          r.mark.toggleClass("iris-author-option-correct", isCorrect);
          r.mark.setAttr("aria-label", isCorrect ? "Correct answer" : "Mark as the correct answer");
          r.mark.setAttr("aria-pressed", String(isCorrect));
        });
      };
      const wireAutoAdd = autoAddRows(
        () => rows.map(r => [r.input]),
        () => addOption(),
      );
      const addOption = () => {
        const row = optionsEl.createDiv({ cls: "iris-author-option-row" });
        const mark = row.createEl("button", { cls: "iris-author-option-mark" });
        const input = row.createEl("input", { type: "text", cls: "iris-author-input" });
        input.placeholder = rows.length === 0 ? "Answer" : "Another option";
        const idx = rows.length;
        mark.addEventListener("click", (e) => { e.preventDefault(); correctIdx = idx; paintMarks(); });
        rows.push({ input, mark });
        wireAutoAdd([input]);
        paintMarks();
      };
      if (initial) {
        try {
          const mc = decodeMC(initial.question, initial.answer);
          q.value = mc.question;
          mc.options.forEach((o, i) => {
            addOption();
            rows[i].input.value = o.text;
            if (o.letter === mc.correct) correctIdx = i;
          });
          paintMarks();
        } catch { /* vetted by editableTypeId */ }
      }
      while (rows.length < 4) addOption();
      if (initial && rows[rows.length - 1].input.value) addOption(); // trailing empty row
      return () => {
        const question = q.value.trim();
        const correctText = rows[correctIdx]?.input.value.trim() ?? "";
        const wrongTexts = rows
          .filter((_, i) => i !== correctIdx)
          .map(r => r.input.value.trim())
          .filter(Boolean);
        if (!question) return "A question is required.";
        if (!correctText) return "The option marked correct is empty.";
        if (wrongTexts.length === 0) return "At least one wrong answer is required.";
        // Options are stored under letter labels, so Z is the ceiling.
        if (wrongTexts.length > 25) return "A multiple choice card can have at most 26 options.";
        const options = [correctText, ...wrongTexts].map((text, i) => ({ letter: String.fromCharCode(65 + i), text }));
        const e = encodeMC({ question, options, correct: "A" });
        return { variant: mkVariant("Multiple Choice", e.question, e.answer), factText: `Q: ${question}\nA: ${correctText}` };
      };
    },
  },
  {
    id: "order",
    label: "Order",
    build(fields, initial) {
      // One form for two stored types that are both an ordered list: a
      // process's steps (Place in Order) and items ranked along a property
      // (Rank). Only the question asked of the list differs.
      const kindField = fields.createDiv({ cls: "iris-author-field" });
      const kind = kindField.createEl("select", { cls: "dropdown iris-author-order-kind" });
      kind.setAttr("aria-label", "What kind of order");
      kind.createEl("option", { text: "Steps of a process", attr: { value: "steps" } });
      kind.createEl("option", { text: "Ranked by a property", attr: { value: "rank" } });
      const title = addText(fields, "Process", "Steps of mitosis");
      const prop = addText(fields, "Property (adjective)", "electronegative");
      const items = addTextArea(fields, "Items, in order (one per line)", { multiline: true });
      const hint = items.parentElement!.createDiv({ cls: "iris-author-hint" });

      const showKind = () => {
        const rank = kind.value === "rank";
        title.parentElement!.toggleClass("iris-hidden", rank);
        prop.parentElement!.toggleClass("iris-hidden", !rank);
        items.placeholder = rank ? "Items, least → most (one per line)" : "Steps, in the correct order (one per line)";
        hint.setText(rank
          ? "Reviews ask \"which is more/less [property]?\" — and with 3+ items, \"place these in order\"."
          : "Shown shuffled, so no step may give away its position — avoid \"then\", \"finally\", \"repeat the above\".");
      };
      kind.addEventListener("change", () => {
        showKind();
        (kind.value === "rank" ? prop : title).focus();
      });

      if (initial) {
        try {
          if (initial.exerciseType === "Rank") {
            const r = decodeRank(initial.question, initial.answer);
            kind.value = "rank";
            prop.value = r.property;
            items.value = r.items.join("\n");
          } else {
            const os = decodeOrderSteps(initial.question, initial.answer);
            title.value = os.title;
            items.value = os.steps.join("\n");
          }
        } catch { /* vetted by editableTypeId */ }
      }
      showKind();

      return () => {
        const list = lines(items.value);
        if (kind.value === "rank") {
          const property = prop.value.trim();
          if (!property) return "A property adjective is required.";
          if (list.length < 2) return "At least two items are required.";
          const e = encodeRank({ property, items: list });
          return {
            variant: mkVariant("Rank", e.question, e.answer),
            factText: `In order of ${property} (least → most): ${list.join(", ")}`,
          };
        }
        const t = title.value.trim();
        if (!t) return "A process name is required.";
        // Two steps shuffle into the right order half the time — not an exercise.
        if (list.length < 3) return "Ordering needs at least three steps.";
        const e = encodeOrderSteps({ title: t, steps: list });
        return {
          variant: mkVariant("Place in Order", e.question, e.answer),
          factText: `${t}: ${list.join(" → ")}`,
        };
      };
    },
  },
  {
    id: "multistep",
    label: "Multi-step",
    build(fields, initial) {
      const steps: { q: HTMLTextAreaElement; a: HTMLTextAreaElement }[] = [];
      const stepsEl = fields.createDiv();
      const wireAutoAdd = autoAddRows(
        () => steps.map(s => [s.q, s.a]),
        () => addStep(),
      );
      const addStep = () => {
        const n = steps.length + 1;
        const wrap = stepsEl.createDiv({ cls: "iris-author-step" });
        wrap.createDiv({ text: `Step ${n}`, cls: "iris-author-step-title" });
        const q = addTextArea(wrap, "Question");
        const a = addTextArea(wrap, "Answer");
        steps.push({ q, a });
        wireAutoAdd([q, a]);
      };
      if (initial) {
        try {
          for (const st of decodeMultiStep(initial.question).steps) {
            addStep();
            const s = steps[steps.length - 1];
            s.q.value = st.question;
            s.a.value = st.answer;
          }
        } catch { /* vetted by editableTypeId */ }
      }
      while (steps.length < 2) addStep();
      if (initial && steps[steps.length - 1].q.value) addStep(); // trailing empty step
      return () => {
        const complete: MultiStep[] = [];
        for (const s of steps) {
          const question = s.q.value.trim();
          const answer = s.a.value.trim();
          if (question && answer) complete.push({ question, answer });
          else if (question || answer) return "Every step needs both a question and an answer (or leave both empty).";
        }
        if (complete.length < 2) return "A multi-step card needs at least two complete steps.";
        const e = encodeMultiStep(complete);
        return {
          variant: mkVariant("Multi-step", e.question, e.answer),
          factText: complete.map((st, i) => `Step ${i + 1} — Q: ${st.question} A: ${st.answer}`).join("\n"),
        };
      };
    },
  },
  {
    id: "match",
    label: "Match",
    build(fields, initial) {
      const prompt = addTextArea(fields, "Prompt (optional)", {
        placeholder: DEFAULT_MATCH_PROMPT,
      });
      fields.createDiv({
        text: "Each row is one correct pairing. In review the right column is shuffled and the learner drags a line to each match.",
        cls: "iris-author-hint",
      });
      const rows: { left: HTMLInputElement; right: HTMLInputElement }[] = [];
      const rowsEl = fields.createDiv();
      const wireAutoAdd = autoAddRows(
        () => rows.map(r => [r.left, r.right]),
        () => addRow(),
      );
      const addRow = () => {
        const row = rowsEl.createDiv({ cls: "iris-author-pair-row" });
        const left = row.createEl("input", { type: "text", cls: "iris-author-input" });
        left.placeholder = "Left";
        const right = row.createEl("input", { type: "text", cls: "iris-author-input" });
        right.placeholder = "Right";
        rows.push({ left, right });
        wireAutoAdd([left, right]);
      };
      if (initial) {
        try {
          const m = decodeMatch(initial.question);
          if (m.prompt !== DEFAULT_MATCH_PROMPT) prompt.value = m.prompt;
          for (const p of m.pairs) {
            addRow();
            const r = rows[rows.length - 1];
            r.left.value = p.left;
            r.right.value = p.right;
          }
        } catch { /* vetted by editableTypeId */ }
      }
      while (rows.length < MIN_MATCH_PAIRS) addRow();
      if (initial && rows[rows.length - 1].left.value) addRow(); // trailing empty row
      return () => {
        const pairs: MatchPair[] = [];
        for (const r of rows) {
          const left = r.left.value.trim();
          const right = r.right.value.trim();
          if (left && right) pairs.push({ left, right });
          else if (left || right) return "Every row needs both sides (or leave both empty).";
        }
        if (pairs.length < MIN_MATCH_PAIRS) {
          return `A match card needs at least ${MIN_MATCH_PAIRS} pairs — with two, getting one right forces the other.`;
        }
        const seen = new Set<string>();
        for (const p of pairs) {
          // Two identical boxes in a column are indistinguishable on screen, so
          // one of the two lines would always grade wrong.
          if (seen.has(`L${p.left}`)) return `"${p.left}" appears twice on the left.`;
          if (seen.has(`R${p.right}`)) return `"${p.right}" appears twice on the right.`;
          seen.add(`L${p.left}`);
          seen.add(`R${p.right}`);
        }
        const e = encodeMatch({ prompt: prompt.value.trim() || DEFAULT_MATCH_PROMPT, pairs });
        return {
          variant: mkVariant("Match", e.question, e.answer),
          factText: pairs.map(p => `${p.left} — ${p.right}`).join("\n"),
        };
      };
    },
  },
  {
    id: "list",
    label: "List",
    build(fields, initial, ctx) {
      const prompt = addTextArea(fields, "Prompt", { placeholder: "Name the four humours." });
      const items = addTextArea(fields, "Items (one per line)", {
        multiline: true,
        hint: "Marked unordered, so sequence doesn't matter. Each item must stand on its own.",
      });
      // List answers are marked item-by-item by the LLM; without that backend
      // the review views skip List variants entirely, so say so up front rather
      // than letting the card silently never come up.
      if (!llmMarkingEnabled(ctx.plugin)) {
        fields.createDiv({
          cls: "iris-author-hint iris-author-warn",
          text: "AI marking is off — List cards can't be marked, so they won't come up in review.",
        });
      }
      if (initial) {
        try {
          const l = decodeList(initial.question, initial.answer);
          prompt.value = l.prompt;
          items.value = l.items.join("\n");
        } catch { /* vetted by editableTypeId */ }
      }
      return () => {
        const p = prompt.value.trim();
        const list = lines(items.value);
        if (!p) return "A prompt is required.";
        if (list.length < 2) return "A list needs at least two items.";
        const e = encodeList({ prompt: p, items: list });
        return {
          variant: mkVariant("List", e.question, e.answer),
          factText: `${p} ${list.join(", ")}`,
        };
      };
    },
  },
  {
    id: "mistake",
    label: "Correct the mistake",
    build(fields, initial) {
      const wrong = addTextArea(fields, "Statement with the error", {
        hint: "For a wrong number, write {correct|min..max} — e.g. {6.022|1.000..9.999} — and the distractor is randomised each review.",
      });
      const right = addTextArea(fields, "Corrected statement");
      if (initial) {
        wrong.value = initial.question;
        right.value = initial.answer;
      }
      return () => {
        const incorrect = wrong.value.trim();
        const corrected = right.value.trim();
        if (!incorrect) return "The statement with the error is required.";
        if (!corrected) return "The corrected statement is required.";
        if (incorrect.toLowerCase() === corrected.toLowerCase()) {
          return "The two statements are identical — the first one needs an error in it.";
        }
        return {
          variant: mkVariant("Correct the Mistake", incorrect, corrected),
          factText: corrected,
        };
      };
    },
  },
  {
    id: "synonym",
    label: "Alternate name",
    // New alternate names are double-sided cards; this stays only so
    // existing Synonym variants can still be edited.
    editOnly: true,
    build(fields, initial) {
      const term = addText(fields, "Term", "Krebs cycle");
      const alt = addText(fields, "Alternate name", "citric acid cycle");
      if (initial) {
        term.value = SYNONYM_Q_RE.exec(initial.question)?.[1] ?? "";
        alt.value = initial.answer;
      }
      return () => {
        const t = term.value.trim();
        const a = alt.value.trim();
        if (!t) return "A term is required.";
        if (!a) return "An alternate name is required.";
        return {
          variant: mkVariant("Synonym", synonymQuestion(t), a),
          factText: `${t} is also known as ${a}.`,
        };
      };
    },
  },
  {
    id: "occlusion",
    label: "Image occlusion",
    build(fields, initial, ctx) {
      let imageFile: TFile | null = null;
      let regions: OcclusionRegion[] = [];

      // The buttons name themselves ("Choose image…"), so no label above them.
      const field = fields.createDiv({ cls: "iris-author-field" });
      const row = field.createDiv({ cls: "iris-author-occlusion-row" });
      const pickBtn = row.createEl("button", { text: "Choose image…", attr: { type: "button" } });
      const regionBtn = row.createEl("button", { text: "Edit regions…", attr: { type: "button" } });
      // Always-visible: this one reports state (which image, how many
      // regions), not syntax, so it mustn't collapse with the focus-only hints.
      const status = field.createDiv({ cls: "iris-author-hint iris-author-status" });
      const thumb = field.createDiv({ cls: "iris-author-previews" });

      const refresh = () => {
        regionBtn.disabled = !imageFile;
        thumb.empty();
        if (imageFile) {
          thumb.createEl("img", { cls: "iris-author-preview", attr: { src: ctx.app.vault.getResourcePath(imageFile) } });
        }
        status.setText(imageFile
          ? `${imageFile.name} — ${regions.length} region${regions.length === 1 ? "" : "s"}`
          : "No image chosen.");
      };

      pickBtn.addEventListener("click", () => {
        new ImageSuggestModal(ctx.app, (file) => {
          // A different image invalidates the regions drawn on the old one.
          if (imageFile && file.path !== imageFile.path) regions = [];
          imageFile = file;
          refresh();
        }).open();
      });

      regionBtn.addEventListener("click", () => {
        if (!imageFile) return;
        new ImageOcclusionEditor(ctx.app, ctx.plugin, imageFile, regions, (drawn) => {
          regions = drawn;
          refresh();
        }, "Done").open();
      });

      if (initial) {
        try {
          const d = decodeImageOcclusion(initial.question, initial.answer);
          imageFile = ctx.app.metadataCache.getFirstLinkpathDest(d.imagePath, "");
          regions = d.regions;
        } catch { /* vetted by editableTypeId */ }
      }
      refresh();

      return () => {
        if (!imageFile) return "Choose an image first.";
        if (regions.length === 0) return "Draw at least one region to hide.";
        const e = encodeImageOcclusion(`![[${imageFile.path}]]`, regions);
        return {
          variant: mkVariant("Image Occlusion", e.question, e.answer),
          factText: `![[${imageFile.path}]]`,
        };
      };
    },
  },
];

// ─── Form builder ───────────────────────────────────────────────────────

export interface CardAuthorFormOpts {
  app: App;
  plugin: IrisCardsPlugin;
  saveLabel?: string;
  /** Type chip preselected when the form opens (last-used); defaults to Q&A. */
  initialTypeId?: string;
  /** Pre-fill the matching type's fields from an existing variant (edit mode). */
  initial?: QAVariant;
  /** Reports chip changes so callers can remember the last-used type. */
  onTypeChange?: (typeId: string) => void;
  onSave: (card: AuthoredCard) => void | Promise<void>;
  /** The fact's own sentence, for types that start from it (see AuthorCtx). */
  seedText?: string;
}

/**
 * Render the card-authoring form into `container`: a type picker, the chosen
 * type's fields, and a save button. See the module doc for the keyboard,
 * paste, and field-persistence behavior.
 */
export function buildCardAuthorForm(container: HTMLElement, opts: CardAuthorFormOpts): void {
  const form = container.createDiv({ cls: "iris-author-form" });

  // Fields first, chrome last. The type picker sits in the footer beside Save
  // rather than above the fields: it's a decision about the card you're
  // writing, not a heading for it, and putting it up top made every card start
  // with a labelled dropdown instead of the fact.
  const fieldsHost = form.createDiv({ cls: "iris-author-fields" });
  const errorEl = form.createDiv({ cls: "iris-author-error" });
  const actions = form.createDiv({ cls: "iris-author-actions" });
  const typeSelect = actions.createEl("select", { cls: "dropdown iris-author-type" });
  typeSelect.setAttr("aria-label", "Card type");
  const prefillTypeId = opts.initial ? editableTypeId(opts.initial) : null;
  const offered = TYPE_DEFS.filter(d => !d.editOnly || d.id === prefillTypeId);
  for (const def of offered) {
    typeSelect.createEl("option", { text: def.label, attr: { value: def.id } });
  }
  const saveBtn = actions.createEl("button", { cls: "iris-author-save", text: opts.saveLabel ?? "Save card" });

  // Each type's fields are built once and kept alive behind the picker, so
  // switching type never discards anything already typed.
  const built = new Map<string, { el: HTMLDivElement; collect: Collect }>();
  let active: { el: HTMLDivElement; collect: Collect } | null = null;

  const selectType = (def: AuthorTypeDef) => {
    typeSelect.value = def.id;
    errorEl.setText("");
    let entry = built.get(def.id);
    if (!entry) {
      const el = fieldsHost.createDiv();
      entry = {
        el,
        collect: def.build(el, def.id === prefillTypeId ? opts.initial : undefined, { app: opts.app, plugin: opts.plugin, seedText: opts.seedText }),
      };
      built.set(def.id, entry);
    }
    for (const e of built.values()) e.el.style.display = e === entry ? "" : "none";
    active = entry;
    // Heights measure as 0 while hidden — grow now that the fields are visible.
    for (const ta of Array.from(entry.el.querySelectorAll("textarea"))) autoGrow(ta);
    const inputs = visibleInputs(entry.el);
    // Prefilled fields (editing an existing card) never fire input, so seed
    // their thumbnails here.
    for (const i of inputs) syncImagePreviews(opts.app, i);
    const target = inputs.find(i => !i.value.trim()) ?? inputs[0];
    window.setTimeout(() => target?.focus(), 0);
    opts.onTypeChange?.(def.id);
  };

  typeSelect.addEventListener("change", () => {
    const def = offered.find(d => d.id === typeSelect.value);
    if (def) selectType(def);
  });

  let saving = false;
  const save = async () => {
    if (saving || !active) return;
    const result = active.collect();
    if (typeof result === "string") {
      errorEl.setText(result);
      return;
    }
    errorEl.setText("");
    saving = true;
    saveBtn.disabled = true;
    try {
      await opts.onSave(result);
    } finally {
      saving = false;
      saveBtn.disabled = false;
    }
  };

  saveBtn.addEventListener("click", () => void save());

  form.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      void save();
      return;
    }
    if (e.shiftKey) return; // newline in textareas
    const t = e.target;
    if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return;
    if (t.dataset.multiline) return; // list-entry field: Enter makes a newline
    e.preventDefault();
    const inputs = active ? visibleInputs(active.el) : [];
    const idx = inputs.indexOf(t);
    const rest = idx >= 0 ? inputs.slice(idx + 1) : [];
    // When everything after the cursor is empty and the card is already
    // complete, Enter saves — no walking through optional/auto-added rows.
    if (active && rest.every(i => !i.value.trim()) && typeof active.collect() !== "string") {
      void save();
      return;
    }
    const next = rest[0];
    if (next) next.focus();
    else void save();
  });

  // Textareas track their content height.
  form.addEventListener("input", (e) => {
    if (e.target instanceof HTMLTextAreaElement) autoGrow(e.target);
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) {
      syncImagePreviews(opts.app, e.target);
    }
  });

  // Pasting an image into any field embeds it (saved to the attachment folder).
  form.addEventListener("paste", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement)) return;
    const image = Array.from(e.clipboardData?.files ?? []).find(f => f.type.startsWith("image/"));
    if (!image) return;
    e.preventDefault();
    insertClipboardImage(opts.app, t, image).catch((err) => {
      console.error("[iris-cards] image paste failed", err);
      new Notice("The image couldn't be saved to the vault.");
    });
  });

  const lastTypeId = opts.initialTypeId && (RETIRED_TYPE_IDS[opts.initialTypeId] ?? opts.initialTypeId);
  const initial = offered.find(d => d.id === (prefillTypeId ?? lastTypeId)) ?? offered[0];
  selectType(initial);
}

// ─── Edit modal ─────────────────────────────────────────────────────────

/**
 * Edit an existing variant in the authoring form, pre-filled. The caller owns
 * persistence (replacing the variant on the card file) via `onSaved`.
 */
export class CardEditModal extends Modal {
  constructor(
    app: App,
    private plugin: IrisCardsPlugin,
    private variant: QAVariant,
    private onSaved: (card: AuthoredCard) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("iris-manual-card-modal");
    this.setTitle("Edit card");
    buildCardAuthorForm(contentEl, {
      app: this.app,
      plugin: this.plugin,
      saveLabel: "Save changes",
      initial: this.variant,
      onSave: async (authored) => {
        await this.onSaved(authored);
        this.close();
      },
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
