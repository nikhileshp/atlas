# Atlas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Atlas, an entity-centric, append-only, bitemporal system of record for a long-only equity firm's research: entities (CIK-spined), artifacts, quality scores, scenarios, position inputs, and decisions — running entirely on localhost against local Supabase.

**Architecture:** Next.js App Router (TS, Tailwind) with all reads in React Server Components and all writes in Server Actions through `@supabase/ssr` clients carrying the user's JWT. Local Supabase (CLI + Docker) provides Postgres/Auth/Storage; the security model lives in RLS policies keyed on JWT `app_metadata` (org_id, role), with UPDATE/DELETE revoked outright. Bitemporality is uniform base columns (`valid_at`, `recorded_at`, `supersedes`, `is_tombstone`) on every research table plus a single `resolveAsOf()` helper used by every view, driven by an as-of cookie set from the header control.

**Tech Stack:** Next.js 15 (App Router), TypeScript, Tailwind, @supabase/supabase-js + @supabase/ssr, Supabase CLI (local Docker), vitest (unit + RLS integration tests), tsx (seed script).

## Global Constraints

- Localhost only. No deployment target, no Vercel config, no production Dockerfile, no CI deploy workflow, no hosting settings.
- Every connection detail (URLs, keys, bucket name, ports, EDGAR base URLs + User-Agent) read from `.env.local` via `lib/env.ts`. Nothing hardcoded in application code.
- Server Actions for all writes. No client-side database access (no supabase-js in client components except none at all — clients only render and call actions).
- Append-only: the app issues **no UPDATE and no DELETE** against the seven research tables. Enforced by revoking those verbs from `authenticated`/`anon` and having no update/delete RLS policies.
- CIK-spined: `entity` is unique on `(org_id, cik)`; every join is on entity UUID/CIK. No feature joins on ticker strings.
- Bitemporal: every research row carries `valid_at` (world time) and `recorded_at` (system time). Every list/detail view respects the header "as of" control (default now).
- Attribution: every write records `created_by = auth.uid()`, enforced in RLS `WITH CHECK`, derived server-side from the session, never from form data.
- Roles: analyst → insert artifact/artifact_entity/quality_score/scenario; pm → analyst's set + position_input/decision; admin → entity/entity_alias (+ user management). Enforced in RLS.
- SEC EDGAR: server-side only (CORS), `User-Agent` from env on every call, on-disk response cache in `EDGAR_CACHE_DIR`.
- Out of scope (leave clearly marked placeholders if a screen begs for it): similarity/comparison, automated scoring, screening/ranking, portfolio optimization, chat, LLM calls.
- Conventional Commits; git repo initialized in Task 1.
- Note: `atlas_schema.sql` was not provided; per user decision the schema is authored from the spec in Task 2 as the initial migration. One deliberate addition to the named seven tables: `artifact_entity` junction (an artifact must link ≥1 entity, and can link several; arrays would lose FK integrity). It follows the same append-only/bitemporal rules. `org` and `profile` are infrastructure tables (profile is service-role-writable only, used for user directory/roles display).

## Environment Variables (`.env.example`, copied to `.env.local` by bootstrap)

```bash
# --- Supabase (local dev; values printed by `npx supabase status`) ---
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key from supabase status>
SUPABASE_SERVICE_ROLE_KEY=<service_role key from supabase status>
SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres

# --- App ---
SITE_URL=http://localhost:3000
SUPABASE_STORAGE_BUCKET=artifacts

# --- SEC EDGAR ---
EDGAR_BASE_URL=https://www.sec.gov
EDGAR_DATA_BASE_URL=https://data.sec.gov
EDGAR_USER_AGENT="Atlas dev prabhakar.nikhilesh@gmail.com"
EDGAR_CACHE_DIR=.cache/edgar

# --- Seed (dev only) ---
SEED_USER_PASSWORD=atlas-local-dev
```

When this moves off localhost, only `NEXT_PUBLIC_SUPABASE_URL`, keys, `SUPABASE_DB_URL`, and `SITE_URL` change; `SEED_USER_PASSWORD` and the dev switcher disappear (README documents this).

## File Structure

