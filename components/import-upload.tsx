"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { prepareUpload } from "@/actions/artifacts";
import { startImportBatch } from "@/actions/import";

export function ImportUpload() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const prepared = await prepareUpload(file.name);
      if (prepared.error) throw new Error(prepared.error);
      const res = await fetch(prepared.signedUrl, {
        method: "PUT",
        headers: { "content-type": "application/xml", "x-upsert": "false" },
        body: file,
      });
      if (!res.ok) throw new Error(`Storage rejected the upload (${res.status}).`);
      const started = await startImportBatch(prepared.storageKey, file.name);
      if (started.error || !started.batchId) throw new Error(started.error ?? "Could not start import.");
      router.push(`/import/${started.batchId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
      setBusy(false);
    }
  };

  return (
    <div className="bg-card border border-rule p-5">
      <label className="block">
        <span className="section-label">Evernote export (.enex)</span>
        <input
          type="file"
          accept=".enex,application/xml,text/xml"
          disabled={busy}
          onChange={onChange}
          className="mt-1 block w-full text-sm file:mr-3 file:border file:border-rule file:bg-card file:px-3 file:py-1.5 file:text-xs file:font-data file:uppercase"
        />
      </label>
      <p className="text-xs text-ink-faint mt-2">
        In Evernote: select a notebook → Export → ENEX. Notes and their PDF / Office attachments are staged for review; images are skipped. Nothing is written to the record until you press Import.
      </p>
      {busy && <p className="text-xs font-data mt-2">Uploading…</p>}
      {error && <p className="text-sm text-oxblood bg-oxblood-wash border border-oxblood/30 px-3 py-2 mt-3">{error}</p>}
    </div>
  );
}
