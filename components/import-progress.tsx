"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { discardImportBatch, parseImportChunk, retryImportBatch } from "@/actions/import";

/**
 * Drives parsing for a batch in 'parsing', and offers Retry / Discard when it
 * is 'failed'. A failed batch keeps its offset, so Retry resumes where it
 * stopped. Staging is idempotent, so a reload or a second tab is harmless.
 */
export function ImportProgress({
  batchId, failed, failedError, initialDone, initialTotal, canEdit,
}: {
  batchId: string;
  failed: boolean;
  failedError: string | null;
  initialDone: number;
  initialTotal: number | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [done, setDone] = useState(initialDone);
  const [total, setTotal] = useState(initialTotal);
  const [notes, setNotes] = useState(0);
  const [error, setError] = useState<string | null>(failed ? (failedError ?? "Parsing failed.") : null);
  const running = useRef(false);

  useEffect(() => {
    if (failed || !canEdit || running.current) return;
    running.current = true;
    (async () => {
      try {
        for (;;) {
          const r = await parseImportChunk(batchId);
          setDone(r.bytesDone);
          setTotal(r.bytesTotal);
          setNotes(r.notesSeen);
          if (r.error || r.status === "failed") {
            setError(r.error ?? "Parsing failed.");
            router.refresh();
            break;
          }
          if (r.done) {
            router.refresh();
            break;
          }
        }
      } catch {
        // the request itself died (timeout, network); progress is saved server-side
        setError("The connection dropped while reading the export. Reload this page to continue.");
      } finally {
        running.current = false;
      }
    })();
  }, [batchId, failed, canEdit, router]);

  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const act = (fn: () => Promise<{ error: string | null }>) =>
    start(async () => {
      const r = await fn();
      if (r.error) setError(r.error);
      router.refresh();
    });

  return (
    <div className="bg-card border border-rule p-5">
      <p className="section-label">{failed ? "Reading stopped" : "Reading export…"}</p>
      <div className="mt-2 h-2 bg-paper-deep border border-rule">
        <div className="h-full bg-pine" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs font-data mt-2">
        {pct}% · {notes} notes
      </p>
      {error && (
        <p className="text-sm text-oxblood bg-oxblood-wash border border-oxblood/30 px-3 py-2 mt-3">{error}</p>
      )}
      {canEdit && (
        <div className="flex gap-3 mt-4">
          {failed && (
            <button
              disabled={pending}
              onClick={() => act(() => retryImportBatch(batchId))}
              className="bg-pine text-paper px-4 py-2 text-sm font-data hover:bg-pine-dark disabled:opacity-50"
            >
              Retry
            </button>
          )}
          <button
            disabled={pending}
            onClick={() => {
              if (confirm("Discard this batch? Nothing from it has been written to the record.")) {
                act(() => discardImportBatch(batchId));
              }
            }}
            className="border border-rule px-4 py-2 text-sm font-data disabled:opacity-50"
          >
            Discard
          </button>
        </div>
      )}
    </div>
  );
}