```
atlas/
├── plan/                                # this plan
├── scripts/
│   ├── bootstrap.sh                     # one-command startup
│   └── seed.ts                          # service-role seed (tsx)
├── supabase/
│   ├── config.toml                      # signup disabled, mailpit on
│   └── migrations/
│       ├── 20260803000001_schema.sql    # tables + helpers + indexes
│       └── 20260803000002_rls.sql       # grants, RLS, storage policies
├── fixtures/edgar/                      # checked-in EDGAR JSON for offline seed
├── lib/
│   ├── env.ts                           # typed env access, throws on missing
│   ├── asof.ts                          # resolveAsOf(), as-of cookie read
│   ├── hash.ts                          # sha256 of buffer
│   ├── edgar.ts                         # EDGAR fetch + file cache (server-only)
│   ├── types.ts                         # DB row types
│   └── supabase/
│       ├── server.ts                    # @supabase/ssr server client (user JWT)
│       ├── middleware.ts                # session refresh helper
│       └── admin.ts                     # service-role client (server-only)
├── actions/                             # "use server" — ALL writes
│   ├── asof.ts        setAsOf(dateISO | null)
│   ├── auth.ts        signIn, signOut, setPassword
│   ├── dev.ts         devSwitchUser(email)            [NODE_ENV gate]
│   ├── entities.ts    createEntity, addAlias
│   ├── artifacts.ts   createArtifact (3 paths), tombstoneArtifact
│   ├── scores.ts      createQualityScore
│   ├── scenarios.ts   createScenario
│   ├── positions.ts   createPositionInput
│   ├── decisions.ts   createDecision
│   └── admin.ts       inviteUser
├── components/
│   ├── header.tsx, as-of-control.tsx, user-switcher.tsx
│   ├── entity-search.tsx                # EDGAR search picker (client)
│   ├── artifact-form.tsx                # 3-path ingest (client)
│   ├── score-wizard.tsx                 # 5-section causal-chain wizard (client)
│   ├── position-form.tsx, decision-form.tsx, scenario-form.tsx
│   └── (small presentational pieces: badges, tables, section cards)
├── app/
│   ├── layout.tsx, globals.css
│   ├── login/page.tsx
│   ├── auth/confirm/route.ts            # verifyOtp for invite links
│   ├── auth/set-password/page.tsx
│   ├── api/edgar/search/route.ts        # ?q= → matches (server-side EDGAR)
│   ├── api/edgar/company/[cik]/route.ts # submissions detail
│   └── (app)/                           # authed group, shared chrome
│       ├── layout.tsx                   # header: nav, as-of, switcher
│       ├── page.tsx                     # entity list
│       ├── entities/new/page.tsx
│       ├── entities/[id]/page.tsx       # ENTITY DETAIL (center of app)
│       ├── entities/[id]/score/page.tsx
│       ├── entities/[id]/position/page.tsx
│       ├── positions/page.tsx           # portfolio-wide, replaces spreadsheet
│       ├── artifacts/new/page.tsx
│       ├── artifacts/[id]/page.tsx
│       └── admin/users/page.tsx
├── tests/
│   ├── asof.test.ts, hash.test.ts, edgar-cache.test.ts   # unit
│   └── rls.test.ts, seed.test.ts                         # integration (live local stack)
├── middleware.ts
├── .env.example  .gitignore  README.md
└── package.json  tsconfig.json  next.config.ts  etc.
```

---

### Task 1: Scaffold — Next.js app, Tailwind, env plumbing, git

**Files:**
- Create: entire Next.js scaffold via `create-next-app`, `lib/env.ts`, `.env.example`, `.gitignore` additions, `tests/` + vitest config
- Test: `tests/env.test.ts`

**Interfaces:**
- Produces: `env(name: EnvKey): string` — throws `Missing environment variable: X` if unset; `EnvKey` union of the vars above.

- [ ] **Step 1: Scaffold**

```bash
cd /home/nikhilesh/Projects/atlas
npx --yes create-next-app@latest . --ts --tailwind --eslint --app --no-src-dir --import-alias "@/*" --use-npm
npm i @supabase/supabase-js @supabase/ssr
npm i -D vitest tsx @types/node dotenv
git init -b master
```

- [ ] **Step 2: Write `.env.example`** with the block from "Environment Variables" above. Add to `.gitignore`: `.env.local`, `.cache/`, `supabase/.temp/`.

- [ ] **Step 3: Failing test for env access** (`tests/env.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { env } from "@/lib/env";

describe("env", () => {
  it("returns a set variable", () => {
    process.env.SITE_URL = "http://localhost:3000";
    expect(env("SITE_URL")).toBe("http://localhost:3000");
  });
  it("throws on a missing variable", () => {
    delete process.env.SUPABASE_STORAGE_BUCKET;
    expect(() => env("SUPABASE_STORAGE_BUCKET")).toThrow(/SUPABASE_STORAGE_BUCKET/);
  });
});
```

Run `npx vitest run tests/env.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement `lib/env.ts`**

```ts
const KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_URL", "SITE_URL",
  "SUPABASE_STORAGE_BUCKET", "EDGAR_BASE_URL", "EDGAR_DATA_BASE_URL",
  "EDGAR_USER_AGENT", "EDGAR_CACHE_DIR", "SEED_USER_PASSWORD",
] as const;
export type EnvKey = (typeof KEYS)[number];

export function env(name: EnvKey): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}
```

- [ ] **Step 5: vitest config + npm scripts** (`vitest.config.ts` with `@` alias, `dotenv/config` loading `.env.local`; scripts: `test`, `test:integration`, `seed`, `bootstrap`). Run test → PASS.

- [ ] **Step 6: Commit** `chore: scaffold Next.js app with typed env access`

---

### Task 2: Supabase local project + schema migration

**Files:**
- Create: `supabase/config.toml` (via `supabase init`, then edit), `supabase/migrations/20260803000001_schema.sql`

**Interfaces:**
- Produces: tables `org`, `profile`, `entity`, `entity_alias`, `artifact`, `artifact_entity`, `quality_score`, `scenario`, `position_input`, `decision`; helper fns `app.org_id()`, `app.user_role()`. Uniform base columns on research tables: `id uuid pk`, `org_id`, `created_by`, `valid_at timestamptz`, `recorded_at timestamptz default now()`, `supersedes uuid self-FK`, `is_tombstone boolean default false` (entity: no supersedes/tombstone — it is the write-once CIK anchor; legal names/tickers live in `entity_alias`).

- [ ] **Step 1: `supabase init`**, then edit `config.toml` auth section:

```toml
[auth]
enabled = true
site_url = "http://localhost:3000"
additional_redirect_urls = ["http://localhost:3000/auth/confirm"]
enable_signup = false            # invite-only; admin API still works

[auth.email]
enable_signup = false
enable_confirmations = true
```

(Mail catcher — Inbucket/Mailpit at :54324 — is on by default.)

- [ ] **Step 2: Write migration `20260803000001_schema.sql`** — full content:

```sql
create extension if not exists pgcrypto;
create schema if not exists app;

