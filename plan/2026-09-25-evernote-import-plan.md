# Evernote Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An in-app **Import** page that takes an Evernote `.enex` export, stages its notes and document attachments with suggested company links, lets the importer review and adjust, and writes the approved items into Atlas as artifacts with correct dates and attribution.

**Architecture:** The export goes browser→Storage via the existing signed-URL path; the server parses it in resumable range-reads into two *mutable staging tables* (`import_batch`, `import_item`); pure functions do ENML→text, note splitting, matching, and payload mapping so they are unit-tested without a database; two "runner" modules (`parse-run`, `commit-run`) take a Supabase client so the integration tests can drive them with a real JWT; Server Actions are thin wrappers. Commit writes artifacts through the user's JWT exactly like the manual ingest path, so RLS, attribution, dedup-as-version, and the tombstone-on-link-failure rule are unchanged.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind, @supabase/ssr + supabase-js, Supabase Storage, `fast-xml-parser` (new dep), vitest, Playwright (python, scratchpad) for the browser check.

**Spec:** `plan/2026-09-25-evernote-import-design.md`

## Global Constraints

- Append-only research tables untouched: the app issues **no UPDATE/DELETE** against `entity`, `entity_alias`, `artifact`, `artifact_entity`, `quality_score`, `scenario`, `position_input`, `decision`. Staging tables are the documented exception (UPDATE allowed, no DELETE).
- All writes to the record go through the **user's JWT client** (`requireUser().supabase`), never the service role.
- Files never pass through a Server Action body: browser→Storage with `prepareUpload` (actions/artifacts.ts), server→Storage for decoded attachments.
- Hosted function budget: a parse step stops after **8 s** of work; at least one whole note per call.
- Storage keys are `<org_id>/<uuid>/<file name>` (`buildStorageKey` in `lib/storage.ts`); the existing path policies apply.
- Attachments: only `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/vnd.ms-powerpoint`, `application/vnd.openxmlformats-officedocument.presentationml.presentation`, `text/csv` are imported; everything else is counted in `images_skipped`.
- Roles: import visible/usable when `canWriteResearch(role)` (`lib/roles.ts`).
- Conventional Commits; run `npm test` (unit) after each unit task and `npm run test:integration` (needs `npm run seed` first, local stack via `sg docker -c "npx supabase start"`) after DB-touching tasks.
- Local stack commands need the `sg docker -c "..."` wrapper on this machine.

---

### Task 1: Staging tables, grants, policies, row types

**Files:**
- Create: `supabase/migrations/20260925000006_import_staging.sql`
- Modify: `lib/types.ts` (append)
- Modify: `package.json` (`test:integration` list)
- Test: `tests/import.test.ts` (new; first describe block only)

**Interfaces:**
- Produces: tables `public.import_batch`, `public.import_item` (columns below); types `ImportBatchRow`, `ImportItemRow`, `ImportBatchStatus`, `ImportItemStatus`, `ImportItemKind`.

- [ ] **Step 1: Write the failing integration test (staging policies)**

Create `tests/import.test.ts`:

```ts
/**
 * Import staging: mutable workbench tables. Policies exercised with real JWTs:
 *  - creator inserts a batch and updates its items
 *  - same-org colleague can read but not update
 *  - other org sees nothing
 * Run after `npm run seed`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

const url = () => env("NEXT_PUBLIC_SUPABASE_URL");
const anonKey = () => env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const admin = createClient(url(), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

async function signedIn(email: string) {
  const c = createClient(url(), anonKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: env("SEED_USER_PASSWORD") });
  if (error) throw new Error(`sign-in ${email}: ${error.message}`);
  return c;
}
async function uid(c: SupabaseClient) {
  return (await c.auth.getUser()).data.user!.id;
}

let alice: SupabaseClient; // analyst, batch creator
let pete: SupabaseClient; // pm, same org
let rita: SupabaseClient; // analyst, other org (created here; not seeded)
let orgId: string;
let otherOrgId: string;
let ritaId: string;
let batchId: string;
let itemId: string;

beforeAll(async () => {
  alice = await signedIn("alice.analyst@atlas.test");
  pete = await signedIn("pete.pm@atlas.test");
  const { data: org } = await admin.from("org").select("id").eq("name", "Meridian Capital Partners").single();
  orgId = org!.id;

  const { data: org2 } = await admin.from("org").insert({ name: "Import Rival LP" }).select().single();
  otherOrgId = org2!.id;
  const { data: ritaUser, error: ritaErr } = await admin.auth.admin.createUser({
    email: "rita.import@other.test",
    password: env("SEED_USER_PASSWORD"),
    email_confirm: true,
    app_metadata: { org_id: otherOrgId, role: "analyst" },
  });
  if (ritaErr) throw ritaErr;
  ritaId = ritaUser.user!.id;
  await admin.from("profile").insert({ user_id: ritaId, org_id: otherOrgId, email: "rita.import@other.test", display_name: "Rita Import", role: "analyst" });
  rita = await signedIn("rita.import@other.test");
});

afterAll(async () => {
  // staging rows reference the batch; service role may delete (grant all)
  await admin.from("import_item").delete().eq("org_id", orgId).like("content_hash", "abc");
  await admin.from("profile").delete().eq("user_id", ritaId);
  await admin.auth.admin.deleteUser(ritaId);
  await admin.from("org").delete().eq("id", otherOrgId);
});

describe("import staging policies", () => {
  it("creator can insert a batch and an item", async () => {
    const { data: b, error } = await alice
      .from("import_batch")
      .insert({ org_id: orgId, created_by: await uid(alice), source_kind: "enex", storage_key: `${orgId}/test/x.enex`, file_name: "x.enex" })
      .select()
      .single();
    expect(error).toBeNull();
    batchId = b!.id;
    const { data: i, error: ie } = await alice
      .from("import_item")
      .insert({
        batch_id: batchId, org_id: orgId, kind: "note", position: 0, title: "t",
        valid_at: new Date().toISOString(), body: "hello", content_hash: "abc", artifact_type: "note",
      })
      .select()
      .single();
    expect(ie).toBeNull();
    itemId = i!.id;
  });

  it("creator can update their item; a colleague can read but not update", async () => {
    const { error } = await alice.from("import_item").update({ include: false }).eq("id", itemId);
    expect(error).toBeNull();
    const { data: seen } = await pete.from("import_item").select("id").eq("id", itemId);
    expect(seen).toHaveLength(1);
    const { data: updated } = await pete.from("import_item").update({ include: true }).eq("id", itemId).select();
    expect(updated).toEqual([]); // RLS filters the row out of the update
  });

  it("other org sees nothing", async () => {
    const { data } = await rita.from("import_batch").select("id").eq("id", batchId);
    expect(data).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run seed && npx vitest run tests/import.test.ts`
Expected: FAIL — `relation "public.import_batch" does not exist` (or "Could not find the table").

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260925000006_import_staging.sql`:

```sql
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
```

- [ ] **Step 4: Append row types**

Append to `lib/types.ts`:

```ts
// ── import staging (mutable workbench; see migration 20260925000006) ───────

export type ImportBatchStatus = "parsing" | "review" | "importing" | "imported" | "failed" | "discarded";
export type ImportItemStatus = "pending" | "duplicate" | "unmatched" | "imported" | "skipped" | "error";
export type ImportItemKind = "note" | "attachment";

