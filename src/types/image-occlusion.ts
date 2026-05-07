/**
 * Image Occlusion encoding. One QAVariant per card holds the image embed in
 * `question` and a JSON list of regions in `answer`. The renderer picks a
 * random region per render (like cloze) and occludes it; the user types the
 * label. Per-region accepted-answer alternates use the gap-alternates encoding
 * with the region label as the binding term.
 */

export interface OcclusionRegion {
  /** Image-natural pixel coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

export interface DecodedImageOcclusion {
  /** Raw image link as written in the question (e.g. `![[foo.png]]` or `![](path)`). */
  imageLink: string;
  /** Resolved link target — the path/name inside the embed. */
  imagePath: string;
  regions: OcclusionRegion[];
}

const WIKI_RE = /^!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/;
const MD_RE = /^!\[[^\]]*\]\(([^)]+)\)$/;

export function extractImagePath(link: string): string | null {
  const trimmed = link.trim();
  const wiki = WIKI_RE.exec(trimmed);
  if (wiki) return wiki[1].trim();
  const md = MD_RE.exec(trimmed);
  if (md) return md[1].trim();
  return null;
}

export function encodeImageOcclusion(imageLink: string, regions: OcclusionRegion[]): { question: string; answer: string } {
  return {
    question: imageLink.trim(),
    answer: JSON.stringify(regions.map(r => ({
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.w), h: Math.round(r.h),
      label: r.label,
    }))),
  };
}

export function decodeImageOcclusion(question: string, answer: string): DecodedImageOcclusion {
  const imageLink = question.trim();
  const imagePath = extractImagePath(imageLink);
  if (!imagePath) throw new Error("Image occlusion question is not a valid image embed");
  const parsed = JSON.parse(answer);
  if (!Array.isArray(parsed)) throw new Error("Image occlusion answer is not an array");
  const regions: OcclusionRegion[] = parsed.map((r: unknown) => {
    if (!r || typeof r !== "object") throw new Error("Region is not an object");
    const o = r as Record<string, unknown>;
    const x = Number(o.x), y = Number(o.y), w = Number(o.w), h = Number(o.h);
    const label = typeof o.label === "string" ? o.label : "";
    if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) {
      throw new Error("Region has non-numeric coordinates");
    }
    return { x, y, w, h, label };
  });
  return { imageLink, imagePath, regions };
}
