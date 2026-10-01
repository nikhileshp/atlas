import Link from "next/link";
import { requireUser } from "@/lib/supabase/server";
import { getAsOf, isTimeTraveling } from "@/lib/asof-server";
import { AsOfControl, TimewarpBanner } from "@/components/as-of-control";
import { UserSwitcher } from "@/components/user-switcher";
import { NavActive } from "@/components/nav-active";
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
    <div className="min-h-screen flex flex-col lg:flex-row gap-3 p-3 lg:gap-0 lg:p-4">
      <aside className="lg:w-60 lg:shrink-0 flex flex-col gap-3 lg:gap-8 lg:px-3 lg:py-5 lg:sticky lg:top-4 lg:h-[calc(100vh-2rem)]">
        <Link href="/" className="flex items-center gap-3 px-1">
          <span className="grid place-items-center h-9 w-9 rounded-xl bg-pine text-paper">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 19 12 5l7 14M8.2 13.5h7.6" />
            </svg>
          </span>
          <span className="font-display text-2xl font-medium tracking-tight text-ink">
            Atlas
          </span>
        </Link>

        <nav className="app-nav overflow-x-auto lg:overflow-visible">
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
        <NavActive />

        <div className="hidden lg:block mt-auto rounded-2xl bg-ink/[0.06] px-4 py-5 text-center">
          <div className="section-label">Organization</div>
          <div className="font-display text-lg font-medium leading-snug text-ink mt-1">
            {org?.name ?? "—"}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            Append-only · every row remembered · CIK-spined
          </p>
          <form action={signOut} className="mt-4">
            <button className="w-full bg-ink text-paper py-2.5 hover:bg-pine-dark">
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="app-main flex-1 min-w-0 flex flex-col bg-surface rounded-[1.75rem] shadow-[0_1px_2px_rgb(23_24_28/0.04)]">
        <header className="flex items-center justify-between gap-4 flex-wrap px-5 sm:px-8 pt-5 pb-4">
          <AsOfControl asOfIso={asOf.toISOString()} pinned={pinned} />
          <div className="flex items-center gap-3 flex-wrap">
            {process.env.NODE_ENV === "development" && devProfiles.length > 0 && (
              <UserSwitcher profiles={devProfiles} currentEmail={profile.email} />
            )}
            <div className="flex items-center gap-2.5" title={profile.email}>
              <span className="grid place-items-center h-9 w-9 rounded-full bg-pine-dark text-paper text-sm font-semibold">
                {profile.display_name.trim().charAt(0).toUpperCase()}
              </span>
              <span className="text-sm font-medium text-ink">{profile.display_name}</span>
              <span
                className={`px-2 py-0.5 text-[11px] font-data uppercase tracking-wider ${ROLE_STYLE[profile.role]}`}
              >
                {profile.role}
              </span>
            </div>
            <form action={signOut} className="lg:hidden">
              <button className="text-xs font-medium text-ink-faint hover:text-oxblood">
                Sign out
              </button>
            </form>
          </div>
        </header>

        {pinned && <TimewarpBanner asOfIso={asOf.toISOString()} />}

        <main className="flex-1 w-full max-w-6xl px-5 sm:px-8 pt-4 pb-10">{children}</main>
      </div>
    </div>
  );
}
