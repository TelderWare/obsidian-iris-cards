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

export function encryptSecret(key: string): string {
  if (!key) return "";
  try {
    const { safeStorage } = require("electron");
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
      const { safeStorage } = require("electron");
      return safeStorage.decryptString(Buffer.from(stored.slice(4), "base64"));
    } catch {
      return "";
    }
  }
  return stored;
}
