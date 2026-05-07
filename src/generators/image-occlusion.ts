import { type App, TFile } from "obsidian";
import { callClaudeTool } from "../api/client";
import { type OcclusionRegion } from "../types/image-occlusion";

const SYSTEM_PROMPT =
  "You prepare image-occlusion flashcards from labeled diagrams. Given an image, identify every label-like text region or unambiguously named visual structure worth occluding for study. For each, return a tight bounding box in image-natural pixel coordinates (origin top-left) and the exact label or canonical name. Skip captions, axis numbers, footnotes, copyright marks, and decorative text. Aim for 4-15 regions per image — quality over quantity.";

const TOOL = {
  name: "occlusion_regions",
  description: "Return the list of regions to occlude in the image.",
  input_schema: {
    type: "object" as const,
    properties: {
      regions: {
        type: "array" as const,
        description: "Regions to occlude.",
        items: {
          type: "object" as const,
          properties: {
            x: { type: "number" as const, description: "Left edge in image-natural pixels" },
            y: { type: "number" as const, description: "Top edge in image-natural pixels" },
            w: { type: "number" as const, description: "Width in pixels" },
            h: { type: "number" as const, description: "Height in pixels" },
            label: { type: "string" as const, description: "The label text or canonical name of the structure" },
          },
          required: ["x", "y", "w", "h", "label"],
        },
      },
    },
    required: ["regions"],
  },
};

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...(bytes.subarray(i, i + chunk) as unknown as number[]));
  }
  return btoa(binary);
}

function mimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    default: return "image/png";
  }
}

export async function suggestOcclusions(
  app: App,
  imageFile: TFile,
  apiKey: string,
  model: string,
  imageNaturalSize: { width: number; height: number },
): Promise<OcclusionRegion[]> {
  const buffer = await app.vault.readBinary(imageFile);
  const base64 = arrayBufferToBase64(buffer);
  const mediaType = mimeFromExt(imageFile.extension);

  const content = [
    {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: base64 },
    },
    {
      type: "text",
      text: `Image dimensions: ${imageNaturalSize.width} × ${imageNaturalSize.height} pixels. Return all bounding boxes in those original-image coordinates.`,
    },
  ];

  const r = await callClaudeTool<{ regions: OcclusionRegion[] }>(
    apiKey, model, SYSTEM_PROMPT, content, TOOL, 2000, 0,
  );
  return (r.regions ?? [])
    .map(reg => ({
      x: Number(reg.x), y: Number(reg.y),
      w: Number(reg.w), h: Number(reg.h),
      label: String(reg.label ?? "").trim(),
    }))
    .filter(r => r.label && r.w > 0 && r.h > 0 && isFinite(r.x) && isFinite(r.y));
}
