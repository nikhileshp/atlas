/**
 * The RLS matrix, exercised against the live local stack with real JWTs:
 *  - UPDATE and DELETE are denied to every application role (append-only)
 *  - role gates: analyst/pm insert what the spec says; admin is a superset of pm
 *  - attribution: created_by must be the acting user
 *  - tenancy: a second org sees nothing of the seeded org, via the JWT claim
 *  - storage: writes are confined to the caller's org prefix
 *
 * Policies that are only written but never exercised are policies that are
 * wrong — this suite is the exercise. Run after `npm run seed`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

const url = () => env("NEXT_PUBLIC_SUPABASE_URL");
const anonKey = () => env("NEXT_PUBLIC_SUPABASE_ANON_KEY");

const admin = createClient(url(), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

async function signedInClient(email: string, password?: string) {
  const client = createClient(url(), anonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email,
    password: password ?? env("SEED_USER_PASSWORD"),
  });
  if (error) throw new Error(`sign-in ${email}: ${error.message}`);
  return client;
}

let alice: SupabaseClient; // analyst
let pete: SupabaseClient; // pm
let ada: SupabaseClient; // admin
let rita: SupabaseClient; // analyst in a DIFFERENT org

let orgId: string;
let otherOrgId: string;
let ritaId: string;
let appleId: string;
let anArtifactId: string;
let aPositionId: string;
const cleanupRows: [table: string, id: string][] = [];

beforeAll(async () => {
  alice = await signedInClient("alice.analyst@atlas.test");
  pete = await signedInClient("pete.pm@atlas.test");
  ada = await signedInClient("ada.admin@atlas.test");

  const { data: org } = await admin.from("org").select("id").single();
  orgId = org!.id;
  const { data: apple } = await admin
    .from("entity")
    .select("id")
    .eq("cik", "0000320193")
    .single();
  appleId = apple!.id;
  const { data: art } = await admin
    .from("artifact")
    .select("id")
    .eq("is_tombstone", false)
    .limit(1)
    .single();
  anArtifactId = art!.id;
  const { data: pos } = await admin.from("position_input").select("id").limit(1).single();
  aPositionId = pos!.id;

  // second org + user for the tenancy check
  const { data: org2 } = await admin
    .from("org")
    .insert({ name: "Rival Fund LP" })
    .select()
    .single();
  otherOrgId = org2!.id;
  const { data: ritaUser, error: ritaErr } = await admin.auth.admin.createUser({
    email: "rita.analyst@other.test",
    password: env("SEED_USER_PASSWORD"),
    email_confirm: true,
    app_metadata: { org_id: otherOrgId, role: "analyst" },
  });
  if (ritaErr) throw ritaErr;
  ritaId = ritaUser.user!.id;
  await admin.from("profile").insert({
    user_id: ritaId,
    org_id: otherOrgId,
    email: "rita.analyst@other.test",
    display_name: "Rita Chen",
    role: "analyst",
  });
  rita = await signedInClient("rita.analyst@other.test");
});

afterAll(async () => {
  for (const [table, id] of cleanupRows.reverse()) {
    await admin.from(table).delete().eq("id", id);
  }
  await admin.from("profile").delete().eq("user_id", ritaId);
  await admin.auth.admin.deleteUser(ritaId);
  await admin.from("org").delete().eq("id", otherOrgId);
});

const uid = async (c: SupabaseClient) => (await c.auth.getUser()).data.user!.id;

describe("append-only: no UPDATE, no DELETE, for any application role", () => {
  it("denies UPDATE even to the row's author", async () => {
    const { data: before } = await admin
      .from("artifact")
      .select("title")
      .eq("id", anArtifactId)
      .single();

    const { data, error } = await alice
      .from("artifact")
      .update({ title: "vandalized" })
      .eq("id", anArtifactId)
      .select();
    expect(error !== null || (data ?? []).length === 0).toBe(true);

    const { data: after } = await admin
      .from("artifact")
      .select("title")
      .eq("id", anArtifactId)
      .single();
    expect(after!.title).toBe(before!.title);
  });

  it("denies DELETE even to the pm on position inputs", async () => {
    const { data, error } = await pete
      .from("position_input")
      .delete()
      .eq("id", aPositionId)
      .select();
    expect(error !== null || (data ?? []).length === 0).toBe(true);

    const { data: still } = await admin
      .from("position_input")
      .select("id")
      .eq("id", aPositionId)
      .single();
    expect(still!.id).toBe(aPositionId);
  });
});

describe("role gates", () => {
  it("analyst cannot write position inputs", async () => {
    const { error } = await alice.from("position_input").insert({
      org_id: orgId,
      entity_id: appleId,
      created_by: await uid(alice),
      irr: 0.1,
      skew: 2,
      conviction: 5,
      fcf_growth: 0.05,
      computed_weight: 1,
      chosen_weight: 1,
      valid_at: new Date().toISOString(),
    });
    expect(error).not.toBeNull();
  });

  it("pm can write position inputs", async () => {
    const { data, error } = await pete
      .from("position_input")
      .insert({
        org_id: orgId,
        entity_id: appleId,
        created_by: await uid(pete),
        irr: 0.1,
        skew: 2,
        conviction: 5,
        fcf_growth: 0.05,
        computed_weight: 1,
        chosen_weight: 1,
        rationale: "rls test row",
        valid_at: new Date().toISOString(),
      })
      .select()
      .single();
    expect(error).toBeNull();
    cleanupRows.push(["position_input", data!.id]);
  });

  it("analyst can write artifacts", async () => {
    const base = {
      org_id: orgId,
      artifact_type: "note",
      source_kind: "paste",
      title: "rls test note",
      author: "test",
      body: "text",
      valid_at: new Date().toISOString(),
    };
    const { data, error } = await alice
      .from("artifact")
      .insert({ ...base, created_by: await uid(alice) })
      .select()
      .single();
    expect(error).toBeNull();
    cleanupRows.push(["artifact", data!.id]);
  });

  it("admin is a superset: can write artifacts", async () => {
    const { data, error } = await ada
      .from("artifact")
      .insert({
        org_id: orgId,
        artifact_type: "note",
        source_kind: "paste",
        title: "rls test note by admin",
        author: "test",
        body: "text",
        created_by: await uid(ada),
        valid_at: new Date().toISOString(),
      })
      .select()
      .single();
    expect(error).toBeNull();
    cleanupRows.push(["artifact", data!.id]);
  });

  it("admin is a superset: can write position inputs", async () => {
    const { data, error } = await ada
      .from("position_input")
      .insert({
        org_id: orgId,
        entity_id: appleId,
        created_by: await uid(ada),
        irr: 0.1,
        skew: 2,
        conviction: 5,
        fcf_growth: 0.05,
        computed_weight: 1,
        chosen_weight: 1,
        rationale: "rls test row by admin",
        valid_at: new Date().toISOString(),
      })
      .select()
      .single();
    expect(error).toBeNull();
    cleanupRows.push(["position_input", data!.id]);
  });

  it("admin can write entity aliases; analyst cannot", async () => {
    const base = {
      org_id: orgId,
      entity_id: appleId,
      alias_type: "internal",
      value: "rls-test-alias",
      valid_at: new Date().toISOString(),
    };
    const { data, error } = await ada
      .from("entity_alias")
      .insert({ ...base, created_by: await uid(ada) })
      .select()
      .single();
    expect(error).toBeNull();
    cleanupRows.push(["entity_alias", data!.id]);

    const { error: aliceErr } = await alice
      .from("entity_alias")
      .insert({ ...base, value: "rls-test-alias-2", created_by: await uid(alice) });
    expect(aliceErr).not.toBeNull();
  });

  it("pm can record decisions with explicit FKs", async () => {
    const { data, error } = await pete
      .from("decision")
      .insert({
        org_id: orgId,
        entity_id: appleId,
        created_by: await uid(pete),
        decision_type: "hold",
        summary: "rls test decision",
        position_input_id: aPositionId,
        quality_score_id: null,
        valid_at: new Date().toISOString(),
      })
      .select()
      .single();
    expect(error).toBeNull();
    cleanupRows.push(["decision", data!.id]);
  });
});

describe("attribution", () => {
  it("rejects a write whose created_by is not the acting user", async () => {
    const { error } = await alice.from("artifact").insert({
      org_id: orgId,
      artifact_type: "note",
      source_kind: "paste",
      title: "forged attribution",
      author: "test",
      body: "text",
      created_by: await uid(pete), // forging pete
      valid_at: new Date().toISOString(),
    });
    expect(error).not.toBeNull();
  });
});

describe("tenancy: the org claim in the JWT is the boundary", () => {
  it("a user from another org sees no entities, artifacts, or scores", async () => {
    for (const table of ["entity", "artifact", "quality_score", "position_input"]) {
      const { data, error } = await rita.from(table).select("id");
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
  });

  it("a user from another org cannot insert into the seeded org", async () => {
    const { error } = await rita.from("artifact").insert({
      org_id: orgId, // not rita's org
      artifact_type: "note",
      source_kind: "paste",
      title: "cross-tenant write",
      author: "rita",
      body: "x",
      created_by: ritaId,
      valid_at: new Date().toISOString(),
    });
    expect(error).not.toBeNull();
  });
});

describe("storage tenancy", () => {
  const bucket = () => env("SUPABASE_STORAGE_BUCKET");

  it("allows upload under the caller's own org prefix", async () => {
    const key = `${orgId}/rls-test/hello.txt`;
    const { error } = await alice.storage
      .from(bucket())
      .upload(key, Buffer.from("hi"), { contentType: "text/plain" });
    expect(error).toBeNull();
    await admin.storage.from(bucket()).remove([key]);
  });

  it("rejects upload under another org's prefix", async () => {
    const { error } = await alice.storage
      .from(bucket())
      .upload(`${otherOrgId}/rls-test/hello.txt`, Buffer.from("hi"), {
        contentType: "text/plain",
      });
    expect(error).not.toBeNull();
  });

  // Browser-direct uploads: the server mints a signed upload URL with the
  // caller's JWT, so the same path policy must gate URL creation.
  it("mints a signed upload URL only under the caller's own org prefix", async () => {
    const own = await alice.storage
      .from(bucket())
      .createSignedUploadUrl(`${orgId}/rls-test-signed/hello.txt`);
    expect(own.error).toBeNull();
    expect(own.data?.token).toBeTruthy();

    const foreign = await alice.storage
      .from(bucket())
      .createSignedUploadUrl(`${otherOrgId}/rls-test-signed/hello.txt`);
    expect(foreign.error).not.toBeNull();
  });
});
