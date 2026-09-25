"use client";

import { startTransition, useActionState, useState, type FormEvent } from "react";
import { createArtifact, prepareUpload, type ArtifactFormState } from "@/actions/artifacts";

interface EntityOption {
  id: string;
  label: string;
}

const initial: ArtifactFormState = { error: null };

const SOURCES = [
  { key: "file", label: "File upload", hint: "xlsx, docx, pdf, pptx — models & primers off the shared drive" },
  { key: "url", label: "URL", hint: "filings, transcripts, news" },
  { key: "paste", label: "Paste", hint: "note text lifted out of Evernote" },
] as const;

export function ArtifactForm({
  entities,
  preselected,
}: {
  entities: EntityOption[];
  preselected: string | null;
}) {
  const [state, action, pending] = useActionState(createArtifact, initial);
  const [source, setSource] = useState<(typeof SOURCES)[number]["key"]>("file");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [linked, setLinked] = useState<Set<string>>(
    new Set(preselected ? [preselected] : []),
  );

  /**
   * Files never pass through the Server Action (1 MB body cap; 4.5 MB on
   * Vercel). The browser PUTs the file straight to Storage using a signed URL
   * the server mints under the user's JWT, then submits only the object key.
   */
  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    if (source !== "file") return; // url / paste: ordinary action submit
    e.preventDefault();
    setUploadError(null);
    const form = e.currentTarget;
    const fd = new FormData(form);
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setUploadError("Choose a file.");
      return;
    }
    setUploading(true);
    try {
      const prepared = await prepareUpload(file.name);
      if (prepared.error) throw new Error(prepared.error);
      const res = await fetch(prepared.signedUrl, {
        method: "PUT",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-upsert": "false",
        },
        body: file,
      });
      if (!res.ok) throw new Error(`Storage rejected the upload (${res.status}).`);
      fd.delete("file");
      fd.set("storage_key", prepared.storageKey);
      startTransition(() => action(fd));
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  const toggle = (id: string) =>
    setLinked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <form action={action} onSubmit={onSubmit} className="space-y-6">
      {/* source path */}
      <div className="grid sm:grid-cols-3 gap-2">
        {SOURCES.map((s) => (
          <label
            key={s.key}
            className={`border px-4 py-3 cursor-pointer ${
              source === s.key
                ? "border-pine bg-pine-wash"
                : "border-rule bg-card hover:border-rule-strong"
            }`}
          >
            <input
              type="radio"
              name="source_kind"
              value={s.key}
              checked={source === s.key}
              onChange={() => setSource(s.key)}
              className="sr-only"
            />
            <div className="font-medium text-sm">{s.label}</div>
            <div className="text-xs text-ink-soft mt-0.5">{s.hint}</div>
          </label>
        ))}
      </div>

      {source === "file" && (
        <label className="block">
          <span className="section-label">File</span>
          <input
            type="file"
            name="file"
            accept=".xlsx,.docx,.pdf,.pptx,.csv,.xls,.doc,.ppt,.txt"
            className="mt-1 block w-full text-sm file:mr-3 file:border file:border-rule file:bg-card file:px-3 file:py-1.5 file:text-xs file:font-data file:uppercase"
          />
          <span className="text-xs text-ink-faint">
            Stored in object storage; re-uploading identical content is detected
            by hash and recorded as a new version, not a duplicate.
          </span>
        </label>
      )}
      {source === "url" && (
        <label className="block">
          <span className="section-label">URL</span>
          <input
            type="url"
            name="url"
            placeholder="https://…"
            className="mt-1 w-full border border-rule bg-card px-3 py-2 font-data text-sm focus:outline-none focus:border-pine"
          />
        </label>
      )}
      {source === "paste" && (
        <label className="block">
          <span className="section-label">Note text</span>
          <textarea
            name="body"
            rows={8}
            placeholder="Paste from Evernote…"
            className="mt-1 w-full border border-rule bg-card px-3 py-2 text-sm focus:outline-none focus:border-pine"
          />
        </label>
      )}

      {/* metadata */}
      <div className="grid sm:grid-cols-2 gap-4">
        <label className="block">
          <span className="section-label">Title</span>
          <input
            name="title"
            required
            className="mt-1 w-full border border-rule bg-card px-3 py-2 text-sm focus:outline-none focus:border-pine"
          />
        </label>
        <label className="block">
          <span className="section-label">Type</span>
          <select
            name="artifact_type"
            className="mt-1 w-full border border-rule bg-card px-3 py-2 font-data text-sm"
            defaultValue="note"
          >
            {["note", "model", "primer", "thesis", "filing", "transcript", "other"].map(
              (t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ),
            )}
          </select>
        </label>
        <label className="block">
          <span className="section-label">Author</span>
          <input
            name="author"
            required
            placeholder="Who wrote it (may predate Atlas)"
            className="mt-1 w-full border border-rule bg-card px-3 py-2 text-sm focus:outline-none focus:border-pine"
          />
        </label>
        <label className="block">
          <span className="section-label">Date the content refers to</span>
          <input
            type="date"
            name="valid_at"
            required
            className="mt-1 w-full border border-rule bg-card px-3 py-2 font-data text-sm focus:outline-none focus:border-pine"
          />
          <span className="text-xs text-ink-faint">
            Valid time — distinct from the entry date, which Atlas records
            automatically.
          </span>
        </label>
      </div>
      <label className="block">
        <span className="section-label">Summary</span>
        <textarea
          name="summary"
          rows={2}
          className="mt-1 w-full border border-rule bg-card px-3 py-2 text-sm focus:outline-none focus:border-pine"
        />
      </label>

      {/* entity links — blocking requirement */}
      <fieldset className="border border-rule bg-card p-4">
        <legend className="section-label px-1">
          Linked entities — required, at least one
        </legend>
        <p className="text-xs text-ink-soft mb-2">
          An artifact linked to nothing is invisible and worthless; saving is
          blocked until it is attached to a company.
        </p>
        <div className="grid sm:grid-cols-2 gap-1">
          {entities.map((e) => (
            <label key={e.id} className="flex items-center gap-2 text-sm py-0.5">
              <input
                type="checkbox"
                name="entity_ids"
                value={e.id}
                checked={linked.has(e.id)}
                onChange={() => toggle(e.id)}
                className="accent-[var(--color-pine)]"
              />
              {e.label}
            </label>
          ))}
        </div>
      </fieldset>

      {(uploadError ?? state.error) && (
        <p className="text-sm text-oxblood bg-oxblood-wash border border-oxblood/30 px-3 py-2">
          {uploadError ?? state.error}
        </p>
      )}
      <button
        disabled={pending || uploading || linked.size === 0}
        className="bg-pine text-paper px-6 py-2.5 text-sm font-data uppercase tracking-wider hover:bg-pine-dark disabled:opacity-50"
        title={linked.size === 0 ? "Link at least one entity first" : undefined}
      >
        {uploading ? "Uploading…" : pending ? "Saving…" : "Save artifact"}
      </button>
      {linked.size === 0 && (
        <span className="ml-3 text-xs text-oxblood font-data">
          link at least one entity to enable saving
        </span>
      )}
    </form>
  );
}
