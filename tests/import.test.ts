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
