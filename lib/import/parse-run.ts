/**
 * One resumable step of parsing an uploaded .enex: read a byte range from
 * Storage starting at batch.bytes_done, stage every complete note it contains
 * (uploading document attachments), record the new offset, stop when the
 * time budget is spent or the file is finished.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAsOf } from "@/lib/asof";
import { sha256Hex } from "@/lib/hash";
import { buildStorageKey } from "@/lib/storage";
import { defaultArtifactType } from "@/lib/import/classify";
import { parseNoteBlock, splitCompleteNotes } from "@/lib/import/enex";
import { buildAliasIndex, initialStatus, suggestEntities } from "@/lib/import/match";
import type { AliasRow, ArtifactRow, ImportBatchRow } from "@/lib/types";

const DEFAULT_CHUNK = 8 * 1024 * 1024;
const MAX_CHUNK = 160 * 1024 * 1024;

async function readRange(url: string, start: number, length: number): Promise<{ bytes: Buffer; total: number }> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${start + length - 1}` } });
  if (res.status !== 206 && res.status !== 200) throw new Error(`storage range read failed: ${res.status}`);
  const cr = res.headers.get("content-range"); // bytes start-end/total
  const total = cr ? Number(cr.split("/")[1]) : Number(res.headers.get("content-length"));
  return { bytes: Buffer.from(await res.arrayBuffer()), total };
}

export async function parseBatchStep(
  supabase: SupabaseClient,
  batchId: string,
  opts: { bucket: string; deadlineMs?: number; chunkBytes?: number },
): Promise<{ done: boolean; batch: ImportBatchRow }> {
  const deadline = Date.now() + (opts.deadlineMs ?? 8000);
  const { data: b, error } = await supabase.from("import_batch").select("*").eq("id", batchId).single();
  if (error || !b) throw new Error(`batch not found: ${error?.message}`);
  let batch = b as ImportBatchRow;
  if (batch.status !== "parsing") return { done: batch.status !== "parsing", batch };

  const fail = async (msg: string) => {
    const { data } = await supabase.from("import_batch").update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("id", batchId).select().single();
    return { done: true, batch: (data ?? { ...batch, status: "failed", error: msg }) as ImportBatchRow };
  };

  try {
    const { data: signed, error: sErr } = await supabase.storage.from(opts.bucket).createSignedUrl(batch.storage_key, 600);
    if (sErr || !signed) throw new Error(`signed url: ${sErr?.message}`);

    // alias index + existing hashes, once per step
    const { data: aliasRows } = await supabase.from("entity_alias").select("*");
    const aliases = resolveAsOf((aliasRows ?? []) as AliasRow[], new Date());
    const index = buildAliasIndex(aliases);
    const { data: artRows } = await supabase.from("artifact").select("*");
    const live = resolveAsOf((artRows ?? []) as ArtifactRow[], new Date());
    const hashToArtifact = new Map(live.filter((a) => a.content_hash).map((a) => [a.content_hash as string, a.id]));

    let offset = batch.bytes_done;
    let chunk = opts.chunkBytes ?? DEFAULT_CHUNK;
    let position = await nextPosition(supabase, batchId);

    for (;;) {
      let { bytes, total } = await readRange(signed.signedUrl, offset, chunk);
      let eof = offset + bytes.length >= total;
      let split = splitCompleteNotes(bytes, eof);
      while (split.blocks.length === 0 && !eof) {
        chunk *= 2;
        if (chunk > MAX_CHUNK) throw new Error("A single note exceeds the size the importer can handle (160 MB).");
        ({ bytes, total } = await readRange(signed.signedUrl, offset, chunk));
        eof = offset + bytes.length >= total;
        split = splitCompleteNotes(bytes, eof);
      }

      let consumedUpTo = offset;
      let processed = 0;
      for (const block of split.blocks) {
        const note = parseNoteBlock(block.toString("utf8"));
        position = await stageNote(supabase, batch, note, position, index, hashToArtifact, opts.bucket);
        consumedUpTo = offset + (block.byteOffset - bytes.byteOffset) + block.length;
        batch = { ...batch, notes_seen: batch.notes_seen + 1, images_skipped: batch.images_skipped + note.imagesSkipped };
        processed += 1;
        if (Date.now() > deadline) break;
      }
      // Every block in this chunk staged (including the zero-block case: only
      // the closing tag was left) -> the whole consumed span is done. If the
      // deadline cut the loop short, resume right after the last staged note.
      const processedAll = processed === split.blocks.length;
      const newOffset = processedAll ? (eof ? total : offset + split.consumed) : consumedUpTo;
      const done = newOffset >= total;
      const { data: saved } = await supabase
        .from("import_batch")
        .update({
          bytes_total: total,
          bytes_done: newOffset,
          notes_seen: batch.notes_seen,
          images_skipped: batch.images_skipped,
          status: done ? "review" : "parsing",
          updated_at: new Date().toISOString(),
        })
        .eq("id", batchId)
        .select()
        .single();
      batch = saved as ImportBatchRow;
      if (done || Date.now() > deadline) return { done, batch };
      offset = newOffset;
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

async function nextPosition(supabase: SupabaseClient, batchId: string): Promise<number> {
  const { data } = await supabase.from("import_item").select("position").eq("batch_id", batchId).order("position", { ascending: false }).limit(1);
  return data && data.length ? data[0].position + 1 : 0;
}

async function stageNote(
  supabase: SupabaseClient,
  batch: ImportBatchRow,
  note: ReturnType<typeof parseNoteBlock>,
  position: number,
  index: ReturnType<typeof buildAliasIndex>,
  hashToArtifact: Map<string, string>,
  bucket: string,
): Promise<number> {
  const suggested = suggestEntities(index, note.title, note.text);
  const noteHash = sha256Hex(note.text);
  const noteDup = hashToArtifact.get(noteHash) ?? null;
  const noteStatus = initialStatus(suggested, noteDup);
  const { data: noteRow, error } = await supabase
    .from("import_item")
    .insert({
      batch_id: batch.id, org_id: batch.org_id, kind: "note", parent_item_id: null, position,
      title: note.title, author: note.author, valid_at: note.createdAt, body: note.text,
      content_hash: noteHash, artifact_type: defaultArtifactType("note", null),
      suggested_entity_ids: suggested, chosen_entity_ids: suggested,
      include: noteStatus.include, status: noteStatus.status, duplicate_of: noteDup,
    })
    .select("id")
    .single();
  if (error || !noteRow) throw new Error(`stage note: ${error?.message}`);
  position += 1;

  for (const doc of note.documents) {
    const key = buildStorageKey(batch.org_id, doc.fileName);
    const hash = sha256Hex(doc.bytes);
    const dup = hashToArtifact.get(hash) ?? null;
    let uploadError: string | null = null;
    const { error: upErr } = await supabase.storage.from(bucket).upload(key, doc.bytes, { contentType: doc.mime || "application/octet-stream" });
    if (upErr) uploadError = upErr.message;
    const st = uploadError ? { status: "error" as const, include: false } : initialStatus(suggested, dup);
    const { error: iErr } = await supabase.from("import_item").insert({
      batch_id: batch.id, org_id: batch.org_id, kind: "attachment", parent_item_id: noteRow.id, position,
      title: doc.fileName, author: note.author, valid_at: note.createdAt, body: null,
      storage_key: uploadError ? null : key, file_name: doc.fileName, mime: doc.mime, bytes: doc.bytes.length,
      content_hash: hash, artifact_type: defaultArtifactType("attachment", doc.fileName),
      suggested_entity_ids: suggested, chosen_entity_ids: suggested,
      include: st.include, status: st.status, duplicate_of: dup, error: uploadError,
    });
    if (iErr) throw new Error(`stage attachment: ${iErr.message}`);
    position += 1;
  }
  return position;
}
