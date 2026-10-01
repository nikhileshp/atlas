import type { ArtifactType } from "@/lib/types";

export const DOCUMENT_MIMES: ReadonlySet<string> = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/csv",
]);

const DOCUMENT_EXT = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv"]);
const SPREADSHEET_EXT = new Set(["xls", "xlsx", "csv"]);

function ext(fileName: string | null): string {
  const m = /\.([a-z0-9]+)$/i.exec(fileName ?? "");
  return m ? m[1].toLowerCase() : "";
}

export function isDocument(mime: string | null, fileName: string | null): boolean {
  if (mime && DOCUMENT_MIMES.has(mime.toLowerCase())) return true;
  return DOCUMENT_EXT.has(ext(fileName));
}

export function defaultArtifactType(kind: "note" | "attachment", fileName: string | null): ArtifactType {
  if (kind === "note") return "note";
  return SPREADSHEET_EXT.has(ext(fileName)) ? "model" : "other";
}
