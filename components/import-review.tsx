"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { bulkUpdateImportItems, commitImportBatch, discardImportBatch, updateImportItem } from "@/actions/import";
import type { ArtifactType, ImportBatchRow, ImportItemRow } from "@/lib/types";

const TYPES: ArtifactType[] = ["note", "model", "primer", "thesis", "filing", "transcript", "other"];
type Filter = "all" | "ready" | "unmatched" | "duplicates";

export function ImportReview({
  batch, items, entities, canEdit,
}: { batch: ImportBatchRow; items: ImportItemRow[]; entities: { id: string; label: string }[]; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkEntity, setBulkEntity] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const label = useMemo(() => new Map(entities.map((e) => [e.id, e.label])), [entities]);

  const visible = items.filter((i) =>
    filter === "all" ? true
    : filter === "unmatched" ? i.status === "unmatched"
    : filter === "duplicates" ? i.status === "duplicate"
    : i.include && i.chosen_entity_ids.length > 0 && i.status !== "imported",
  );
  const counts = {
    notes: items.filter((i) => i.kind === "note").length,
    docs: items.filter((i) => i.kind === "attachment").length,
    unmatched: items.filter((i) => i.status === "unmatched").length,
    duplicates: items.filter((i) => i.status === "duplicate").length,
    ready: items.filter((i) => i.include && i.chosen_entity_ids.length > 0 && !["imported", "skipped"].includes(i.status)).length,
  };

  const act = (fn: () => Promise<{ error: string | null }>) =>
    start(async () => {
      const r = await fn();
      if (r.error) setMessage(r.error);
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

  const readOnly = !canEdit || batch.status === "imported" || batch.status === "discarded";

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

      {!readOnly && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 bg-paper-deep border border-rule px-3 py-2 text-xs">
          <span className="font-data">{selected.size} selected</span>
          <select value={bulkEntity} onChange={(e) => setBulkEntity(e.target.value)} className="border border-rule bg-card px-2 py-1 font-data">
            <option value="">Add company…</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
          <button disabled={!bulkEntity || pending} onClick={() => act(() => bulkUpdateImportItems([...selected], { addEntityId: bulkEntity }))} className="border border-rule px-2 py-1 disabled:opacity-50">Apply</button>
          <button disabled={pending} onClick={() => act(() => bulkUpdateImportItems([...selected], { include: true }))} className="border border-rule px-2 py-1">Tick</button>
          <button disabled={pending} onClick={() => act(() => bulkUpdateImportItems([...selected], { include: false }))} className="border border-rule px-2 py-1">Untick</button>
        </div>
      )}

      <table className="w-full bg-card border border-rule text-sm">
        <thead>
          <tr className="text-left">
            <th className="px-2 py-2 border-b-2 border-rule-strong"><input type="checkbox" onChange={(e) => setSelected(e.target.checked ? new Set(visible.map((i) => i.id)) : new Set())} /></th>
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
              <td className="px-2 py-1.5"><input type="checkbox" checked={selected.has(i.id)} onChange={() => toggleSel(i.id)} /></td>
              <td className="px-2 py-1.5"><input type="checkbox" checked={i.include} disabled={readOnly || i.status === "imported"} onChange={(e) => act(() => updateImportItem(i.id, { include: e.target.checked }))} /></td>
              <td className={`px-2 py-1.5 ${i.kind === "attachment" ? "pl-8 text-ink-soft" : ""}`} title={i.body ?? i.file_name ?? ""}>
                {i.title}
                {i.kind === "attachment" && i.bytes != null && <span className="ml-2 font-data text-xs">{Math.round(i.bytes / 1024)} KB</span>}
              </td>
              <td className="px-2 py-1.5 font-data text-xs">{i.valid_at.slice(0, 10)}</td>
              <td className="px-2 py-1.5">
                <select value={i.artifact_type} disabled={readOnly} onChange={(e) => act(() => updateImportItem(i.id, { artifact_type: e.target.value as ArtifactType }))} className="border border-rule bg-card px-1 py-0.5 font-data text-xs">
                  {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </td>
              <td className="px-2 py-1.5">
                <div className="flex flex-wrap gap-1 items-center">
                  {i.chosen_entity_ids.map((id) => (
                    <span key={id} className="text-[10px] font-data uppercase bg-pine-wash text-pine px-1.5 py-0.5">
                      {label.get(id) ?? id.slice(0, 8)}
                      {!readOnly && <button className="ml-1" onClick={() => act(() => updateImportItem(i.id, { chosen_entity_ids: i.chosen_entity_ids.filter((x) => x !== id) }))}>×</button>}
                    </span>
                  ))}
                  {!readOnly && (
                    <select value="" onChange={(e) => e.target.value && act(() => updateImportItem(i.id, { chosen_entity_ids: [...i.chosen_entity_ids, e.target.value] }))} className="border border-rule bg-card px-1 py-0.5 font-data text-[10px]">
                      <option value="">+</option>
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

      {!readOnly && (
        <div className="flex gap-3">
          <button disabled={pending || counts.ready === 0} onClick={runImport} className="bg-pine text-paper px-6 py-2.5 text-sm font-data uppercase tracking-wider hover:bg-pine-dark disabled:opacity-50">
            Import {counts.ready} item{counts.ready === 1 ? "" : "s"}
          </button>
          <button disabled={pending} onClick={() => { if (confirm("Discard this batch? Nothing has been written to the record.")) act(() => discardImportBatch(batch.id)); }} className="border border-rule px-4 py-2.5 text-sm font-data uppercase tracking-wider">Discard</button>
        </div>
      )}
    </div>
  );
}
