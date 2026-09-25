/**
 * User removal, against the live local stack. Two outcomes:
 *  - a user who never wrote anything is deleted outright (auth + profile)
 *  - a user who authored rows keeps their rows and profile (attribution is
 *    append-only) but loses access: sign-in is refused and profile.removed_at
 *    is set
 * Run after `npm run seed`.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { removeUser } from "@/lib/users";

const url = env("NEXT_PUBLIC_SUPABASE_URL");
const admin = createClient(url, env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});
const PASSWORD = "removal-test-password";
const created: string[] = [];

async function makeUser(email: string, role: string) {
  const { data: org } = await admin.from("org").select("id").single();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { org_id: org!.id, role },
  });
  if (error || !data.user) throw error;
  created.push(data.user.id);
  await admin.from("profile").insert({
    user_id: data.user.id,
    org_id: org!.id,
    email,
    display_name: email,
    role,
  });
  return { id: data.user.id, orgId: org!.id as string };
}

async function canSignIn(email: string) {
  const c = createClient(url, env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  return error === null;
}

afterAll(async () => {
  for (const id of created) {
    await admin.from("artifact").delete().eq("created_by", id);
    await admin.from("profile").delete().eq("user_id", id);
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
});

describe("removeUser", () => {
  it("deletes a user who authored nothing", async () => {
    const { id } = await makeUser("removal-blank@atlas.test", "analyst");
    expect(await canSignIn("removal-blank@atlas.test")).toBe(true);

    const outcome = await removeUser(admin, id);

    expect(outcome).toBe("deleted");
    const { data: users } = await admin.auth.admin.listUsers();
    expect(users.users.some((u) => u.id === id)).toBe(false);
    const { data: profile } = await admin.from("profile").select("user_id").eq("user_id", id);
    expect(profile).toEqual([]);
  });

  it("revokes access but keeps rows and profile for a user who authored rows", async () => {
    const { id, orgId } = await makeUser("removal-author@atlas.test", "analyst");
    const { data: art, error } = await admin
      .from("artifact")
      .insert({
        org_id: orgId,
        created_by: id,
        artifact_type: "note",
        source_kind: "paste",
        title: "written before removal",
        author: "test",
        body: "text",
        valid_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    expect(error).toBeNull();

    const outcome = await removeUser(admin, id);

    expect(outcome).toBe("revoked");
    expect(await canSignIn("removal-author@atlas.test")).toBe(false);
    const { data: still } = await admin.from("artifact").select("id").eq("id", art!.id).single();
    expect(still?.id).toBe(art!.id);
    const { data: profile } = await admin
      .from("profile")
      .select("removed_at")
      .eq("user_id", id)
      .single();
    expect(profile?.removed_at).not.toBeNull();
  });
});
