import type { Role } from "@/lib/types";

/**
 * Role capabilities, mirrored from the RLS policies in supabase/migrations.
 * The database is the enforcement point; these only decide what the UI shows.
 * Admin is a superset of pm (migration 20260925000004_admin_superset.sql).
 */
export function canWriteResearch(role: Role): boolean {
  return role === "analyst" || role === "pm" || role === "admin";
}

export function canWritePositions(role: Role): boolean {
  return role === "pm" || role === "admin";
}
