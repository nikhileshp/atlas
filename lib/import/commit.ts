import type { ArtifactType, ImportItemRow, SourceKind } from "@/lib/types";

export interface ArtifactInsert {
  org_id: string;
  artifact_type: ArtifactType;
  source_kind: SourceKind;
  title: string;
  author: string;
  summary: string;
  storage_key: string | null;
  url: null;
  body: string | null;
  content_hash: string;
  created_by: string;
  valid_at: string;
  supersedes: string | null;
}

export interface CommitContext {
  orgId: string;
  userId: string;
  importerName: string;
  noteTitle: string | null;
  predecessorId: string | null;
}

/** Same shape the manual ingest path inserts (actions/artifacts.ts). */
export function artifactPayloadFor(item: ImportItemRow, ctx: CommitContext): ArtifactInsert {
  const isNote = item.kind === "note";
  return {
    org_id: ctx.orgId,
    artifact_type: item.artifact_type,
    source_kind: isNote ? "paste" : "file",
    title: isNote ? item.title : `${ctx.noteTitle ?? "Attachment"} — ${item.title}`,
    author: item.author?.trim() || ctx.importerName,
    summary: "",
    storage_key: isNote ? null : item.storage_key,
    url: null,
    body: isNote ? item.body : null,
    content_hash: item.content_hash,
    created_by: ctx.userId,
    valid_at: item.valid_at,
    supersedes: ctx.predecessorId,
  };
}
