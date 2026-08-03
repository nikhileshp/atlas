import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/**
 * Service-role client. Server-only infrastructure (user invites, seeding).
 * Never import from a client component; never use for ordinary app writes —
 * those go through the user's own JWT so RLS and attribution hold.
 */
export function createAdminClient() {
  return createSupabaseClient(
    env("NEXT_PUBLIC_SUPABASE_URL"),
    env("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
