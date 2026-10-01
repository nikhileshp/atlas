/**
 * Evernote Markup Language -> plain text. ENML is XHTML-like; we keep line
 * structure (block ends and <br> become newlines, list items get bullets),
 * substitute document attachments with a placeholder, drop images, and decode
 * entities. Pure; no DOM.
 */

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n: string) => NAMED[n.toLowerCase()] ?? m);
}

export function enmlToText(enml: string, mediaNames: Map<string, string | null>): string {
  let s = enml
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<\/?en-note[^>]*>/gi, "");

  s = s.replace(/<en-media\b[^>]*?hash="([0-9a-fA-F]+)"[^>]*\/?>/g, (_, hash: string) => {
    const name = mediaNames.get(hash.toLowerCase());
    return name ? `[attachment: ${name}]` : "";
  });

  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<\/(div|p|li|tr|h[1-6]|blockquote|pre|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  s = decodeEntities(s);

  return s
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "").replace(/^[ \t]+/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
