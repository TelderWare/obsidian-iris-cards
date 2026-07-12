import { App, Notice, TFile, TFolder } from "obsidian";
import {
  GRADE_AGAIN, GRADE_GOOD,
  initialStability, initialDifficulty, updateStability, updateDifficulty,
  retrievability, daysSince, optimalInterval, pForget,
  buildLogEntry, S_INITIAL, NEW_CARD_FORGETTING_SCORE, cardHasTag,
} from "./scheduler";

/**
 * Tables — the second data model beside fact cards.
 *
 * A table is a markdown file (in the cards folder) with `kind: table`
 * frontmatter and an ordinary markdown table in its body:
 *
 *   ---
 *   kind: table
 *   table: Amino acids
 *   table-id: 1783948123456   # stable pairing UID, stamped on first use
 *   order-by: Mass            # column that defines introduction order
 *   order-desc: false         # optional; ascending by default
 *   key: Name                 # optional; row identity column (default: first)
 *   no-quiz: Mass             # optional; column(s) used for order/reference
 *                             #   only — never shown or asked in review
 *   module: BMS101            # optional, same semantics as cards
 *   ---
 *
 *   | Name | Structure | Code | Mass |
 *   | ---- | --------- | ---- | ---- |
 *   | Glycine | ![[gly.png]] | Gly | 75.07 |
 *
 * Per-row scheduling state lives in a COMPANION FILE (`kind: table-state`,
 * same `table-id`), not in the table itself. Reviews (often on the phone)
 * rewrite only the state file while content edits (usually on desktop) touch
 * only the table file, so whole-file sync conflicts can't eat a day of
 * reviews or a batch of edits. The pairing is by UID in both frontmatters —
 * renaming or moving either file never detaches them.
 *
 * The state file holds one readable block per introduced row:
 *
 *   Row: Glycine
 *   Stability: 2.31
 *   Difficulty: 5.1
 *   Reviewed: 2026-07-12T10:00:00.000Z
 *   Next-due: 2026-07-15T00:00:00.000Z
 *   Repetitions: 3
 *   Log: 2026-07-12T10:00:00.000Z,c,1832,3
 *
 * A row *having* a block is what "introduced" means — delete a block to
 * un-introduce the row; delete or empty the state file to reset the table.
 * Rows are introduced one at a time in `order-by` order, user-pulled from
 * the review view's done screen. Reviews present a row as a Pairs exercise
 * over its columns.
 *
 * Blocks whose key no longer matches any table row (e.g. the row's key value
 * was renamed) are NEVER discarded: they're kept in the state file, reported
 * as orphans, and the review view offers a manual relink. No automatic
 * re-matching — guessing which row state belongs to is how history gets
 * silently corrupted.
 */

export interface RowState {
  stability: number | null;
  difficulty: number | null;
  lastReviewed: string | null;
  nextDue: string | null;
  repetitions: number;
  suspended: boolean;
  log: string[];
}

export interface TableRow {
  key: string;
  cells: Record<string, string>;
}

export interface IrisTable {
  file: TFile;
  sidecar: TFile | null;
  name: string;
  columns: string[];
  /** Rows sorted into introduction order (by `order-by`, else document order). */
  rows: TableRow[];
  state: Map<string, RowState>;
  /** State-block keys that match no current row — preserved, surfaced for relink. */
  orphanKeys: string[];
  orderBy: string | null;
  /** Columns excluded from quizzing (`no-quiz:` frontmatter). Present in the
   * table for ordering/reference (e.g. a Mass sort key) but never shown or
   * asked as a Pairs side. */
  noQuiz: string[];
}

const MS_PER_DAY = 86400000;
const MAX_ROW_LOG_ENTRIES = 100;
/** Legacy (pre-sidecar) embedded state section marker — migrated on sight. */
const LEGACY_STATE_SEP = "\n---\nRow: ";

