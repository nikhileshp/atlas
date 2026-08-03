import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCompany } from "@/lib/edgar";

/** Company identity detail (names, tickers, former names) from EDGAR submissions. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ cik: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { cik } = await params;
  try {
    const company = await getCompany(cik);
    return NextResponse.json({ company });
  } catch (err) {
    const message = err instanceof Error ? err.message : "EDGAR lookup failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