export interface ImportBatchRow {
  id: string;
  org_id: string;
  created_by: string;
  source_kind: "enex";
  storage_key: string;
  file_name: string;
  status: ImportBatchStatus;
  bytes_total: number | null;
  bytes_done: number;
  notes_seen: number;
  images_skipped: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImportItemRow {
  id: string;
  batch_id: string;
  org_id: string;
  kind: ImportItemKind;
  parent_item_id: string | null;
  position: number;
  title: string;
  author: string | null;
  valid_at: string;
  body: string | null;
  storage_key: string | null;
  file_name: string | null;
  mime: string | null;
  bytes: number | null;
  content_hash: string;
  artifact_type: ArtifactType;
  suggested_entity_ids: string[];
  chosen_entity_ids: string[];
  include: boolean;
  status: ImportItemStatus;
  duplicate_of: string | null;
  artifact_id: string | null;
  error: string | null;
}
```

- [ ] **Step 5: Apply locally, add to the integration script, run**

```bash
sg docker -c "npx supabase migration up"
```

Edit `package.json` `test:integration` to: `"vitest run tests/rls.test.ts tests/seed.test.ts tests/users.test.ts tests/import.test.ts"`.

Run: `npx vitest run tests/import.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260925000006_import_staging.sql lib/types.ts package.json tests/import.test.ts
git commit -m "feat(import): staging tables for Evernote import with org/creator policies"
```

---

### Task 2: ENML → plain text

**Files:**
- Create: `lib/import/enml.ts`
- Test: `tests/import/enml.test.ts`

**Interfaces:**
- Produces: `enmlToText(enml: string, mediaNames: Map<string, string | null>): string` — `mediaNames` maps a lowercase md5 hash (from `<en-media hash>`) to a display file name (document) or `null` (image → dropped).

- [ ] **Step 1: Write the failing tests**

Create `tests/import/enml.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { enmlToText } from "@/lib/import/enml";

const wrap = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>${inner}</en-note>`;

describe("enmlToText", () => {
  it("turns block tags and <br> into line breaks and strips the rest", () => {
    const text = enmlToText(wrap("<div>Mgmt call <b>notes</b></div><div>Pricing power strong</div><br/><p>End</p>"), new Map());
    expect(text).toBe("Mgmt call notes\nPricing power strong\n\nEnd");
  });

  it("decodes entities and bullets list items", () => {
    const text = enmlToText(wrap("<ul><li>Q&amp;A: margins &gt; 30%</li><li>FCF&nbsp;up</li></ul>"), new Map());
    expect(text).toBe("• Q&A: margins > 30%\n• FCF up");
  });

  it("replaces document media with a placeholder and drops image media", () => {
    const names = new Map<string, string | null>([
      ["aaaa", "model.xlsx"],
      ["bbbb", null],
    ]);
    const text = enmlToText(
      wrap('<div>See <en-media hash="AAAA" type="application/vnd.ms-excel"/> and <en-media hash="bbbb" type="image/png"/></div>'),
      names,
    );
    expect(text).toBe("See [attachment: model.xlsx] and");
  });

  it("collapses runs of blank lines to one", () => {
    const text = enmlToText(wrap("<div>a</div><div><br/></div><div><br/></div><div><br/></div><div>b</div>"), new Map());
    expect(text).toBe("a\n\nb");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/import/enml.test.ts`
Expected: FAIL — cannot find `@/lib/import/enml`.

- [ ] **Step 3: Implement**

Create `lib/import/enml.ts`:

```ts
/**
 * Evernote Markup Language -> plain text. ENML is XHTML-like; we keep line
 * structure (block ends and <br> become newlines, list items get bullets),
 * substitute document attachments with a placeholder, drop images, and decode
 * entities. Pure; no DOM.
 */

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n: string) => NAMED[n.toLowerCase()] ?? m);
}

export function enmlToText(enml: string, mediaNames: Map<string, string | null>): string {
  let s = enml
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<\/?en-note[^>]*>/gi, "");

  s = s.replace(/<en-media\b[^>]*?hash="([0-9a-fA-F]+)"[^>]*\/?>/g, (_, hash: string) => {
    const name = mediaNames.get(hash.toLowerCase());
    return name ? `[attachment: ${name}]` : "";
  });

  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<\/(div|p|li|tr|h[1-6]|blockquote|pre|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  s = decodeEntities(s);

  return s
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "").replace(/^[ \t]+/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/import/enml.test.ts`
Expected: PASS (4 tests). If the placeholder test leaves a trailing space before "and", the `<en-media>` for the image yields "" and the surrounding " and " keeps one space on each side — the expected string is `"See [attachment: model.xlsx] and"`; adjust the input, not the function, if whitespace differs.

- [ ] **Step 5: Add the test file to the unit script and commit**

Edit `package.json` `"test"` to end with ` tests/storage-key.test.ts tests/import/*.test.ts` (vitest accepts the glob).

```bash
git add lib/import/enml.ts tests/import/enml.test.ts package.json
git commit -m "feat(import): ENML to plain text"
```

---

### Task 3: Attachment classification and type defaults

**Files:**
- Create: `lib/import/classify.ts`
- Test: `tests/import/classify.test.ts`

**Interfaces:**
- Produces: `isDocument(mime: string | null, fileName: string | null): boolean`; `defaultArtifactType(kind: "note" | "attachment", fileName: string | null): ArtifactType`; `DOCUMENT_MIMES: ReadonlySet<string>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/import/classify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isDocument, defaultArtifactType } from "@/lib/import/classify";

describe("classify", () => {
  it("accepts office documents, pdf, csv by mime", () => {
    expect(isDocument("application/pdf", "a.pdf")).toBe(true);
    expect(isDocument("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "m.xlsx")).toBe(true);
    expect(isDocument("text/csv", "d.csv")).toBe(true);
  });
  it("falls back to the extension when mime is generic", () => {
    expect(isDocument("application/octet-stream", "deck.pptx")).toBe(true);
    expect(isDocument(null, "model.xls")).toBe(true);
  });
  it("rejects images and unknown types", () => {
    expect(isDocument("image/png", "shot.png")).toBe(false);
    expect(isDocument("application/octet-stream", "blob.bin")).toBe(false);
  });
  it("defaults note->note, spreadsheet->model, other docs->other", () => {
    expect(defaultArtifactType("note", null)).toBe("note");
    expect(defaultArtifactType("attachment", "m.xlsx")).toBe("model");
    expect(defaultArtifactType("attachment", "d.CSV")).toBe("model");
    expect(defaultArtifactType("attachment", "primer.pdf")).toBe("other");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/import/classify.test.ts` — Expected: FAIL, module missing.

- [ ] **Step 3: Implement**

Create `lib/import/classify.ts`:

```ts
import type { ArtifactType } from "@/lib/types";

export const DOCUMENT_MIMES: ReadonlySet<string> = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/csv",
]);

const DOCUMENT_EXT = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv"]);
const SPREADSHEET_EXT = new Set(["xls", "xlsx", "csv"]);

function ext(fileName: string | null): string {
  const m = /\.([a-z0-9]+)$/i.exec(fileName ?? "");
  return m ? m[1].toLowerCase() : "";
}

export function isDocument(mime: string | null, fileName: string | null): boolean {
  if (mime && DOCUMENT_MIMES.has(mime.toLowerCase())) return true;
  return DOCUMENT_EXT.has(ext(fileName));
}

export function defaultArtifactType(kind: "note" | "attachment", fileName: string | null): ArtifactType {
  if (kind === "note") return "note";
  return SPREADSHEET_EXT.has(ext(fileName)) ? "model" : "other";
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/import/classify.test.ts` → PASS (4).

- [ ] **Step 5: Commit**

```bash
git add lib/import/classify.ts tests/import/classify.test.ts
git commit -m "feat(import): attachment classification and artifact type defaults"
```

---

### Task 4: ENEX note splitting and note parsing (with fixture)

**Files:**
- Create: `fixtures/enex/sample.enex`
- Create: `lib/import/enex.ts`
- Modify: `package.json` (add dependency `fast-xml-parser`)
- Test: `tests/import/enex.test.ts`

**Interfaces:**
- Consumes: `enmlToText` (Task 2), `isDocument` (Task 3).
- Produces:
  - `splitCompleteNotes(buf: Buffer, isEof: boolean): { blocks: Buffer[]; consumed: number }` — returns every complete `<note>…</note>` in `buf` and the byte count consumed up to the end of the last one (0 if none). Bytes before the first `<note` (the header) count as consumed once a note follows them; at EOF trailing bytes are consumed too.
  - `parseNoteBlock(xml: string): ParsedNote` where
    ```ts
    interface ParsedResource { fileName: string; mime: string; bytes: Buffer; md5: string }
    interface ParsedNote { title: string; author: string | null; createdAt: string; text: string; documents: ParsedResource[]; imagesSkipped: number }
    ```
  - `enexDateToIso(s: string): string` — `20240115T093000Z` → `2024-01-15T09:30:00.000Z`.

- [ ] **Step 1: Install the parser and create the fixture**

```bash
npm i fast-xml-parser@^4
mkdir -p fixtures/enex
```

Create `fixtures/enex/sample.enex` (a tiny valid PDF and a 1×1 PNG, base64):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export export-date="20260920T120000Z" application="Evernote" version="10.0">
<note>
<title>AAPL mgmt call 2024-03</title>
<content><![CDATA[<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note><div>Met CFO. Pricing power intact; services mix up.</div><div>Model attached: <en-media hash="8ae8b4e27e6f5f1b0a5c0d9e6b7c3f22" type="application/pdf"/></div><div><en-media hash="71a50dbba44c78128b221b7df7bb51f1" type="image/png"/></div></en-note>]]></content>
<created>20240312T140500Z</created>
<updated>20240312T150000Z</updated>
<note-attributes><author>Alice Okafor</author></note-attributes>
<resource>
<data encoding="base64">
JVBERi0xLjEKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBv
Ymo8PC9UeXBlL1BhZ2VzL0tpZHNbXS9Db3VudCAwPj5lbmRvYmoKdHJhaWxlcjw8L1Jvb3QgMSAw
IFI+Pg==
</data>
<mime>application/pdf</mime>
<resource-attributes><file-name>apple-model-summary.pdf</file-name></resource-attributes>
</resource>
<resource>
<data encoding="base64">
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6
kgAAAABJRU5ErkJggg==
</data>
<mime>image/png</mime>
<resource-attributes><file-name>chart.png</file-name></resource-attributes>
</resource>
</note>
<note>
<title>General market thoughts</title>
<content><![CDATA[<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note><div>Rates higher for longer. No single name.</div></en-note>]]></content>
<created>20240401T090000Z</created>
</note>
<note>
<title>Costco vs Visa: pricing</title>
<content><![CDATA[<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note><div>Costco Wholesale keeps membership fee flat; V takes price in cross-border.</div></en-note>]]></content>
<created>20240515T160000Z</created>
</note>
</en-export>
```

The `<en-media hash>` values must equal the md5 of the decoded resource bytes. After creating the file, compute them and patch the fixture:

```bash
node -e '
const fs=require("fs"),c=require("crypto");
const x=fs.readFileSync("fixtures/enex/sample.enex","utf8");
const datas=[...x.matchAll(/<data encoding="base64">\s*([\s\S]*?)\s*<\/data>/g)].map(m=>m[1].replace(/\s+/g,""));
for (const d of datas) console.log(c.createHash("md5").update(Buffer.from(d,"base64")).digest("hex"));'
```

Replace the two `hash="…"` values in note 1 with the printed md5s (first = pdf, second = png).

- [ ] **Step 2: Write the failing tests**

Create `tests/import/enex.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { splitCompleteNotes, parseNoteBlock, enexDateToIso } from "@/lib/import/enex";

const FIXTURE = readFileSync("fixtures/enex/sample.enex");

describe("enexDateToIso", () => {
  it("converts Evernote timestamps", () => {
    expect(enexDateToIso("20240312T140500Z")).toBe("2024-03-12T14:05:00.000Z");
  });
});

describe("splitCompleteNotes", () => {
  it("returns all three notes and consumes through the last </note> when given the whole file", () => {
    const { blocks, consumed } = splitCompleteNotes(FIXTURE, true);
    expect(blocks).toHaveLength(3);
    expect(consumed).toBe(FIXTURE.length); // EOF: trailing </en-export> consumed
    expect(blocks[0].toString("utf8").startsWith("<note>")).toBe(true);
  });

  it("returns only complete notes from a partial buffer and reports where to resume", () => {
    const cut = FIXTURE.indexOf("<title>Costco") - 40; // inside note 3's opening region
    const part = FIXTURE.subarray(0, cut);
    const { blocks, consumed } = splitCompleteNotes(part, false);
    expect(blocks).toHaveLength(2);
    const rest = FIXTURE.subarray(consumed);
    const second = splitCompleteNotes(rest, true);
    expect(second.blocks).toHaveLength(1);
    expect(second.blocks[0].toString("utf8")).toContain("Costco vs Visa");
  });

  it("consumes nothing when no note is complete yet", () => {
    const part = FIXTURE.subarray(0, 200);
    expect(splitCompleteNotes(part, false)).toEqual({ blocks: [], consumed: 0 });
  });

  it("chunked feeding in 1 KB slices yields the same notes as one pass", () => {
    const titles: string[] = [];
    let offset = 0;
    let carry = Buffer.alloc(0);
    while (offset < FIXTURE.length) {
      const slice = FIXTURE.subarray(offset, Math.min(offset + 1024, FIXTURE.length));
      offset += slice.length;
      carry = Buffer.concat([carry, slice]);
      const { blocks, consumed } = splitCompleteNotes(carry, offset >= FIXTURE.length);
      for (const b of blocks) titles.push(parseNoteBlock(b.toString("utf8")).title);
      carry = carry.subarray(consumed);
    }
    expect(titles).toEqual(["AAPL mgmt call 2024-03", "General market thoughts", "Costco vs Visa: pricing"]);
  });
});

describe("parseNoteBlock", () => {
  const { blocks } = splitCompleteNotes(FIXTURE, true);

  it("extracts title, author, created, text with a document placeholder, and documents only", () => {
    const n = parseNoteBlock(blocks[0].toString("utf8"));
    expect(n.title).toBe("AAPL mgmt call 2024-03");
    expect(n.author).toBe("Alice Okafor");
    expect(n.createdAt).toBe("2024-03-12T14:05:00.000Z");
    expect(n.text).toBe("Met CFO. Pricing power intact; services mix up.\nModel attached: [attachment: apple-model-summary.pdf]");
    expect(n.documents).toHaveLength(1);
    expect(n.documents[0].fileName).toBe("apple-model-summary.pdf");
    expect(n.documents[0].mime).toBe("application/pdf");
    expect(n.documents[0].bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(n.imagesSkipped).toBe(1);
  });

  it("handles a note without author or resources", () => {
    const n = parseNoteBlock(blocks[1].toString("utf8"));
    expect(n.author).toBeNull();
    expect(n.documents).toEqual([]);
    expect(n.imagesSkipped).toBe(0);
    expect(n.text).toBe("Rates higher for longer. No single name.");
  });
});
```

- [ ] **Step 3: Run to verify it fails** — `npx vitest run tests/import/enex.test.ts` → FAIL, module missing.

- [ ] **Step 4: Implement**

Create `lib/import/enex.ts`:

```ts
/**
 * Evernote export (.enex) handling that works on byte ranges, so a large
 * export can be parsed across several hosted-function invocations:
 *  - splitCompleteNotes: find whole <note>…</note> blocks in a buffer and say
 *    how many bytes are safe to consider consumed.
 *  - parseNoteBlock: one note's XML -> title/author/date/text/documents.
 * ENML content is CDATA (XML-escaped inside), so a literal "</note>" cannot
 * occur inside a note body; splitting on it is safe for real exports.
 */
import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { enmlToText } from "@/lib/import/enml";
import { isDocument } from "@/lib/import/classify";

const OPEN = Buffer.from("<note>");
const CLOSE = Buffer.from("</note>");

export interface ParsedResource {
  fileName: string;
  mime: string;
  bytes: Buffer;
  md5: string;
}

export interface ParsedNote {
  title: string;
  author: string | null;
  createdAt: string;
  text: string;
  documents: ParsedResource[];
  imagesSkipped: number;
}

export function enexDateToIso(s: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s.trim());
  if (!m) throw new Error(`Unrecognised Evernote timestamp: ${s}`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
}

export function splitCompleteNotes(buf: Buffer, isEof: boolean): { blocks: Buffer[]; consumed: number } {
  const blocks: Buffer[] = [];
  let cursor = 0;
  let consumed = 0;
  for (;;) {
    const start = buf.indexOf(OPEN, cursor);
    if (start === -1) break;
    const end = buf.indexOf(CLOSE, start + OPEN.length);
    if (end === -1) break;
    const stop = end + CLOSE.length;
    blocks.push(buf.subarray(start, stop));
    cursor = stop;
    consumed = stop;
  }
  if (isEof && blocks.length > 0) consumed = buf.length;
  if (isEof && blocks.length === 0 && buf.indexOf(OPEN) === -1) consumed = buf.length;
  return { blocks, consumed };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "__cdata",
  textNodeName: "#text",
  trimValues: true,
  isArray: (name) => name === "resource",
});

type Raw = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

function textOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  const n = node as Raw;
  if (typeof n.__cdata === "string") return n.__cdata;
  if (typeof n["#text"] === "string") return n["#text"] as string;
  return "";
}

