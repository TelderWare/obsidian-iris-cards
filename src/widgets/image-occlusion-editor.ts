import { App, Modal, Notice, TFile, setIcon } from "obsidian";
import type IrisCardsPlugin from "../main";
import { type OcclusionRegion } from "../types/image-occlusion";
import { suggestOcclusions } from "../generators/image-occlusion";
import { hasRelay } from "../api/client";

interface EditorRegion extends OcclusionRegion {
  /** Stable key for DOM diffing across re-renders. */
  key: number;
}

const MIN_SIZE = 8;

export class ImageOcclusionEditor extends Modal {
  private regions: EditorRegion[] = [];
  private selectedKey: number | null = null;
  private nextKey = 1;

  private natural = { width: 0, height: 0 };
  private stageEl!: HTMLDivElement;
  private imgEl!: HTMLImageElement;
  private overlayEl!: HTMLDivElement;
  private statusEl!: HTMLDivElement;
  private suggestBtn!: HTMLButtonElement;

  private dragMode: "draw" | "move" | "resize" | null = null;
  private dragStart = { x: 0, y: 0 };
  private dragOriginal: OcclusionRegion | null = null;
  private dragKey: number | null = null;

  constructor(
    app: App,
    private plugin: IrisCardsPlugin,
    private imageFile: TFile,
    initial: OcclusionRegion[],
    private onSave: (regions: OcclusionRegion[]) => void | Promise<void>,
  ) {
    super(app);
    for (const r of initial) this.regions.push({ ...r, key: this.nextKey++ });
  }