-- JWT claim helpers used by every RLS policy
create or replace function app.org_id() returns uuid
language sql stable as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'org_id', '')::uuid
$$;

create or replace function app.user_role() returns text
language sql stable as $$
  select auth.jwt() -> 'app_metadata' ->> 'role'
$$;

-- ── infrastructure ────────────────────────────────────────────────
create table public.org (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- user directory; written only by service role (seed / invite action)
create table public.profile (
  user_id uuid primary key references auth.users (id),
  org_id uuid not null references public.org (id),
  email text not null,
  display_name text not null,
  role text not null check (role in ('analyst', 'pm', 'admin')),
  created_at timestamptz not null default now()
);

-- ── research tables (append-only, bitemporal) ─────────────────────
-- valid_at    : when the fact was true in the world
-- recorded_at : when the system learned it
-- supersedes  : prior version of this logical fact (revision/correction)
-- is_tombstone: this row retracts the row it supersedes

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
  storage_key text,      -- Supabase Storage object key; bytes never in Postgres
  url text,
  body text,             -- pasted note text
  content_hash text,     -- sha256 hex; duplicate detection → versioning
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

-- junction: an artifact must be linked to >=1 entity (enforced in the
-- server action, which inserts links with the artifact or tombstones it)
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

-- one row per scoring session; five metrics as explicit column groups.
-- causal chain order for the form:
--   management -> pricing_power -> roiic_moat -> balance_sheet -> growth_durability
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

create table public.position_input (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id),
  entity_id uuid not null references public.entity (id),
  irr numeric not null,
  skew numeric not null,                 -- upside : downside ratio
  conviction numeric not null,           -- conviction / model edge
  fcf_growth numeric not null,
  computed_weight numeric,               -- what the formula produced (nullable: no model run)
  chosen_weight numeric not null,        -- what the human actually chose; NEVER collapsed
  rationale text not null default '',
  created_by uuid not null references auth.users (id),
  valid_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  supersedes uuid references public.position_input (id),
  is_tombstone boolean not null default false
);

create table public.decision (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id),
  entity_id uuid not null references public.entity (id),
  decision_type text not null check
    (decision_type in ('initiate', 'increase', 'decrease', 'exit', 'hold')),
  summary text not null check (length(trim(summary)) > 0),
  -- explicit FKs to what was current at the moment of decision (never by timestamp proximity)
  position_input_id uuid not null references public.position_input (id),
  quality_score_id uuid references public.quality_score (id),
  created_by uuid not null references auth.users (id),   -- who decided
  valid_at timestamptz not null,                          -- when decided
  recorded_at timestamptz not null default now(),
  supersedes uuid references public.decision (id),
  is_tombstone boolean not null default false
);

-- indexes for org-scoped, as-of, and per-entity access paths
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
```

- [ ] **Step 3: `npx supabase start` then `npx supabase db reset`** → migration applies cleanly.

- [ ] **Step 4: Verify constraints bite** (psql via `SUPABASE_DB_URL`): attempt `insert into entity (org_id, cik, created_by, valid_at) values (..., '320193', ...)` → fails CIK format check; insert quality_score with empty evidence array → fails cardinality check. Expected: ERROR for both.

- [ ] **Step 5: Commit** `feat(db): initial schema — CIK-spined, append-only, bitemporal`

---

### Task 3: RLS migration — org tenancy, role gates, no update/delete, storage policies

**Files:**
- Create: `supabase/migrations/20260803000002_rls.sql`

**Interfaces:**
- Produces: RLS on all tables; role-gated INSERT policies; zero update/delete policies plus explicit `REVOKE UPDATE, DELETE`; storage.objects policies scoped to `<org_id>/` path prefix.

- [ ] **Step 1: Write migration** — full content:

```sql
-- Append-only enforcement, layer 1: the app role simply lacks the verbs.
revoke update, delete, truncate on all tables in schema public from authenticated, anon;

-- Layer 2: RLS everywhere; absence of UPDATE/DELETE policies denies them
-- even if a future migration re-grants the verbs.
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

create policy org_select on public.org
  for select to authenticated using (id = app.org_id());

create policy profile_select on public.profile
  for select to authenticated using (org_id = app.org_id());
-- profile writes: service role only (no authenticated policies).

-- entity records are managed by admin
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

-- research content: analyst and pm
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

-- sizing and decisions: pm only
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

-- storage: object keys are '<org_id>/<artifact_id>/<filename>'.
-- Policies are path-scoped, not bucket-name-scoped, so the bucket name
-- stays in env. No update/delete policies: storage is append-only too.
create policy storage_objects_select on storage.objects
  for select to authenticated
  using ((storage.foldername(name))[1] = app.org_id()::text);
create policy storage_objects_insert on storage.objects
  for insert to authenticated
  with check ((storage.foldername(name))[1] = app.org_id()::text);
