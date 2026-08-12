import { App, SuggestModal, TFile } from "obsidian";

export const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

/** Fuzzy-ish picker over every image in the vault. Shared by the "create image
 * occlusion card" command and the author form's Image Occlusion type. */
export class ImageSuggestModal extends SuggestModal<TFile> {
  private files: TFile[];

  constructor(app: App, private onPick: (file: TFile) => void) {
    super(app);
    this.files = app.vault.getFiles().filter(f => IMAGE_EXTS.has(f.extension.toLowerCase()));
    this.setPlaceholder("Pick an image…");
  }

  getSuggestions(query: string): TFile[] {
    const q = query.toLowerCase();
    return this.files.filter(f => f.path.toLowerCase().includes(q)).slice(0, 50);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.createDiv({ text: file.name });
    el.createDiv({ text: file.path, cls: "iris-suggest-path" });
  }

  onChooseSuggestion(file: TFile): void {
    this.onPick(file);
  }
}
