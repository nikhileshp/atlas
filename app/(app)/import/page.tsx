import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/supabase/server";
import { canWriteResearch } from "@/lib/roles";
import { ImportUpload } from "@/components/import-upload";
import type { ImportBatchRow } from "@/lib/types";

// Server Actions invoked from this page (upload start) inherit this budget.
export const maxDuration = 60;

export default async function ImportPage() {
  const { supabase, user, profile } = await requireUser();
  if (!canWriteResearch(profile.role)) notFound();
  const { data } = await supabase
    .from("import_batch")
    .select("*")
    .eq("created_by", user.id)
    .order("created_at", { ascending: false })
    .limit(50);
  const batches = (data ?? []) as ImportBatchRow[];

  return (
    <div className="max-w-3xl rise space-y-8">
      <header>
        <h1 className="font-display text-3xl text-pine-dark">Import</h1>
        <p className="text-sm text-ink-soft mt-1">Bring existing research into the record. Suggested company links are reviewed before anything is written.</p>
      </header>
      <ImportUpload />
      {batches.length > 0 && (
        <table className="w-full bg-card border border-rule text-sm">
          <thead>
            <tr className="text-left">
              <th className="section-label px-4 py-2.5 border-b-2 border-rule-strong">File</th>
              <th className="section-label px-4 py-2.5 border-b-2 border-rule-strong">Status</th>
              <th className="section-label px-4 py-2.5 border-b-2 border-rule-strong">Notes</th>
              <th className="section-label px-4 py-2.5 border-b-2 border-rule-strong">Started</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id} className="border-b border-rule hover:bg-pine-wash/40">
                <td className="px-4 py-2.5"><Link href={`/import/${b.id}`} className="font-medium text-pine-dark hover:underline">{b.file_name}</Link></td>
                <td className="px-4 py-2.5 font-data text-xs uppercase">{b.status}</td>
                <td className="px-4 py-2.5 font-data text-xs">{b.notes_seen}</td>
                <td className="px-4 py-2.5 font-data text-xs text-ink-soft">{new Date(b.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
