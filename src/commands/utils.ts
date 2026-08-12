import { Platform } from "obsidian";

export function stripMarkdown(text: string): string {
  // Protect math spans ($$...$$ and $...$) — their _ and * are LaTeX
  // subscripts/operators, not Markdown emphasis, and must survive stripping.
  const math: string[] = [];
  const guarded = text.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, (m) => {
    math.push(m);
    return `\x00${math.length - 1}\x00`;
  });

  const stripped = guarded
    .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2") // [[link|display]] → display, [[link]] → link
    .replace(/\*\*(.+?)\*\*/g, "$1")   // **bold**
    .replace(/__(.+?)__/g, "$1")        // __bold__
    .replace(/\*(.+?)\*/g, "$1")        // *italic*
    .replace(/_(.+?)_/g, "$1")          // _italic_
    .replace(/~~(.+?)~~/g, "$1");       // ~~strikethrough~~

  return stripped.replace(/\x00(\d+)\x00/g, (_, i) => math[Number(i)]);
}

/**
 * Electron's safeStorage only exists in the desktop app. Asking for it on
 * mobile doesn't fail quietly: Obsidian intercepts the require, logs an error
 * and shows the user an "iris-cards attempted to load NodeJS package" notice —
 * which fired on every settings save, including the authoring form's remember-
 * my-last-card-type write. Check the platform instead of catching afterwards.
 */
function safeStorageOrNull(): { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string } | null {
  // Both flags matter: a real phone isn't a desktop app, and desktop running
  // in mobile-emulation mode blocks `require` the same way a phone does while
  // still reporting isDesktopApp — so emulation reproduces the phone's
  // behaviour instead of hiding it.
  if (Platform.isMobile || !Platform.isDesktopApp) return null;
  try {
    return require("electron").safeStorage ?? null;
  } catch {
    return null;
  }
}

export function encryptSecret(key: string): string {
  if (!key) return "";
  try {
    const safeStorage = safeStorageOrNull();
    if (!safeStorage) return key;
    if (safeStorage.isEncryptionAvailable()) {
      return "enc:" + safeStorage.encryptString(key).toString("base64");
    }
  } catch { /* safeStorage unavailable */ }
  return key;
}

export function decryptSecret(stored: string): string {
  if (!stored) return "";
  if (stored.startsWith("enc:")) {
    try {
      const safeStorage = safeStorageOrNull();
      // An encrypted key can't be read on mobile at all — it was sealed with
      // the desktop's OS keychain. Empty, as before, so callers fall back to
      // the relay rather than sending ciphertext as an API key.
      if (!safeStorage) return "";
      return safeStorage.decryptString(Buffer.from(stored.slice(4), "base64"));
    } catch {
      return "";
    }
  }
  return stored;
}