function emptyRowState(): RowState {
  return { stability: null, difficulty: null, lastReviewed: null, nextDue: null, repetitions: 0, suspended: false, log: [] };
}

/** Split a markdown table line into cells, honouring `\|` escapes. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") { cur += "|"; i++; continue; }
    if (ch === "|") { cells.push(cur); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur);
  // A well-formed row is |a|b| — drop the empty leading/trailing cells.
  if (cells.length > 0 && cells[0].trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map(c => c.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every(c => /^:?-{2,}:?$/.test(c.trim()) || /^:-+:?$/.test(c.trim()));
}

/** Parse the markdown table (columns + keyed rows) out of a table file body. */
function parseTableBody(content: string, keyColWanted: string | undefined): { columns: string[]; rows: TableRow[] } {
  const body = content.replace(/^---[\s\S]*?---\n*/, "");
  const lines = body.split("\n");
  let columns: string[] = [];
  const rows: TableRow[] = [];
  let inTable = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("|")) {
      if (inTable) break; // only the first table counts
      continue;
    }
    const cells = splitRow(t);
    if (!inTable) {
      columns = cells;
      inTable = true;
      continue;
    }
    if (isSeparatorRow(cells)) continue;
    const cellMap: Record<string, string> = {};
    columns.forEach((col, i) => { cellMap[col] = cells[i] ?? ""; });
    rows.push({ key: "", cells: cellMap });
  }

  const keyCol = keyColWanted && columns.includes(keyColWanted) ? keyColWanted : columns[0];
  const seen = new Set<string>();
  const keyed: TableRow[] = [];
  for (const r of rows) {
    const key = (r.cells[keyCol] ?? "").trim();
    if (!key || seen.has(key)) continue; // rows need a unique, non-empty key
    seen.add(key);
    keyed.push({ ...r, key });
  }
  return { columns, rows: keyed };
}

/** Parse `Row:` state blocks out of text (a state file body, or a legacy
 * embedded section). Lines before the first `Row:` are ignored. */
function parseStateBlocks(text: string): Map<string, RowState> {
  const state = new Map<string, RowState>();
  let cur: RowState | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("Row: ")) {
      cur = emptyRowState();
      state.set(line.slice(5).trim(), cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith("Stability: ")) {
      const v = parseFloat(line.slice(11)); if (isFinite(v)) cur.stability = v;
    } else if (line.startsWith("Difficulty: ")) {
      const v = parseFloat(line.slice(12)); if (isFinite(v)) cur.difficulty = v;
    } else if (line.startsWith("Reviewed: ")) {
      cur.lastReviewed = line.slice(10).trim() || null;
    } else if (line.startsWith("Next-due: ")) {
      cur.nextDue = line.slice(10).trim() || null;
    } else if (line.startsWith("Repetitions: ")) {
      const v = parseInt(line.slice(13), 10); if (isFinite(v)) cur.repetitions = v;
    } else if (line.startsWith("Suspended: ")) {
      cur.suspended = line.slice(11).trim() === "true";
    } else if (line.startsWith("Log: ")) {
      cur.log = line.slice(5).split(" | ").map(s => s.trim()).filter(Boolean);
    }
  }
  return state;
}

function buildStateBlocks(rows: TableRow[], state: Map<string, RowState>): string {
  // Emit in table order so the file reads like the table; orphaned keys
  // (rows since renamed/removed) keep their state at the end — never dropped.
  const ordered: [string, RowState][] = [];
  for (const r of rows) {
    const st = state.get(r.key);
    if (st) ordered.push([r.key, st]);
  }
  const known = new Set(rows.map(r => r.key));
  for (const [key, st] of state) {
    if (!known.has(key)) ordered.push([key, st]);
  }
  return ordered.map(([key, st]) => {
    let b = `Row: ${key}`;
    if (st.stability != null) b += `\nStability: ${st.stability}`;
    if (st.difficulty != null) b += `\nDifficulty: ${st.difficulty}`;
    if (st.lastReviewed) b += `\nReviewed: ${st.lastReviewed}`;
    if (st.nextDue) b += `\nNext-due: ${st.nextDue}`;
    if (st.repetitions > 0) b += `\nRepetitions: ${st.repetitions}`;
    if (st.suspended) b += `\nSuspended: true`;
    if (st.log.length > 0) b += `\nLog: ${st.log.join(" | ")}`;
    return b;
  }).join("\n\n");
}

