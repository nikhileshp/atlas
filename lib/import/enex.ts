/**
 * Evernote export (.enex) handling that works on byte ranges, so a large
 * export can be parsed across several hosted-function invocations:
 *  - splitCompleteNotes: find whole <note>…</note> blocks in a buffer and say
 *    how many bytes are safe to consider consumed.
 *  - parseNoteBlock: one note's XML -> title/author/date/text/documents.
 * ENML content is CDATA (XML-escaped inside), so a literal "</note>" cannot
 * occur inside a note body; splitting on it is safe for real exports.
 */
import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { enmlToText } from "@/lib/import/enml";
import { isDocument } from "@/lib/import/classify";

const OPEN = Buffer.from("<note>");
const CLOSE = Buffer.from("</note>");

export interface ParsedResource {
  fileName: string;
  mime: string;
  bytes: Buffer;
  md5: string;
}

export interface ParsedNote {
  title: string;
  author: string | null;
  createdAt: string;
  text: string;
  documents: ParsedResource[];
  imagesSkipped: number;
}

export function enexDateToIso(s: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s.trim());
  if (!m) throw new Error(`Unrecognised Evernote timestamp: ${s}`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
}

export function splitCompleteNotes(buf: Buffer, isEof: boolean): { blocks: Buffer[]; consumed: number } {
  const blocks: Buffer[] = [];
  let cursor = 0;
  let consumed = 0;
  for (;;) {
    const start = buf.indexOf(OPEN, cursor);
    if (start === -1) break;
    const end = buf.indexOf(CLOSE, start + OPEN.length);
    if (end === -1) break;
    const stop = end + CLOSE.length;
    blocks.push(buf.subarray(start, stop));
    cursor = stop;
    consumed = stop;
  }
  if (isEof && blocks.length > 0) consumed = buf.length;
  if (isEof && blocks.length === 0 && buf.indexOf(OPEN) === -1) consumed = buf.length;
  return { blocks, consumed };
}

const MIME_EXT: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "text/csv": ".csv",
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "__cdata",
  textNodeName: "#text",
  trimValues: true,
  // titles like "0700", "3.10", "true" are text, not numbers or booleans
  parseTagValue: false,
  isArray: (name) => name === "resource",
});

type Raw = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

function textOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const n = node as Raw;
  if (typeof n.__cdata === "string") return n.__cdata;
  // content containing "]]>" is exported as several CDATA sections
  if (Array.isArray(n.__cdata)) return n.__cdata.map(textOf).join("");
  if (typeof n["#text"] === "string") return n["#text"] as string;
  return "";
}

export function parseNoteBlock(xml: string): ParsedNote {
  const doc = parser.parse(xml) as Raw;
  const note = (doc.note ?? {}) as Raw;

  const resources = ((note.resource as Raw[] | undefined) ?? []).map((r) => {
    const data = textOf(r.data).replace(/\s+/g, "");
    const bytes = Buffer.from(data, "base64");
    const attrs = (r["resource-attributes"] ?? {}) as Raw;
    const mime = str(r.mime).toLowerCase();
    // a nameless resource still needs an extension: type defaults key off it
    const fileName = str(attrs["file-name"]) || `attachment${MIME_EXT[mime] ?? ""}`;
    return { fileName, mime, bytes, md5: createHash("md5").update(bytes).digest("hex") };
  });

  const documents: ParsedResource[] = [];
  let imagesSkipped = 0;
  const mediaNames = new Map<string, string | null>();
  for (const r of resources) {
    if (isDocument(r.mime, r.fileName)) {
      documents.push(r);
      mediaNames.set(r.md5, r.fileName);
    } else {
      imagesSkipped += 1;
      mediaNames.set(r.md5, null);
    }
  }

  const attrs = (note["note-attributes"] ?? {}) as Raw;
  const author = str(attrs.author).trim() || null;
  const created = str(note.created) || str(note.updated);

  return {
    title: str(note.title).trim() || "(untitled note)",
    author,
    createdAt: created ? enexDateToIso(created) : new Date().toISOString(),
    text: enmlToText(textOf(note.content), mediaNames),
    documents,
    imagesSkipped,
  };
}
