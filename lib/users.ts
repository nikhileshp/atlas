import type { SupabaseClient } from "@supabase/supabase-js";

/** Tables carrying created_by; a user with rows in any of them is an author. */
const AUTHORED_TABLES = [
  "entity",
  "entity_alias",
  "artifact",
  "artifact_entity",
  "quality_score",
  "scenario",
  "position_input",
  "decision",
  // staging, not research — but a batch references its creator, so a user who
  // started one cannot be hard-deleted
  "import_batch",
] as const;

/** Effectively permanent; Supabase Auth bans are expressed as a duration. */
const BAN_FOREVER = "876000h";

export type RemovalOutcome = "deleted" | "revoked";

/**
 * Remove a user from the org. Requires the service-role client.
 *
 * - Authored nothing (a stale invite, a mistaken add): delete the profile and
 *   the auth user outright.
 * - Authored rows: those rows are the firm's record and reference the user,
 *   so the user is banned in Auth and the profile is stamped `removed_at`.
 *   Existing sessions expire on their own (JWT lifetime); requireUser also
 *   refuses a removed profile.
 */
export async function removeUser(
  admin: SupabaseClient,
  userId: string,
): Promise<RemovalOutcome> {
  const authored = await hasAuthoredRows(admin, userId);

  if (!authored) {
    const { error: profileErr } = await admin.from("profile").delete().eq("user_id", userId);
    if (profileErr) throw new Error(`delete profile: ${profileErr.message}`);
    const { error: authErr } = await admin.auth.admin.deleteUser(userId);
    if (authErr) throw new Error(`delete auth user: ${authErr.message}`);
    return "deleted";
  }

  const { error: banErr } = await admin.auth.admin.updateUserById(userId, {
    ban_duration: BAN_FOREVER,
  });
  if (banErr) throw new Error(`ban user: ${banErr.message}`);
  const { error: stampErr } = await admin
    .from("profile")
    .update({ removed_at: new Date().toISOString() })
    .eq("user_id", userId);
  if (stampErr) throw new Error(`stamp profile: ${stampErr.message}`);
  return "revoked";
}

async function hasAuthoredRows(admin: SupabaseClient, userId: string): Promise<boolean> {
  for (const table of AUTHORED_TABLES) {
    const { count, error } = await admin
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("created_by", userId);
    if (error) throw new Error(`count ${table}: ${error.message}`);
    if ((count ?? 0) > 0) return true;
  }
  return false;
}
