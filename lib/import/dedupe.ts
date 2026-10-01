/**
 * Which content hashes already exist as LIVE artifacts in the org (not
 * retracted, not superseded)? Queried by hash, never by loading the artifact
 * table: PostgREST caps a response at 1000 rows, so a full-table read silently
 * stops detecting duplicates once the org has more artifacts than that.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const IN_CHUNK = 100;

export async function liveArtifactsByHash(
  supabase: SupabaseClient,
  hashes: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(hashes)];
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const slice = unique.slice(i, i + IN_CHUNK);
    const { data: candidates, error } = await supabase
      .from("artifact")
      .select("id,content_hash,is_tombstone,recorded_at")
      .in("content_hash", slice)
      .order("recorded_at", { ascending: false });
    if (error) throw new Error(`duplicate lookup: ${error.message}`);
    const rows = (candidates ?? []).filter((r) => !r.is_tombstone);
    if (rows.length === 0) continue;

    const superseded = new Set<string>();
    const ids = rows.map((r) => r.id as string);
    for (let j = 0; j < ids.length; j += IN_CHUNK) {
      const { data: later, error: e2 } = await supabase
        .from("artifact")
        .select("supersedes")
        .in("supersedes", ids.slice(j, j + IN_CHUNK));
      if (e2) throw new Error(`duplicate lookup: ${e2.message}`);
      for (const l of later ?? []) superseded.add(l.supersedes as string);
    }
    for (const r of rows) {
      const h = r.content_hash as string;
      if (!superseded.has(r.id as string) && !out.has(h)) out.set(h, r.id as string);
    }
  }
  return out;
}

/** True when the artifact is still the live head (not retracted, nothing supersedes it). */
export async function isLiveArtifact(supabase: SupabaseClient, artifactId: string): Promise<boolean> {
  const { data: row } = await supabase.from("artifact").select("id,is_tombstone").eq("id", artifactId).maybeSingle();
  if (!row || row.is_tombstone) return false;
  const { count } = await supabase.from("artifact").select("id", { count: "exact", head: true }).eq("supersedes", artifactId);
  return (count ?? 0) === 0;
}

/** Read every row of a query despite the 1000-row response cap. */
export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < pageSize) return out;
  }
}
