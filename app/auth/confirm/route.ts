import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";

/**
 * Lands invite/confirmation links from the local mail catcher. Verifies the
 * OTP token hash, binds the session cookie, then routes invitees to password
 * setup. This is the real Auth email flow, not a stub.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  if (token_hash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) {
      const dest = type === "invite" ? "/auth/set-password" : "/";
      return NextResponse.redirect(new URL(dest, env("SITE_URL")));
    }
  }

  return NextResponse.redirect(new URL("/login?error=invalid_link", env("SITE_URL")));
}
