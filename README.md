# Atlas

Entity-centric system of record for a long-only equity firm's research.
Companies are keyed on SEC CIK (names and tickers are aliases); every table is
**append-only** (no UPDATE, no DELETE — enforced by row-level security and
revoked grants, not convention); every row is **bitemporal** (`valid_at` =
when the fact was true in the world, `recorded_at` = when Atlas learned it).
The "as of" control in the header re-renders every view as the system saw the
world at that instant — that is how the firm reconstructs what it knew at the
moment it made a decision.

Runs entirely on localhost. No deployment configuration exists on purpose.

## Prerequisites

- Node.js 20+ (Node 22+ preferred; on Node 20 a bundled `ws` polyfill covers
  supabase-js's WebSocket requirement)
- Docker (daemon running, and your user in the `docker` group)
- [Supabase CLI](https://supabase.com/docs/guides/cli)

## One command

```bash
npm run bootstrap
```

That copies `.env.example` → `.env.local` (if absent), installs dependencies,
starts local Supabase (Postgres, Auth, Storage, Studio — in Docker), applies
the migrations in `supabase/migrations/`, seeds eighteen months of history,
and starts the dev server at **http://localhost:3000**.

### Seeded logins

Password for all three: `atlas-local-dev` (env `SEED_USER_PASSWORD`).

| Email | Role | Writes |
|---|---|---|
| `alice.analyst@atlas.test` | analyst | artifacts, quality scores, scenarios |
| `pete.pm@atlas.test` | pm | analyst's set + position inputs, decisions |
| `ada.admin@atlas.test` | admin | entity records, aliases, user invites |

A dev-only user switcher sits in the header (gated on
`NODE_ENV === "development"`), so RLS behavior across the three roles can be
checked without logging out. Each switch is a real sign-in — real JWT, real
policies.

### Local service URLs

| Service | URL |
|---|---|
| App | http://localhost:3000 |
| Supabase Studio | http://127.0.0.1:54323 |
| Mail catcher (invites land here) | http://127.0.0.1:54324 |
| Supabase API | http://127.0.0.1:54321 |

## Things worth trying first

1. Pin the **as of** control to `2025-06-01`. Apple drops to one quality
   score (the February 2026 change of mind vanishes), a retracted Moody's
   note reappears, and Visa's position history rewinds.
2. Open **Positions**: Visa carries a model weight of 4.0% and a chosen
   weight of 6.5% — both stored, neither overwriting the other. The
   divergence is the point.
3. Re-upload the same file twice: the hash match is surfaced as a new
   version of the existing artifact, not a duplicate.
4. As `ada.admin`, invite a user; open the mail catcher, click the link,
   set a password — the real Auth email flow, no stubs.

## Environment variables

All connection details live in `.env.local` (never committed). The values in
`.env.example` are the Supabase CLI's standard local development keys —
public constants, identical on every machine.

| Variable | Purpose | Changes when leaving localhost? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase API URL | **yes** — hosted project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client key (RLS-bound) | **yes** |
| `SUPABASE_SERVICE_ROLE_KEY` | server-only admin key (invites, seed) | **yes** |
| `SUPABASE_DB_URL` | direct Postgres URL (psql/migrations) | **yes** |
| `SITE_URL` | app origin used in auth links | **yes** — real hostname |
| `SUPABASE_STORAGE_BUCKET` | artifact bucket name | usually no |
| `EDGAR_BASE_URL` / `EDGAR_DATA_BASE_URL` | SEC endpoints | no |
| `EDGAR_USER_AGENT` | SEC-required identification with contact email | contact stays accurate |
| `EDGAR_CACHE_DIR` | on-disk EDGAR response cache | no |
| `SEED_USER_PASSWORD` | seeded/dev-switcher password | **removed** — dev only |

Moving off localhost is a config change, not a code change: repoint the four
Supabase values and `SITE_URL` at hosted infrastructure. The dev user
switcher and seed credentials are development-only and do not ship
(`NODE_ENV` gate).

## Database changes

Schema changes happen by adding a migration — never by editing the database
directly:

```bash
npx supabase migration new <name>   # writes supabase/migrations/<ts>_<name>.sql
npx supabase db reset               # replays all migrations + seed from scratch
```

The schema's three non-negotiables, all enforced in
`supabase/migrations/`:

1. **CIK-spined** — `entity` is unique on `(org_id, cik)`; every name,
   ticker, FIGI, LEI, and informal internal name lives in `entity_alias`.
   Nothing joins on a ticker string.
2. **Append-only** — the application role has SELECT and INSERT only;
   UPDATE/DELETE/TRUNCATE are revoked and no RLS policy grants them.
   "Edits" write superseding rows; "deletes" write tombstone rows.
3. **Bitemporal** — every research row carries `valid_at`, `recorded_at`,
   `supersedes`, `is_tombstone`. `lib/asof.ts` resolves what the system
   believed at any instant.

## Tests

```bash
npm test                  # unit: env, as-of resolution, hashing, EDGAR cache
npm run test:integration  # live-stack: seed shape + the full RLS matrix
```

The RLS suite signs in as each role with real JWTs and proves the matrix:
update/delete denial, per-role insert gates, attribution
(`created_by = auth.uid()` or rejected), cross-org isolation, and
org-prefixed storage paths.
