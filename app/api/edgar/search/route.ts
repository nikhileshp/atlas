import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { searchCompanies } from "@/lib/edgar";

/**
 * Server-side EDGAR company search. Exists because EDGAR sends no permissive
 * CORS headers — the browser can only talk to our own origin. Responses are
 * disk-cached (lib/edgar.ts) so UI iteration does not hammer the SEC.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const q = new URL(request.url).searchParams.get("q") ?? "";
  try {
    const matches = await searchCompanies(q);
    return NextResponse.json({ matches });
  } catch (err) {
    const message = err instanceof Error ? err.message : "EDGAR lookup failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
