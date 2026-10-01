# Evernote Import — Design

**Status:** approved in conversation 2026-09-25; implementation plan follows.
**Problem it serves:** Problem A of the firm's research problem statement — the
proprietary notes (source 5) and the primers/theses and models embedded in them
(sources 9, 6) live in Evernote and are stranded. This feature moves them into
Atlas as artifacts, linked to companies, with their original dates, so the
knowledge layer built later has a corpus to work on.

## Decisions taken

| Question | Decision |
|---|---|
| Script or app feature? | App feature: an **Import** page. |
| How items get linked to companies | **Suggest and review**: alias-based suggestions, user confirms before anything is written. |
| Attachments | **Documents become artifacts** (pdf, doc/docx, xls/xlsx, ppt/pptx, csv); **images are dropped** and counted. |
| First format | Evernote export (`.enex`). Folder-of-files import is a later format on the same page. |
| Who can import | Anyone who can write research: analyst, pm, admin (`canWriteResearch`). |

## Non-goals (this milestone)

- Text extraction from PDFs/spreadsheets (belongs to the search/synthesis milestone).
- Importing images or inline screenshots.
- Editing note text before import (import faithfully; corrections are new versions later).
- Any change to the seven research tables or their append-only rules.

## 1. Flow

1. Header gains **Import** (visible when `canWriteResearch(role)`).
2. `/import` lists the caller's batches (status, counts, date) and has one control: choose an `.enex` file.
3. The file uploads browser→Storage via a signed URL (`prepareUpload` path, key `<org>/<uuid>/<name>` — same as artifacts). The client then calls `startImportBatch(storageKey, fileName)` → batch row, status `parsing`, redirect to `/import/[batchId]`.
4. The batch page drives parsing: it calls `parseImportChunk(batchId)` repeatedly; each call processes whole notes until ~8 s elapsed, persists progress, and returns `{ done, notesSeen, bytesDone, bytesTotal }`. A progress bar shows bytes. When `done`, status becomes `review`.
5. Review table (section 5). **Import** calls `commitImportBatch(batchId)` in pages of 50 items until done, then status `imported`. The page remains as a receipt.
6. A batch can be **discarded** at any point before `imported` (status `discarded`; staged attachment objects are left in place under the staging prefix — cheap, and deletion is not something Atlas does).

## 2. Data model (staging — mutable by design)

These are workbench tables, explicitly *not* part of the record. They are the
first mutable application tables in Atlas; the exception is documented in the
migration header and in README "Database changes".

```sql
create table public.import_batch (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id),
  created_by uuid not null references auth.users (id),
  source_kind text not null check (source_kind in ('enex')),
  storage_key text not null,           -- the uploaded export
  file_name text not null,
  status text not null check (status in ('parsing','review','importing','imported','failed','discarded')) default 'parsing',
  bytes_total bigint,
  bytes_done bigint not null default 0, -- resume offset (byte after last complete </note>)
  notes_seen int not null default 0,
  images_skipped int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.import_item (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.import_batch (id),
  org_id uuid not null references public.org (id),
  kind text not null check (kind in ('note','attachment')),
  parent_item_id uuid references public.import_item (id),   -- attachment -> its note
  position int not null,                 -- order within the export (note index, then attachment index)
  title text not null,
  author text,                            -- ENEX <author> when present
  valid_at timestamptz not null,          -- note <created>
  body text,                              -- note: plain text from ENML
  storage_key text,                       -- attachment: staged object (final artifact reuses this key)
  file_name text,
  mime text,
  bytes bigint,
  content_hash text not null,             -- sha256 of body text / attachment bytes
  artifact_type text not null check (artifact_type in ('note','model','primer','thesis','filing','transcript','other')),
  suggested_entity_ids uuid[] not null default '{}',
  chosen_entity_ids uuid[] not null default '{}',
  include boolean not null default true,
  status text not null check (status in ('pending','duplicate','unmatched','imported','skipped','error')) default 'pending',
  duplicate_of uuid references public.artifact (id),
  artifact_id uuid references public.artifact (id),
  error text
);
create index on public.import_item (batch_id, position);
```