export function parseNoteBlock(xml: string): ParsedNote {
  const doc = parser.parse(xml) as Raw;
  const note = (doc.note ?? {}) as Raw;

  const resources = ((note.resource as Raw[] | undefined) ?? []).map((r) => {
    const data = textOf(r.data).replace(/\s+/g, "");
    const bytes = Buffer.from(data, "base64");
    const attrs = (r["resource-attributes"] ?? {}) as Raw;
    const fileName = str(attrs["file-name"]) || "attachment";
    return { fileName, mime: str(r.mime).toLowerCase(), bytes, md5: createHash("md5").update(bytes).digest("hex") };
  });

  const documents: ParsedResource[] = [];
  let imagesSkipped = 0;
  const mediaNames = new Map<string, string | null>();
  for (const r of resources) {
    if (isDocument(r.mime, r.fileName)) {
      documents.push(r);
      mediaNames.set(r.md5, r.fileName);
    } else {
      imagesSkipped += 1;
      mediaNames.set(r.md5, null);
    }
  }

  const attrs = (note["note-attributes"] ?? {}) as Raw;
  const author = str(attrs.author).trim() || null;
  const created = str(note.created) || str(note.updated);

  return {
    title: str(note.title).trim() || "(untitled note)",
    author,
    createdAt: created ? enexDateToIso(created) : new Date().toISOString(),
    text: enmlToText(textOf(note.content), mediaNames),
    documents,
    imagesSkipped,
  };
}
```

- [ ] **Step 5: Run to verify it passes** — `npx vitest run tests/import/enex.test.ts` → PASS (7). If `parseNoteBlock` returns `mime` as `application/pdf` but the resource order differs, check `isArray`.

- [ ] **Step 6: Commit**

```bash
git add fixtures/enex/sample.enex lib/import/enex.ts tests/import/enex.test.ts package.json package-lock.json
git commit -m "feat(import): range-safe ENEX note splitting and note parsing"
```

---

### Task 5: Matching and initial status

**Files:**
- Create: `lib/import/match.ts`
- Test: `tests/import/match.test.ts`

**Interfaces:**
- Consumes: `AliasRow` (`lib/types.ts`).
- Produces:
  - `buildAliasIndex(aliases: AliasRow[]): AliasIndex`
  - `suggestEntities(index: AliasIndex, title: string, body: string): string[]` — entity ids, best first, unique.
  - `initialStatus(suggested: string[], duplicateOf: string | null): { status: "pending" | "duplicate" | "unmatched"; include: boolean }`

- [ ] **Step 1: Write the failing tests**

Create `tests/import/match.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildAliasIndex, suggestEntities, initialStatus } from "@/lib/import/match";
import type { AliasRow } from "@/lib/types";

const base = { id: "", org_id: "o", created_by: "u", valid_at: "2024-01-01T00:00:00Z", recorded_at: "2024-01-01T00:00:00Z", supersedes: null, is_tombstone: false };
const alias = (entity_id: string, alias_type: AliasRow["alias_type"], value: string): AliasRow =>
  ({ ...base, id: `${entity_id}-${alias_type}-${value}`, entity_id, alias_type, value }) as AliasRow;

const aliases: AliasRow[] = [
  alias("apple", "legal_name", "Apple Inc."),
  alias("apple", "ticker", "AAPL"),
  alias("visa", "legal_name", "Visa Inc."),
  alias("visa", "ticker", "V"),
  alias("visa", "internal", "Visa"),
  alias("costco", "legal_name", "Costco Wholesale Corporation"),
  alias("costco", "ticker", "COST"),
  alias("costco", "internal", "Costco"),
];
const index = buildAliasIndex(aliases);

