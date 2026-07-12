/**
 * Pairs — a multi-sided card the user authors by hand. Each side has a
 * user-chosen field name ("structure", "name", "function", "three-letter
 * code", …) and markdown content. A presentation shows one side and asks the
 * learner to recall another; with 3+ sides each review picks a fresh pairing.
 *
 * Stored in Q as human-readable lines, one side each — Dataview-style:
 *
 *   structure:: ![[molecule.png]]
 *   name:: Alanine
 *
 * `::` can't collide with the QA block's own directives (Type:, Reviewed:, …),
 * which all use a single colon. Newlines inside a side are stored as <br> so
 * every side stays on one line. No A: line. Earlier v2 builds stored a JSON
 * array; decodePairs still reads that as a legacy fallback.
 */

export interface PairsField {
  name: string;
  content: string;
}

export interface PairsResult {
  fields: PairsField[];
}

export function encodePairs(fields: PairsField[]): { question: string; answer: string } {
  const lines = fields.map(f =>
    `${f.name.replace(/:/g, "").trim()}:: ${f.content.replace(/\r?\n/g, "<br>").trim()}`,
  );
  return { question: lines.join("\n"), answer: "" };
}

export function decodePairs(question: string): PairsResult {
  const q = question.trim();
  const fields: PairsField[] = q.startsWith("[") ? decodePairsLegacyJson(q) : decodePairsLines(q);
  if (fields.length < 2) throw new Error("Pairs card needs at least two sides");
  return { fields };
}

function decodePairsLines(q: string): PairsField[] {
  const fields: PairsField[] = [];
  for (const line of q.split("\n")) {
    const m = line.match(/^([^:]+?)::\s*(.+)$/);
    if (!m) continue;
    const name = m[1].trim();
    const content = m[2].replace(/<br>/g, "\n").trim();
    if (name && content) fields.push({ name, content });
  }
  return fields;
}

/** Earlier v2 builds stored the sides as a JSON array in Q. */
function decodePairsLegacyJson(q: string): PairsField[] {
  let raw: unknown;
  try { raw = JSON.parse(q); } catch { throw new Error("Invalid pairs data"); }
  if (!Array.isArray(raw)) throw new Error("Pairs payload is not an array");
  const fields: PairsField[] = [];
  for (const f of raw) {
    if (typeof f !== "object" || f === null) continue;
    const name = (f as Record<string, unknown>)["name"];
    const content = (f as Record<string, unknown>)["content"];
    if (typeof name === "string" && name.trim() && typeof content === "string" && content.trim()) {
      fields.push({ name: name.trim(), content: content.trim() });
    }
  }
  return fields;
}

/**
 * Whether a side's content is short plain text the learner can reasonably be
 * asked to type (vs. an image embed or a paragraph, which get reveal-and-grade).
 */
export function isTypeableContent(content: string): boolean {
  return !content.includes("\n")
    && !content.includes("![[")
    && !content.includes("![")
    && content.length <= 120;
}