**Grants / RLS.** `authenticated`: SELECT, INSERT, UPDATE on both (no DELETE).
Policies: select where `org_id = app.org_id()`; insert where `org_id = app.org_id()`
and `created_by = auth.uid()` (batch) / batch belongs to caller (item); update
where the batch's `created_by = auth.uid()` and `app.user_role() in ('analyst','pm','admin')`.
`service_role`: ALL (matches existing convention). Storage: staged attachment
objects live under `<org>/<uuid>/<file>` like everything else, so the existing
path policies apply unchanged.

**Type defaults.** note → `note`; attachment xls/xlsx/csv → `model`; pdf/doc/docx/ppt/pptx → `other`. Editable per row before import.

## 3. Parsing (server, resumable)

- ENEX is XML: `<en-export><note>…</note>…</en-export>`. Each `<note>` has
  `<title>`, `<created>` (`YYYYMMDDTHHMMSSZ`), optional `<updated>`,
  `<note-attributes><author>`, `<content><![CDATA[ENML]]></content>`, and zero
  or more `<resource>` each with `<data encoding="base64">`, `<mime>`,
  `<resource-attributes><file-name>`.
- `parseImportChunk` reads the object from Storage with an HTTP `Range` from
  `bytes_done`, feeds a streaming XML parser (`saxes`), and handles complete
  notes one at a time. After each `</note>` it records the byte offset; when
  elapsed time > 8 s it stops after the current note and persists
  `bytes_done`, `notes_seen`, `images_skipped`. A note is processed entirely
  within one call (base64 decode + upload of its document attachments).
- Resume correctness: the parser is re-created per call and starts at a note
  boundary, so the stream it sees is `<note>…` fragments without the root
  element; wrap with a synthetic `<en-export>` prefix. The first call starts at
  0 and skips the header up to the first `<note`.
- ENML → text: strip tags; `<br>`, `</div>`, `</p>`, `</li>`, `</tr>` become
  newlines; `<en-media>` becomes `[attachment: <file-name>]` when the resource
  is a document, nothing when it is an image; decode entities; collapse >2
  blank lines. Pure function `enmlToText(enml: string, resourceNames: Map<hash,string>)`.
- Attachment classification by `mime` and file extension. Document mimes:
  `application/pdf`, `application/msword`, `…wordprocessingml.document`,
  `application/vnd.ms-excel`, `…spreadsheetml.sheet`, `application/vnd.ms-powerpoint`,
  `…presentationml.presentation`, `text/csv`. Everything else (incl. `image/*`) is
  skipped and counted in `images_skipped`.
- Hashes: note → sha256 of the plain text; attachment → sha256 of bytes (same
  function the artifact path uses, so duplicate detection matches later uploads).
- Failure: any thrown error marks the batch `failed` with the message; items
  already staged remain (harmless) and nothing has touched the record.

## 4. Matching

- Matching runs inside `parseImportChunk` as each note is staged. The alias
  index is built once per call from `entity_alias` resolved as-of now: for each
  entity, its legal names, tickers, and internal names. (Companies added after
  a batch was parsed are not suggested for it; the review picker still offers them.)
- Rules: a ticker matches as a whole word, case-sensitive uppercase, in title
  or body (`\bAAPL\b`). **Tickers of one or two characters match only in
  explicit forms** — `$V`, `(V)`, `NYSE: V` / `NASDAQ: V` — because bare `A`,
  `IT`, `M&A`, `AT&T` are ordinary prose and a match pre-ticks a link (review
  finding I6, 2026-09-30). A name matches case-insensitively as a whole phrase,
  minimum 3 characters. Title matches rank before body matches; the suggestion
  list is ordered by rank then alias length (longer, more specific first).
- Attachments inherit their note's suggestions.
- `status` after matching: `duplicate` if `content_hash` exists on a live
  artifact in the org (`include=false`, `duplicate_of` set); else `unmatched`
  if no suggestions (`include=false`); else `pending` (`include=true`,
  `chosen = suggested`).
- Pure functions in `lib/import/match.ts`; the alias index is a plain array so
  the unit tests need no database.

## 5. Review page (`/import/[batchId]`)

- Header: file name, counts (notes, documents, images skipped, duplicates,
  unmatched), status, **Import selected** and **Discard** buttons.
