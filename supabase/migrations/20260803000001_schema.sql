-- Atlas initial schema.
--
-- Three non-negotiable properties, enforced here and in 20260803000002_rls.sql:
--   1. CIK-spined: entity is keyed on SEC CIK; names/tickers/FIGIs/LEIs are
--      aliases in entity_alias. Nothing joins on a ticker string.
--   2. Append-only: the application issues no UPDATE and no DELETE. "Edits"
--      supersede prior rows; "deletes" are tombstone rows.
--   3. Bitemporal: every research row carries valid_at (when the fact was
--      true in the world) and recorded_at (when the system learned it).

create extension if not exists pgcrypto;
create schema if not exists app;
grant usage on schema app to authenticated, anon;

-- JWT claim helpers used by every RLS policy
create or replace function app.org_id() returns uuid
language sql stable as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'org_id', '')::uuid
$$;

create or replace function app.user_role() returns text
language sql stable as $$
  select auth.jwt() -> 'app_metadata' ->> 'role'
$$;

-- ── infrastructure ──────────────────────────────────────────────────────────

create table public.org (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- User directory; written only by the service role (seed / admin invite).
create table public.profile (
  user_id uuid primary key references auth.users (id),
  org_id uuid not null references public.org (id),
  email text not null,
  display_name text not null,
  role text not null check (role in ('analyst', 'pm', 'admin')),
  created_at timestamptz not null default now()
);

-- ── research tables (append-only, bitemporal) ───────────────────────────────
-- Uniform base columns:
--   valid_at     when the fact was true in the world
--   recorded_at  when the system learned it (app never sets this; default now())
--   supersedes   prior version of this logical fact (revision or correction)
--   is_tombstone this row retracts the row it supersedes

-- entity is the write-once CIK anchor. Legal names, tickers, and every other
-- name live in entity_alias, so renames/retickers are alias versions and the
-- spine never mutates.
create table public.entity (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id),
  cik text not null check (cik ~ '^[0-9]{10}$'),
  created_by uuid not null references auth.users (id),
  valid_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  unique (org_id, cik)
);

create table public.entity_alias (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id),
  entity_id uuid not null references public.entity (id),
  alias_type text not null check
    (alias_type in ('legal_name', 'ticker', 'former_name', 'figi', 'lei', 'internal')),
  value text not null check (length(trim(value)) > 0),
  created_by uuid not null references auth.users (id),
  valid_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  supersedes uuid references public.entity_alias (id),
  is_tombstone boolean not null default false
);

create table public.artifact (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id),
  artifact_type text not null check
    (artifact_type in ('note', 'model', 'primer', 'thesis', 'filing', 'transcript', 'other')),
  source_kind text not null check (source_kind in ('file', 'url', 'paste')),
  title text not null check (length(trim(title)) > 0),
  author text not null,
  summary text not null default '',
  storage_key text,      -- Supabase Storage object key; file bytes never in Postgres
  url text,
  body text,             -- pasted note text (e.g. lifted out of Evernote)
  content_hash text,     -- sha256 hex; duplicate upload -> new version, not new artifact
  created_by uuid not null references auth.users (id),
  valid_at timestamptz not null,                    -- date the content refers to
  recorded_at timestamptz not null default now(),   -- date it entered Atlas
  supersedes uuid references public.artifact (id),
  is_tombstone boolean not null default false,
  check (
    is_tombstone
    or (source_kind = 'file' and storage_key is not null)
    or (source_kind = 'url' and url is not null)
    or (source_kind = 'paste' and body is not null)
  )
);

-- Junction: every artifact must be linked to >=1 entity (enforced by the
-- createArtifact server action, which tombstones an artifact whose links
-- fail to land). Kept as a table rather than an array so links carry real
-- foreign keys and the same append-only history as everything else.
create table public.artifact_entity (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id),
  artifact_id uuid not null references public.artifact (id),
  entity_id uuid not null references public.entity (id),
  created_by uuid not null references auth.users (id),
  valid_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  supersedes uuid references public.artifact_entity (id),
  is_tombstone boolean not null default false
);

