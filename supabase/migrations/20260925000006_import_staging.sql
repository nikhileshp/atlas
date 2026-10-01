-- Import staging. These two tables are a WORKBENCH, not the record: an
-- Evernote export is parsed into them, the importer reviews and edits company
-- links, and only "Import" writes artifacts (through the normal append-only
-- path). They are therefore the one place in Atlas where UPDATE is granted.
-- DELETE stays revoked; abandoned batches are marked 'discarded'.

create table public.import_batch (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id),
  created_by uuid not null references auth.users (id),
  source_kind text not null check (source_kind in ('enex')),
  storage_key text not null,
  file_name text not null,
  status text not null default 'parsing'
    check (status in ('parsing','review','importing','imported','failed','discarded')),
  bytes_total bigint,
  bytes_done bigint not null default 0,
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
  parent_item_id uuid references public.import_item (id),
  position int not null,
  title text not null,
  author text,
  valid_at timestamptz not null,
  body text,
  storage_key text,
  file_name text,
  mime text,
  bytes bigint,
  content_hash text not null,
  artifact_type text not null
    check (artifact_type in ('note','model','primer','thesis','filing','transcript','other')),
  suggested_entity_ids uuid[] not null default '{}',
  chosen_entity_ids uuid[] not null default '{}',
  include boolean not null default true,
  status text not null default 'pending'
    check (status in ('pending','duplicate','unmatched','imported','skipped','error')),
  duplicate_of uuid references public.artifact (id),
  artifact_id uuid references public.artifact (id),
  error text
);
create index on public.import_item (batch_id, position);
create index on public.import_batch (org_id, created_at);

grant select, insert, update on public.import_batch, public.import_item to authenticated;
grant all on public.import_batch, public.import_item to service_role;

alter table public.import_batch enable row level security;
alter table public.import_item enable row level security;

create policy import_batch_select on public.import_batch
  for select to authenticated using (org_id = app.org_id());
create policy import_batch_insert on public.import_batch
  for insert to authenticated with check (
    org_id = app.org_id() and created_by = auth.uid()
    and app.user_role() in ('analyst', 'pm', 'admin')
  );
create policy import_batch_update on public.import_batch
  for update to authenticated
  using (org_id = app.org_id() and created_by = auth.uid())
  with check (org_id = app.org_id() and created_by = auth.uid());

create policy import_item_select on public.import_item
  for select to authenticated using (org_id = app.org_id());
create policy import_item_insert on public.import_item
  for insert to authenticated with check (
    org_id = app.org_id()
    and exists (select 1 from public.import_batch b where b.id = batch_id and b.created_by = auth.uid())
  );
create policy import_item_update on public.import_item
  for update to authenticated
  using (
    org_id = app.org_id()
    and exists (select 1 from public.import_batch b where b.id = batch_id and b.created_by = auth.uid())
  )
  with check (
    org_id = app.org_id()
    and exists (select 1 from public.import_batch b where b.id = batch_id and b.created_by = auth.uid())
  );