- Filters: all / unmatched / duplicates / ready.
- Rows: include checkbox · title (with 2-line body preview on hover/expand) ·
  date · type select · company chips (× to remove, + opens a searchable picker
  over the org's entities) · status flag. Attachment rows are indented under
  their note and show file name and size.
- Bulk bar (appears when rows are ticked): "Add company to selected", "Set type
  for selected", "Untick selected".
- Every edit is a server action writing the item row (`updateImportItem`), so
  the review survives reloads and can be shared with a colleague in the same
  org (read-only for them; only the creator edits).

## 6. Import semantics (`commitImportBatch`)

- Precondition: batch `review` or `importing`, caller is the batch creator.
- For each item with `include=true`, `chosen_entity_ids` non-empty, and
  `status in ('pending','unmatched','duplicate')`, in `position` order, pages
  of 50 per call:
  - note → `artifact{source_kind:'paste', artifact_type, title, author: item.author ?? importer display name, body, content_hash, valid_at, created_by: importer}`
  - attachment → `artifact{source_kind:'file', storage_key: item.storage_key, title: "<note title> — <file name>", …}`
  - then `artifact_entity` rows for `chosen_entity_ids`; on link failure reuse
    the existing tombstone rule (write a tombstone superseding the orphan).
  - `supersedes`: if the hash already exists (duplicate the user chose to
    include anyway) → new version of the existing artifact, same as the manual
    path.
  - mark item `imported` with `artifact_id`; on error mark `error` with message
    and continue.
- Items with `include=false` or no companies → `skipped`.
- Writes go through the user's JWT client (RLS + attribution), not the service
  role. Batch → `imported` when no items remain; the receipt lists links to
  created artifacts.
- Idempotent: rerunning only touches items not yet `imported`/`skipped`.

## 7. Errors and limits

- Hosted function budget: chunk work is capped at ~8 s; each call handles at
  least one whole note. A single note whose attachments exceed the function's
  memory/time is recorded as `error` on that item and parsing continues (so
  one 200 MB deck does not block a notebook).
- Storage per-file limit (50 MB on the current plan) → attachment `error`
  with the message, note still imported.
- Duplicate export uploaded twice → second batch's items all flag `duplicate`.
- Discard is allowed before `imported`; after that the batch is a receipt.

## 8. Tests

**Unit (no DB)** `tests/import/*.test.ts` with `fixtures/enex/sample.enex`
(3 notes: one with a pdf + png, one plain, one mentioning two companies by
ticker and name; author on one; entities/aliases as a plain array):
- `enmlToText`: tags → text, line breaks, entities, `en-media` placeholders.
- chunked parsing: feeding the fixture in 1 KB slices yields the same notes as
  one pass; resume from a recorded offset yields the remaining notes only.
- attachment classification and type defaults.
- matching: ticker whole-word, name case-insensitive, title-before-body order,
  no suggestion → unmatched.
- duplicate flagging given a set of existing hashes.
- commit mapping: item → artifact insert payload (pure function).

**Integration (live stack)** in `tests/import.test.ts` (sequential runner):
- staging RLS: creator can update their items; another org sees nothing;
  analyst in the same org can read but not update someone else's batch.
- `commitImportBatch` over a seeded batch writes artifacts + links with
  `created_by = importer`, marks items, is idempotent on rerun.

**Browser** (scratchpad Playwright): upload fixture → parse → review shows 3
notes + 1 attachment, 1 unmatched → assign company → import → artifacts appear
on the company page.

## Files

```
supabase/migrations/20260925000006_import_staging.sql
lib/import/enml.ts          enmlToText
lib/import/enex.ts          streaming note parser (saxes), chunk driver
lib/import/match.ts         alias index + suggest(), flagDuplicates()
lib/import/classify.ts      document mimes, type defaults
lib/import/commit.ts        item -> artifact payload (pure)
actions/import.ts           startImportBatch, parseImportChunk, updateImportItem,
                            bulkUpdateImportItems, commitImportBatch, discardImportBatch
app/(app)/import/page.tsx            batches + upload
app/(app)/import/[batchId]/page.tsx  progress / review / receipt
components/import-upload.tsx, import-review.tsx (client)
fixtures/enex/sample.enex
tests/import/*.test.ts, tests/import.test.ts
```
