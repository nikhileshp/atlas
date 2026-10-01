"use client";

import { usePathname } from "next/navigation";

/** Sections whose nav link is not simply "/<first segment>". */
const SECTION_HOME: Record<string, string> = {
  "": "/",
  entities: "/",
  artifacts: "/artifacts/new",
  admin: "/admin/users",
};

function activeHref(pathname: string): string | null {
  if (pathname === "/entities/new") return pathname;
  const section = pathname.split("/")[1] ?? "";
  if (section in SECTION_HOME) return SECTION_HOME[section];
  return /^[a-z0-9-]+$/i.test(section) ? `/${section}` : null;
}

/**
 * Presentational only: marks the sidebar link for the current section as
 * active. The nav stays a plain list of <Link>s in the server layout; this
 * emits one CSS rule that sets the --nav-* properties `.app-nav a` reads
 * (see globals.css), so adding a link needs no change here.
 */
export function NavActive() {
  const href = activeHref(usePathname());
  if (!href) return null;
  return (
    <style>{`.app-nav a[href="${href}"]{--nav-chip:var(--color-pine);--nav-icon:#fff;--nav-ink:var(--color-ink);--nav-weight:600}`}</style>
  );
}