describe("suggestEntities", () => {
  it("matches a ticker as a whole uppercase word", () => {
    expect(suggestEntities(index, "AAPL mgmt call", "")).toEqual(["apple"]);
    expect(suggestEntities(index, "", "the AAPLE thing")).toEqual([]);
    expect(suggestEntities(index, "", "we like aapl")).toEqual([]); // case-sensitive tickers
  });

  it("does not match a one-letter ticker inside ordinary words but does as a word", () => {
    expect(suggestEntities(index, "", "a very good quarter")).toEqual([]);
    expect(suggestEntities(index, "", "V takes price in cross-border")).toEqual(["visa"]);
  });

  it("matches names case-insensitively, including punctuation in the alias", () => {
    expect(suggestEntities(index, "", "long apple inc. since 2019")).toEqual(["apple"]);
    expect(suggestEntities(index, "", "Costco keeps fees flat")).toEqual(["costco"]);
  });

  it("ranks a title match above a body match", () => {
    expect(suggestEntities(index, "Costco vs Visa: pricing", "Apple mentioned in passing")).toEqual(["costco", "visa", "apple"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(suggestEntities(index, "General market thoughts", "Rates higher for longer.")).toEqual([]);
  });
});

describe("initialStatus", () => {
  it("duplicates are excluded regardless of matches", () => {
    expect(initialStatus(["apple"], "art-1")).toEqual({ status: "duplicate", include: false });
  });
  it("unmatched items are excluded", () => {
    expect(initialStatus([], null)).toEqual({ status: "unmatched", include: false });
  });
  it("matched items are pending and included", () => {
    expect(initialStatus(["apple"], null)).toEqual({ status: "pending", include: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/import/match.test.ts` → FAIL, module missing.

- [ ] **Step 3: Implement**

Create `lib/import/match.ts`:

```ts
/**
 * Company suggestions for imported items, from the aliases the org already
 * maintains. Tickers: whole word, case-sensitive. Names (legal, former,
 * internal): whole phrase, case-insensitive, >= 3 chars. Title beats body.
 * Pure; the caller supplies alias rows already resolved as-of now.
 */
import type { AliasRow } from "@/lib/types";

interface Entry {
  entityId: string;
  kind: "ticker" | "name";
  value: string;
  re: RegExp;
}

export interface AliasIndex {
  entries: Entry[];
}

const NAME_TYPES = new Set(["legal_name", "former_name", "internal"]);

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildAliasIndex(aliases: AliasRow[]): AliasIndex {
  const entries: Entry[] = [];
  for (const a of aliases) {
    const value = a.value.trim();
    if (a.alias_type === "ticker" && value) {
      entries.push({ entityId: a.entity_id, kind: "ticker", value, re: new RegExp(`(?<![\\w])${escape(value)}(?![\\w])`) });
    } else if (NAME_TYPES.has(a.alias_type) && value.length >= 3) {
      entries.push({ entityId: a.entity_id, kind: "name", value, re: new RegExp(`(?<![\\w])${escape(value)}(?![\\w])`, "i") });
    }
  }
  return { entries };
}

export function suggestEntities(index: AliasIndex, title: string, body: string): string[] {
  const best = new Map<string, { score: number; len: number }>();
  for (const e of index.entries) {
    let score = 0;
    if (e.re.test(title)) score = 2;
    else if (e.re.test(body)) score = 1;
    if (!score) continue;
    const prev = best.get(e.entityId);
    if (!prev || score > prev.score || (score === prev.score && e.value.length > prev.len)) {
      best.set(e.entityId, { score, len: e.value.length });
    }
  }
  return [...best.entries()]
    .sort((a, b) => b[1].score - a[1].score || b[1].len - a[1].len)
    .map(([id]) => id);
}

export function initialStatus(
  suggested: string[],
  duplicateOf: string | null,
): { status: "pending" | "duplicate" | "unmatched"; include: boolean } {
  if (duplicateOf) return { status: "duplicate", include: false };
  if (suggested.length === 0) return { status: "unmatched", include: false };
  return { status: "pending", include: true };
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/import/match.test.ts` → PASS (8). In the ranking test both Costco (internal alias "Costco", length 6) and Visa (internal alias "Visa", length 4) match in the title; Costco ranks first on alias length; Apple matches only in the body and comes last.

- [ ] **Step 5: Commit**

```bash
git add lib/import/match.ts tests/import/match.test.ts
git commit -m "feat(import): alias-based company suggestions and initial item status"
```

---

### Task 6: Item → artifact payload (pure) and commit runner (integration)

**Files:**
- Create: `lib/import/commit.ts` (pure mapping)
- Create: `lib/import/commit-run.ts` (runner over a Supabase client)
- Test: `tests/import/commit.test.ts` (unit), `tests/import.test.ts` (append a describe)

**Interfaces:**
- Consumes: `ImportItemRow`, `ArtifactRow` (`lib/types.ts`), `resolveAsOf` (`lib/asof.ts`).
- Produces:
  - `artifactPayloadFor(item: ImportItemRow, ctx: { orgId: string; userId: string; importerName: string; noteTitle: string | null; predecessorId: string | null }): ArtifactInsert`
  - `commitBatchPage(supabase: SupabaseClient, ctx: { orgId: string; userId: string; importerName: string }, batchId: string, pageSize: number): Promise<{ processed: number; remaining: number }>`

- [ ] **Step 1: Write the failing unit test**

Create `tests/import/commit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { artifactPayloadFor } from "@/lib/import/commit";
import type { ImportItemRow } from "@/lib/types";

const item = (over: Partial<ImportItemRow>): ImportItemRow => ({
  id: "i1", batch_id: "b1", org_id: "o1", kind: "note", parent_item_id: null, position: 0,
  title: "AAPL mgmt call", author: "Alice Okafor", valid_at: "2024-03-12T14:05:00.000Z",
  body: "Met CFO.", storage_key: null, file_name: null, mime: null, bytes: null,
  content_hash: "h1", artifact_type: "note", suggested_entity_ids: ["apple"], chosen_entity_ids: ["apple"],
  include: true, status: "pending", duplicate_of: null, artifact_id: null, error: null, ...over,
});
const ctx = { orgId: "o1", userId: "u1", importerName: "Pete Marsh", noteTitle: null, predecessorId: null };

describe("artifactPayloadFor", () => {
  it("maps a note to a paste artifact attributed to the importer, author from the note", () => {
    expect(artifactPayloadFor(item({}), ctx)).toEqual({
      org_id: "o1", artifact_type: "note", source_kind: "paste", title: "AAPL mgmt call",
      author: "Alice Okafor", summary: "", storage_key: null, url: null, body: "Met CFO.",
      content_hash: "h1", created_by: "u1", valid_at: "2024-03-12T14:05:00.000Z", supersedes: null,
    });
  });

  it("falls back to the importer's name when the note has no author", () => {
    expect(artifactPayloadFor(item({ author: null }), ctx).author).toBe("Pete Marsh");
  });

  it("maps an attachment to a file artifact titled after its note", () => {
    const p = artifactPayloadFor(
      item({ kind: "attachment", title: "apple-model-summary.pdf", body: null, storage_key: "o1/x/apple-model-summary.pdf", artifact_type: "other" }),
      { ...ctx, noteTitle: "AAPL mgmt call" },
    );
    expect(p.source_kind).toBe("file");
    expect(p.title).toBe("AAPL mgmt call — apple-model-summary.pdf");
    expect(p.storage_key).toBe("o1/x/apple-model-summary.pdf");
    expect(p.body).toBeNull();
  });

  it("supersedes the predecessor when one is given", () => {
    expect(artifactPayloadFor(item({}), { ...ctx, predecessorId: "art-9" }).supersedes).toBe("art-9");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/import/commit.test.ts` → FAIL, module missing.

- [ ] **Step 3: Implement the pure mapping**

Create `lib/import/commit.ts`:

```ts
import type { ArtifactType, ImportItemRow, SourceKind } from "@/lib/types";

export interface ArtifactInsert {
  org_id: string;
  artifact_type: ArtifactType;
  source_kind: SourceKind;
  title: string;
  author: string;
  summary: string;
  storage_key: string | null;
  url: null;
  body: string | null;
  content_hash: string;
  created_by: string;
  valid_at: string;
  supersedes: string | null;
}

export interface CommitContext {
  orgId: string;
  userId: string;
  importerName: string;
  noteTitle: string | null;
  predecessorId: string | null;
}

/** Same shape the manual ingest path inserts (actions/artifacts.ts). */
export function artifactPayloadFor(item: ImportItemRow, ctx: CommitContext): ArtifactInsert {
  const isNote = item.kind === "note";
  return {
    org_id: ctx.orgId,
    artifact_type: item.artifact_type,
    source_kind: isNote ? "paste" : "file",
    title: isNote ? item.title : `${ctx.noteTitle ?? "Attachment"} — ${item.title}`,
    author: item.author?.trim() || ctx.importerName,
    summary: "",
    storage_key: isNote ? null : item.storage_key,
    url: null,
    body: isNote ? item.body : null,
    content_hash: item.content_hash,
    created_by: ctx.userId,
    valid_at: item.valid_at,
    supersedes: ctx.predecessorId,
  };
}
```

Check `SourceKind` exists in `lib/types.ts` (`grep -n "SourceKind" lib/types.ts`); it is used by `ArtifactRow`, so it does.

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/import/commit.test.ts` → PASS (4).

- [ ] **Step 5: Write the failing integration test for the runner**

Append to `tests/import.test.ts`:

```ts
import { commitBatchPage } from "@/lib/import/commit-run";

describe("commitBatchPage", () => {
  let appleId: string;
  let commitBatch: string;

  beforeAll(async () => {
    const { data: apple } = await admin.from("entity").select("id").eq("cik", "0000320193").single();
    appleId = apple!.id;
    const { data: b } = await alice
      .from("import_batch")
      .insert({ org_id: orgId, created_by: await uid(alice), source_kind: "enex", storage_key: `${orgId}/test/c.enex`, file_name: "c.enex", status: "review" })
      .select()
      .single();
    commitBatch = b!.id;
    const rows = [
      { kind: "note", position: 0, title: "Imported note", body: "text one", content_hash: "import-h-1", artifact_type: "note", chosen_entity_ids: [appleId], include: true },
      { kind: "note", position: 1, title: "Skipped note", body: "text two", content_hash: "import-h-2", artifact_type: "note", chosen_entity_ids: [], include: true },
      { kind: "note", position: 2, title: "Unticked", body: "text three", content_hash: "import-h-3", artifact_type: "note", chosen_entity_ids: [appleId], include: false },
    ];
    for (const r of rows) {
      const { error } = await alice.from("import_item").insert({ ...r, batch_id: commitBatch, org_id: orgId, valid_at: "2024-03-12T14:05:00.000Z" });
      if (error) throw error;
    }
  });

  it("writes artifacts + links for included items with companies, skips the rest, and is idempotent", async () => {
    const ctx = { orgId, userId: await uid(alice), importerName: "Alice Okafor" };
    const first = await commitBatchPage(alice, ctx, commitBatch, 50);
    expect(first).toEqual({ processed: 3, remaining: 0 });

    const { data: items } = await alice.from("import_item").select("title,status,artifact_id").eq("batch_id", commitBatch).order("position");
    expect(items!.map((i) => i.status)).toEqual(["imported", "skipped", "skipped"]);
    const artifactId = items![0].artifact_id!;

    const { data: art } = await alice.from("artifact").select("title,created_by,valid_at,source_kind").eq("id", artifactId).single();
    expect(art!.title).toBe("Imported note");
    expect(art!.created_by).toBe(await uid(alice));
    expect(art!.valid_at).toBe("2024-03-12T14:05:00+00:00");
    expect(art!.source_kind).toBe("paste");
    const { data: links } = await alice.from("artifact_entity").select("entity_id").eq("artifact_id", artifactId);
    expect(links!.map((l) => l.entity_id)).toEqual([appleId]);

    const again = await commitBatchPage(alice, ctx, commitBatch, 50);
    expect(again).toEqual({ processed: 0, remaining: 0 });
    const { data: batch } = await alice.from("import_batch").select("status").eq("id", commitBatch).single();
    expect(batch!.status).toBe("imported");
  });
});
```

Run: `npx vitest run tests/import.test.ts` → FAIL, `@/lib/import/commit-run` missing.

- [ ] **Step 6: Implement the runner**

Create `lib/import/commit-run.ts`:

```ts
/**
 * Writes staged items into the record, one page per call, through the
 * caller's JWT client (RLS + attribution apply exactly as for manual ingest).
 * Idempotent: only items still 'pending' | 'unmatched' | 'duplicate' are
 * touched. Artifacts and links are written together; a link failure retracts
 * the orphan with a tombstone (same rule as actions/artifacts.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAsOf } from "@/lib/asof";
import { artifactPayloadFor } from "@/lib/import/commit";
import type { ArtifactRow, ImportItemRow } from "@/lib/types";

export interface CommitRunContext {
  orgId: string;
  userId: string;
  importerName: string;
}

const OPEN_STATUSES = ["pending", "unmatched", "duplicate"] as const;

export async function commitBatchPage(
  supabase: SupabaseClient,
  ctx: CommitRunContext,
  batchId: string,
  pageSize: number,
): Promise<{ processed: number; remaining: number }> {
  await supabase.from("import_batch").update({ status: "importing", updated_at: new Date().toISOString() }).eq("id", batchId).eq("status", "review");

  const { data: page, error } = await supabase
    .from("import_item")
    .select("*")
    .eq("batch_id", batchId)
    .in("status", [...OPEN_STATUSES])
    .order("position")
    .limit(pageSize);
  if (error) throw new Error(`load items: ${error.message}`);
  const items = (page ?? []) as ImportItemRow[];

  // note titles for attachment naming (parents may be outside this page)
  const parentIds = [...new Set(items.map((i) => i.parent_item_id).filter((x): x is string => !!x))];
  const noteTitle = new Map<string, string>();
  if (parentIds.length) {
    const { data: parents } = await supabase.from("import_item").select("id,title").in("id", parentIds);
    for (const p of parents ?? []) noteTitle.set(p.id, p.title);
  }

  for (const item of items) {
    if (!item.include || item.chosen_entity_ids.length === 0) {
      await supabase.from("import_item").update({ status: "skipped" }).eq("id", item.id);
      continue;
    }
    try {
      const { data: sameHash } = await supabase.from("artifact").select("*").eq("content_hash", item.content_hash);
      const predecessor = resolveAsOf((sameHash ?? []) as ArtifactRow[], new Date())[0] ?? null;

      const payload = artifactPayloadFor(item, {
        ...ctx,
        noteTitle: item.parent_item_id ? (noteTitle.get(item.parent_item_id) ?? null) : null,
        predecessorId: predecessor?.id ?? null,
      });
      const { data: artifact, error: insErr } = await supabase.from("artifact").insert(payload).select("id").single();
      if (insErr || !artifact) throw new Error(insErr?.message ?? "artifact insert failed");

      const { error: linkErr } = await supabase.from("artifact_entity").insert(
        item.chosen_entity_ids.map((entityId) => ({
          org_id: ctx.orgId,
          artifact_id: artifact.id,
          entity_id: entityId,
          created_by: ctx.userId,
          valid_at: item.valid_at,
        })),
      );
      if (linkErr) {
        await supabase.from("artifact").insert({
          ...payload,
          summary: "Tombstone: entity links failed to save during import.",
          valid_at: new Date().toISOString(),
          supersedes: artifact.id,
          is_tombstone: true,
        });
        throw new Error(`links: ${linkErr.message}`);
      }
      await supabase.from("import_item").update({ status: "imported", artifact_id: artifact.id, error: null }).eq("id", item.id);
    } catch (e) {
      await supabase.from("import_item").update({ status: "error", error: e instanceof Error ? e.message : String(e) }).eq("id", item.id);
    }
  }

  const { count } = await supabase
    .from("import_item")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId)
    .in("status", [...OPEN_STATUSES]);
  const remaining = count ?? 0;
  if (remaining === 0) {
    await supabase.from("import_batch").update({ status: "imported", updated_at: new Date().toISOString() }).eq("id", batchId);
  }
  return { processed: items.length, remaining };
}
```

- [ ] **Step 7: Run to verify it passes** — `npm run seed && npx vitest run tests/import.test.ts` → PASS (4 tests). If the `valid_at` equality fails on format, compare `new Date(art.valid_at).toISOString()` to the ISO input instead.

- [ ] **Step 8: Commit**

```bash
git add lib/import/commit.ts lib/import/commit-run.ts tests/import/commit.test.ts tests/import.test.ts
git commit -m "feat(import): item-to-artifact mapping and idempotent commit runner"
```

---

### Task 7: Parse runner (resumable range reads) — integration

**Files:**
- Create: `lib/import/parse-run.ts`
- Test: `tests/import.test.ts` (append a describe)

**Interfaces:**
- Consumes: `splitCompleteNotes`, `parseNoteBlock` (Task 4); `buildAliasIndex`, `suggestEntities`, `initialStatus` (Task 5); `defaultArtifactType` (Task 3); `buildStorageKey` (`lib/storage.ts`); `sha256Hex` (`lib/hash.ts`); `resolveAsOf` (`lib/asof.ts`).
- Produces: `parseBatchStep(supabase: SupabaseClient, batchId: string, opts: { bucket: string; deadlineMs?: number; chunkBytes?: number }): Promise<{ done: boolean; batch: ImportBatchRow }>`

- [ ] **Step 1: Write the failing integration test**

Append to `tests/import.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { parseBatchStep } from "@/lib/import/parse-run";

describe("parseBatchStep", () => {
  const bucket = env("SUPABASE_STORAGE_BUCKET");
  let parseBatch: string;

  beforeAll(async () => {
    const key = `${orgId}/import-test/${Date.now()}-sample.enex`;
    const { error: upErr } = await alice.storage.from(bucket).upload(key, readFileSync("fixtures/enex/sample.enex"), { contentType: "application/xml" });
    if (upErr) throw upErr;
    const { data: b } = await alice
      .from("import_batch")
      .insert({ org_id: orgId, created_by: await uid(alice), source_kind: "enex", storage_key: key, file_name: "sample.enex" })
      .select()
      .single();
    parseBatch = b!.id;
  });

  it("stages notes and document attachments with suggestions, resuming across small chunks", async () => {
    let done = false;
    let calls = 0;
    while (!done) {
      const r = await parseBatchStep(alice, parseBatch, { bucket, chunkBytes: 1500, deadlineMs: 0 });
      done = r.done;
      calls += 1;
      if (calls > 20) throw new Error("did not finish");
    }
    expect(calls).toBeGreaterThan(1); // deadlineMs 0 => one note per call

    const { data: batch } = await alice.from("import_batch").select("*").eq("id", parseBatch).single();
    expect(batch!.status).toBe("review");
    expect(batch!.notes_seen).toBe(3);
    expect(batch!.images_skipped).toBe(1);

    const { data: items } = await alice.from("import_item").select("*").eq("batch_id", parseBatch).order("position");
    expect(items!.map((i) => [i.kind, i.title])).toEqual([
      ["note", "AAPL mgmt call 2024-03"],
      ["attachment", "apple-model-summary.pdf"],
      ["note", "General market thoughts"],
      ["note", "Costco vs Visa: pricing"],
    ]);
    const { data: apple } = await admin.from("entity").select("id").eq("cik", "0000320193").single();
    expect(items![0].suggested_entity_ids).toEqual([apple!.id]);
    expect(items![0].status).toBe("pending");
    expect(items![1].parent_item_id).toBe(items![0].id);
    expect(items![1].artifact_type).toBe("other");
    expect(items![1].storage_key).toMatch(new RegExp(`^${orgId}/[0-9a-f-]{36}/apple-model-summary.pdf$`));
    expect(items![2].status).toBe("unmatched");
    const { data: visa } = await admin.from("entity").select("id").eq("cik", "0001403161").single();
    expect(items![3].suggested_entity_ids).toContain(visa!.id); // "V" as a whole word in the body
  });
});
```

Run: `npx vitest run tests/import.test.ts` → FAIL, `@/lib/import/parse-run` missing.

- [ ] **Step 2: Implement the runner**

Create `lib/import/parse-run.ts`:

```ts
/**
 * One resumable step of parsing an uploaded .enex: read a byte range from
 * Storage starting at batch.bytes_done, stage every complete note it contains
 * (uploading document attachments), record the new offset, stop when the
 * time budget is spent or the file is finished.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAsOf } from "@/lib/asof";
import { sha256Hex } from "@/lib/hash";
import { buildStorageKey } from "@/lib/storage";
import { defaultArtifactType } from "@/lib/import/classify";
import { parseNoteBlock, splitCompleteNotes } from "@/lib/import/enex";
import { buildAliasIndex, initialStatus, suggestEntities } from "@/lib/import/match";
import type { AliasRow, ArtifactRow, ImportBatchRow } from "@/lib/types";

const DEFAULT_CHUNK = 8 * 1024 * 1024;
const MAX_CHUNK = 160 * 1024 * 1024;

async function readRange(url: string, start: number, length: number): Promise<{ bytes: Buffer; total: number }> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${start + length - 1}` } });
  if (res.status !== 206 && res.status !== 200) throw new Error(`storage range read failed: ${res.status}`);
  const cr = res.headers.get("content-range"); // bytes start-end/total
  const total = cr ? Number(cr.split("/")[1]) : Number(res.headers.get("content-length"));
  return { bytes: Buffer.from(await res.arrayBuffer()), total };
}

export async function parseBatchStep(
  supabase: SupabaseClient,
  batchId: string,
  opts: { bucket: string; deadlineMs?: number; chunkBytes?: number },
): Promise<{ done: boolean; batch: ImportBatchRow }> {
  const deadline = Date.now() + (opts.deadlineMs ?? 8000);
  const { data: b, error } = await supabase.from("import_batch").select("*").eq("id", batchId).single();
  if (error || !b) throw new Error(`batch not found: ${error?.message}`);
  let batch = b as ImportBatchRow;
  if (batch.status !== "parsing") return { done: batch.status !== "parsing", batch };

  const fail = async (msg: string) => {
    const { data } = await supabase.from("import_batch").update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("id", batchId).select().single();
    return { done: true, batch: (data ?? { ...batch, status: "failed", error: msg }) as ImportBatchRow };
  };

  try {
    const { data: signed, error: sErr } = await supabase.storage.from(opts.bucket).createSignedUrl(batch.storage_key, 600);
    if (sErr || !signed) throw new Error(`signed url: ${sErr?.message}`);

    // alias index + existing hashes, once per step
    const { data: aliasRows } = await supabase.from("entity_alias").select("*");
    const aliases = resolveAsOf((aliasRows ?? []) as AliasRow[], new Date());
    const index = buildAliasIndex(aliases);
    const { data: artRows } = await supabase.from("artifact").select("*");
    const live = resolveAsOf((artRows ?? []) as ArtifactRow[], new Date());
    const hashToArtifact = new Map(live.filter((a) => a.content_hash).map((a) => [a.content_hash as string, a.id]));

    let offset = batch.bytes_done;
    let chunk = opts.chunkBytes ?? DEFAULT_CHUNK;
    let position = await nextPosition(supabase, batchId);

    for (;;) {
      let { bytes, total } = await readRange(signed.signedUrl, offset, chunk);
      let eof = offset + bytes.length >= total;
      let split = splitCompleteNotes(bytes, eof);
      while (split.blocks.length === 0 && !eof) {
        chunk *= 2;
        if (chunk > MAX_CHUNK) throw new Error("A single note exceeds the size the importer can handle (160 MB).");
        ({ bytes, total } = await readRange(signed.signedUrl, offset, chunk));
        eof = offset + bytes.length >= total;
        split = splitCompleteNotes(bytes, eof);
      }

      let consumedUpTo = offset;
      for (const block of split.blocks) {
        const note = parseNoteBlock(block.toString("utf8"));
        position = await stageNote(supabase, batch, note, position, index, hashToArtifact, opts.bucket);
        consumedUpTo = offset + (block.byteOffset - bytes.byteOffset) + block.length;
        batch = { ...batch, notes_seen: batch.notes_seen + 1, images_skipped: batch.images_skipped + note.imagesSkipped };
        if (Date.now() > deadline) break;
      }
      const finishedChunk = consumedUpTo >= offset + split.consumed;
      const newOffset = finishedChunk && eof ? total : finishedChunk ? offset + split.consumed : consumedUpTo;
      const done = newOffset >= total;
      const { data: saved } = await supabase
        .from("import_batch")
        .update({
          bytes_total: total,
          bytes_done: newOffset,
          notes_seen: batch.notes_seen,
          images_skipped: batch.images_skipped,
          status: done ? "review" : "parsing",
          updated_at: new Date().toISOString(),
        })
        .eq("id", batchId)
        .select()
        .single();
      batch = saved as ImportBatchRow;
      if (done || Date.now() > deadline) return { done, batch };
      offset = newOffset;
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

async function nextPosition(supabase: SupabaseClient, batchId: string): Promise<number> {
  const { data } = await supabase.from("import_item").select("position").eq("batch_id", batchId).order("position", { ascending: false }).limit(1);
  return data && data.length ? data[0].position + 1 : 0;
}

async function stageNote(
  supabase: SupabaseClient,
  batch: ImportBatchRow,
  note: ReturnType<typeof parseNoteBlock>,
  position: number,
  index: ReturnType<typeof buildAliasIndex>,
  hashToArtifact: Map<string, string>,
  bucket: string,
): Promise<number> {
  const suggested = suggestEntities(index, note.title, note.text);
  const noteHash = sha256Hex(note.text);
  const noteDup = hashToArtifact.get(noteHash) ?? null;
  const noteStatus = initialStatus(suggested, noteDup);
  const { data: noteRow, error } = await supabase
    .from("import_item")
    .insert({
      batch_id: batch.id, org_id: batch.org_id, kind: "note", parent_item_id: null, position,
      title: note.title, author: note.author, valid_at: note.createdAt, body: note.text,
      content_hash: noteHash, artifact_type: defaultArtifactType("note", null),
      suggested_entity_ids: suggested, chosen_entity_ids: suggested,
      include: noteStatus.include, status: noteStatus.status, duplicate_of: noteDup,
    })
    .select("id")
    .single();
  if (error || !noteRow) throw new Error(`stage note: ${error?.message}`);
  position += 1;

  for (const doc of note.documents) {
    const key = buildStorageKey(batch.org_id, doc.fileName);
    const hash = sha256Hex(doc.bytes);
    const dup = hashToArtifact.get(hash) ?? null;
    let uploadError: string | null = null;
    const { error: upErr } = await supabase.storage.from(bucket).upload(key, doc.bytes, { contentType: doc.mime || "application/octet-stream" });
    if (upErr) uploadError = upErr.message;
    const st = uploadError ? { status: "error" as const, include: false } : initialStatus(suggested, dup);
    const { error: iErr } = await supabase.from("import_item").insert({
      batch_id: batch.id, org_id: batch.org_id, kind: "attachment", parent_item_id: noteRow.id, position,
      title: doc.fileName, author: note.author, valid_at: note.createdAt, body: null,
      storage_key: uploadError ? null : key, file_name: doc.fileName, mime: doc.mime, bytes: doc.bytes.length,
      content_hash: hash, artifact_type: defaultArtifactType("attachment", doc.fileName),
      suggested_entity_ids: suggested, chosen_entity_ids: suggested,
      include: st.include, status: st.status, duplicate_of: dup, error: uploadError,
    });
    if (iErr) throw new Error(`stage attachment: ${iErr.message}`);
    position += 1;
  }
  return position;
}
```

Note on `consumedUpTo`: `block` is a subarray of `bytes`, so `block.byteOffset - bytes.byteOffset` is its start inside the chunk. When the deadline interrupts mid-chunk, `bytes_done` is set to the end of the last staged note, so the next call re-reads from there and never double-stages.

- [ ] **Step 3: Run to verify it passes** — `npm run seed && npx vitest run tests/import.test.ts` → PASS (5). If the local storage does not honour `Range` (status 200 with the whole body), the runner still works because `readRange` accepts 200; the "calls > 1" assertion then depends on `deadlineMs: 0`, which breaks after each note — still > 1.

- [ ] **Step 4: Commit**

```bash
git add lib/import/parse-run.ts tests/import.test.ts
git commit -m "feat(import): resumable ENEX parse runner staging notes and attachments"
```

---

### Task 8: Server Actions

**Files:**
- Create: `actions/import.ts`

**Interfaces:**
- Consumes: `requireUser` (`lib/supabase/server.ts`), `canWriteResearch` (`lib/roles.ts`), `isOwnedStorageKey` (`lib/storage.ts`), `parseBatchStep` (Task 7), `commitBatchPage` (Task 6), `env`.
- Produces (all `"use server"`):
  - `startImportBatch(storageKey: string, fileName: string): Promise<{ batchId: string | null; error: string | null }>`
  - `parseImportChunk(batchId: string): Promise<{ done: boolean; status: ImportBatchStatus; bytesDone: number; bytesTotal: number | null; notesSeen: number; error: string | null }>`
  - `updateImportItem(itemId: string, patch: { include?: boolean; chosen_entity_ids?: string[]; artifact_type?: ArtifactType }): Promise<{ error: string | null }>`
  - `bulkUpdateImportItems(itemIds: string[], patch: { include?: boolean; addEntityId?: string; artifact_type?: ArtifactType }): Promise<{ error: string | null }>`
  - `commitImportBatch(batchId: string): Promise<{ remaining: number; error: string | null }>`
  - `discardImportBatch(batchId: string): Promise<{ error: string | null }>`

- [ ] **Step 1: Implement**

Create `actions/import.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/supabase/server";
import { canWriteResearch } from "@/lib/roles";
import { isOwnedStorageKey } from "@/lib/storage";
import { env } from "@/lib/env";
import { parseBatchStep } from "@/lib/import/parse-run";
import { commitBatchPage } from "@/lib/import/commit-run";
import type { ArtifactType, ImportBatchRow, ImportBatchStatus } from "@/lib/types";

async function ownedBatch(batchId: string) {
  const { supabase, user, profile } = await requireUser();
  if (!canWriteResearch(profile.role)) throw new Error("Your role cannot import.");
  const { data } = await supabase.from("import_batch").select("*").eq("id", batchId).single();
  const batch = data as ImportBatchRow | null;
  if (!batch || batch.created_by !== user.id) throw new Error("Batch not found.");
  return { supabase, user, profile, batch };
}

export async function startImportBatch(storageKey: string, fileName: string) {
  const { supabase, user, profile } = await requireUser();
  if (!canWriteResearch(profile.role)) return { batchId: null, error: "Your role cannot import." };
  if (!isOwnedStorageKey(storageKey, profile.org_id)) return { batchId: null, error: "Upload did not complete." };
  const { data, error } = await supabase
    .from("import_batch")
    .insert({ org_id: profile.org_id, created_by: user.id, source_kind: "enex", storage_key: storageKey, file_name: fileName })
    .select("id")
    .single();
  if (error || !data) return { batchId: null, error: error?.message ?? "Could not start import." };
  revalidatePath("/import");
  return { batchId: data.id as string, error: null };
}

export async function parseImportChunk(batchId: string) {
  try {
    const { supabase } = await ownedBatch(batchId);
    const { done, batch } = await parseBatchStep(supabase, batchId, { bucket: env("SUPABASE_STORAGE_BUCKET") });
    if (done) revalidatePath(`/import/${batchId}`);
    return { done, status: batch.status as ImportBatchStatus, bytesDone: batch.bytes_done, bytesTotal: batch.bytes_total, notesSeen: batch.notes_seen, error: batch.error };
  } catch (e) {
    return { done: true, status: "failed" as ImportBatchStatus, bytesDone: 0, bytesTotal: null, notesSeen: 0, error: e instanceof Error ? e.message : "Parse failed." };
  }
}

export async function updateImportItem(
  itemId: string,
  patch: { include?: boolean; chosen_entity_ids?: string[]; artifact_type?: ArtifactType },
) {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from("import_item").update(patch).eq("id", itemId).select("batch_id").single();
  if (error || !data) return { error: error?.message ?? "Not allowed." };
  revalidatePath(`/import/${data.batch_id}`);
  return { error: null };
}

export async function bulkUpdateImportItems(
  itemIds: string[],
  patch: { include?: boolean; addEntityId?: string; artifact_type?: ArtifactType },
) {
  const { supabase } = await requireUser();
  if (itemIds.length === 0) return { error: null };
  const { data: rows, error } = await supabase.from("import_item").select("id,batch_id,chosen_entity_ids").in("id", itemIds);
  if (error) return { error: error.message };
  for (const r of rows ?? []) {
    const next: Record<string, unknown> = {};
    if (patch.include !== undefined) next.include = patch.include;
    if (patch.artifact_type) next.artifact_type = patch.artifact_type;
    if (patch.addEntityId && !r.chosen_entity_ids.includes(patch.addEntityId)) next.chosen_entity_ids = [...r.chosen_entity_ids, patch.addEntityId];
    if (Object.keys(next).length) await supabase.from("import_item").update(next).eq("id", r.id);
  }
  if (rows?.length) revalidatePath(`/import/${rows[0].batch_id}`);
  return { error: null };
}

export async function commitImportBatch(batchId: string) {
  try {
    const { supabase, user, profile, batch } = await ownedBatch(batchId);
    if (!["review", "importing"].includes(batch.status)) return { remaining: 0, error: `Batch is ${batch.status}.` };
    const { remaining } = await commitBatchPage(supabase, { orgId: profile.org_id, userId: user.id, importerName: profile.display_name }, batchId, 50);
    revalidatePath(`/import/${batchId}`);
    revalidatePath("/");
    return { remaining, error: null };
  } catch (e) {
    return { remaining: 0, error: e instanceof Error ? e.message : "Import failed." };
  }
}

export async function discardImportBatch(batchId: string) {
  try {
    const { supabase, batch } = await ownedBatch(batchId);
    if (batch.status === "imported") return { error: "Already imported." };
    await supabase.from("import_batch").update({ status: "discarded", updated_at: new Date().toISOString() }).eq("id", batchId);
    revalidatePath("/import");
    revalidatePath(`/import/${batchId}`);
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not discard." };
  }
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit -p . && npx eslint actions lib` → clean.

- [ ] **Step 3: Commit**

```bash
git add actions/import.ts
git commit -m "feat(import): server actions for start, parse, review edits, commit, discard"
```

---

### Task 9: Import pages and components

**Files:**
- Create: `app/(app)/import/page.tsx`
- Create: `app/(app)/import/[batchId]/page.tsx`
- Create: `components/import-upload.tsx`
- Create: `components/import-progress.tsx`
- Create: `components/import-review.tsx`
- Modify: `app/(app)/layout.tsx:66-75` (nav)

**Interfaces:**
- Consumes: actions from Task 8; `prepareUpload` (`actions/artifacts.ts`); `fetchEntitiesAsOf`, `fetchAliasesAsOf`, `identityFromAliases` (`lib/queries.ts`); `getAsOf` (`lib/asof-server.ts`); `canWriteResearch`.

- [ ] **Step 1: Nav link**

In `app/(app)/layout.tsx`, after the Ingest link add:

```tsx
            {canWriteResearch(profile.role) && (
              <Link href="/import" className="hover:text-pine-dark">Import</Link>
            )}
```

and add `import { canWriteResearch } from "@/lib/roles";` to the imports.

- [ ] **Step 2: Upload component**

Create `components/import-upload.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { prepareUpload } from "@/actions/artifacts";
import { startImportBatch } from "@/actions/import";

export function ImportUpload() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const prepared = await prepareUpload(file.name);
      if (prepared.error) throw new Error(prepared.error);
      const res = await fetch(prepared.signedUrl, {
        method: "PUT",
        headers: { "content-type": "application/xml", "x-upsert": "false" },
        body: file,
      });
      if (!res.ok) throw new Error(`Storage rejected the upload (${res.status}).`);
      const started = await startImportBatch(prepared.storageKey, file.name);
      if (started.error || !started.batchId) throw new Error(started.error ?? "Could not start import.");
      router.push(`/import/${started.batchId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
      setBusy(false);
    }
  };

  return (
    <div className="bg-card border border-rule p-5">
      <label className="block">
        <span className="section-label">Evernote export (.enex)</span>
        <input
          type="file"
          accept=".enex,application/xml,text/xml"
          disabled={busy}
          onChange={onChange}
          className="mt-1 block w-full text-sm file:mr-3 file:border file:border-rule file:bg-card file:px-3 file:py-1.5 file:text-xs file:font-data file:uppercase"
        />
      </label>
      <p className="text-xs text-ink-faint mt-2">
        In Evernote: select a notebook → Export → ENEX. Notes and their PDF / Office attachments are staged for review; images are skipped. Nothing is written to the record until you press Import.
      </p>
      {busy && <p className="text-xs font-data mt-2">Uploading…</p>}
      {error && <p className="text-sm text-oxblood bg-oxblood-wash border border-oxblood/30 px-3 py-2 mt-3">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Batches page**

Create `app/(app)/import/page.tsx`:

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/supabase/server";
import { canWriteResearch } from "@/lib/roles";
import { ImportUpload } from "@/components/import-upload";
import type { ImportBatchRow } from "@/lib/types";

export default async function ImportPage() {
  const { supabase, profile } = await requireUser();
  if (!canWriteResearch(profile.role)) notFound();
  const { data } = await supabase.from("import_batch").select("*").order("created_at", { ascending: false }).limit(50);
  const batches = (data ?? []) as ImportBatchRow[];

  return (
    <div className="max-w-3xl rise space-y-8">
      <header>
        <h1 className="font-display text-3xl text-pine-dark">Import</h1>
        <p className="text-sm text-ink-soft mt-1">Bring existing research into the record. Suggested company links are reviewed before anything is written.</p>
      </header>
      <ImportUpload />
      {batches.length > 0 && (
        <table className="w-full bg-card border border-rule text-sm">
          <thead>
            <tr className="text-left">
              <th className="section-label px-4 py-2.5 border-b-2 border-rule-strong">File</th>
              <th className="section-label px-4 py-2.5 border-b-2 border-rule-strong">Status</th>
              <th className="section-label px-4 py-2.5 border-b-2 border-rule-strong">Notes</th>
              <th className="section-label px-4 py-2.5 border-b-2 border-rule-strong">Started</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id} className="border-b border-rule hover:bg-pine-wash/40">
                <td className="px-4 py-2.5"><Link href={`/import/${b.id}`} className="font-medium text-pine-dark hover:underline">{b.file_name}</Link></td>
                <td className="px-4 py-2.5 font-data text-xs uppercase">{b.status}</td>
                <td className="px-4 py-2.5 font-data text-xs">{b.notes_seen}</td>
                <td className="px-4 py-2.5 font-data text-xs text-ink-soft">{new Date(b.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Progress component (drives parsing)**

Create `components/import-progress.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseImportChunk } from "@/actions/import";

export function ImportProgress({ batchId, initialDone, initialTotal }: { batchId: string; initialDone: number; initialTotal: number | null }) {
  const router = useRouter();
  const [done, setDone] = useState(initialDone);
  const [total, setTotal] = useState(initialTotal);
  const [notes, setNotes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  useEffect(() => {
    if (running.current) return;
    running.current = true;
    (async () => {
      for (;;) {
        const r = await parseImportChunk(batchId);
        setDone(r.bytesDone);
        setTotal(r.bytesTotal);
        setNotes(r.notesSeen);
        if (r.error) { setError(r.error); break; }
        if (r.done) { router.refresh(); break; }
      }
    })();
  }, [batchId, router]);

  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="bg-card border border-rule p-5">
      <p className="section-label">Reading export…</p>
      <div className="mt-2 h-2 bg-paper-deep border border-rule"><div className="h-full bg-pine" style={{ width: `${pct}%` }} /></div>
      <p className="text-xs font-data mt-2">{pct}% · {notes} notes</p>
      {error && <p className="text-sm text-oxblood bg-oxblood-wash border border-oxblood/30 px-3 py-2 mt-3">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 5: Review component**

Create `components/import-review.tsx`:

```tsx
"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { bulkUpdateImportItems, commitImportBatch, discardImportBatch, updateImportItem } from "@/actions/import";
import type { ArtifactType, ImportBatchRow, ImportItemRow } from "@/lib/types";

const TYPES: ArtifactType[] = ["note", "model", "primer", "thesis", "filing", "transcript", "other"];
type Filter = "all" | "ready" | "unmatched" | "duplicates";

export function ImportReview({
  batch, items, entities, canEdit,
}: { batch: ImportBatchRow; items: ImportItemRow[]; entities: { id: string; label: string }[]; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkEntity, setBulkEntity] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const label = useMemo(() => new Map(entities.map((e) => [e.id, e.label])), [entities]);

  const visible = items.filter((i) =>
    filter === "all" ? true
    : filter === "unmatched" ? i.status === "unmatched"
    : filter === "duplicates" ? i.status === "duplicate"
    : i.include && i.chosen_entity_ids.length > 0 && i.status !== "imported",
  );
  const counts = {
    notes: items.filter((i) => i.kind === "note").length,
    docs: items.filter((i) => i.kind === "attachment").length,
    unmatched: items.filter((i) => i.status === "unmatched").length,
    duplicates: items.filter((i) => i.status === "duplicate").length,
    ready: items.filter((i) => i.include && i.chosen_entity_ids.length > 0 && !["imported", "skipped"].includes(i.status)).length,
  };

  const act = (fn: () => Promise<{ error: string | null }>) =>
    start(async () => {
      const r = await fn();
      if (r.error) setMessage(r.error);
      router.refresh();
    });

  const runImport = () =>
    start(async () => {
      setMessage("Importing…");
      for (;;) {
        const r = await commitImportBatch(batch.id);
        if (r.error) { setMessage(r.error); break; }
        if (r.remaining === 0) { setMessage(null); break; }
      }
      router.refresh();
    });

  const toggleSel = (id: string) =>
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const readOnly = !canEdit || batch.status === "imported" || batch.status === "discarded";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-xs font-data">
        <span>{counts.notes} notes · {counts.docs} documents · {batch.images_skipped} images skipped</span>
        <span className="text-ink-soft">· {counts.ready} ready · {counts.unmatched} unmatched · {counts.duplicates} duplicates</span>
        <span className="flex-1" />
        {(["all", "ready", "unmatched", "duplicates"] as Filter[]).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={`uppercase tracking-wider px-2 py-1 border ${filter === f ? "border-pine bg-pine-wash" : "border-rule"}`}>{f}</button>
        ))}
      </div>

      {!readOnly && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 bg-paper-deep border border-rule px-3 py-2 text-xs">
          <span className="font-data">{selected.size} selected</span>
          <select value={bulkEntity} onChange={(e) => setBulkEntity(e.target.value)} className="border border-rule bg-card px-2 py-1 font-data">
            <option value="">Add company…</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
          <button disabled={!bulkEntity || pending} onClick={() => act(() => bulkUpdateImportItems([...selected], { addEntityId: bulkEntity }))} className="border border-rule px-2 py-1 disabled:opacity-50">Apply</button>
          <button disabled={pending} onClick={() => act(() => bulkUpdateImportItems([...selected], { include: true }))} className="border border-rule px-2 py-1">Tick</button>
          <button disabled={pending} onClick={() => act(() => bulkUpdateImportItems([...selected], { include: false }))} className="border border-rule px-2 py-1">Untick</button>
        </div>
      )}

      <table className="w-full bg-card border border-rule text-sm">
        <thead>
          <tr className="text-left">
            <th className="px-2 py-2 border-b-2 border-rule-strong"><input type="checkbox" onChange={(e) => setSelected(e.target.checked ? new Set(visible.map((i) => i.id)) : new Set())} /></th>
            <th className="section-label px-2 py-2 border-b-2 border-rule-strong">Include</th>
            <th className="section-label px-2 py-2 border-b-2 border-rule-strong">Title</th>
            <th className="section-label px-2 py-2 border-b-2 border-rule-strong">Date</th>
            <th className="section-label px-2 py-2 border-b-2 border-rule-strong">Type</th>
            <th className="section-label px-2 py-2 border-b-2 border-rule-strong">Companies</th>
            <th className="section-label px-2 py-2 border-b-2 border-rule-strong">Status</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((i) => (
            <tr key={i.id} className={`border-b border-rule ${i.kind === "attachment" ? "bg-paper-deep/40" : ""}`}>
              <td className="px-2 py-1.5"><input type="checkbox" checked={selected.has(i.id)} onChange={() => toggleSel(i.id)} /></td>
              <td className="px-2 py-1.5"><input type="checkbox" checked={i.include} disabled={readOnly || i.status === "imported"} onChange={(e) => act(() => updateImportItem(i.id, { include: e.target.checked }))} /></td>
              <td className={`px-2 py-1.5 ${i.kind === "attachment" ? "pl-8 text-ink-soft" : ""}`} title={i.body ?? i.file_name ?? ""}>
                {i.title}
                {i.kind === "attachment" && i.bytes != null && <span className="ml-2 font-data text-xs">{Math.round(i.bytes / 1024)} KB</span>}
              </td>
              <td className="px-2 py-1.5 font-data text-xs">{i.valid_at.slice(0, 10)}</td>
              <td className="px-2 py-1.5">
                <select value={i.artifact_type} disabled={readOnly} onChange={(e) => act(() => updateImportItem(i.id, { artifact_type: e.target.value as ArtifactType }))} className="border border-rule bg-card px-1 py-0.5 font-data text-xs">
                  {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </td>
              <td className="px-2 py-1.5">
                <div className="flex flex-wrap gap-1 items-center">
                  {i.chosen_entity_ids.map((id) => (
                    <span key={id} className="text-[10px] font-data uppercase bg-pine-wash text-pine px-1.5 py-0.5">
                      {label.get(id) ?? id.slice(0, 8)}
                      {!readOnly && <button className="ml-1" onClick={() => act(() => updateImportItem(i.id, { chosen_entity_ids: i.chosen_entity_ids.filter((x) => x !== id) }))}>×</button>}
                    </span>
                  ))}
                  {!readOnly && (
                    <select value="" onChange={(e) => e.target.value && act(() => updateImportItem(i.id, { chosen_entity_ids: [...i.chosen_entity_ids, e.target.value] }))} className="border border-rule bg-card px-1 py-0.5 font-data text-[10px]">
                      <option value="">+</option>
                      {entities.filter((e) => !i.chosen_entity_ids.includes(e.id)).map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
                    </select>
                  )}
                </div>
              </td>
              <td className="px-2 py-1.5 font-data text-[10px] uppercase">
                {i.status === "imported" && i.artifact_id ? <a href={`/artifacts/${i.artifact_id}`} className="text-pine underline decoration-dotted">imported</a> : i.status}
                {i.error && <span className="block normal-case text-oxblood">{i.error}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {message && <p className="text-sm bg-paper-deep border border-rule px-3 py-2">{message}</p>}

      {!readOnly && (
        <div className="flex gap-3">
          <button disabled={pending || counts.ready === 0} onClick={runImport} className="bg-pine text-paper px-6 py-2.5 text-sm font-data uppercase tracking-wider hover:bg-pine-dark disabled:opacity-50">
            Import {counts.ready} item{counts.ready === 1 ? "" : "s"}
          </button>
          <button disabled={pending} onClick={() => { if (confirm("Discard this batch? Nothing has been written to the record.")) act(() => discardImportBatch(batch.id)); }} className="border border-rule px-4 py-2.5 text-sm font-data uppercase tracking-wider">Discard</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Batch page**

Create `app/(app)/import/[batchId]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/supabase/server";
import { getAsOf } from "@/lib/asof-server";
import { fetchEntitiesAsOf, fetchAliasesAsOf, identityFromAliases } from "@/lib/queries";
import { ImportProgress } from "@/components/import-progress";
import { ImportReview } from "@/components/import-review";
import type { ImportBatchRow, ImportItemRow } from "@/lib/types";

export default async function ImportBatchPage({ params }: PageProps<"/import/[batchId]">) {
  const { batchId } = await params;
  const { supabase, user } = await requireUser();
  const { data: b } = await supabase.from("import_batch").select("*").eq("id", batchId).single();
  if (!b) notFound();
  const batch = b as ImportBatchRow;

  const [{ data: rows }, entities, aliases] = await Promise.all([
    supabase.from("import_item").select("*").eq("batch_id", batchId).order("position"),
    fetchEntitiesAsOf(supabase, await getAsOf()),
    fetchAliasesAsOf(supabase, await getAsOf()),
  ]);
  const identity = identityFromAliases(aliases);
  const options = entities.map((e) => ({
    id: e.id,
    label: `${identity.get(e.id)?.legalName ?? e.cik} (${identity.get(e.id)?.tickers.join(", ") || "CIK " + e.cik})`,
  }));

  return (
    <div className="rise space-y-6">
      <header>
        <h1 className="font-display text-3xl text-pine-dark">{batch.file_name}</h1>
        <p className="text-xs font-data uppercase tracking-wider text-ink-soft mt-1">{batch.status}</p>
      </header>
      {batch.status === "parsing" && <ImportProgress batchId={batch.id} initialDone={batch.bytes_done} initialTotal={batch.bytes_total} />}
      {batch.status === "failed" && <p className="text-sm text-oxblood bg-oxblood-wash border border-oxblood/30 px-3 py-2">{batch.error}</p>}
      {batch.status !== "parsing" && batch.status !== "failed" && (
        <ImportReview batch={batch} items={(rows ?? []) as ImportItemRow[]} entities={options} canEdit={batch.created_by === user.id} />
      )}
    </div>
  );
}
```

Check how other dynamic pages type `params` (`grep -n "PageProps" "app/(app)/entities/[id]/page.tsx"`) and mirror it.

- [ ] **Step 7: Typecheck, lint, build**

Run: `npx tsc --noEmit -p . && npx eslint app components actions lib && npm run build` → clean.

- [ ] **Step 8: Commit**

```bash
git add "app/(app)/import" "app/(app)/layout.tsx" components/import-upload.tsx components/import-progress.tsx components/import-review.tsx
git commit -m "feat(import): Import pages — upload, progress, suggest-and-review table, receipt"
```

---

### Task 10: Browser verification, docs, deploy

**Files:**
- Modify: `README.md` (new section), `DEPLOY.md` (one line under Ongoing about staging tables), memory note.
- Scratchpad: Playwright script (not committed).

- [ ] **Step 1: Browser run on the local stack**

Start: `sg docker -c "npx supabase start"`, `npm run seed`, `npm run dev`. Script (python Playwright, scratchpad) logs in as `pete.pm@atlas.test`, opens `/import`, uploads `fixtures/enex/sample.enex`, waits for the review table (`text=General market thoughts`), asserts 3 note rows + 1 attachment row and one `unmatched`, adds Apple to the unmatched row via its `+` select, clicks `Import 4 items` (count may be 3 if the duplicate/unmatched logic leaves one unticked — read the button text), waits for `imported` links, then opens `/entities/<apple id>` and asserts "AAPL mgmt call 2024-03" and "AAPL mgmt call 2024-03 — apple-model-summary.pdf" are listed. Run it; all checks must pass. Stop the dev server.

- [ ] **Step 2: Full test runs**

`npm test` (all unit) and `npm run seed && npm run test:integration` → all green.

- [ ] **Step 3: Docs**

README, after "Things worth trying first", add:

```markdown
## Importing from Evernote

**Import** (header) takes an Evernote `.enex` export. Notes and their PDF /
Office attachments are staged with suggested company links (from the aliases
you maintain); you review, adjust, and press Import. Imported artifacts carry
the note's created date as `valid_at` and the importer as `created_by`.
Images are skipped. The staging tables (`import_batch`, `import_item`) are
the one deliberately mutable area of the schema — a workbench, not the record.
```

DEPLOY.md, under "Ongoing", add: `- **Import staging**: batches accumulate in \`import_batch\`; discarded/imported batches keep their staged attachment objects. Harmless; prune with the service role if storage fills.`

- [ ] **Step 4: Ship**

```bash
git add README.md DEPLOY.md
git commit -m "docs: Evernote import"
npx supabase db push          # applies 20260925000006 to the hosted project
git push origin main          # Vercel deploys
```

Poll `https://api.github.com/repos/nikhileshp/atlas/deployments?per_page=1` statuses until `success` for the pushed sha. Then update the project memory file with: Import page exists; staging tables are the mutable exception; `fast-xml-parser` dependency.
