"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "@/lib/supabase/server";
import { canWriteResearch } from "@/lib/roles";
import { isOwnedStorageKey } from "@/lib/storage";
import { env } from "@/lib/env";
import { parseBatchStep } from "@/lib/import/parse-run";
import { commitBatchPage, reopenErrorItems } from "@/lib/import/commit-run";
import { sanitizeItemPatch } from "@/lib/import/review";
import type { ArtifactType, ImportBatchRow, ImportBatchStatus } from "@/lib/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES: ReadonlySet<string> = new Set(["note", "model", "primer", "thesis", "filing", "transcript", "other"]);
const CHUNK = 100;

/** The caller's own batch, or an error. Every action goes through this. */
async function ownedBatch(batchId: string) {
  const { supabase, user, profile } = await requireUser();
  if (!canWriteResearch(profile.role)) throw new Error("Your role cannot import.");
  if (!UUID.test(batchId)) throw new Error("Batch not found.");
  const { data } = await supabase.from("import_batch").select("*").eq("id", batchId).maybeSingle();
  const batch = data as ImportBatchRow | null;
  if (!batch || batch.created_by !== user.id) throw new Error("Batch not found.");
  return { supabase, user, profile, batch };
}

/** Review edits are only allowed while the batch is in review. */
async function reviewableBatchOf(itemIds: string[]) {
  const { supabase, user, profile } = await requireUser();
  if (!canWriteResearch(profile.role)) throw new Error("Your role cannot import.");
  if (itemIds.length === 0 || itemIds.some((id) => !UUID.test(id))) throw new Error("No items selected.");
  const batchIds = new Set<string>();
  for (let i = 0; i < itemIds.length; i += CHUNK) {
    const { data, error } = await supabase.from("import_item").select("batch_id").in("id", itemIds.slice(i, i + CHUNK));
    if (error) throw new Error(error.message);
    for (const r of data ?? []) batchIds.add(r.batch_id as string);
  }
  if (batchIds.size !== 1) throw new Error("Items must belong to one batch.");
  const [batchId] = [...batchIds];
  const { data: b } = await supabase.from("import_batch").select("id,status,created_by").eq("id", batchId).maybeSingle();
  if (!b || b.created_by !== user.id) throw new Error("Batch not found.");
  if (b.status !== "review") throw new Error(`This batch is ${b.status}; it can no longer be edited.`);
  return { supabase, batchId };
}

async function unknownEntities(supabase: SupabaseClient, ids: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data } = await supabase.from("entity").select("id").in("id", ids.slice(i, i + CHUNK));
    for (const e of data ?? []) found.add(e.id as string);
  }
  return ids.filter((id) => !found.has(id));
}

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export async function startImportBatch(storageKey: string, fileName: string) {
  const { supabase, user, profile } = await requireUser();
  if (!canWriteResearch(profile.role)) return { batchId: null, error: "Your role cannot import." };
  if (!isOwnedStorageKey(storageKey, profile.org_id)) return { batchId: null, error: "Upload did not complete." };
  const { data, error } = await supabase
    .from("import_batch")
    .insert({ org_id: profile.org_id, created_by: user.id, source_kind: "enex", storage_key: storageKey, file_name: String(fileName).slice(0, 255) })
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
    return { done: true, status: "failed" as ImportBatchStatus, bytesDone: 0, bytesTotal: null, notesSeen: 0, error: message(e, "Parse failed.") };
  }
}

/** A failed parse keeps its offset; put it back in the queue. */
export async function retryImportBatch(batchId: string) {
  try {
    const { supabase, batch } = await ownedBatch(batchId);
    if (batch.status !== "failed") return { error: `Batch is ${batch.status}.` };
    const { error } = await supabase
      .from("import_batch")
      .update({ status: "parsing", error: null, updated_at: new Date().toISOString() })
      .eq("id", batchId);
    if (error) return { error: error.message };
    revalidatePath(`/import/${batchId}`);
    return { error: null };
  } catch (e) {
    return { error: message(e, "Could not retry.") };
  }
}

