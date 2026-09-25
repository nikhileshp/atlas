-- Artifact storage bucket. Locally the seed script creates it; in a hosted
-- project there is no seed, so the bucket is part of the schema. Private:
-- reads go through signed URLs, and the RLS policies in 20260803000002_rls.sql
-- scope objects to the caller's org folder.
insert into storage.buckets (id, name, public)
values ('artifacts', 'artifacts', false)
on conflict (id) do nothing;
