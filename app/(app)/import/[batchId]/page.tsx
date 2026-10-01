import { notFound } from "next/navigation";
import { requireUser } from "@/lib/supabase/server";
import { getAsOf } from "@/lib/asof-server";
import { fetchEntitiesAsOf, fetchAliasesAsOf, identityFromAliases } from "@/lib/queries";
import { ImportProgress } from "@/components/import-progress";
import { ImportReview } from "@/components/import-review";
import type { ImportBatchRow, ImportItemRow } from "@/lib/types";

export default async function ImportBatchPage({ params }: PageProps<"/import/[batchId]">) {
  const { batchId } = await params;
  const { supabase, user } = await requireUser();
  const { data: b } = await supabase.from("import_batch").select("*").eq("id", batchId).single();
  if (!b) notFound();
  const batch = b as ImportBatchRow;

  const [{ data: rows }, entities, aliases] = await Promise.all([
    supabase.from("import_item").select("*").eq("batch_id", batchId).order("position"),
    fetchEntitiesAsOf(supabase, await getAsOf()),
    fetchAliasesAsOf(supabase, await getAsOf()),
  ]);
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
      {batch.status === "parsing" && <ImportProgress batchId={batch.id} initialDone={batch.bytes_done} initialTotal={batch.bytes_total} />}
      {batch.status === "failed" && <p className="text-sm text-oxblood bg-oxblood-wash border border-oxblood/30 px-3 py-2">{batch.error}</p>}
      {batch.status !== "parsing" && batch.status !== "failed" && (
        <ImportReview batch={batch} items={(rows ?? []) as ImportItemRow[]} entities={options} canEdit={batch.created_by === user.id} />
      )}
    </div>
  );
}
