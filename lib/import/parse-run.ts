/**
 * One resumable step of parsing an uploaded .enex: read a byte range from
 * Storage starting at batch.bytes_done, stage every complete note it contains
 * (uploading document attachments), record the new offset, stop when the
 * time budget is spent or the file is finished.
 *
 * Staging is idempotent. An item's `position` is the note's byte offset in
 * the export (attachments: offset + 1 + i) and is unique per batch, so a step
 * that runs twice over the same bytes — a reload, a second tab, a crash before
 * progress was saved — finds the rows already there and adds nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAsOf } from "@/lib/asof";
import { sha256Hex } from "@/lib/hash";
import { buildStorageKey } from "@/lib/storage";
import { defaultArtifactType } from "@/lib/import/classify";
import { fetchAll, liveArtifactsByHash } from "@/lib/import/dedupe";
import { parseNoteBlock, splitCompleteNotes, type ParsedNote } from "@/lib/import/enex";
import { buildAliasIndex, initialStatus, suggestEntities, type AliasIndex } from "@/lib/import/match";
import type { AliasRow, ImportBatchRow } from "@/lib/types";

const DEFAULT_CHUNK = 8 * 1024 * 1024;
/** Largest single note the importer will buffer; bigger ones become an error item. */
export const MAX_NOTE_BYTES = 128 * 1024 * 1024;
const OPEN = Buffer.from("<note>");
const CLOSE = Buffer.from("</note>");
const UNIQUE_VIOLATION = "23505";

