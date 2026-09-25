-- Marks a user whose access has been revoked. Users who authored research
-- rows are never hard-deleted (created_by FKs have no cascade, and the rows
-- are the firm's record); they are banned in Auth and stamped here so the
-- directory shows them as removed. Written by the service role only.
alter table public.profile add column removed_at timestamptz;
