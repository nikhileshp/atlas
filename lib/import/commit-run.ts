/**
 * Writes staged items into the record, one page per call, through the
 * caller's JWT client (RLS + attribution apply exactly as for manual ingest).
 *
 * - Idempotent: only items still 'pending' | 'unmatched' | 'duplicate' are
 *   touched; a call stops at its time budget and the next one continues.
 * - Versioning: an item supersedes an existing artifact ONLY when the parser
 *   flagged it as a duplicate of that artifact and the reviewer chose to
 *   include it anyway. Two items in one batch that merely share a hash (empty
 *   clips, the same deck attached to two notes) stay independent artifacts —
 *   they must never become "versions" of each other.
 * - Artifacts and links are written together; a link failure retracts the
 *   orphan with a tombstone (same rule as actions/artifacts.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { artifactPayloadFor } from "@/lib/import/commit";
import { isLiveArtifact } from "@/lib/import/dedupe";
import type { ImportItemRow, ImportItemStatus } from "@/lib/types";

export interface CommitRunContext {
  orgId: string;
  userId: string;
  importerName: string;
}

const OPEN_STATUSES = ["pending", "unmatched", "duplicate"] as const;
const IN_CHUNK = 100;

/** Progress could not be recorded; continuing would re-import the same item. */
class CommitAbort extends Error {}

export async function commitBatchPage(
  supabase: SupabaseClient,
  ctx: CommitRunContext,
  batchId: string,
  pageSize: number,
  deadlineMs = 8000,
): Promise<{ processed: number; remaining: number }> {
  const deadline = Date.now() + deadlineMs;
  await supabase
    .from("import_batch")
    .update({ status: "importing", updated_at: new Date().toISOString() })
    .eq("id", batchId)
    .eq("status", "review");

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
  for (let i = 0; i < parentIds.length; i += IN_CHUNK) {
    const { data: parents } = await supabase.from("import_item").select("id,title").in("id", parentIds.slice(i, i + IN_CHUNK));
    for (const p of parents ?? []) noteTitle.set(p.id as string, p.title as string);
  }

  // companies must exist (and be visible to this user) before anything is written
  const wanted = [...new Set(items.flatMap((i) => i.chosen_entity_ids))];
  const validEntities = new Set<string>();
  for (let i = 0; i < wanted.length; i += IN_CHUNK) {
    const { data: found, error: eErr } = await supabase.from("entity").select("id").in("id", wanted.slice(i, i + IN_CHUNK));
    if (eErr) throw new Error(`load companies: ${eErr.message}`);
    for (const e of found ?? []) validEntities.add(e.id as string);
  }

  const mark = async (id: string, patch: { status: ImportItemStatus; artifact_id?: string | null; error?: string | null }) => {
    const { error: mErr } = await supabase.from("import_item").update(patch).eq("id", id);
    if (mErr) throw new CommitAbort(`Could not record import progress: ${mErr.message}`);
  };

  let processed = 0;
  for (const item of items) {
    processed += 1;
    if (!item.include || item.chosen_entity_ids.length === 0) {
      await mark(item.id, { status: "skipped" });
    } else if (item.chosen_entity_ids.some((id) => !validEntities.has(id))) {
      await mark(item.id, { status: "error", error: "Unknown company in the selection — remove it and retry." });
    } else if (item.kind === "attachment" && !item.storage_key) {
      await mark(item.id, { status: "error", error: "This attachment was not stored and cannot be imported." });
    } else {
      try {
        const predecessorId =
          item.status === "duplicate" && item.duplicate_of && (await isLiveArtifact(supabase, item.duplicate_of))
            ? item.duplicate_of
            : null;

        const payload = artifactPayloadFor(item, {
          ...ctx,
          noteTitle: item.parent_item_id ? (noteTitle.get(item.parent_item_id) ?? null) : null,
          predecessorId,
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
        await mark(item.id, { status: "imported", artifact_id: artifact.id as string, error: null });
      } catch (e) {
        if (e instanceof CommitAbort) throw e;
        await mark(item.id, { status: "error", error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (Date.now() > deadline) break;
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
  return { processed, remaining };
}

/**
 * Put failed items that still have their content back in the queue (a
 * transient insert failure should not be permanent) and reopen the batch.
 * Returns how many items were reopened.
 */
export async function reopenErrorItems(supabase: SupabaseClient, batchId: string): Promise<number> {
  const { data, error } = await supabase
    .from("import_item")
    .update({ status: "pending", error: null })
    .eq("batch_id", batchId)
    .eq("status", "error")
    .is("artifact_id", null)
    .or("and(kind.eq.note,body.not.is.null),and(kind.eq.attachment,storage_key.not.is.null)")
    .select("id");
  if (error) throw new Error(`reopen errors: ${error.message}`);
  const n = data?.length ?? 0;
  if (n > 0) {
    await supabase.from("import_batch").update({ status: "review", updated_at: new Date().toISOString() }).eq("id", batchId);
  }
  return n;
}