```

- [ ] **Step 2: `npx supabase db reset`** → both migrations apply. Verify with psql: `select tablename, policyname, cmd from pg_policies where schemaname='public' order by 1;` → only SELECT/INSERT rows, no UPDATE/DELETE.

- [ ] **Step 3: Commit** `feat(db): RLS — org tenancy, role gates, append-only enforcement`

(Behavioral verification of these policies is Task 5's integration suite, which needs seeded users.)

---

### Task 4: Seed script — org, three users, five EDGAR entities, 18 months of history

**Files:**
- Create: `scripts/seed.ts`, `fixtures/edgar/company_tickers.json` (trimmed), `fixtures/edgar/CIK*.json` (5 files)
- Test: `tests/seed.test.ts`

**Interfaces:**
- Consumes: service-role client from `lib/supabase/admin.ts` (created here: `createAdminClient()` using `env("NEXT_PUBLIC_SUPABASE_URL")` + `env("SUPABASE_SERVICE_ROLE_KEY")`, `auth: { persistSession: false }`).
- Produces: idempotent `npm run seed` (wipes public research tables' rows for the seed org via service role SQL `delete` — service role is exempt from the app's append-only rule; seeding is not an app write). Users: `alice.analyst@atlas.test` (analyst), `pete.pm@atlas.test` (pm), `ada.admin@atlas.test` (admin), password `env("SEED_USER_PASSWORD")`, `app_metadata: { org_id, role }`. Storage bucket `env("SUPABASE_STORAGE_BUCKET")` created if absent.

**Seed dataset (all timestamps explicit; today is 2026-08-03, so history spans 2025-02 → 2026-07):**
- Org: "Meridian Capital Partners".
- Entities (CIKs, fetched from EDGAR live with fixture fallback): Apple `0000320193`, Microsoft `0000789019`, Costco `0000909832`, Visa `0001403161`, Moody's `0001059556`. Aliases seeded from EDGAR: legal_name, ticker(s), former names; plus internal aliases (e.g. "AAPL primer folder" internal alias for Apple).
- Artifacts: ~14 across entities and types (notes/primers/models/filings/transcripts; mix of url + paste; two `file` artifacts uploaded to storage from small generated .txt-as-pdf placeholder files — real bytes, real object keys), recorded_at staggered 2025-02 → 2026-06. Include: one artifact **version chain** (Costco model re-uploaded with same content_hash 2026-01 superseding the 2025-05 row) and one **tombstoned** artifact (Moody's stale note tombstoned 2026-03 — before that date it shows, after it doesn't).
- Quality scores: Apple scored 2025-03-10 (`initial`, pricing_power 9) and again 2026-02-20 (`change_of_mind`, pricing_power 6, reasoning documents the changed view, supersedes the first). Microsoft scored once 2025-06 (`initial`) and refined 2025-11 (`refinement`). Every metric row carries reasoning + ≥1 evidence artifact id.
- Scenarios: bull/base/bear for Apple, base for Visa.
- Position inputs: Visa 3 rows (2025-04, 2025-10, 2026-05; the 2026-05 row has computed_weight 4.0 vs chosen_weight 6.5 — the divergence case, rationale explains it); Apple 2 rows (computed = chosen, the formula-following case); Costco 1 row.
- Decisions: Visa `initiate` 2025-04 (FK → first Visa position_input, no score), Visa `increase` 2026-05 (FK → divergent position_input), Apple `hold` 2026-03 (FK → Apple position_input + the change_of_mind quality_score row).
- All `created_by` attributions: alice writes artifacts/scores/scenarios, pete writes positions/decisions, ada creates entities/aliases.

- [ ] **Step 1: Write failing `tests/seed.test.ts`** (integration; service client): asserts org count 1, 3 profiles with the 3 roles, 5 entities with valid CIKs, ≥40 aliases? (assert ≥ 5 legal_name + ≥5 ticker), artifact version chain exists (`supersedes` non-null with equal content_hash), a tombstone artifact exists, Apple has 2 quality_score rows with second `revision_kind='change_of_mind'` and `supersedes` set, a position_input with `computed_weight <> chosen_weight`, decisions have non-null `position_input_id`, distinct recorded_at values span ≥ 500 days.

- [ ] **Step 2: Write `lib/supabase/admin.ts`** and `scripts/seed.ts` implementing the dataset above. Key mechanics: `supabase.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { org_id, role } })`; explicit `recorded_at`/`valid_at` on every research row; storage upload via `admin.storage.from(env("SUPABASE_STORAGE_BUCKET")).upload(...)`; EDGAR fetch with `User-Agent: env("EDGAR_USER_AGENT")` and fallback to `fixtures/edgar/`.

- [ ] **Step 3: Run `npm run seed` then `npx vitest run tests/seed.test.ts`** → PASS.

- [ ] **Step 4: Commit** `feat(seed): org, roles, EDGAR entities, 18-month research history`

---

### Task 5: RLS integration test suite

**Files:**
- Test: `tests/rls.test.ts`

**Interfaces:**
- Consumes: seeded users; anon-key clients signed in via `signInWithPassword`.

- [ ] **Step 1: Write the matrix tests** (these are the "policies that are exercised" the spec demands):

```ts
// per signed-in role client:
// 1. UPDATE denial: alice updates her own artifact title → error or 0 rows affected; row unchanged.
// 2. DELETE denial: pete deletes a position_input → error or 0 rows; row still present.
// 3. Role gates: alice inserts position_input → rejected; pete inserts → ok;
//    alice inserts artifact → ok; ada inserts artifact → rejected;
//    ada inserts entity_alias → ok; alice inserts entity_alias → rejected;
//    pete inserts decision with valid FKs → ok.
// 4. Attribution: alice inserts artifact with created_by = pete.id → rejected.
// 5. Tenancy: create a second org + user via service role; that user selects
//    entity/artifact/quality_score → all empty arrays despite seeded data.
// 6. Storage: alice uploads to `<other_org_id>/x.txt` → rejected; to own org prefix → ok.
```

Each written as a concrete vitest case; supabase-js returns `error` for policy violations (PostgREST 42501) and empty `data` for update/delete without policy — assert on both row-count-unchanged AND error presence where applicable.

- [ ] **Step 2: Run → some cases will fail** if policies have gaps; fix the RLS migration (edit migration file, `db reset`, re-seed, re-run) until the full matrix passes.

- [ ] **Step 3: Commit** `test(db): RLS matrix — roles, tenancy, append-only, attribution`

---

### Task 6: Auth plumbing — clients, middleware, login, invite confirm, set password

**Files:**
- Create: `lib/supabase/server.ts`, `lib/supabase/middleware.ts`, `middleware.ts`, `actions/auth.ts`, `app/login/page.tsx`, `app/auth/confirm/route.ts`, `app/auth/set-password/page.tsx`

**Interfaces:**
- Produces: `createClient()` (server, cookie-bound, per @supabase/ssr docs pattern); `requireUser()` → `{ user, profile }` or redirect `/login`; actions `signIn(formData)`, `signOut()`, `setPassword(formData)`.

- [ ] **Step 1: Implement `lib/supabase/server.ts`** — standard `createServerClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), { cookies })` pattern, plus `requireUser()` which calls `auth.getUser()`, loads `profile` row, and `redirect("/login")` when absent.
- [ ] **Step 2: Implement `middleware.ts`** — @supabase/ssr session refresh; unauthenticated requests to `(app)` routes redirect to `/login` (matcher excludes `/login`, `/auth/*`, `/api/edgar/*` stays behind auth? — EDGAR routes require a session too: check user in handler).
- [ ] **Step 3: Login page** — email/password form posting to `signIn` server action (`signInWithPassword`, redirect `/`). Error state rendered from `useActionState`. No signup link (invite-only).
- [ ] **Step 4: `app/auth/confirm/route.ts`** — GET with `token_hash` + `type` → `supabase.auth.verifyOtp({ type, token_hash })` → redirect `/auth/set-password` (invite) or `/`. Set-password page calls `setPassword` action (`auth.updateUser({ password })` — this is auth schema, not a research table; allowed).
- [ ] **Step 5: Verify manually**: `npm run dev`, log in as each seeded user; wrong password shows error. Commit `feat(auth): cookie-bound Supabase auth, invite confirm flow`

---

### Task 7: App chrome — layout, nav, as-of control, dev user switcher + as-of lib

**Files:**
- Create: `app/(app)/layout.tsx`, `components/header.tsx`, `components/as-of-control.tsx`, `components/user-switcher.tsx`, `actions/asof.ts`, `actions/dev.ts`, `lib/asof.ts`
- Test: `tests/asof.test.ts`

**Interfaces:**
- Produces:
  - `resolveAsOf<T extends VersionedRow>(rows: T[], asOf: Date): T[]` — rows visible as of `asOf`: `recorded_at <= asOf`, not superseded by a visible row, not tombstoned. `VersionedRow = { id: string; recorded_at: string; supersedes: string | null; is_tombstone: boolean }`.
  - `versionChain(rows, headId)` — ordered history for a logical fact (for artifact versions / score history display).
  - `getAsOf(): Promise<Date>` — reads `atlas-as-of` cookie, defaults to now.
  - `setAsOf(iso: string | null)` server action — sets/clears cookie, `revalidatePath("/", "layout")`.
  - `devSwitchUser(email: string)` server action — **throws unless `process.env.NODE_ENV === "development"`**; `signInWithPassword({ email, password: env("SEED_USER_PASSWORD") })` re-binding the session cookie to the target seeded user.

- [ ] **Step 1: Failing unit tests for `resolveAsOf`**

```ts
const t = (d: string) => new Date(d);
const rows = [
  { id: "a1", recorded_at: "2025-03-01T00:00:00Z", supersedes: null, is_tombstone: false },
  { id: "a2", recorded_at: "2026-01-01T00:00:00Z", supersedes: "a1", is_tombstone: false },
  { id: "b1", recorded_at: "2025-06-01T00:00:00Z", supersedes: null, is_tombstone: false },
  { id: "b2", recorded_at: "2026-03-01T00:00:00Z", supersedes: "b1", is_tombstone: true },
];
// as of 2025-04-01 → [a1]                (b1 not yet recorded)
// as of 2025-07-01 → [a1, b1]
// as of 2026-02-01 → [a2, b1]            (a1 superseded)
// as of 2026-04-01 → [a2]                (b1 retracted by tombstone b2)
// as of 2024-01-01 → []
```

- [ ] **Step 2: Implement `lib/asof.ts`**

```ts
export function resolveAsOf<T extends VersionedRow>(rows: T[], asOf: Date): T[] {
  const visible = rows.filter((r) => new Date(r.recorded_at) <= asOf);
  const superseded = new Set(visible.map((r) => r.supersedes).filter(Boolean));
  return visible.filter((r) => !superseded.has(r.id) && !r.is_tombstone);
}
```

Run tests → PASS.

- [ ] **Step 3: Chrome.** `(app)/layout.tsx` calls `requireUser()` + `getAsOf()`; header shows: nav (Entities, Positions, New Artifact, Admin·Users when role=admin), the signed-in user + role badge, sign-out, `<AsOfControl>` (datetime-local input + "Now" reset; amber banner style when as-of ≠ now: "Viewing the world as Atlas knew it on …"), and `<UserSwitcher>` rendered **only when `process.env.NODE_ENV === "development"`** (server-side gate at render site) listing the three seeded users from `profile`, calling `devSwitchUser`.
- [ ] **Step 4: Verify in browser**: switcher swaps role badge without logout; as-of banner appears and persists across navigation. Commit `feat(app): chrome with as-of control and dev user switcher`

---

### Task 8: EDGAR proxy — lib, cache, route handlers

**Files:**
- Create: `lib/edgar.ts`, `app/api/edgar/search/route.ts`, `app/api/edgar/company/[cik]/route.ts`
- Test: `tests/edgar-cache.test.ts`

**Interfaces:**
- Produces:
  - `searchCompanies(q: string): Promise<{ cik: string; ticker: string; name: string }[]>` (top 12; substring match on name/ticker, case-insensitive; CIK zero-padded to 10).
  - `getCompany(cik10: string): Promise<{ cik: string; name: string; tickers: string[]; formerNames: { name: string; from: string | null; to: string | null }[] }>` from `${EDGAR_DATA_BASE_URL}/submissions/CIK<cik10>.json`.
  - `fetchCached(url: string, ttlMs: number): Promise<unknown>` — file cache in `env("EDGAR_CACHE_DIR")`, key = sha256(url), TTL 24h tickers / 7d submissions; **every** fetch sends `User-Agent: env("EDGAR_USER_AGENT")`; non-200 → typed error. Tickers file: `${EDGAR_BASE_URL}/files/company_tickers.json`.
  - Route handlers: check session (`createClient().auth.getUser()` → 401 if none), then return JSON. This is the CORS workaround: the browser only ever talks to our origin.

- [ ] **Step 1: Failing tests for `fetchCached`** (inject fetch via parameter or `vi.stubGlobal`): a) miss → network called once, file written; b) hit within TTL → network NOT called; c) expired TTL → refetch; d) asserts `User-Agent` header equals env value.
- [ ] **Step 2: Implement, run tests → PASS.**
- [ ] **Step 3: Live smoke**: `curl -b <session>` or temporary node script hitting `searchCompanies("apple")` → includes CIK `0000320193`. Second call served from `.cache/edgar/` (log line).
- [ ] **Step 4: Commit** `feat(edgar): server-side EDGAR proxy with UA header and disk cache`

---

### Task 9: Entity creation + aliases — EDGAR search picker, manual CIK fallback, alias warnings

**Files:**
- Create: `app/(app)/entities/new/page.tsx`, `components/entity-search.tsx`, `actions/entities.ts`, `app/(app)/page.tsx` (entity list)

**Interfaces:**
- Produces:
  - `createEntity(input: { cik: string })` action — admin-gated by RLS; fetches `getCompany(cik)`; inserts `entity` (unique(org_id, cik) → friendly "already exists" error linking to the existing page); seeds `entity_alias` rows: legal_name, one `ticker` per EDGAR ticker, one `former_name` per EDGAR former name (valid_at from EDGAR date when present, else now). Returns entity id; redirects to detail.
  - `addAlias(input: { entityId, aliasType, value })` action — before insert, resolves current aliases org-wide (`resolveAsOf`) and if `value` (case-insensitive) already points at a **different** entity returns `{ warning: "…already resolves to <Name> (CIK …)" }`; caller re-submits with `confirmed: true` to insert anyway.
- Consumes: `searchCompanies` via `/api/edgar/search` (client fetch to our own origin), `resolveAsOf`, `requireUser`.

- [ ] **Step 1: `entity-search.tsx`** (client): debounced input → `GET /api/edgar/search?q=`; result rows (name, ticker, CIK) with "Add" button → calls `createEntity`. Collapsed "Enter CIK manually" fallback section beneath (10-digit input, same action). Non-admins see the page read-only with an explanatory note (RLS would reject anyway; UI says why).
- [ ] **Step 2: Entity list page** (`(app)/page.tsx`): fetch entities + aliases, `resolveAsOf(…, await getAsOf())`, table of legal name / ticker / CIK / counts, linking to detail. Respects as-of (an entity recorded after as-of doesn't appear — entity rows: filter `recorded_at <= asOf`).
- [ ] **Step 3: Verify in browser** as ada (admin): search "costco", add; aliases seeded from EDGAR visible; adding alias "COST" to a second entity produces the cross-entity warning; as alice the create UI is disabled. Commit `feat(entities): EDGAR-backed creation, alias seeding, collision warnings`

---

### Task 10: Artifact ingest — three paths, hashing, versioning, mandatory entity links

**Files:**
- Create: `app/(app)/artifacts/new/page.tsx`, `components/artifact-form.tsx`, `actions/artifacts.ts`, `app/(app)/artifacts/[id]/page.tsx`, `lib/hash.ts`
- Test: `tests/hash.test.ts` (sha256 hex of known buffer)

**Interfaces:**
- Produces: `createArtifact(formData: FormData)` action. Fields: `source_kind` (file|url|paste), file / url / body, `artifact_type`, `title`, `author`, `summary`, `valid_at` (date content refers to), `entity_ids` (multi-select, **required ≥1 — server rejects otherwise; this is the blocking link requirement**). Flow:
  1. Validate ≥1 entity id and all belong to org.
  2. file: read bytes server-side, `sha256` → `content_hash`; upload to `env("SUPABASE_STORAGE_BUCKET")` at `${orgId}/${crypto.randomUUID()}/${filename}` **before** the DB row; store `storage_key`. paste: hash of body. url: hash of normalized url.
  3. Duplicate check: current (resolveAsOf now) artifacts with same `content_hash` → if found, insert the new row with `supersedes: existing.id` and return `{ dedup: { supersededTitle } }` so the UI surfaces "recognized as a new version of X", not a silent dup.
  4. Insert `artifact`, then `artifact_entity` rows; if any link insert fails, insert an `is_tombstone` artifact row superseding the orphan (append-only cleanup) and return error.
  - `tombstoneArtifact(artifactId)` action — inserts `{ supersedes: artifactId, is_tombstone: true, source_kind/type/title copied }`.
- Artifact detail page: metadata, linked entities, signed download URL for files (`storage.from(bucket).createSignedUrl`), version chain via `versionChain()`, tombstone button ("removes from view; history is preserved" — append-only messaging).

- [ ] **Step 1: hash test → implement `lib/hash.ts`** (`createHash("sha256")`). PASS.
- [ ] **Step 2: Build form (client) + action per above.** Multi-entity select populated server-side from current entities. Submit disabled until ≥1 entity chosen (server still re-validates).
- [ ] **Step 3: Verify in browser as alice**: upload an .xlsx → appears on entity page; re-upload same file → "new version" surfaced, chain visible on artifact detail; paste path and URL path each save; attempt with no entity → blocked. Commit `feat(artifacts): three-path ingest with hashing, versioning, mandatory links`

---

### Task 11: Entity detail — the center of the application

**Files:**
- Create: `app/(app)/entities/[id]/page.tsx` + small presentational components (identity block, artifact group list, score history table/sparklines, scenario list, position/decision timeline)

**Interfaces:**
- Consumes: everything above. One server component fetching, for the entity: aliases, artifact links + artifacts, quality_scores, scenarios, position_inputs, decisions — each passed through `resolveAsOf(rows, await getAsOf())`.

- [ ] **Step 1: Build the page** with sections:
  - **Identity block**: legal name (current `legal_name` alias), CIK, current ticker(s), all aliases grouped by type with alias-add form (admin only, wired to `addAlias` incl. warning confirm step).
  - **Artifacts** grouped by `artifact_type`, each linking to artifact detail; version count badge.
  - **Quality score history**: table of sessions (columns = five metrics in causal-chain order, rows = sessions by `valid_at`), each cell score + expandable reasoning + evidence links; `revision_kind` badge ("changed view" highlighted). This is the series-over-time view; no aggregation, no ranking (out of scope).
  - **Scenarios**: bull/base/bear cards + `scenario-form` (analyst/pm).
  - **Position inputs & decisions**: single chronological (by `valid_at`) merged timeline; position rows show `computed_weight` vs `chosen_weight` side by side with the delta highlighted when they differ; decision rows show type, summary, decider, and links to the exact `position_input` / `quality_score` rows they reference. Links to `/entities/[id]/score` and `/entities/[id]/position`.
- [ ] **Step 2: Verify with as-of**: set as-of to 2025-06-01 → Apple shows only the initial score, Moody's tombstoned note visible again, Visa shows first position only; reset to now → present-day view. Commit `feat(entities): entity detail page with as-of aware sections`

---

### Task 12: Quality scoring wizard — causal chain, evidence-required, prior view shown

**Files:**
- Create: `app/(app)/entities/[id]/score/page.tsx`, `components/score-wizard.tsx`, `actions/scores.ts`

**Interfaces:**
- Produces: `createQualityScore(input: { entityId, revisionKind, metrics: Record<MetricKey, { score: number; reasoning: string; evidence: string[] }> })` — server validates every metric has score 1–10, non-empty reasoning, ≥1 evidence artifact id belonging to the org (mirrors DB checks; friendly errors); `supersedes` set to the current head score (resolved server-side), `revision_kind` from input ('initial' forced when no prior exists).
- `MetricKey = 'management' | 'pricing_power' | 'roiic_moat' | 'balance_sheet' | 'growth_durability'` — **this exact order is the wizard order**, with on-screen rationale: management stewards capital allocation → pricing power is a source of moat → moat sustains ROIIC → balance sheet governs whether growth is fundable → growth durability is the conclusion, not the premise.

- [ ] **Step 1: Build wizard (client)**: one section at a time; sticky sidebar shows what was already entered upstream (scores + first line of reasoning); each section: 1–10 selector, reasoning textarea, evidence multi-select from the entity's current artifacts (must pick ≥1 to advance — "A score with no evidence pointer is not accepted"). If a prior score session exists (passed from the server page), each section renders the **previous score + previous reasoning** beside the inputs, and the final step requires choosing `refinement` vs `change_of_mind` before submit.
- [ ] **Step 2: Verify as alice**: score Costco (initial); score Apple again → prior 2026-02 view shown per section, pick change_of_mind → new row appears in history with badge; old row intact; try submitting a section without evidence → blocked client and server side. Commit `feat(scores): causal-chain scoring wizard with evidence requirement and revision marking`

---

### Task 13: Positions & decisions — the spreadsheet replacement

**Files:**
- Create: `app/(app)/positions/page.tsx`, `app/(app)/entities/[id]/position/page.tsx`, `components/position-form.tsx`, `components/decision-form.tsx`, `actions/positions.ts`, `actions/decisions.ts`

**Interfaces:**
- Produces:
  - `createPositionInput(input: { entityId, irr, skew, conviction, fcfGrowth, computedWeight: number | null, chosenWeight, rationale })` — two separate weight fields end to end; nothing computes one from the other; both stored; `supersedes` = current head for the entity.
  - `createDecision(input: { entityId, decisionType, summary, positionInputId, qualityScoreId: string | null, decidedAt })` — the referenced rows are chosen **explicitly**: the form is pre-filled server-side with the ids of the current-as-of-now head position_input and head quality_score, displayed to the PM as "deciding on the basis of:" cards; ids go into the row as FKs.
- Placeholder markers (per spec's out-of-scope rule): a visibly labeled "Computed weight — model integration is a separate workstream; enter the model's output here" helper under the computed field. No optimizer, no ranking.

- [ ] **Step 1: `/positions` page**: every entity with any position history; current head row per entity (as-of aware): IRR, skew, conviction, FCF growth, computed vs chosen weight (delta chip when divergent), last decision; links to per-entity position page.
- [ ] **Step 2: Per-entity position page**: `position-form` (pm only; analysts see read-only with note), **full prior-input history inline** below the form (all rows, chronological, computed & chosen always both visible); `decision-form` beneath with the basis cards described above; decision history list.
- [ ] **Step 3: Verify as pete**: save a new Visa input → new row on top, prior three intact; record a decision → FK ids match the head rows; as alice the forms are read-only and a direct action call is rejected by RLS (spot-check via test in Task 5 already). Commit `feat(positions): dual-weight position inputs and FK-anchored decisions`

---

### Task 14: Admin users screen — invite through the mail catcher

**Files:**
- Create: `app/(app)/admin/users/page.tsx`, `actions/admin.ts`

**Interfaces:**
- Produces: `inviteUser(input: { email, displayName, role })` — verifies acting user's role === 'admin' (from profile; defense in depth), then service-role client: `auth.admin.inviteUserByEmail(email, { data: {}, redirectTo: env("SITE_URL") + "/auth/confirm" })` + set `app_metadata { org_id, role }` + insert `profile` row. The invite email lands in the local mail catcher (README: http://127.0.0.1:54324).

- [ ] **Step 1: Build page**: user table from `profile` (name, email, role, joined); invite form (admin-gated in UI + action). Non-admins get 404-style guard.
- [ ] **Step 2: Verify end-to-end**: invite `new.analyst@atlas.test` as ada → open Mailpit at :54324 → click invite link → lands on `/auth/confirm` → set password → signed in as analyst; RLS treats them correctly (can add artifact, cannot add position). This exercises the real invite/confirmation flow, not a stub. Commit `feat(admin): invite-only user management via local mail catcher`

---

### Task 15: README + one-command bootstrap + clean-checkout verification

**Files:**
- Create: `README.md`, `scripts/bootstrap.sh`

- [ ] **Step 1: `scripts/bootstrap.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.local ] || cp .env.example .env.local
npm install
npx supabase start
npx supabase db reset        # applies supabase/migrations in order
npm run seed
npm run dev
```

`package.json`: `"bootstrap": "bash scripts/bootstrap.sh"`.

- [ ] **Step 2: README** sections: what Atlas is (3 sentences); prerequisites (Node 20+, Docker, Supabase CLI); **`npm run bootstrap`** as the one command; seeded logins table (3 users + password env); the as-of control and append-only model in two paragraphs; environment variable table with a "changes when leaving localhost" column (Supabase URL/keys/DB URL/SITE_URL change; SEED_USER_PASSWORD and the dev user switcher are dev-only and disappear); mail catcher URL for invites; Studio URL; how to add a migration (`supabase migration new`, never edit the DB directly).
- [ ] **Step 3: Clean-checkout rehearsal**: `git clone` the repo into `/tmp/atlas-clean` (or `git archive`), delete nothing, run `npm run bootstrap` with a fresh `supabase stop --no-backup` beforehand; confirm app serves, login works, seed data visible. Fix anything that only worked due to local state.
- [ ] **Step 4: Commit** `docs: README with one-command bootstrap and env migration notes`

---

### Task 16: Full-app smoke pass (Playwright via webapp-testing skill)

- [ ] **Step 1: Scripted browser pass** over the running app: login as each role; as-of flip on entity detail (2025-06-01 vs now) changes score history, artifact visibility (tombstone case), and position history; scoring wizard blocks evidence-less advance; artifact form blocks entity-less save; duplicate upload surfaces version message; dev switcher visible in dev.
- [ ] **Step 2: `NODE_ENV=production` build check** (`npm run build && npm start` locally): user switcher absent from chrome. (Local production-mode build only — still no deployment artifacts.)
- [ ] **Step 3: Fix anything found; final commit** `test: end-to-end smoke pass across roles and as-of views`

---

## Self-Review (performed at planning time)

- **Spec coverage:** stack/localhost/env-only config → Tasks 1, 15; Supabase CLI + real Auth/RLS locally → Tasks 2–5; migrations-as-files → Tasks 2–3; one command → Task 15; user switcher (dev-gated) → Task 7; mail catcher invites → Task 14; CIK-spine → Task 2 (entity unique on org+cik; aliases in entity_alias; no ticker joins anywhere); append-only → Tasks 3 (revoke + no policies) & 5 (exercised); bitemporal + as-of control on every view → Tasks 2, 7, 11, 13; org tenancy via JWT claim → Tasks 3, 5; three roles → Tasks 3, 5; attribution → RLS `created_by = auth.uid()` + Task 5 case 4; EDGAR search/CORS/UA/cache → Task 8; alias seeding + manual CIK fallback + collision warning → Task 9; entity detail with all five sections → Task 11; three-path ingest, storage-not-postgres, mandatory links, hash versioning → Task 10; causal-chain wizard, evidence-required, prior-view + refinement/change-of-mind → Task 12; dual weights never collapsed, inline history, FK-anchored decisions → Task 13; seed with 18-month spread, twice-scored company with changed view, divergent weights → Task 4; README env-migration note → Task 15; out-of-scope placeholders → Task 13 note (and nothing else builds scoring/ranking/similarity/LLM).
- **Deviation noted:** `artifact_entity` junction added to the named seven (rationale in Global Constraints); `org`/`profile` infrastructure tables.
- **Type consistency:** `MetricKey` order matches quality_score column groups and wizard order; `VersionedRow` shape matches base columns; env keys in `lib/env.ts` match `.env.example`; storage key format `<org_id>/<uuid>/<filename>` matches storage policies' first-folder check; seed users' emails/roles match Task 5's matrix and Task 7's switcher.
