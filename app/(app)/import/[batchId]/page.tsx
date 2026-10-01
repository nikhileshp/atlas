import { notFound } from "next/navigation";
import { requireUser } from "@/lib/supabase/server";
import { fetchEntitiesAsOf, fetchAliasesAsOf, identityFromAliases } from "@/lib/queries";
import { ImportProgress } from "@/components/import-progress";
import { ImportReview } from "@/components/import-review";
import { fetchAll } from "@/lib/import/dedupe";
import type { ImportBatchRow, ImportItemRow } from "@/lib/types";

const PREVIEW_CHARS = 300;

// Parse and Import steps are Server Actions invoked from this page; each does
// about 8 s of work, and this is the ceiling the platform allows them.
export const maxDuration = 60;

export default async function ImportBatchPage({ params }: PageProps<"/import/[batchId]">) {
  const { batchId } = await params;
  const { supabase, user } = await requireUser();
  const { data: b } = await supabase.from("import_batch").select("*").eq("id", batchId).single();
  if (!b) notFound();
  const batch = b as ImportBatchRow;
  const canEdit = batch.created_by === user.id;

  // The review table must show every item Import will write: PostgREST caps a
  // response at 1000 rows, so the items are paged. Bodies are trimmed to a
  // preview — the full text is not needed to review and would be re-sent on
  // every refresh.
  const [rows, entities, aliases] = await Promise.all([
    fetchAll<ImportItemRow>((from, to) =>
      supabase.from("import_item").select("*").eq("batch_id", batchId).order("position").range(from, to),
    ),
    fetchEntitiesAsOf(supabase, new Date()),
    fetchAliasesAsOf(supabase, new Date()),
  ]);
  const items = rows.map((r) => (r.body && r.body.length > PREVIEW_CHARS ? { ...r, body: `${r.body.slice(0, PREVIEW_CHARS)}…` } : r));
  const identity = identityFromAliases(aliases);
  const options = entities.map((e) => ({
    id: e.id,
    label: `${identity.get(e.id)?.legalName ?? e.cik} (${identity.get(e.id)?.tickers.join(", ") || "CIK " + e.cik})`,
  }));

  return (
    <div className="rise space-y-6">
      <header>
        <h1 className="font-display text-3xl text-pine-dark">{batch.file_name}</h1>
        <p className="text-xs font-data uppercase tracking-wider text-ink-soft mt-1">{batch.status}</p>
      </header>
      {(batch.status === "parsing" || batch.status === "failed") && (
        <ImportProgress
          key={batch.status}
          batchId={batch.id}
          failed={batch.status === "failed"}
          failedError={batch.error}
          initialDone={batch.bytes_done}
          initialTotal={batch.bytes_total}
          canEdit={canEdit}
        />
      )}
      {batch.status !== "parsing" && batch.status !== "failed" && (
        <ImportReview batch={batch} items={items} entities={options} canEdit={canEdit} />
      )}
    </div>
  );
}
