"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseImportChunk } from "@/actions/import";

export function ImportProgress({ batchId, initialDone, initialTotal }: { batchId: string; initialDone: number; initialTotal: number | null }) {
  const router = useRouter();
  const [done, setDone] = useState(initialDone);
  const [total, setTotal] = useState(initialTotal);
  const [notes, setNotes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  useEffect(() => {
    if (running.current) return;
    running.current = true;
    (async () => {
      for (;;) {
        const r = await parseImportChunk(batchId);
        setDone(r.bytesDone);
        setTotal(r.bytesTotal);
        setNotes(r.notesSeen);
        if (r.error) { setError(r.error); break; }
        if (r.done) { router.refresh(); break; }
      }
    })();
  }, [batchId, router]);

  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="bg-card border border-rule p-5">
      <p className="section-label">Reading export…</p>
      <div className="mt-2 h-2 bg-paper-deep border border-rule"><div className="h-full bg-pine" style={{ width: `${pct}%` }} /></div>
      <p className="text-xs font-data mt-2">{pct}% · {notes} notes</p>
      {error && <p className="text-sm text-oxblood bg-oxblood-wash border border-oxblood/30 px-3 py-2 mt-3">{error}</p>}
    </div>
  );
}
