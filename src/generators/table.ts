import { stripMarkdown } from "../commands/utils";
import type { PairsField } from "./pairs";

/**
 * Markdown table → one Double-sided (Pairs) card per row, each column a named
 * side. Which columns may be *shown* as the prompt is inferred, not asked:
 *
 *   1. Empty cells are ignored.
 *   2. A column whose remaining values are all distinct is *identifying* — a
 *      value picks out exactly one row, so "which row has X?" has one answer.
 *   3. Any other column is *non-identifying* — it repeats ("Aliphatic"), so it
 *      can be asked for but never shown as the prompt.
 *
 * In the amino-acid table, Name / Three-letter / One-letter / pKa come out
 * identifying and Side chain doesn't: a review may show "Gly" and ask for the
 * name, but never shows "Aliphatic" and asks which amino acid it is.
 */

export interface TableColumn {
  header: string;
  identifying: boolean;
}

export interface ParsedTable {
  columns: TableColumn[];
  /** One entry per data row; "" for an empty cell. */
  rows: string[][];
}

const SEPARATOR_CELL = /^:?-+:?$/;

/** Split one table line into trimmed cells, honouring `\|` escapes. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      // Obsidian escapes the pipe in [[link\|alias]] inside tables — keep it
      // as a literal pipe in the cell.
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

/** Comparison key for uniqueness: rendered text, case- and space-insensitive. */
function cellKey(cell: string): string {
  return stripMarkdown(cell).replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Parse a selection that is exactly one Markdown table (header row, separator
 * row, at least one data row). Returns null for anything else, so the caller
 * can fall through to its other selection shapes.
 */
export function parseMarkdownTable(text: string): ParsedTable | null {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 3) return null;
  if (!lines.every(l => l.includes("|"))) return null;

  const sep = splitRow(lines[1]);
  if (!sep.every(c => SEPARATOR_CELL.test(c))) return null;

  const headerCells = splitRow(lines[0]);
  const width = headerCells.length;
  if (width < 2 || sep.length !== width) return null;

  const rawRows = lines.slice(2).map(l => {
    const cells = splitRow(l);
    // GFM pads short rows and drops overflow cells; do the same.
    while (cells.length < width) cells.push("");
    return cells.slice(0, width);
  });

  // Drop columns that are empty in every row — nothing to learn there.
  const keep = headerCells
    .map((_, c) => c)
    .filter(c => rawRows.some(r => r[c] !== ""));
  if (keep.length < 2) return null;

  const rows = rawRows.map(r => keep.map(c => r[c]));
  const columns: TableColumn[] = keep.map((c, i) => {
    const keys = rows.map(r => r[i]).filter(v => v !== "").map(cellKey);
    return {
      header: headerCells[c] || `Column ${c + 1}`,
      identifying: new Set(keys).size === keys.length,
    };
  });

  return { columns, rows };
}

/**
 * The sides of each row's card. Rows that can't make a card — fewer than two
 * filled cells, or no filled identifying cell to show as the prompt — are
 * returned as null so the caller can report how many were skipped.
 */
export function tableRowsToPairs(table: ParsedTable): (PairsField[] | null)[] {
  return table.rows.map(row => {
    const fields: PairsField[] = [];
    row.forEach((cell, i) => {
      if (!cell) return;
      const col = table.columns[i];
      fields.push({
        name: col.header,
        content: cell,
        ...(col.identifying ? {} : { answerOnly: true }),
      });
    });
    if (fields.length < 2 || fields.every(f => f.answerOnly)) return null;
    return fields;
  });
}