async function readRange(url: string, start: number, length: number): Promise<{ bytes: Buffer; total: number }> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${start + length - 1}` } });
  const cr = res.headers.get("content-range"); // "bytes start-end/total" or "bytes */total"
  if (res.status === 416) {
    return { bytes: Buffer.alloc(0), total: cr ? Number(cr.split("/")[1]) : start };
  }
  if (res.status === 200 && start > 0) {
    // the whole object came back; treating it as the requested range would re-stage everything
    throw new Error("Storage ignored the byte range; cannot resume this import safely.");
  }
  if (res.status !== 206 && res.status !== 200) throw new Error(`Storage range read failed (${res.status}).`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const total = cr ? Number(cr.split("/")[1]) : Number(res.headers.get("content-length") ?? bytes.length);
  return { bytes, total };
}

/** Absolute offset just past the next </note> at or after `from`, without buffering the note. */
async function findNoteEnd(url: string, from: number, total: number): Promise<number> {
  let at = from;
  let tail = Buffer.alloc(0);
  while (at < total) {
    const { bytes } = await readRange(url, at, DEFAULT_CHUNK);
    if (bytes.length === 0) break;
    const window = Buffer.concat([tail, bytes]);
    const hit = window.indexOf(CLOSE);
    if (hit !== -1) return at - tail.length + hit + CLOSE.length;
    tail = window.subarray(Math.max(0, window.length - (CLOSE.length - 1)));
    at += bytes.length;
  }
  return total;
}

export async function parseBatchStep(
  supabase: SupabaseClient,
  batchId: string,
  opts: { bucket: string; deadlineMs?: number; chunkBytes?: number },
): Promise<{ done: boolean; batch: ImportBatchRow }> {
  const deadline = Date.now() + (opts.deadlineMs ?? 8000);
  const reload = async (): Promise<ImportBatchRow> => {
    const { data, error } = await supabase.from("import_batch").select("*").eq("id", batchId).single();
    if (error || !data) throw new Error(`batch not found: ${error?.message}`);
    return data as ImportBatchRow;
  };
  let batch = await reload();
  if (batch.status !== "parsing") return { done: true, batch };

  try {
    const { data: signed, error: sErr } = await supabase.storage.from(opts.bucket).createSignedUrl(batch.storage_key, 600);
    if (sErr || !signed) throw new Error(`signed url: ${sErr?.message}`);
    const url = signed.signedUrl;

    const aliasRows = await fetchAll<AliasRow>((from, to) =>
      supabase.from("entity_alias").select("*").order("id").range(from, to),
    );
    const index = buildAliasIndex(resolveAsOf(aliasRows, new Date()));

    const baseChunk = opts.chunkBytes ?? DEFAULT_CHUNK;
    let offset = batch.bytes_done;
    let chunk = baseChunk;
    let images = 0;

    /** Save progress; null means another runner (or a status change) got there first. */
    const persist = async (newOffset: number, total: number): Promise<ImportBatchRow | null> => {
      const { count } = await supabase
        .from("import_item")
        .select("id", { count: "exact", head: true })
        .eq("batch_id", batchId)
        .eq("kind", "note");
      const { data } = await supabase
        .from("import_batch")
        .update({
          bytes_total: total,
          bytes_done: newOffset,
          notes_seen: count ?? batch.notes_seen,
          images_skipped: batch.images_skipped + images,
          status: newOffset >= total ? "review" : "parsing",
          updated_at: new Date().toISOString(),
        })
        .eq("id", batchId)
        .eq("status", "parsing")
        .lte("bytes_done", newOffset)
        .select()
        .maybeSingle();
      images = 0;
      return (data as ImportBatchRow | null) ?? null;
    };

    for (;;) {
      let { bytes, total } = await readRange(url, offset, chunk);
      let eof = offset + bytes.length >= total;
      let split = splitCompleteNotes(bytes, eof);
      let oversize = false;
      while (split.blocks.length === 0 && !eof) {
        if (chunk >= MAX_NOTE_BYTES) {
          oversize = true;
          break;
        }
        chunk = Math.min(chunk * 2, MAX_NOTE_BYTES);
        ({ bytes, total } = await readRange(url, offset, chunk));
        eof = offset + bytes.length >= total;
        split = splitCompleteNotes(bytes, eof);
      }

      let newOffset: number;
      if (oversize) {
        // one note bigger than the buffer limit: record it and move past it
        const rel = bytes.indexOf(OPEN);
        const noteStart = offset + Math.max(rel, 0);
        await stageErrorNote(
          supabase,
          batch,
          noteStart,
          "(note too large to import)",
          `This note is larger than ${MAX_NOTE_BYTES / (1024 * 1024)} MB and was skipped.`,
        );
        newOffset = await findNoteEnd(url, noteStart, total);
        chunk = baseChunk;
      } else {
        let lastEnd = offset;
        let processed = 0;
        for (const block of split.blocks) {
          const noteStart = offset + (block.byteOffset - bytes.byteOffset);
          let note: ParsedNote | null = null;
          try {
            note = parseNoteBlock(block.toString("utf8"));
          } catch (e) {
            await stageErrorNote(
              supabase,
              batch,
              noteStart,
              "(unreadable note)",
              `Could not read this note: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          if (note) {
            const fresh = await stageNote(supabase, batch, note, noteStart, index, opts.bucket);
            if (fresh) images += note.imagesSkipped;
          }
          lastEnd = noteStart + block.length;
          processed += 1;
          if (Date.now() > deadline) break;
        }
        // All blocks staged (including the zero-block case: only the closing
        // tag was left) -> the whole consumed span is done. If the deadline
        // cut the loop short, resume right after the last staged note.
        const processedAll = processed === split.blocks.length;
        newOffset = processedAll ? (eof ? total : offset + split.consumed) : lastEnd;
      }

      const saved = await persist(newOffset, total);
      if (!saved) {
        batch = await reload();
        return { done: batch.status !== "parsing", batch };
      }
      batch = saved;
      const done = newOffset >= total;
      if (done || Date.now() > deadline) return { done, batch };
      offset = newOffset;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const { data } = await supabase
      .from("import_batch")
      .update({ status: "failed", error: msg, updated_at: new Date().toISOString() })
      .eq("id", batchId)
      .select()
      .maybeSingle();
    return { done: true, batch: (data as ImportBatchRow | null) ?? { ...batch, status: "failed", error: msg } };
  }
}

/** A placeholder row for a note that could not be staged; never importable. */
async function stageErrorNote(
  supabase: SupabaseClient,
  batch: ImportBatchRow,
  position: number,
  title: string,
  message: string,
): Promise<void> {
  const { error } = await supabase.from("import_item").insert({
    batch_id: batch.id,
    org_id: batch.org_id,
    kind: "note",
    position,
    title,
    valid_at: new Date().toISOString(),
    body: null,
    content_hash: sha256Hex(`unstaged:${batch.id}:${position}`),
    artifact_type: "note",
    include: false,
    status: "error",
    error: message,
  });
  if (error && error.code !== UNIQUE_VIOLATION) throw new Error(`stage error note: ${error.message}`);
}

