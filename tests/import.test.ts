/**
 * Import staging: mutable workbench tables. Policies exercised with real JWTs:
 *  - creator inserts a batch and updates its items
 *  - same-org colleague can read but not update
 *  - other org sees nothing
 * Run after `npm run seed`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { env } from "@/lib/env";
import { parseBatchStep } from "@/lib/import/parse-run";
import { commitBatchPage } from "@/lib/import/commit-run";

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