function buildSidecarContent(uid: string, tableBasename: string, rows: TableRow[], state: Map<string, RowState>): string {
  const blocks = buildStateBlocks(rows, state);
  return [
    "---",
    "kind: table-state",
    `table-id: ${uid}`,
    "---",
    "",
    `Scheduling state for [[${tableBasename}]] — one block per introduced row. Delete a block to un-introduce its row; delete every block to reset the table.`,
    "",
    blocks,
    "",
  ].join("\n");
}

/** Sort rows by the order column: numeric when every value parses, else
 * natural string order. No order column → document order. */
function sortRows(rows: TableRow[], orderBy: string | null, desc: boolean): TableRow[] {
  if (!orderBy) return rows;
  const vals = rows.map(r => (r.cells[orderBy] ?? "").trim());
  const numeric = vals.length > 0 && vals.every(v => v !== "" && isFinite(parseFloat(v)));
  const sorted = [...rows].sort((a, b) => {
    const av = (a.cells[orderBy] ?? "").trim();
    const bv = (b.cells[orderBy] ?? "").trim();
    const cmp = numeric
      ? parseFloat(av) - parseFloat(bv)
      : av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
    return desc ? -cmp : cmp;
  });
  return sorted;
}

/** A table with rows not yet introduced, for the done screen's waiting list. */
export interface WaitingTable {
  file: TFile;
  name: string;
  total: number;
  started: number;
  nextKey: string;
}

/** Orphaned state surfaced for manual relinking on the done screen. */
export interface OrphanedTableState {
  file: TFile;
  name: string;
  orphanKey: string;
  /** Row keys with no state — the only legal relink targets. */
  candidates: string[];
}

export class TableStore {
  private cache = new Map<string, { tableMtime: number; sidecarPath: string | null; sidecarMtime: number; table: IrisTable }>();
  /** Freshly created sidecars, so pairing works before the metadata cache
   * has parsed the new file's frontmatter. */
  private sidecarByUid = new Map<string, string>();
  /** Legacy embedded-state migrations in flight (one attempt per file). */
  private migrating = new Set<string>();

  constructor(private app: App) {}

  /** The table files in the cards folder (`kind: table` frontmatter). */
  private tableFiles(cardsFolder: string): TFile[] {
    const folder = this.app.vault.getAbstractFileByPath(cardsFolder.trim() || "Iris Cards");
    if (!(folder instanceof TFolder)) return [];
    const out: TFile[] = [];
    for (const child of folder.children) {
      if (!(child instanceof TFile) || child.extension !== "md") continue;
      if (this.app.metadataCache.getFileCache(child)?.frontmatter?.["kind"] === "table") out.push(child);
    }
    return out;
  }

  isTableFile(file: TFile): boolean {
    return this.app.metadataCache.getFileCache(file)?.frontmatter?.["kind"] === "table";
  }

  isStateFile(file: TFile): boolean {
    return this.app.metadataCache.getFileCache(file)?.frontmatter?.["kind"] === "table-state";
  }

  /** The table paired (by UID) with a state file, if any — for event handling. */
  pairedTable(stateFile: TFile): TFile | null {
    const uid = this.app.metadataCache.getFileCache(stateFile)?.frontmatter?.["table-id"];
    if (typeof uid !== "string" && typeof uid !== "number") return null;
    const parent = stateFile.parent;
    if (!parent) return null;
    for (const child of parent.children) {
      if (!(child instanceof TFile) || child.extension !== "md") continue;
      const fm = this.app.metadataCache.getFileCache(child)?.frontmatter;
      if (fm?.["kind"] === "table" && String(fm["table-id"]) === String(uid)) return child;
    }
    return null;
  }

