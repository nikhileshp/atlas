"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/supabase/server";
import { canWriteResearch } from "@/lib/roles";
import { isOwnedStorageKey } from "@/lib/storage";
import { env } from "@/lib/env";
import { parseBatchStep } from "@/lib/import/parse-run";
import { commitBatchPage } from "@/lib/import/commit-run";
import type { ArtifactType, ImportBatchRow, ImportBatchStatus } from "@/lib/types";

async function ownedBatch(batchId: string) {
  const { supabase, user, profile } = await requireUser();
  if (!canWriteResearch(profile.role)) throw new Error("Your role cannot import.");
  const { data } = await supabase.from("import_batch").select("*").eq("id", batchId).single();
  const batch = data as ImportBatchRow | null;
  if (!batch || batch.created_by !== user.id) throw new Error("Batch not found.");
  return { supabase, user, profile, batch };
}

export async function startImportBatch(storageKey: string, fileName: string) {
  const { supabase, user, profile } = await requireUser();
  if (!canWriteResearch(profile.role)) return { batchId: null, error: "Your role cannot import." };
  if (!isOwnedStorageKey(storageKey, profile.org_id)) return { batchId: null, error: "Upload did not complete." };
  const { data, error } = await supabase
    .from("import_batch")
    .insert({ org_id: profile.org_id, created_by: user.id, source_kind: "enex", storage_key: storageKey, file_name: fileName })
    .select("id")
    .single();
  if (error || !data) return { batchId: null, error: error?.message ?? "Could not start import." };
  revalidatePath("/import");
  return { batchId: data.id as string, error: null };
}

export async function parseImportChunk(batchId: string) {
  try {
    const { supabase } = await ownedBatch(batchId);
    const { done, batch } = await parseBatchStep(supabase, batchId, { bucket: env("SUPABASE_STORAGE_BUCKET") });
    if (done) revalidatePath(`/import/${batchId}`);
    return { done, status: batch.status as ImportBatchStatus, bytesDone: batch.bytes_done, bytesTotal: batch.bytes_total, notesSeen: batch.notes_seen, error: batch.error };
  } catch (e) {
    return { done: true, status: "failed" as ImportBatchStatus, bytesDone: 0, bytesTotal: null, notesSeen: 0, error: e instanceof Error ? e.message : "Parse failed." };
  }
}

export async function updateImportItem(
  itemId: string,
  patch: { include?: boolean; chosen_entity_ids?: string[]; artifact_type?: ArtifactType },
) {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from("import_item").update(patch).eq("id", itemId).select("batch_id").single();
  if (error || !data) return { error: error?.message ?? "Not allowed." };
  revalidatePath(`/import/${data.batch_id}`);
  return { error: null };
}

export async function bulkUpdateImportItems(
  itemIds: string[],
  patch: { include?: boolean; addEntityId?: string; artifact_type?: ArtifactType },
) {
  const { supabase } = await requireUser();
  if (itemIds.length === 0) return { error: null };
  const { data: rows, error } = await supabase.from("import_item").select("id,batch_id,chosen_entity_ids").in("id", itemIds);
  if (error) return { error: error.message };
  for (const r of rows ?? []) {
    const next: Record<string, unknown> = {};
    if (patch.include !== undefined) next.include = patch.include;
    if (patch.artifact_type) next.artifact_type = patch.artifact_type;
    if (patch.addEntityId && !r.chosen_entity_ids.includes(patch.addEntityId)) next.chosen_entity_ids = [...r.chosen_entity_ids, patch.addEntityId];
    if (Object.keys(next).length) await supabase.from("import_item").update(next).eq("id", r.id);
  }
  if (rows?.length) revalidatePath(`/import/${rows[0].batch_id}`);
  return { error: null };
}

export async function commitImportBatch(batchId: string) {
  try {
    const { supabase, user, profile, batch } = await ownedBatch(batchId);
    if (!["review", "importing"].includes(batch.status)) return { remaining: 0, error: `Batch is ${batch.status}.` };
    const { remaining } = await commitBatchPage(supabase, { orgId: profile.org_id, userId: user.id, importerName: profile.display_name }, batchId, 50);
    revalidatePath(`/import/${batchId}`);
    revalidatePath("/");
    return { remaining, error: null };
  } catch (e) {
    return { remaining: 0, error: e instanceof Error ? e.message : "Import failed." };
  }
}

export async function discardImportBatch(batchId: string) {
  try {
    const { supabase, batch } = await ownedBatch(batchId);
    if (batch.status === "imported") return { error: "Already imported." };
    await supabase.from("import_batch").update({ status: "discarded", updated_at: new Date().toISOString() }).eq("id", batchId);
    revalidatePath("/import");
    revalidatePath(`/import/${batchId}`);
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not discard." };
  }
}
