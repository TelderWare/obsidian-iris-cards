import { encodePairs } from "../generators/pairs";
import type { ExerciseType, QAVariant } from "../types/exercises";

/**
 * Markdown table → flashcards.
 *
 * Empty cells are ignored throughout. A column whose remaining values are all
 * different is *identifying* — each value picks out one row (name, three-letter
 * code, one-letter code, …). A column with a repeated value isn't — it
 * describes rows rather than naming them (side-chain class, …).
 *
 * Per row:
 *   - its identifying cells become one Double-sided card, so any one of them
 *     prompts for another (needs at least two filled in);
 *   - each non-identifying cell becomes a one-way Q&A card, prompted by the
 *     row's first identifying cell. It can't go the other way: "Aliphatic"
 *     doesn't pick out one amino acid.
 */

export interface TableCard {
  variant: QAVariant;
  eligible: ExerciseType[];
  /** The card's fact text; also what makes a re-capture a repeat. */
  factText: string;
}

export interface TableCardsResult {
  cards: TableCard[];
  /** Header names, for the toast. */
  identifying: string[];
  describing: string[];
}

const SEPARATOR_CELL = /^:?-+:?$/;

/** Split one table line on unescaped pipes, dropping the outer ones. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (ch === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** The selection as a table, or null unless the whole of it is one. */
export function parseMarkdownTable(text: string): { headers: string[]; rows: string[][] } | null {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 3) return null;
  if (!lines.every(l => l.includes("|"))) return null;
  const sep = splitRow(lines[1]);
  if (sep.length === 0 || !sep.every(c => SEPARATOR_CELL.test(c))) return null;

  const headers = splitRow(lines[0]);
  const width = headers.length;
  const rows = lines.slice(2).map(l => {
    const cells = splitRow(l).slice(0, width);
    while (cells.length < width) cells.push("");
    return cells;
  });
  return { headers, rows };
}

function variant(exerciseType: ExerciseType, question: string, answer: string): QAVariant {
  return {
    exerciseType, question, answer,
    acceptedAnswers: [], knownIncorrect: [],
    lastReviewed: null, suspended: false, recordMs: null, difficulty: null,
  };
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Lower-case a title-cased header mid-sentence, leaving acronyms (pKa, DNA) alone. */
const uncap = (s: string) => s.replace(/\b[A-Z][a-z]+\b/g, w => w.charAt(0).toLowerCase() + w.slice(1));

export function tableToCards(text: string): TableCardsResult | null {
  const table = parseMarkdownTable(text);
  if (!table) return null;
  const { headers, rows } = table;

  const identifying: number[] = [];
  const describing: number[] = [];
  headers.forEach((_, c) => {
    const values = rows.map(r => r[c]).filter(v => v.length > 0);
    if (values.length === 0) return; // an all-empty column says nothing
    const unique = new Set(values.map(norm)).size === values.length;
    (unique ? identifying : describing).push(c);
  });

  const cards: TableCard[] = [];
  for (const row of rows) {
    const ids = identifying.filter(c => row[c].length > 0);

    if (ids.length >= 2) {
      const sides = ids.map(c => ({ name: headers[c], content: row[c] }));
      const e = encodePairs(sides);
      cards.push({
        variant: variant("Pairs", e.question, e.answer),
        eligible: ["Pairs"],
        factText: sides.map(s => s.name ? `${s.name}: ${s.content}` : s.content).join("\n"),
      });
    }

    // A description needs something to hang it on.
    if (ids.length === 0) continue;
    const key = ids[0];
    for (const c of describing) {
      const value = row[c];
      if (!value) continue;
      // One line: the card format drops blank lines inside a question.
      const question = headers[c]
        ? `What is the ${uncap(headers[c])} of ${row[key]}?`
        : `${row[key]}: what goes with it?`;
      cards.push({
        variant: variant("Q&A", question, value),
        eligible: ["Q&A"],
        factText: `${headers[key] ? headers[key] + ": " : ""}${row[key]}\n${headers[c] || "Value"}: ${value}`,
      });
    }
  }

  return {
    cards,
    identifying: identifying.map(c => headers[c]),
    describing: describing.map(c => headers[c]),
  };
}
