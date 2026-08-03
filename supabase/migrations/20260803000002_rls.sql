-- Atlas RLS: org tenancy from the JWT, role-gated inserts, and hard
-- append-only enforcement.
--
-- Append-only, layer 1: the client-facing roles simply lack the verbs.
revoke update, delete, truncate on all tables in schema public from authenticated, anon;

-- Append-only, layer 2: RLS is enabled everywhere and there are NO update or
-- delete policies, so even a future migration that re-grants the verbs still
-- denies every row. A careless query cannot violate the model.

alter table public.org enable row level security;
alter table public.profile enable row level security;
alter table public.entity enable row level security;
alter table public.entity_alias enable row level security;
alter table public.artifact enable row level security;
alter table public.artifact_entity enable row level security;
alter table public.quality_score enable row level security;
alter table public.scenario enable row level security;
alter table public.position_input enable row level security;
alter table public.decision enable row level security;

-- Tenancy: every policy is keyed on the JWT's org claim (app.org_id() reads
-- app_metadata.org_id), never on WHERE clauses in application code.

create policy org_select on public.org
  for select to authenticated using (id = app.org_id());

create policy profile_select on public.profile
  for select to authenticated using (org_id = app.org_id());
-- profile writes: service role only (no authenticated policies).

-- Entity records are managed by admin.
create policy entity_select on public.entity
  for select to authenticated using (org_id = app.org_id());
create policy entity_insert on public.entity
  for insert to authenticated with check (
    org_id = app.org_id() and created_by = auth.uid()
    and app.user_role() = 'admin'
  );

create policy entity_alias_select on public.entity_alias
  for select to authenticated using (org_id = app.org_id());
create policy entity_alias_insert on public.entity_alias
  for insert to authenticated with check (
    org_id = app.org_id() and created_by = auth.uid()
    and app.user_role() = 'admin'
  );

-- Research content: analyst and pm write; every insert records the acting
-- user (created_by = auth.uid()) — attribution is a hard requirement.
create policy artifact_select on public.artifact
  for select to authenticated using (org_id = app.org_id());
create policy artifact_insert on public.artifact
  for insert to authenticated with check (
    org_id = app.org_id() and created_by = auth.uid()
    and app.user_role() in ('analyst', 'pm')
  );

create policy artifact_entity_select on public.artifact_entity
  for select to authenticated using (org_id = app.org_id());
create policy artifact_entity_insert on public.artifact_entity
  for insert to authenticated with check (
    org_id = app.org_id() and created_by = auth.uid()
    and app.user_role() in ('analyst', 'pm')
  );

create policy quality_score_select on public.quality_score
  for select to authenticated using (org_id = app.org_id());
create policy quality_score_insert on public.quality_score
  for insert to authenticated with check (
    org_id = app.org_id() and created_by = auth.uid()
    and app.user_role() in ('analyst', 'pm')
  );

create policy scenario_select on public.scenario
  for select to authenticated using (org_id = app.org_id());
create policy scenario_insert on public.scenario
  for insert to authenticated with check (
    org_id = app.org_id() and created_by = auth.uid()
    and app.user_role() in ('analyst', 'pm')
  );

-- Sizing and decisions: pm only.
create policy position_input_select on public.position_input
  for select to authenticated using (org_id = app.org_id());
create policy position_input_insert on public.position_input
  for insert to authenticated with check (
    org_id = app.org_id() and created_by = auth.uid()
    and app.user_role() = 'pm'
  );

create policy decision_select on public.decision
  for select to authenticated using (org_id = app.org_id());
create policy decision_insert on public.decision
  for insert to authenticated with check (
    org_id = app.org_id() and created_by = auth.uid()
    and app.user_role() = 'pm'
  );

-- Storage: object keys are '<org_id>/<artifact_id>/<filename>'. Policies are
-- path-scoped (first folder must be the caller's org), not bucket-name-scoped,
-- so the bucket name stays in env. No update/delete policies: storage is
-- append-only too.
create policy storage_objects_select on storage.objects
  for select to authenticated
  using ((storage.foldername(name))[1] = app.org_id()::text);
create policy storage_objects_insert on storage.objects
  for insert to authenticated
  with check ((storage.foldername(name))[1] = app.org_id()::text);