  /** Locate a table's state file by UID (frontmatter pairing, not filename). */
  private findSidecar(tableFile: TFile, uid: string): TFile | null {
    const remembered = this.sidecarByUid.get(uid);
    if (remembered) {
      const f = this.app.vault.getAbstractFileByPath(remembered);
      if (f instanceof TFile) return f;
      this.sidecarByUid.delete(uid);
    }
    const parent = tableFile.parent;
    if (!parent) return null;
    for (const child of parent.children) {
      if (!(child instanceof TFile) || child.extension !== "md" || child.path === tableFile.path) continue;
      const fm = this.app.metadataCache.getFileCache(child)?.frontmatter;
      if (fm?.["kind"] === "table-state" && String(fm["table-id"]) === String(uid)) return child;
    }
    return null;
  }

  private tableUid(tableFile: TFile): string | null {
    const raw = this.app.metadataCache.getFileCache(tableFile)?.frontmatter?.["table-id"];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (typeof raw === "number") return String(raw);
    return null;
  }

  /** Get (or stamp) the table's pairing UID. */
  private async ensureUid(tableFile: TFile): Promise<string> {
    const existing = this.tableUid(tableFile);
    if (existing) return existing;
    const uid = String(Date.now());
    await this.app.fileManager.processFrontMatter(tableFile, (fm) => {
      if (!fm["table-id"]) fm["table-id"] = uid;
    });
    return this.tableUid(tableFile) ?? uid;
  }

  /** Parse (or return cached) table + its state file. The cache is keyed on
   * both files' mtimes, so edits to either invalidate transparently. */
  async getTable(file: TFile): Promise<IrisTable | null> {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (fm?.["kind"] !== "table") return null;

    const uid = this.tableUid(file);
    const sidecar = uid ? this.findSidecar(file, uid) : null;

    const hit = this.cache.get(file.path);
    if (hit
      && hit.tableMtime === file.stat.mtime
      && hit.sidecarPath === (sidecar?.path ?? null)
      && hit.sidecarMtime === (sidecar?.stat.mtime ?? 0)) {
      return hit.table;
    }

    const content = await this.app.vault.cachedRead(file);
    const keyCol = typeof fm["key"] === "string" ? fm["key"] : undefined;

    // Legacy format: state embedded in the table file. Read it so nothing
    // breaks, and kick off a one-time migration to a sidecar.
    const legacyIdx = content.indexOf(LEGACY_STATE_SEP);
    const tableContent = legacyIdx === -1 ? content : content.slice(0, legacyIdx);
    const legacyState = legacyIdx === -1 ? null : parseStateBlocks(content.slice(legacyIdx + 5));
    if (legacyIdx !== -1 && !this.migrating.has(file.path)) {
      this.migrating.add(file.path);
      void this.migrateLegacyState(file);
    }

    const parsed = parseTableBody(tableContent, keyCol);
    const state = sidecar
      ? parseStateBlocks((await this.app.vault.cachedRead(sidecar)).replace(/^---[\s\S]*?---\n*/, ""))
      : legacyState ?? new Map<string, RowState>();

    const orderBy = typeof fm["order-by"] === "string" && parsed.columns.includes(fm["order-by"])
      ? fm["order-by"] : null;
    const rawNoQuiz = fm["no-quiz"];
    const noQuiz = (Array.isArray(rawNoQuiz) ? rawNoQuiz : typeof rawNoQuiz === "string" ? rawNoQuiz.split(",") : [])
      .filter((c): c is string => typeof c === "string")
      .map(c => c.trim())
      .filter(c => parsed.columns.includes(c));
    const name = typeof fm["table"] === "string" && fm["table"].trim() ? fm["table"].trim() : file.basename;
    const rowKeys = new Set(parsed.rows.map(r => r.key));
    const table: IrisTable = {
      file,
      sidecar,
      name,
      columns: parsed.columns,
      rows: sortRows(parsed.rows, orderBy, fm["order-desc"] === true),
      state,
      orphanKeys: [...state.keys()].filter(k => !rowKeys.has(k)),
      orderBy,
      noQuiz,
    };
    this.cache.set(file.path, {
      tableMtime: file.stat.mtime,
      sidecarPath: sidecar?.path ?? null,
      sidecarMtime: sidecar?.stat.mtime ?? 0,
      table,
    });
    return table;
  }