export async function updateImportItem(itemId: string, rawPatch: unknown) {
  try {
    const { patch, error: vErr } = sanitizeItemPatch(rawPatch);
    if (vErr || !patch) return { error: vErr ?? "Nothing to change." };
    const { supabase, batchId } = await reviewableBatchOf([itemId]);
    if (patch.chosen_entity_ids?.length) {
      const missing = await unknownEntities(supabase, patch.chosen_entity_ids);
      if (missing.length) return { error: "Unknown company in the selection." };
    }
    const { data, error } = await supabase
      .from("import_item")
      .update(patch)
      .eq("id", itemId)
      .not("status", "in", "(imported,error)")
      .select("id");
    if (error) return { error: error.message };
    if (!data?.length) return { error: "This item can no longer be edited." };
    revalidatePath(`/import/${batchId}`);
    return { error: null };
  } catch (e) {
    return { error: message(e, "Could not update the item.") };
  }
}

export async function bulkUpdateImportItems(
  itemIds: string[],
  patch: { include?: boolean; addEntityId?: string; artifact_type?: ArtifactType },
) {
  try {
    const ids = [...new Set(itemIds)];
    const { supabase, batchId } = await reviewableBatchOf(ids);
    const set: { include?: boolean; artifact_type?: ArtifactType } = {};
    if (patch.include !== undefined) {
      if (typeof patch.include !== "boolean") return { error: "include must be true or false." };
      set.include = patch.include;
    }
    if (patch.artifact_type !== undefined) {
      if (!TYPES.has(patch.artifact_type)) return { error: "Unknown artifact type." };
      set.artifact_type = patch.artifact_type;
    }
    if (patch.addEntityId !== undefined) {
      if (!UUID.test(patch.addEntityId) || (await unknownEntities(supabase, [patch.addEntityId])).length) {
        return { error: "Unknown company." };
      }
    }

    const errors: string[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      if (Object.keys(set).length) {
        const { error } = await supabase.from("import_item").update(set).in("id", slice).not("status", "in", "(imported,error)");
        if (error) errors.push(error.message);
      }
      if (patch.addEntityId) {
        const add = patch.addEntityId;
        const { data: rows, error } = await supabase
          .from("import_item")
          .select("id,chosen_entity_ids")
          .in("id", slice)
          .not("status", "in", "(imported,error)");
        if (error) errors.push(error.message);
        const results = await Promise.all(
          (rows ?? [])
            .filter((r) => !(r.chosen_entity_ids as string[]).includes(add))
            .map((r) =>
              supabase
                .from("import_item")
                .update({ chosen_entity_ids: [...(r.chosen_entity_ids as string[]), add] })
                .eq("id", r.id),
            ),
        );
        for (const r of results) if (r.error) errors.push(r.error.message);
      }
    }
    revalidatePath(`/import/${batchId}`);
    return { error: errors.length ? `${errors.length} update(s) failed: ${errors[0]}` : null };
  } catch (e) {
    return { error: message(e, "Could not update the items.") };
  }
}

export async function commitImportBatch(batchId: string) {
  try {
    const { supabase, user, profile, batch } = await ownedBatch(batchId);
    if (!["review", "importing"].includes(batch.status)) return { remaining: 0, error: `Batch is ${batch.status}.` };
    const { remaining } = await commitBatchPage(
      supabase,
      { orgId: profile.org_id, userId: user.id, importerName: profile.display_name },
      batchId,
      50,
    );
    revalidatePath(`/import/${batchId}`);
    revalidatePath("/");
    return { remaining, error: null };
  } catch (e) {
    return { remaining: 0, error: message(e, "Import failed.") };
  }
}

/** Put failed-but-recoverable items back in the queue and reopen the batch. */
export async function retryImportErrors(batchId: string) {
  try {
    const { supabase, batch } = await ownedBatch(batchId);
    if (!["review", "importing", "imported"].includes(batch.status)) return { reopened: 0, error: `Batch is ${batch.status}.` };
    const reopened = await reopenErrorItems(supabase, batchId);
    revalidatePath(`/import/${batchId}`);
    return { reopened, error: null };
  } catch (e) {
    return { reopened: 0, error: message(e, "Could not retry.") };
  }
}

export async function discardImportBatch(batchId: string) {
  try {
    const { supabase, batch } = await ownedBatch(batchId);
    if (batch.status === "imported") return { error: "Already imported." };
    const { error } = await supabase
      .from("import_batch")
      .update({ status: "discarded", updated_at: new Date().toISOString() })
      .eq("id", batchId);
    if (error) return { error: error.message };
    revalidatePath("/import");
    revalidatePath(`/import/${batchId}`);
    return { error: null };
  } catch (e) {
    return { error: message(e, "Could not discard.") };
  }
}
