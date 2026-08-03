"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";

/**
 * Dev-only user switcher: re-binds the session cookie to another seeded user
 * so RLS behavior across the three roles can be checked without logging out.
 * Hard-gated on NODE_ENV so it cannot ship.
 */
export async function devSwitchUser(email: string): Promise<void> {
  if (process.env.NODE_ENV !== "development") {
    throw new Error("devSwitchUser is available only in development");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password: env("SEED_USER_PASSWORD"),
  });
  if (error) throw new Error(`Dev switch failed: ${error.message}`);

  revalidatePath("/", "layout");
}