  /** Move a legacy embedded state section out to a sidecar, then strip it. */
  private async migrateLegacyState(file: TFile): Promise<void> {
    try {
      const uid = await this.ensureUid(file);
      let sidecar = this.findSidecar(file, uid);
      if (!sidecar) {
        // Seed the sidecar from the embedded section before stripping it.
        const content = await this.app.vault.cachedRead(file);
        const idx = content.indexOf(LEGACY_STATE_SEP);
        if (idx === -1) return;
        const state = parseStateBlocks(content.slice(idx + 5));
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const keyCol = typeof fm?.["key"] === "string" ? fm["key"] : undefined;
        const rows = parseTableBody(content.slice(0, idx), keyCol).rows;
        sidecar = await this.createSidecar(file, uid, rows, state);
      }
      // State now lives in the sidecar — drop the embedded section.
      await this.app.vault.process(file, (content) => {
        const idx = content.indexOf(LEGACY_STATE_SEP);
        return idx === -1 ? content : content.slice(0, idx).trimEnd() + "\n";
      });
      this.cache.delete(file.path);
    } catch (e) {
      console.error("[iris-cards] table state migration failed", file.path, e);
      this.migrating.delete(file.path); // allow a retry next parse
    }
  }

  private async createSidecar(tableFile: TFile, uid: string, rows: TableRow[], state: Map<string, RowState>): Promise<TFile> {
    const dir = tableFile.parent?.path ? tableFile.parent.path + "/" : "";
    let path = `${dir}${tableFile.basename} state.md`;
    if (this.app.vault.getAbstractFileByPath(path)) {
      path = `${dir}${tableFile.basename} state ${Date.now()}.md`;
    }
    const created = await this.app.vault.create(path, buildSidecarContent(uid, tableFile.basename, rows, state));
    // Remember the pairing directly — the metadata cache parses new files
    // asynchronously, and the next write may need the sidecar before then.
    this.sidecarByUid.set(uid, created.path);
    return created;
  }

  /** Parse every table in the folder (warms the cache for the sync accessors). */
  async getTables(cardsFolder: string): Promise<IrisTable[]> {
    const out: IrisTable[] = [];
    for (const file of this.tableFiles(cardsFolder)) {
      const t = await this.getTable(file);
      if (t) out.push(t);
    }
    return out;
  }

  /** Cached tables only — for sync callers (badge). May lag until getTables runs. */
  cachedTables(cardsFolder: string): IrisTable[] {
    const out: IrisTable[] = [];
    for (const file of this.tableFiles(cardsFolder)) {
      const hit = this.cache.get(file.path);
      if (hit && hit.tableMtime === file.stat.mtime) out.push(hit.table);
    }
    return out;
  }

  private tableModule(table: IrisTable): string | undefined {
    const m = this.app.metadataCache.getFileCache(table.file)?.frontmatter?.["module"];
    return typeof m === "string" && m ? m : undefined;
  }

  private tableMatches(table: IrisTable, moduleFilter?: Set<string>, tagFilter?: string): boolean {
    if (moduleFilter && moduleFilter.size > 0) {
      const mod = this.tableModule(table);
      if (!mod || !moduleFilter.has(mod)) return false;
    }
    if (tagFilter) {
      const fm = this.app.metadataCache.getFileCache(table.file)?.frontmatter;
      if (!cardHasTag(fm, tagFilter)) return false;
    }
    return true;
  }

