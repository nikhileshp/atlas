-- Import staging hardening (whole-branch review, 2026-09-30).
--
-- 1. Idempotent staging: an item's position is now the note's byte offset in
--    the export (attachments: offset + 1 + i), unique per batch. A parse step
--    that is repeated (reload, second tab, crash before progress was saved)
--    collides on the index instead of staging the note twice.
-- 2. Column-level UPDATE: the reviewer may change only what the review table
--    edits, plus the bookkeeping the commit/parse runners write. storage_key,
--    content_hash, body, valid_at, batch_id, org_id are not client-writable.
-- 3. DELETE/TRUNCATE revoked explicitly (default privileges had left TRUNCATE).
-- 4. Update policies require a research-writing role, like the insert policy.

alter table public.import_item alter column position type bigint;
drop index if exists public.import_item_batch_id_position_idx;
create unique index import_item_batch_position_key on public.import_item (batch_id, position);

revoke all on public.import_batch, public.import_item from anon;
revoke delete, truncate, update on public.import_batch, public.import_item from authenticated;
grant update (status, bytes_total, bytes_done, notes_seen, images_skipped, error, updated_at)
  on public.import_batch to authenticated;
grant update (include, chosen_entity_ids, artifact_type, status, artifact_id, error)
  on public.import_item to authenticated;

drop policy import_batch_update on public.import_batch;
create policy import_batch_update on public.import_batch
  for update to authenticated
  using (
    org_id = app.org_id() and created_by = auth.uid()
    and app.user_role() in ('analyst', 'pm', 'admin')
  )
  with check (org_id = app.org_id() and created_by = auth.uid());

drop policy import_item_update on public.import_item;
create policy import_item_update on public.import_item
  for update to authenticated
  using (
    org_id = app.org_id()
    and app.user_role() in ('analyst', 'pm', 'admin')
    and exists (select 1 from public.import_batch b where b.id = batch_id and b.created_by = auth.uid())
  )
  with check (
    org_id = app.org_id()
    and exists (select 1 from public.import_batch b where b.id = batch_id and b.created_by = auth.uid())
  );