-- One row per scoring session; the five metrics are explicit column groups.
-- The scoring form walks them in causal-chain order:
--   management -> pricing_power -> roiic_moat -> balance_sheet -> growth_durability
-- (pricing power is a source of moat; moat sustains ROIIC; balance sheet
-- governs whether growth is fundable and durable).
-- Every metric requires reasoning and >=1 supporting artifact: a score with
-- no evidence pointer is not accepted.
create table public.quality_score (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id),
  entity_id uuid not null references public.entity (id),
  revision_kind text not null check
    (revision_kind in ('initial', 'refinement', 'change_of_mind')),

  management_score int not null check (management_score between 1 and 10),
  management_reasoning text not null check (length(trim(management_reasoning)) > 0),
  management_evidence uuid[] not null check (cardinality(management_evidence) >= 1),

  pricing_power_score int not null check (pricing_power_score between 1 and 10),
  pricing_power_reasoning text not null check (length(trim(pricing_power_reasoning)) > 0),
  pricing_power_evidence uuid[] not null check (cardinality(pricing_power_evidence) >= 1),

  roiic_moat_score int not null check (roiic_moat_score between 1 and 10),
  roiic_moat_reasoning text not null check (length(trim(roiic_moat_reasoning)) > 0),
  roiic_moat_evidence uuid[] not null check (cardinality(roiic_moat_evidence) >= 1),

  balance_sheet_score int not null check (balance_sheet_score between 1 and 10),
  balance_sheet_reasoning text not null check (length(trim(balance_sheet_reasoning)) > 0),
  balance_sheet_evidence uuid[] not null check (cardinality(balance_sheet_evidence) >= 1),

  growth_durability_score int not null check (growth_durability_score between 1 and 10),
  growth_durability_reasoning text not null check (length(trim(growth_durability_reasoning)) > 0),
  growth_durability_evidence uuid[] not null check (cardinality(growth_durability_evidence) >= 1),

  created_by uuid not null references auth.users (id),
  valid_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  supersedes uuid references public.quality_score (id),
  is_tombstone boolean not null default false
);

create table public.scenario (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id),
  entity_id uuid not null references public.entity (id),
  scenario_kind text not null check (scenario_kind in ('bull', 'base', 'bear', 'other')),
  title text not null check (length(trim(title)) > 0),
  narrative text not null,
  probability numeric check (probability between 0 and 1),
  created_by uuid not null references auth.users (id),
  valid_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  supersedes uuid references public.scenario (id),
  is_tombstone boolean not null default false
);

-- The screen that replaces the destructive spreadsheet. computed_weight and
-- chosen_weight are captured separately and never collapsed: the gap between
-- them is the record of human judgment.
create table public.position_input (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id),
  entity_id uuid not null references public.entity (id),
  irr numeric not null,
  skew numeric not null,                 -- upside : downside ratio
  conviction numeric not null,           -- conviction / model edge
  fcf_growth numeric not null,
  computed_weight numeric,               -- what the formula/model produced (null: no model run)
  chosen_weight numeric not null,        -- what the human actually chose
  rationale text not null default '',
  created_by uuid not null references auth.users (id),
  valid_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  supersedes uuid references public.position_input (id),
  is_tombstone boolean not null default false
);

-- What was decided, by whom, when — anchored to the exact position_input and
-- quality_score rows that were current at the moment of decision, as explicit
-- foreign keys, never by timestamp proximity.
create table public.decision (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id),
  entity_id uuid not null references public.entity (id),
  decision_type text not null check
    (decision_type in ('initiate', 'increase', 'decrease', 'exit', 'hold')),
  summary text not null check (length(trim(summary)) > 0),
  position_input_id uuid not null references public.position_input (id),
  quality_score_id uuid references public.quality_score (id),
  created_by uuid not null references auth.users (id),   -- who decided
  valid_at timestamptz not null,                          -- when decided
  recorded_at timestamptz not null default now(),
  supersedes uuid references public.decision (id),
  is_tombstone boolean not null default false
);

-- ── indexes for org-scoped, as-of, and per-entity access paths ──────────────

create index on public.entity (org_id);
create index on public.entity_alias (org_id, entity_id, recorded_at);
create index on public.entity_alias (org_id, lower(value));
create index on public.artifact (org_id, recorded_at);
create index on public.artifact (org_id, content_hash);
create index on public.artifact_entity (org_id, entity_id, recorded_at);
create index on public.artifact_entity (org_id, artifact_id);
create index on public.quality_score (org_id, entity_id, recorded_at);
create index on public.scenario (org_id, entity_id, recorded_at);
create index on public.position_input (org_id, entity_id, recorded_at);
create index on public.decision (org_id, entity_id, recorded_at);
