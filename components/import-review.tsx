"use client";

import { useMemo, useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  bulkUpdateImportItems,
  commitImportBatch,
  discardImportBatch,
  retryImportErrors,
  updateImportItem,
} from "@/actions/import";
import type { ArtifactType, ImportBatchRow, ImportItemRow } from "@/lib/types";

const TYPES: ArtifactType[] = ["note", "model", "primer", "thesis", "filing", "transcript", "other"];
type Filter = "all" | "ready" | "unmatched" | "duplicates";
type IncludePatch = { ids: string[]; include: boolean };

const isReady = (i: ImportItemRow) =>
  i.include && i.chosen_entity_ids.length > 0 && !["imported", "skipped", "error"].includes(i.status);
/** An error item that still has its content can be put back in the queue. */
const isRetriable = (i: ImportItemRow) =>
  i.status === "error" && !i.artifact_id && (i.kind === "note" ? i.body !== null : i.storage_key !== null);

export function ImportReview({
  batch, items, entities, canEdit,
}: { batch: ImportBatchRow; items: ImportItemRow[]; entities: { id: string; label: string }[]; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkEntity, setBulkEntity] = useState("");
  const [bulkType, setBulkType] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const label = useMemo(() => new Map(entities.map((e) => [e.id, e.label])), [entities]);

  // Include ticks respond immediately. The optimistic value lives only for the
  // duration of the transition; when the refresh lands (or the action fails)
  // the server's value is what is shown — it can never go stale.
  const [view, applyInclude] = useOptimistic(items, (state: ImportItemRow[], p: IncludePatch) =>
    state.map((i) => (p.ids.includes(i.id) ? { ...i, include: p.include } : i)),
  );

  const visible = view.filter((i) =>
    filter === "all" ? true
    : filter === "unmatched" ? i.status === "unmatched"
    : filter === "duplicates" ? i.status === "duplicate"
    : isReady(i),
  );
  const counts = {
    notes: view.filter((i) => i.kind === "note").length,
    docs: view.filter((i) => i.kind === "attachment").length,
    unmatched: view.filter((i) => i.status === "unmatched").length,
    duplicates: view.filter((i) => i.status === "duplicate").length,
    ready: view.filter(isReady).length,
    imported: view.filter((i) => i.status === "imported").length,
    retriable: view.filter(isRetriable).length,
  };

  const act = (fn: () => Promise<{ error: string | null }>, optimistic?: IncludePatch) =>
    start(async () => {
      if (optimistic) applyInclude(optimistic);
      const r = await fn();
      setMessage(r.error);
      router.refresh();
    });

  const runImport = () =>
    start(async () => {
      setMessage("Importing…");
      for (;;) {
        const r = await commitImportBatch(batch.id);
        if (r.error) { setMessage(r.error); break; }
        if (r.remaining === 0) { setMessage(null); break; }
      }
      router.refresh();
    });

  const toggleSel = (id: string) =>
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const editable = canEdit && batch.status === "review";
  const closed = batch.status === "imported" || batch.status === "discarded";
  const rowLocked = (i: ImportItemRow) => !editable || i.status === "imported" || i.status === "error";
  const ids = [...selected];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-xs font-data">
        <span>{counts.notes} notes · {counts.docs} documents · {batch.images_skipped} images skipped</span>
        <span className="text-ink-soft">· {counts.ready} ready · {counts.unmatched} unmatched · {counts.duplicates} duplicates</span>
        <span className="flex-1" />
        {(["all", "ready", "unmatched", "duplicates"] as Filter[]).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={`uppercase tracking-wider px-2 py-1 border ${filter === f ? "border-pine bg-pine-wash" : "border-rule"}`}>{f}</button>
        ))}
      </div>

      {editable && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 bg-paper-deep border border-rule px-3 py-2 text-xs">
          <span className="font-data">{selected.size} selected</span>
          <select data-bare aria-label="Company to add" value={bulkEntity} onChange={(e) => setBulkEntity(e.target.value)} className="border border-rule bg-card px-2 py-1 font-data">
            <option value="">Add company…</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
          <button disabled={!bulkEntity || pending} onClick={() => act(() => bulkUpdateImportItems(ids, { addEntityId: bulkEntity }))} className="border border-rule px-2 py-1 disabled:opacity-50">Add</button>
          <select data-bare aria-label="Type to set" value={bulkType} onChange={(e) => setBulkType(e.target.value)} className="border border-rule bg-card px-2 py-1 font-data">
            <option value="">Set type…</option>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button disabled={!bulkType || pending} onClick={() => act(() => bulkUpdateImportItems(ids, { artifact_type: bulkType as ArtifactType }))} className="border border-rule px-2 py-1 disabled:opacity-50">Set</button>
          <button disabled={pending} onClick={() => act(() => bulkUpdateImportItems(ids, { include: true }), { ids, include: true })} className="border border-rule px-2 py-1">Tick</button>
          <button disabled={pending} onClick={() => act(() => bulkUpdateImportItems(ids, { include: false }), { ids, include: false })} className="border border-rule px-2 py-1">Untick</button>
        </div>
      )}

      <table className="w-full bg-card border border-rule text-sm">
        <thead>
          <tr className="text-left">
            <th className="px-2 py-2 border-b-2 border-rule-strong"><input type="checkbox" aria-label="Select all shown" onChange={(e) => setSelected(e.target.checked ? new Set(visible.map((i) => i.id)) : new Set())} /></th>
            <th className="section-label px-2 py-2 border-b-2 border-rule-strong">Include</th>
            <th className="section-label px-2 py-2 border-b-2 border-rule-strong">Title</th>
            <th className="section-label px-2 py-2 border-b-2 border-rule-strong">Date</th>
            <th className="section-label px-2 py-2 border-b-2 border-rule-strong">Type</th>
            <th className="section-label px-2 py-2 border-b-2 border-rule-strong">Companies</th>
            <th className="section-label px-2 py-2 border-b-2 border-rule-strong">Status</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((i) => (
            <tr key={i.id} className={`border-b border-rule ${i.kind === "attachment" ? "bg-paper-deep/40" : ""}`}>
              <td className="px-2 py-1.5"><input type="checkbox" aria-label="Select row" checked={selected.has(i.id)} onChange={() => toggleSel(i.id)} /></td>
              <td className="px-2 py-1.5">
                <input
                  type="checkbox"
                  aria-label="Include in import"
                  checked={i.include}
                  disabled={rowLocked(i)}
                  onChange={(e) => {
                    const include = e.target.checked;
                    act(() => updateImportItem(i.id, { include }), { ids: [i.id], include });
                  }}
                />
              </td>
              <td className={`px-2 py-1.5 ${i.kind === "attachment" ? "pl-8 text-ink-soft" : ""}`} title={i.body ?? i.file_name ?? ""}>
                {i.title}
                {i.kind === "attachment" && i.bytes != null && <span className="ml-2 font-data text-xs">{i.bytes < 1024 ? "<1 KB" : `${Math.round(i.bytes / 1024)} KB`}</span>}
              </td>
              <td className="px-2 py-1.5 font-data text-xs">{i.valid_at.slice(0, 10)}</td>
              <td className="px-2 py-1.5">
                <select data-bare aria-label="Artifact type" value={i.artifact_type} disabled={rowLocked(i)} onChange={(e) => act(() => updateImportItem(i.id, { artifact_type: e.target.value as ArtifactType }))} className="border border-rule bg-card px-1 py-0.5 font-data text-xs">
                  {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </td>
              <td className="px-2 py-1.5">
                <div className="flex flex-wrap gap-1 items-center">
                  {i.chosen_entity_ids.map((id) => (
                    <span key={id} className="text-[10px] font-data uppercase bg-pine-wash text-pine px-1.5 py-0.5">
                      {label.get(id) ?? id.slice(0, 8)}
                      {!rowLocked(i) && <button aria-label="Remove company" className="ml-1" onClick={() => act(() => updateImportItem(i.id, { chosen_entity_ids: i.chosen_entity_ids.filter((x) => x !== id) }))}>×</button>}
                    </span>
                  ))}
                  {!rowLocked(i) && (
                    <select data-bare aria-label="Add company" value="" onChange={(e) => e.target.value && act(() => updateImportItem(i.id, { chosen_entity_ids: [...i.chosen_entity_ids, e.target.value] }))} className="w-auto max-w-[10rem] border border-rule bg-card px-1 py-0.5 font-data text-[10px]">
                      <option value="">+ add</option>
                      {entities.filter((e) => !i.chosen_entity_ids.includes(e.id)).map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
                    </select>
                  )}
                </div>
              </td>
              <td className="px-2 py-1.5 font-data text-[10px] uppercase">
                {i.status === "imported" && i.artifact_id ? <a href={`/artifacts/${i.artifact_id}`} className="text-pine underline decoration-dotted">imported</a> : i.status}
                {i.error && <span className="block normal-case text-oxblood">{i.error}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {message && <p className="text-sm bg-paper-deep border border-rule px-3 py-2">{message}</p>}

      {canEdit && batch.status !== "discarded" && (
        <div className="flex flex-wrap gap-3">
          {!closed && (
            <button disabled={pending || counts.ready === 0} onClick={runImport} className="bg-pine text-paper px-6 py-2.5 text-sm font-data uppercase tracking-wider hover:bg-pine-dark disabled:opacity-50">
              Import {counts.ready} item{counts.ready === 1 ? "" : "s"}
            </button>
          )}
          {counts.retriable > 0 && (
            <button disabled={pending} onClick={() => act(() => retryImportErrors(batch.id))} className="border border-rule px-4 py-2.5 text-sm font-data uppercase tracking-wider disabled:opacity-50">
              Retry {counts.retriable} failed
            </button>
          )}
          {!closed && (
            <button
              disabled={pending}
              onClick={() => {
                const warn = counts.imported > 0
                  ? `Discard the rest of this batch? ${counts.imported} item${counts.imported === 1 ? " is" : "s are"} already in the record and will stay there.`
                  : "Discard this batch? Nothing from it has been written to the record.";
                if (confirm(warn)) act(() => discardImportBatch(batch.id));
              }}
              className="border border-rule px-4 py-2.5 text-sm font-data uppercase tracking-wider disabled:opacity-50"
            >
              Discard
            </button>
          )}
        </div>
      )}
    </div>
  );
}
