import { App, Modal, Notice } from "obsidian";
import { type ExerciseType, type QAVariant } from "../types/exercises";
import { encodePairs, decodePairs, type PairsField } from "../generators/pairs";
import { encodeMultiStep, decodeMultiStep, type MultiStep } from "../generators/multi-step";
import { encodeTFPair, decodeTFPair } from "../generators/true-false";
import { encodeMC, decodeMC } from "../generators/multiple-choice";
import { encodeRank, decodeRank } from "../generators/rank";
import { parseClozeTerms } from "../generators/cloze";

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

interface AuthorTypeDef {
  id: string;
  label: string;
  /** Render the type's fields; when `initial` is given, pre-fill from it. */
  build(fields: HTMLElement, initial?: QAVariant): Collect;
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
      case "Rank": decodeRank(variant.question, variant.answer); return "series";
      case "Multi-step": decodeMultiStep(variant.question); return "multistep";
      default: return null;
    }
  } catch {
    return null;
  }
}

// ─── Small form helpers ─────────────────────────────────────────────────

function autoGrow(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

function addTextArea(parent: HTMLElement, label: string, opts: { placeholder?: string; hint?: string; multiline?: boolean } = {}): HTMLTextAreaElement {
  const field = parent.createDiv({ cls: "iris-author-field" });
  field.createEl("label", { text: label, cls: "iris-author-label" });
  const ta = field.createEl("textarea", { cls: "iris-author-input" });
  ta.rows = 1;
  if (opts.placeholder) ta.placeholder = opts.placeholder;
  // List-entry fields keep Enter as newline instead of field-advance.
  if (opts.multiline) ta.dataset.multiline = "1";
  if (opts.hint) field.createDiv({ text: opts.hint, cls: "iris-author-hint" });
  return ta;
}

function addText(parent: HTMLElement, label: string, placeholder = ""): HTMLInputElement {
  const field = parent.createDiv({ cls: "iris-author-field" });
  field.createEl("label", { text: label, cls: "iris-author-label" });
  const input = field.createEl("input", { type: "text", cls: "iris-author-input" });
  input.placeholder = placeholder;
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
    id: "cloze",
    label: "Cloze",
    build(fields, initial) {
      const s = addTextArea(fields, "Sentence", {
        placeholder: "The capital of France is Paris.",
      });
      const wordsEl = fields.createDiv({ cls: "iris-cloze-words" });
      fields.createDiv({
        text: "Click a word below to hide it; adjacent hidden words become one gap.",
        cls: "iris-author-hint",
      });

      // The textarea is the single source of truth; the chips are a visual
      // editor over it — clicking a chip inserts or removes the asterisks.
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
        const addPlainChips = (plain: string, offset: number) => {
          const wordRe = /\S+/g;
          let w;
          while ((w = wordRe.exec(plain))) {
            const start = offset + w.index;
            const len = w[0].length;
            const chip = wordsEl.createEl("button", { text: w[0], cls: "iris-cloze-word" });
            chip.addEventListener("click", (e) => { e.preventDefault(); wrapWord(start, len); });
          }
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
      };

      if (initial) s.value = initial.question;
      s.addEventListener("input", renderWords);
      renderWords();

      return () => {
        const sentence = s.value.trim();
        if (!sentence) return "A sentence is required.";
        if (parseClozeTerms(sentence).length === 0) return "At least one word needs to be hidden — click it below the sentence.";
        return { variant: mkVariant("Cloze", sentence, ""), factText: sentence };
      };
    },
  },
  {
    id: "pairs",
    label: "Pairs",
    build(fields, initial) {
      const rows: { name: HTMLInputElement; content: HTMLTextAreaElement }[] = [];
      fields.createDiv({
        text: "Sides have a name and content — e.g. \"structure\" / \"name\" / \"three-letter code\". Images can be pasted straight in.",
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
        name.placeholder = "Side name (e.g. structure)";
        const content = row.createEl("textarea", { cls: "iris-author-input iris-author-pair-content" });
        content.rows = 1;
        content.placeholder = "Content";
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
      if (initial && rows[rows.length - 1].name.value) addRow(); // trailing empty row
      return () => {
        const complete: PairsField[] = [];
        for (const r of rows) {
          const name = r.name.value.trim();
          const content = r.content.value.trim();
          if (name && content) complete.push({ name, content });
          else if (name || content) return "Every side needs both a name and content (or leave both empty).";
        }
        if (complete.length < 2) return "A pairs card needs at least two complete sides.";
        const e = encodePairs(complete);
        return {
          variant: mkVariant("Pairs", e.question, e.answer),
          factText: complete.map(f => `${f.name}: ${f.content}`).join("\n"),
        };
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
      const correct = addText(fields, "Correct answer");
      const wrongs = [
        addText(fields, "Wrong answer 1"),
        addText(fields, "Wrong answer 2"),
        addText(fields, "Wrong answer 3"),
      ];
      if (initial) {
        try {
          const mc = decodeMC(initial.question, initial.answer);
          q.value = mc.question;
          correct.value = mc.options.find(o => o.letter === mc.correct)?.text ?? "";
          const rest = mc.options.filter(o => o.letter !== mc.correct);
          rest.slice(0, wrongs.length).forEach((o, i) => { wrongs[i].value = o.text; });
        } catch { /* vetted by editableTypeId */ }
      }
      return () => {
        const question = q.value.trim();
        const correctText = correct.value.trim();
        const wrongTexts = wrongs.map(w => w.value.trim()).filter(Boolean);
        if (!question || !correctText) return "A question and a correct answer are required.";
        if (wrongTexts.length === 0) return "At least one wrong answer is required.";
        const letters = ["A", "B", "C", "D"];
        const options = [correctText, ...wrongTexts].map((text, i) => ({ letter: letters[i], text }));
        const e = encodeMC({ question, options, correct: "A" });
        return { variant: mkVariant("Multiple Choice", e.question, e.answer), factText: `Q: ${question}\nA: ${correctText}` };
      };
    },
  },
  {
    id: "series",
    label: "Property series",
    build(fields, initial) {
      const prop = addText(fields, "Property (adjective)", "electronegative");
      const items = addTextArea(fields, "Items, least → most (one per line)", {
        multiline: true,
        hint: "Reviews ask \"which is more/less [property]?\" — and with 3+ items, \"place these in order\".",
      });
      if (initial) {
        try {
          const r = decodeRank(initial.question, initial.answer);
          prop.value = r.property;
          items.value = r.items.join("\n");
        } catch { /* vetted by editableTypeId */ }
      }
      return () => {
        const property = prop.value.trim();
        const list = items.value.split("\n").map(l => l.trim()).filter(Boolean);
        if (!property) return "A property adjective is required.";
        if (list.length < 2) return "At least two items are required.";
        const e = encodeRank({ property, items: list });
        return {
          variant: mkVariant("Rank", e.question, e.answer),
          factText: `In order of ${property} (least → most): ${list.join(", ")}`,
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
];

// ─── Form builder ───────────────────────────────────────────────────────

export interface CardAuthorFormOpts {
  app: App;
  saveLabel?: string;
  /** Type chip preselected when the form opens (last-used); defaults to Q&A. */
  initialTypeId?: string;
  /** Pre-fill the matching type's fields from an existing variant (edit mode). */
  initial?: QAVariant;
  /** Reports chip changes so callers can remember the last-used type. */
  onTypeChange?: (typeId: string) => void;
  onSave: (card: AuthoredCard) => void | Promise<void>;
}

/**
 * Render the card-authoring form into `container`: a type picker, the chosen
 * type's fields, and a save button. See the module doc for the keyboard,
 * paste, and field-persistence behavior.
 */
export function buildCardAuthorForm(container: HTMLElement, opts: CardAuthorFormOpts): void {
  const form = container.createDiv({ cls: "iris-author-form" });

  const picker = form.createDiv({ cls: "iris-author-typerow" });
  picker.createEl("label", { text: "Type", cls: "iris-author-label" });
  const typeSelect = picker.createEl("select", { cls: "dropdown" });
  for (const def of TYPE_DEFS) {
    typeSelect.createEl("option", { text: def.label, attr: { value: def.id } });
  }
  const fieldsHost = form.createDiv({ cls: "iris-author-fields" });
  const errorEl = form.createDiv({ cls: "iris-author-error" });
  const actions = form.createDiv({ cls: "iris-author-actions" });
  const saveBtn = actions.createEl("button", { cls: "mod-cta iris-author-save", text: opts.saveLabel ?? "Save card" });

  const prefillTypeId = opts.initial ? editableTypeId(opts.initial) : null;

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
      entry = { el, collect: def.build(el, def.id === prefillTypeId ? opts.initial : undefined) };
      built.set(def.id, entry);
    }
    for (const e of built.values()) e.el.style.display = e === entry ? "" : "none";
    active = entry;
    // Heights measure as 0 while hidden — grow now that the fields are visible.
    for (const ta of Array.from(entry.el.querySelectorAll("textarea"))) autoGrow(ta);
    const inputs = Array.from(entry.el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"));
    const target = inputs.find(i => !i.value.trim()) ?? inputs[0];
    window.setTimeout(() => target?.focus(), 0);
    opts.onTypeChange?.(def.id);
  };

  typeSelect.addEventListener("change", () => {
    const def = TYPE_DEFS.find(d => d.id === typeSelect.value);
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
    const inputs = active ? Array.from(active.el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")) : [];
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

  const initial = TYPE_DEFS.find(d => d.id === (prefillTypeId ?? opts.initialTypeId)) ?? TYPE_DEFS[0];
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