  private rowIsDue(st: RowState, desiredRetention: number, now = Date.now()): boolean {
    if (st.suspended) return false;
    if (!st.lastReviewed) return true; // introduced but never reviewed
    if (st.nextDue) return now >= new Date(st.nextDue).getTime();
    return daysSince(st.lastReviewed) >= optimalInterval(st.stability ?? S_INITIAL, desiredRetention);
  }

  /** (file, rowKey) refs for every due, introduced row. */
  async dueRows(cardsFolder: string, desiredRetention: number, moduleFilter?: Set<string>, tagFilter?: string): Promise<{ file: TFile; rowKey: string }[]> {
    const out: { file: TFile; rowKey: string }[] = [];
    for (const table of await this.getTables(cardsFolder)) {
      if (!this.tableMatches(table, moduleFilter, tagFilter)) continue;
      for (const row of table.rows) {
        const st = table.state.get(row.key);
        if (st && this.rowIsDue(st, desiredRetention)) out.push({ file: table.file, rowKey: row.key });
      }
    }
    return out;
  }

  /** Every introduced, unsuspended row — the infinite-mode pool. */
  async allRows(cardsFolder: string, moduleFilter?: Set<string>, tagFilter?: string): Promise<{ file: TFile; rowKey: string }[]> {
    const out: { file: TFile; rowKey: string }[] = [];
    for (const table of await this.getTables(cardsFolder)) {
      if (!this.tableMatches(table, moduleFilter, tagFilter)) continue;
      for (const row of table.rows) {
        const st = table.state.get(row.key);
        if (st && !st.suspended) out.push({ file: table.file, rowKey: row.key });
      }
    }
    return out;
  }

  /** Sync due-row count from the cache, for the badge. */
  cachedDueRowCount(cardsFolder: string, desiredRetention: number, moduleFilter?: Set<string>): number {
    let count = 0;
    for (const table of this.cachedTables(cardsFolder)) {
      if (!this.tableMatches(table, moduleFilter)) continue;
      for (const row of table.rows) {
        const st = table.state.get(row.key);
        if (st && this.rowIsDue(st, desiredRetention)) count++;
      }
    }
    return count;
  }

  /** FSRS forgetting probability for a row (cache-only; new rows score high). */
  rowForgettingScore(path: string, rowKey: string): number {
    const hit = this.cache.get(path);
    const st = hit?.table.state.get(rowKey);
    if (!st || !st.lastReviewed) return NEW_CARD_FORGETTING_SCORE;
    return pForget(daysSince(st.lastReviewed), st.stability ?? S_INITIAL);
  }