  onOpen(): void {
    this.modalEl.addClass("iris-occlusion-editor-wrap");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("iris-occlusion-editor");

    const header = contentEl.createDiv({ cls: "iris-occlusion-editor-header" });
    header.createEl("h2", { text: "Image Occlusion Editor" });
    this.statusEl = header.createDiv({ cls: "iris-occlusion-editor-status" });

    const toolbar = contentEl.createDiv({ cls: "iris-occlusion-editor-toolbar" });

    const apiAvailable = !!this.plugin.settings.anthropicApiKey || hasRelay();
    this.suggestBtn = toolbar.createEl("button", {
      cls: "iris-occlusion-suggest-btn mod-cta",
      text: "Suggest with AI",
    });
    if (!apiAvailable) {
      this.suggestBtn.disabled = true;
      this.suggestBtn.setAttribute("title", "Set an Anthropic API key in settings to enable.");
    }
    this.suggestBtn.addEventListener("click", () => this.runSuggest());

    const clearBtn = toolbar.createEl("button", { text: "Clear all" });
    clearBtn.addEventListener("click", () => {
      this.regions = [];
      this.selectedKey = null;
      this.renderRegions();
      this.updateStatus();
    });

    const help = toolbar.createDiv({ cls: "iris-occlusion-editor-help" });
    help.setText("Drag on the image to draw. Click a box to select. Drag inside to move, drag the corner to resize. Press Delete to remove.");

    this.stageEl = contentEl.createDiv({ cls: "iris-occlusion-editor-stage" });
    this.imgEl = this.stageEl.createEl("img", {
      cls: "iris-occlusion-editor-img",
      attr: { src: this.app.vault.getResourcePath(this.imageFile) },
    });
    this.overlayEl = this.stageEl.createDiv({ cls: "iris-occlusion-editor-overlay" });

    this.imgEl.addEventListener("load", () => {
      this.natural = { width: this.imgEl.naturalWidth, height: this.imgEl.naturalHeight };
      this.renderRegions();
      this.updateStatus();
    });
    if (this.imgEl.complete && this.imgEl.naturalWidth > 0) {
      this.natural = { width: this.imgEl.naturalWidth, height: this.imgEl.naturalHeight };
      this.renderRegions();
      this.updateStatus();
    }

    this.overlayEl.addEventListener("mousedown", (e) => this.onStageMouseDown(e));
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
    window.addEventListener("keydown", this.onKeyDown);

    const footer = contentEl.createDiv({ cls: "iris-occlusion-editor-footer" });
    const cancelBtn = footer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = footer.createEl("button", { cls: "mod-cta", text: "Save card" });
    saveBtn.addEventListener("click", async () => {
      const cleaned = this.regions
        .filter(r => r.w >= MIN_SIZE && r.h >= MIN_SIZE && r.label.trim().length > 0)
        .map(({ x, y, w, h, label }) => ({ x, y, w, h, label: label.trim() }));
      if (cleaned.length === 0) {
        new Notice("Add at least one labeled region.");
        return;
      }
      saveBtn.disabled = true;
      try {
        await this.onSave(cleaned);
        this.close();
      } catch (e) {
        saveBtn.disabled = false;
        new Notice(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  onClose(): void {
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
    window.removeEventListener("keydown", this.onKeyDown);
    this.contentEl.empty();
  }

  // ─── AI Suggest ────────────────────────────────────────────────────

  private async runSuggest(): Promise<void> {
    if (this.natural.width === 0) {
      new Notice("Image still loading, try again.");
      return;
    }
    this.suggestBtn.disabled = true;
    const originalText = this.suggestBtn.textContent;
    this.suggestBtn.setText("Thinking…");
    try {
      const suggestions = await suggestOcclusions(
        this.app, this.imageFile,
        this.plugin.settings.anthropicApiKey,
        this.plugin.settings.claudeModel,
        this.natural,
      );
      if (suggestions.length === 0) {
        new Notice("No regions suggested. Try drawing manually.");
        return;
      }
      // Replace existing regions with suggestions; user can clear/edit further.
      this.regions = suggestions.map(r => ({ ...r, key: this.nextKey++ }));
      this.selectedKey = null;
      this.renderRegions();
      this.updateStatus();
      new Notice(`Suggested ${suggestions.length} regions.`);
    } catch (e) {
      new Notice(`Suggestion failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.suggestBtn.disabled = false;
      this.suggestBtn.setText(originalText ?? "Suggest with AI");
    }
  }

  // ─── Rendering ─────────────────────────────────────────────────────

  private renderRegions(): void {
    this.overlayEl.empty();
    if (this.natural.width === 0) return;

    for (const r of this.regions) {
      const box = this.overlayEl.createDiv({ cls: "iris-occlusion-editor-box" });
      box.dataset.key = String(r.key);
      box.style.left = `${(r.x / this.natural.width) * 100}%`;
      box.style.top = `${(r.y / this.natural.height) * 100}%`;
      box.style.width = `${(r.w / this.natural.width) * 100}%`;
      box.style.height = `${(r.h / this.natural.height) * 100}%`;
      if (r.key === this.selectedKey) {
        box.addClass("iris-occlusion-editor-box-selected");

        // Resize handle (bottom-right)
        const handle = box.createDiv({ cls: "iris-occlusion-editor-handle" });
        handle.dataset.key = String(r.key);

        // Inline label input
        const input = box.createEl("input", {
          cls: "iris-occlusion-editor-label",
          attr: { type: "text", placeholder: "Label", value: r.label },
        });
        input.addEventListener("input", () => {
          const region = this.regions.find(reg => reg.key === r.key);
          if (region) region.label = input.value;
          this.updateStatus();
        });
        input.addEventListener("mousedown", (e) => e.stopPropagation());
        input.addEventListener("click", (e) => e.stopPropagation());
        input.addEventListener("keydown", (e) => e.stopPropagation());
        // Auto-focus newly drawn or AI-suggested empty labels
        if (r.label === "") setTimeout(() => input.focus(), 0);

        const delBtn = box.createEl("button", {
          cls: "iris-occlusion-editor-delete",
          attr: { "aria-label": "Delete region" },
        });
        setIcon(delBtn, "x");
        delBtn.addEventListener("mousedown", (e) => e.stopPropagation());
        delBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.regions = this.regions.filter(reg => reg.key !== r.key);
          this.selectedKey = null;
          this.renderRegions();
          this.updateStatus();
        });
      } else if (r.label) {
        box.createDiv({ cls: "iris-occlusion-editor-box-label", text: r.label });
      }
    }
  }

  private updateStatus(): void {
    const total = this.regions.length;
    const labeled = this.regions.filter(r => r.label.trim()).length;
    this.statusEl.setText(`${labeled} labeled · ${total - labeled} unlabeled`);
  }

  // ─── Mouse handling ────────────────────────────────────────────────

  private displayToNatural(displayX: number, displayY: number): { x: number; y: number } {
    const rect = this.imgEl.getBoundingClientRect();
    const sx = this.natural.width / rect.width;
    const sy = this.natural.height / rect.height;
    return { x: (displayX - rect.left) * sx, y: (displayY - rect.top) * sy };
  }

  private clampRegion(r: OcclusionRegion): OcclusionRegion {
    const x = Math.max(0, Math.min(r.x, this.natural.width));
    const y = Math.max(0, Math.min(r.y, this.natural.height));
    const w = Math.max(MIN_SIZE, Math.min(r.w, this.natural.width - x));
    const h = Math.max(MIN_SIZE, Math.min(r.h, this.natural.height - y));
    return { x, y, w, h, label: r.label };
  }

  private onStageMouseDown(e: MouseEvent): void {
    const target = e.target as HTMLElement;

    // Resize handle
    if (target.hasClass("iris-occlusion-editor-handle")) {
      const key = Number(target.dataset.key);
      const region = this.regions.find(r => r.key === key);
      if (!region) return;
      e.preventDefault();
      this.dragMode = "resize";
      this.dragKey = key;
      this.dragOriginal = { ...region };
      this.dragStart = this.displayToNatural(e.clientX, e.clientY);
      return;
    }

    // Click on a box → select (and prepare to move)
    const boxEl = target.closest(".iris-occlusion-editor-box") as HTMLElement | null;
    if (boxEl) {
      const key = Number(boxEl.dataset.key);
      const region = this.regions.find(r => r.key === key);
      if (!region) return;
      e.preventDefault();
      const wasSelected = this.selectedKey === key;
      this.selectedKey = key;
      if (!wasSelected) this.renderRegions();
      this.dragMode = "move";
      this.dragKey = key;
      this.dragOriginal = { ...region };
      this.dragStart = this.displayToNatural(e.clientX, e.clientY);
      return;
    }

    // Empty area → start drawing
    if (this.natural.width === 0) return;
    e.preventDefault();
    const start = this.displayToNatural(e.clientX, e.clientY);
    const region: EditorRegion = {
      key: this.nextKey++,
      x: start.x, y: start.y, w: 1, h: 1, label: "",
    };
    this.regions.push(region);
    this.selectedKey = region.key;
    this.dragMode = "draw";
    this.dragKey = region.key;
    this.dragOriginal = { ...region };
    this.dragStart = start;
    this.renderRegions();
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (this.dragMode === null || this.dragKey === null || !this.dragOriginal) return;
    const region = this.regions.find(r => r.key === this.dragKey);
    if (!region) return;
    const cur = this.displayToNatural(e.clientX, e.clientY);

    if (this.dragMode === "draw") {
      const x = Math.min(this.dragStart.x, cur.x);
      const y = Math.min(this.dragStart.y, cur.y);
      const w = Math.abs(cur.x - this.dragStart.x);
      const h = Math.abs(cur.y - this.dragStart.y);
      Object.assign(region, this.clampRegion({ x, y, w, h, label: region.label }));
    } else if (this.dragMode === "move") {
      const dx = cur.x - this.dragStart.x;
      const dy = cur.y - this.dragStart.y;
      Object.assign(region, this.clampRegion({
        x: this.dragOriginal.x + dx, y: this.dragOriginal.y + dy,
        w: this.dragOriginal.w, h: this.dragOriginal.h, label: region.label,
      }));
    } else if (this.dragMode === "resize") {
      const dx = cur.x - this.dragStart.x;
      const dy = cur.y - this.dragStart.y;
      Object.assign(region, this.clampRegion({
        x: this.dragOriginal.x, y: this.dragOriginal.y,
        w: this.dragOriginal.w + dx, h: this.dragOriginal.h + dy, label: region.label,
      }));
    }

    // Live-update the box position without rebuilding the DOM (preserves focus)
    const boxEl = this.overlayEl.querySelector(`.iris-occlusion-editor-box[data-key="${region.key}"]`) as HTMLElement | null;
    if (boxEl) {
      boxEl.style.left = `${(region.x / this.natural.width) * 100}%`;
      boxEl.style.top = `${(region.y / this.natural.height) * 100}%`;
      boxEl.style.width = `${(region.w / this.natural.width) * 100}%`;
      boxEl.style.height = `${(region.h / this.natural.height) * 100}%`;
    }
  };

  private onMouseUp = (): void => {
    if (this.dragMode === "draw" && this.dragKey !== null) {
      const region = this.regions.find(r => r.key === this.dragKey);
      // If the user clicked without dragging, drop the tiny zero-area rect.
      if (region && (region.w < MIN_SIZE || region.h < MIN_SIZE)) {
        this.regions = this.regions.filter(r => r.key !== this.dragKey);
        this.selectedKey = null;
        this.renderRegions();
      } else {
        // Re-render to surface label input on the now-finalized box.
        this.renderRegions();
      }
      this.updateStatus();
    }
    this.dragMode = null;
    this.dragKey = null;
    this.dragOriginal = null;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if ((e.key === "Delete" || e.key === "Backspace") && this.selectedKey !== null) {
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "INPUT") return;
      this.regions = this.regions.filter(r => r.key !== this.selectedKey);
      this.selectedKey = null;
      this.renderRegions();
      this.updateStatus();
    }
  };
}
