import Link from "next/link";
import { requireUser } from "@/lib/supabase/server";
import { getAsOf, isTimeTraveling } from "@/lib/asof-server";
import { AsOfControl, TimewarpBanner } from "@/components/as-of-control";
import { UserSwitcher } from "@/components/user-switcher";
import { signOut } from "@/actions/auth";
import type { Profile } from "@/lib/types";

const ROLE_STYLE: Record<string, string> = {
  analyst: "bg-pine-wash text-pine",
  pm: "bg-timewarp-wash text-timewarp",
  admin: "bg-oxblood-wash text-oxblood",
};

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { supabase, profile } = await requireUser();
  const asOf = await getAsOf();
  const pinned = await isTimeTraveling();

  const { data: org } = await supabase
    .from("org")
    .select("name")
    .eq("id", profile.org_id)
    .single();

  // dev switcher data — only fetched and only rendered in development
  let devProfiles: Pick<Profile, "email" | "display_name" | "role">[] = [];
  if (process.env.NODE_ENV === "development") {
    const { data } = await supabase
      .from("profile")
      .select("email, display_name, role")
      .order("role");
    devProfiles = data ?? [];
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-card border-b border-rule-strong">
        <div className="max-w-7xl mx-auto px-6 pt-4 pb-3">
          <div className="flex items-baseline justify-between gap-6 flex-wrap">
            <div className="flex items-baseline gap-4">
              <Link href="/" className="font-display text-3xl tracking-tight text-pine-dark">
                Atlas
              </Link>
              <span className="section-label hidden sm:inline">
                {org?.name ?? "—"}
              </span>
            </div>
            <div className="flex items-center gap-4 flex-wrap">
              <AsOfControl asOfIso={asOf.toISOString()} pinned={pinned} />
              <span
                className={`px-2 py-0.5 text-[11px] font-data uppercase tracking-wider ${ROLE_STYLE[profile.role]}`}
                title={profile.email}
              >
                {profile.display_name} · {profile.role}
              </span>
              {process.env.NODE_ENV === "development" && devProfiles.length > 0 && (
                <UserSwitcher profiles={devProfiles} currentEmail={profile.email} />
              )}
              <form action={signOut}>
                <button className="text-xs font-data uppercase tracking-wide text-ink-faint hover:text-oxblood">
                  Sign out
                </button>
              </form>
            </div>
          </div>
          <nav className="mt-3 flex gap-6 text-xs font-data uppercase tracking-[0.14em] text-ink-soft">
            <Link href="/" className="hover:text-pine-dark">Entities</Link>
            <Link href="/positions" className="hover:text-pine-dark">Positions</Link>
            <Link href="/artifacts/new" className="hover:text-pine-dark">Ingest</Link>
            {profile.role === "admin" && (
              <>
                <Link href="/entities/new" className="hover:text-pine-dark">Add company</Link>
                <Link href="/admin/users" className="hover:text-pine-dark">Users</Link>
              </>
            )}
          </nav>
        </div>
        <div className="rule-double" />
      </header>

      {pinned && <TimewarpBanner asOfIso={asOf.toISOString()} />}

      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8">{children}</main>

      <footer className="border-t border-rule px-6 py-3 text-center text-[11px] font-data text-ink-faint">
        Append-only · every row remembered · CIK-spined
      </footer>
    </div>
  );
}