  /** Tables with rows still waiting to be introduced, for the done screen. */
  async waitingTables(cardsFolder: string): Promise<WaitingTable[]> {
    const out: WaitingTable[] = [];
    for (const table of await this.getTables(cardsFolder)) {
      const next = table.rows.find(r => !table.state.has(r.key));
      if (!next) continue;
      out.push({
        file: table.file,
        name: table.name,
        total: table.rows.length,
        started: table.rows.filter(r => table.state.has(r.key)).length,
        nextKey: next.key,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** State blocks whose key matches no current row, with legal relink targets. */
  async orphanedState(cardsFolder: string): Promise<OrphanedTableState[]> {
    const out: OrphanedTableState[] = [];
    for (const table of await this.getTables(cardsFolder)) {
      if (table.orphanKeys.length === 0) continue;
      const candidates = table.rows.filter(r => !table.state.has(r.key)).map(r => r.key);
      for (const orphanKey of table.orphanKeys) {
        out.push({ file: table.file, name: table.name, orphanKey, candidates });
      }
    }
    return out;
  }

  /** Mutate a table's state file atomically (creating it on first use). */
  private async mutateState(tableFile: TFile, mutate: (state: Map<string, RowState>) => void): Promise<void> {
    const table = await this.getTable(tableFile);
    if (!table) return;
    const uid = await this.ensureUid(tableFile);
    let sidecar = this.findSidecar(tableFile, uid);
    if (!sidecar) {
      // First state write: seed from whatever we currently know (covers the
      // legacy-embedded case racing its own migration).
      sidecar = await this.createSidecar(tableFile, uid, table.rows, table.state);
    }
    await this.app.vault.process(sidecar, (content) => {
      const state = parseStateBlocks(content.replace(/^---[\s\S]*?---\n*/, ""));
      mutate(state);
      return buildSidecarContent(uid, tableFile.basename, table.rows, state);
    });
    this.cache.delete(tableFile.path);
  }

  /** Introduce the next un-introduced row (lowest in introduction order).
   * Returns its key, or null when every row is already introduced. */
  async introduceNext(file: TFile): Promise<string | null> {
    const table = await this.getTable(file);
    if (!table) return null;
    const next = table.rows.find(r => !table.state.has(r.key));
    if (!next) return null;
    await this.mutateState(file, (state) => {
      if (!state.has(next.key)) state.set(next.key, emptyRowState());
    });
    return next.key;
  }

  async suspendRow(file: TFile, rowKey: string): Promise<void> {
    await this.mutateState(file, (state) => {
      const st = state.get(rowKey);
      if (st) st.suspended = true;
    });
  }

  /** Re-key an orphaned state block onto a (renamed) row. Refuses to
   * overwrite existing state — relink targets must be un-introduced rows. */
  async relinkRow(file: TFile, orphanKey: string, newKey: string): Promise<boolean> {
    let ok = false;
    await this.mutateState(file, (state) => {
      const block = state.get(orphanKey);
      if (!block || state.has(newKey)) return;
      state.delete(orphanKey);
      state.set(newKey, block);
      ok = true;
    });
    if (!ok) new Notice("Couldn't relink — the target row already has state.");
    return ok;
  }

  /** Record a review outcome for one row — the row-level recordReview. */
  async recordRowReview(
    file: TFile, rowKey: string,
    correct: boolean, grade: number | undefined,
    elapsedMs: number | undefined, desiredRetention: number,
  ): Promise<void> {
    await this.mutateState(file, (state) => {
      const st = state.get(rowKey) ?? emptyRowState();
      state.set(rowKey, st);
      let newS: number;
      let newD: number;
      if (st.repetitions === 0) {
        newS = initialStability(correct, grade);
        newD = initialDifficulty(correct, grade);
      } else {
        const S = st.stability ?? S_INITIAL;
        const D = st.difficulty ?? initialDifficulty(true, GRADE_GOOD);
        const R = retrievability(daysSince(st.lastReviewed), S);
        newS = updateStability(S, D, correct, R, grade);
        newD = updateDifficulty(D, correct, grade);
      }
      st.stability = Math.round(newS * 1000) / 1000;
      st.difficulty = Math.round(newD * 1000) / 1000;
      st.lastReviewed = new Date().toISOString();
      st.repetitions += 1;
      // UTC-midnight due date from the optimal interval — same convention as
      // cards, minus the cross-card load balancing (rows are few per day).
      const days = Math.max(1, Math.round(optimalInterval(newS, desiredRetention)));
      const due = new Date(Date.now() + days * MS_PER_DAY);
      due.setUTCHours(0, 0, 0, 0);
      st.nextDue = due.toISOString();
      st.log.push(buildLogEntry(correct, elapsedMs, grade ?? (correct ? GRADE_GOOD : GRADE_AGAIN)));
      if (st.log.length > MAX_ROW_LOG_ENTRIES) st.log = st.log.slice(st.log.length - MAX_ROW_LOG_ENTRIES);
    });
  }
}