/** Stage one note and its documents. Returns false when the note row already existed. */
async function stageNote(
  supabase: SupabaseClient,
  batch: ImportBatchRow,
  note: ParsedNote,
  notePos: number,
  index: AliasIndex,
  bucket: string,
): Promise<boolean> {
  const docCount = note.documents.length;
  const { data: existingRows, error: exErr } = await supabase
    .from("import_item")
    .select("id,position")
    .eq("batch_id", batch.id)
    .gte("position", notePos)
    .lte("position", notePos + docCount);
  if (exErr) throw new Error(`stage lookup: ${exErr.message}`);
  const existing = new Map((existingRows ?? []).map((r) => [Number(r.position), r.id as string]));

  const suggested = suggestEntities(index, note.title, note.text);
  const noteHash = sha256Hex(note.text);
  const docHashes = note.documents.map((d) => sha256Hex(d.bytes));
  const hashes = [noteHash, ...docHashes];

  // duplicates of the live record, and of items staged earlier in this batch
  const live = await liveArtifactsByHash(supabase, hashes);
  const { data: staged, error: stErr } = await supabase
    .from("import_item")
    .select("content_hash,position")
    .eq("batch_id", batch.id)
    .in("content_hash", hashes);
  if (stErr) throw new Error(`stage lookup: ${stErr.message}`);
  const inBatch = new Set(
    (staged ?? [])
      .filter((r) => Number(r.position) < notePos || Number(r.position) > notePos + docCount)
      .map((r) => r.content_hash as string),
  );

  let fresh = false;
  let noteId = existing.get(notePos) ?? null;
  if (!noteId) {
    const empty = note.text.trim() === "";
    const dup = empty ? null : (live.get(noteHash) ?? null);
    const st = empty
      ? { status: "error" as const, include: false }
      : dup || inBatch.has(noteHash)
        ? { status: "duplicate" as const, include: false }
        : initialStatus(suggested, null);
    const { data: row, error } = await supabase
      .from("import_item")
      .insert({
        batch_id: batch.id,
        org_id: batch.org_id,
        kind: "note",
        parent_item_id: null,
        position: notePos,
        title: note.title,
        author: note.author,
        valid_at: note.createdAt,
        body: empty ? null : note.text,
        content_hash: noteHash,
        artifact_type: defaultArtifactType("note", null),
        suggested_entity_ids: suggested,
        chosen_entity_ids: suggested,
        include: st.include,
        status: st.status,
        duplicate_of: dup,
        error: empty ? "Empty note (images only) — nothing to import." : null,
      })
      .select("id")
      .single();
    if (error && error.code !== UNIQUE_VIOLATION) throw new Error(`stage note: ${error.message}`);
    if (row) {
      noteId = row.id as string;
      fresh = true;
    } else {
      // another runner staged it between our lookup and insert
      const { data: again } = await supabase
        .from("import_item")
        .select("id")
        .eq("batch_id", batch.id)
        .eq("position", notePos)
        .single();
      noteId = (again?.id as string) ?? null;
    }
  }

  const seen = new Set<string>();
  for (let i = 0; i < docCount; i += 1) {
    const doc = note.documents[i];
    const pos = notePos + 1 + i;
    const hash = docHashes[i];
    const repeated = inBatch.has(hash) || seen.has(hash);
    seen.add(hash);
    if (existing.has(pos)) continue;

    const key = buildStorageKey(batch.org_id, doc.fileName);
    const dup = live.get(hash) ?? null;
    const { error: upErr } = await supabase.storage
      .from(bucket)
      .upload(key, doc.bytes, { contentType: doc.mime || "application/octet-stream" });
    const st = upErr
      ? { status: "error" as const, include: false }
      : dup || repeated
        ? { status: "duplicate" as const, include: false }
        : initialStatus(suggested, null);
    const { error: iErr } = await supabase.from("import_item").insert({
      batch_id: batch.id,
      org_id: batch.org_id,
      kind: "attachment",
      parent_item_id: noteId,
      position: pos,
      title: doc.fileName,
      author: note.author,
      valid_at: note.createdAt,
      body: null,
      storage_key: upErr ? null : key,
      file_name: doc.fileName,
      mime: doc.mime,
      bytes: doc.bytes.length,
      content_hash: hash,
      artifact_type: defaultArtifactType("attachment", doc.fileName),
      suggested_entity_ids: suggested,
      chosen_entity_ids: suggested,
      include: st.include,
      status: st.status,
      duplicate_of: dup,
      error: upErr ? `Could not store this attachment: ${upErr.message}` : null,
    });
    if (iErr && iErr.code !== UNIQUE_VIOLATION) throw new Error(`stage attachment: ${iErr.message}`);
  }
  return fresh;
}
