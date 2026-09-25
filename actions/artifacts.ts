"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/supabase/server";
import { buildStorageKey, isOwnedStorageKey } from "@/lib/storage";
import { canWriteResearch } from "@/lib/roles";
import { env } from "@/lib/env";
import { sha256Hex } from "@/lib/hash";
import { resolveAsOf } from "@/lib/asof";
import type { ArtifactRow } from "@/lib/types";

export interface ArtifactFormState {
  error: string | null;
}

const ARTIFACT_TYPES = ["note", "model", "primer", "thesis", "filing", "transcript", "other"];

export interface PreparedUpload {
  storageKey: string;
  signedUrl: string;
  error: string | null;
}

/**
 * Step one of a file ingest. The browser uploads straight to Storage with a
 * signed URL minted under the caller's JWT (so the org-prefix policy applies),
 * because Server Actions cap request bodies at 1 MB and Vercel at 4.5 MB —
 * far below a primer or a model. createArtifact then receives only the key.
 */
export async function prepareUpload(fileName: string): Promise<PreparedUpload> {
  const { supabase, profile } = await requireUser();
  if (!canWriteResearch(profile.role)) {
    return { storageKey: "", signedUrl: "", error: "Your role cannot write artifacts." };
  }
  const storageKey = buildStorageKey(profile.org_id, fileName || "upload");
  const { data, error } = await supabase.storage
    .from(env("SUPABASE_STORAGE_BUCKET"))
    .createSignedUploadUrl(storageKey);
  if (error || !data) {
    return { storageKey: "", signedUrl: "", error: `Could not start upload: ${error?.message}` };
  }
  return { storageKey, signedUrl: data.signedUrl, error: null };
}

/**
 * Single ingest path for all three sources (file / url / paste).
 *  - files are already in Supabase Storage (see prepareUpload); the action
 *    receives the object key, verifies it belongs to the caller's org, and
 *    reads the object back to hash it — Postgres stores only the key
 *  - a content hash detects re-uploads: same hash -> new VERSION of the
 *    existing artifact (supersedes), never a silent duplicate
 *  - the entity link is a blocking requirement: an artifact linked to
 *    nothing is invisible and worthless, so it cannot be saved
 */
export async function createArtifact(
  _prev: ArtifactFormState,
  formData: FormData,
): Promise<ArtifactFormState> {
  const { supabase, user, profile } = await requireUser();

  const sourceKind = String(formData.get("source_kind") ?? "");
  const artifactType = String(formData.get("artifact_type") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const author = String(formData.get("author") ?? "").trim();
  const summary = String(formData.get("summary") ?? "").trim();
  const validAtRaw = String(formData.get("valid_at") ?? "");
  const entityIds = formData.getAll("entity_ids").map(String).filter(Boolean);

  if (!["file", "url", "paste"].includes(sourceKind)) return { error: "Pick a source." };
  if (!ARTIFACT_TYPES.includes(artifactType)) return { error: "Pick an artifact type." };
  if (!title) return { error: "Title is required." };
  if (!author) return { error: "Author is required." };
  if (!validAtRaw) return { error: "The date the content refers to is required." };
  if (entityIds.length === 0) {
    return { error: "Link at least one entity — an artifact linked to nothing is invisible." };
  }

  // all linked entities must exist in this org (RLS scopes the select)
  const { data: entities } = await supabase
    .from("entity")
    .select("id")
    .in("id", entityIds);
  if ((entities ?? []).length !== entityIds.length) {
    return { error: "One or more linked entities could not be found." };
  }

  // content by source kind + hash
  let url: string | null = null;
  let body: string | null = null;
  let storageKey: string | null = null;
  let contentHash: string;

  if (sourceKind === "file") {
    const key = String(formData.get("storage_key") ?? "");
    if (!isOwnedStorageKey(key, profile.org_id)) return { error: "Choose a file." };
    const { data: blob, error: readError } = await supabase.storage
      .from(env("SUPABASE_STORAGE_BUCKET"))
      .download(key);
    if (readError || !blob) {
      return { error: `Upload did not complete: ${readError?.message ?? "object missing"}` };
    }
    if (blob.size === 0) return { error: "The uploaded file is empty." };
    contentHash = sha256Hex(Buffer.from(await blob.arrayBuffer()));
    storageKey = key;
  } else if (sourceKind === "url") {
    url = String(formData.get("url") ?? "").trim();
    if (!/^https?:\/\/.+/.test(url)) return { error: "Enter a valid http(s) URL." };
    contentHash = sha256Hex(url);
  } else {
    body = String(formData.get("body") ?? "").trim();
    if (!body) return { error: "Paste the note text." };
    contentHash = sha256Hex(body);
  }

  // duplicate detection -> versioning
  const { data: sameHash } = await supabase
    .from("artifact")
    .select("*")
    .eq("content_hash", contentHash);
  const currentSameHash = resolveAsOf((sameHash ?? []) as ArtifactRow[], new Date());
  const predecessor = currentSameHash[0] ?? null;

  const { data: artifact, error } = await supabase
    .from("artifact")
    .insert({
      org_id: profile.org_id,
      artifact_type: artifactType,
      source_kind: sourceKind,
      title,
      author,
      summary,
      storage_key: storageKey,
      url,
      body,
      content_hash: contentHash,
      created_by: user.id,
      valid_at: new Date(validAtRaw).toISOString(),
      supersedes: predecessor?.id ?? null,
    })
    .select()
    .single();
  if (error) {
    return {
      error:
        error.code === "42501"
          ? "Your role cannot write artifacts (analyst, pm, or admin required)."
          : error.message,
    };
  }

  const linkRows = entityIds.map((entityId) => ({
    org_id: profile.org_id,
    artifact_id: artifact.id,
    entity_id: entityId,
    created_by: user.id,
    valid_at: new Date(validAtRaw).toISOString(),
  }));
  const { error: linkError } = await supabase.from("artifact_entity").insert(linkRows);
  if (linkError) {
    // append-only cleanup: retract the orphan with a tombstone, never delete
    await supabase.from("artifact").insert({
      org_id: profile.org_id,
      artifact_type: artifactType,
      source_kind: sourceKind,
      title,
      author,
      summary: "Tombstone: entity links failed to save.",
      created_by: user.id,
      valid_at: new Date().toISOString(),
      supersedes: artifact.id,
      is_tombstone: true,
    });
    return { error: `Entity links failed to save: ${linkError.message}` };
  }

  redirect(`/artifacts/${artifact.id}${predecessor ? "?version=of-existing" : ""}`);
}

/** "Delete" = a new tombstone row superseding the artifact. History stands. */
export async function tombstoneArtifact(formData: FormData): Promise<void> {
  const { supabase, user, profile } = await requireUser();
  const artifactId = String(formData.get("artifact_id") ?? "");

  const { data: artifact } = await supabase
    .from("artifact")
    .select("*")
    .eq("id", artifactId)
    .single();
  if (!artifact) return;

  await supabase.from("artifact").insert({
    org_id: profile.org_id,
    artifact_type: artifact.artifact_type,
    source_kind: artifact.source_kind,
    title: artifact.title,
    author: artifact.author,
    summary: "Tombstone: artifact retracted. Prior versions remain in history.",
    created_by: user.id,
    valid_at: new Date().toISOString(),
    supersedes: artifactId,
    is_tombstone: true,
  });

  revalidatePath("/", "layout");
}
