import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import type { Profile } from "@/lib/types";

/** Cookie-bound Supabase client carrying the signed-in user's JWT. */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    env("NEXT_PUBLIC_SUPABASE_URL"),
    env("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component: cookie writes are handled by
            // the middleware session refresh instead.
          }
        },
      },
    },
  );
}

/** Resolve the signed-in user and their profile, or bounce to /login. */
export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profile")
    .select("*")
    .eq("user_id", user.id)
    .single();
  if (!profile) redirect("/login");

  return { supabase, user, profile: profile as Profile };
}
