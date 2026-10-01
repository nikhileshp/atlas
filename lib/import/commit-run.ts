/**
 * Writes staged items into the record, one page per call, through the
 * caller's JWT client (RLS + attribution apply exactly as for manual ingest).
 * Idempotent: only items still 'pending' | 'unmatched' | 'duplicate' are
 * touched. Artifacts and links are written together; a link failure retracts
 * the orphan with a tombstone (same rule as actions/artifacts.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAsOf } from "@/lib/asof";
import { artifactPayloadFor } from "@/lib/import/commit";
import type { ArtifactRow, ImportItemRow } from "@/lib/types";

export interface CommitRunContext {
  orgId: string;
  userId: string;
  importerName: string;
}

const OPEN_STATUSES = ["pending", "unmatched", "duplicate"] as const;

export async function commitBatchPage(
  supabase: SupabaseClient,
  ctx: CommitRunContext,
  batchId: string,
  pageSize: number,
): Promise<{ processed: number; remaining: number }> {
  await supabase.from("import_batch").update({ status: "importing", updated_at: new Date().toISOString() }).eq("id", batchId).eq("status", "review");

  const { data: page, error } = await supabase
    .from("import_item")
    .select("*")
    .eq("batch_id", batchId)
    .in("status", [...OPEN_STATUSES])
    .order("position")
    .limit(pageSize);
  if (error) throw new Error(`load items: ${error.message}`);
  const items = (page ?? []) as ImportItemRow[];

  // note titles for attachment naming (parents may be outside this page)
  const parentIds = [...new Set(items.map((i) => i.parent_item_id).filter((x): x is string => !!x))];
  const noteTitle = new Map<string, string>();
  if (parentIds.length) {
    const { data: parents } = await supabase.from("import_item").select("id,title").in("id", parentIds);
    for (const p of parents ?? []) noteTitle.set(p.id, p.title);
  }

  for (const item of items) {
    if (!item.include || item.chosen_entity_ids.length === 0) {
      await supabase.from("import_item").update({ status: "skipped" }).eq("id", item.id);
      continue;
    }
    try {
      const { data: sameHash } = await supabase.from("artifact").select("*").eq("content_hash", item.content_hash);
      const predecessor = resolveAsOf((sameHash ?? []) as ArtifactRow[], new Date())[0] ?? null;

      const payload = artifactPayloadFor(item, {
        ...ctx,
        noteTitle: item.parent_item_id ? (noteTitle.get(item.parent_item_id) ?? null) : null,
        predecessorId: predecessor?.id ?? null,
      });
      const { data: artifact, error: insErr } = await supabase.from("artifact").insert(payload).select("id").single();
      if (insErr || !artifact) throw new Error(insErr?.message ?? "artifact insert failed");

      const { error: linkErr } = await supabase.from("artifact_entity").insert(
        item.chosen_entity_ids.map((entityId) => ({
          org_id: ctx.orgId,
          artifact_id: artifact.id,
          entity_id: entityId,
          created_by: ctx.userId,
          valid_at: item.valid_at,
        })),
      );
      if (linkErr) {
        await supabase.from("artifact").insert({
          ...payload,
          summary: "Tombstone: entity links failed to save during import.",
          valid_at: new Date().toISOString(),
          supersedes: artifact.id,
          is_tombstone: true,
        });
        throw new Error(`links: ${linkErr.message}`);
      }
      await supabase.from("import_item").update({ status: "imported", artifact_id: artifact.id, error: null }).eq("id", item.id);
    } catch (e) {
      await supabase.from("import_item").update({ status: "error", error: e instanceof Error ? e.message : String(e) }).eq("id", item.id);
    }
  }

  const { count } = await supabase
    .from("import_item")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId)
    .in("status", [...OPEN_STATUSES]);
  const remaining = count ?? 0;
  if (remaining === 0) {
    await supabase.from("import_batch").update({ status: "imported", updated_at: new Date().toISOString() }).eq("id", batchId);
  }
  return { processed: items.length, remaining };
}
