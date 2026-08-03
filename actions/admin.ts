"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";

export interface InviteFormState {
  error: string | null;
  ok: boolean;
}

/**
 * Invite-only membership. The invite email goes through local Supabase Auth
 * and lands in the mail catcher (http://127.0.0.1:54324) — the real flow,
 * not a stub. The org and role claims ride in app_metadata, which is what
 * every RLS policy keys on.
 */
export async function inviteUser(
  _prev: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const { profile } = await requireUser();
  if (profile.role !== "admin") {
    return { error: "Only admins can invite users.", ok: false };
  }

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const displayName = String(formData.get("display_name") ?? "").trim();
  const role = String(formData.get("role") ?? "");

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "Enter a valid email.", ok: false };
  if (!displayName) return { error: "Display name is required.", ok: false };
  if (!["analyst", "pm", "admin"].includes(role)) return { error: "Pick a role.", ok: false };

  const admin = createAdminClient();

  const { data: invited, error } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${env("SITE_URL")}/auth/confirm`,
  });
  if (error) return { error: error.message, ok: false };

  const userId = invited.user.id;
  const { error: metaError } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: { org_id: profile.org_id, role },
  });
  if (metaError) return { error: metaError.message, ok: false };

  const { error: profileError } = await admin.from("profile").insert({
    user_id: userId,
    org_id: profile.org_id,
    email,
    display_name: displayName,
    role,
  });
  if (profileError) return { error: profileError.message, ok: false };

  revalidatePath("/admin/users");
  return { error: null, ok: true };
}
