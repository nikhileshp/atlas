// Bitemporal resolution. Every research row carries:
//   recorded_at  — when the system learned the fact (transaction time)
//   supersedes   — the prior version this row replaces
//   is_tombstone — this row retracts what it supersedes
// resolveAsOf answers: "what did the system believe at time asOf?"

export interface VersionedRow {
  id: string;
  recorded_at: string;
  supersedes: string | null;
  is_tombstone: boolean;
}

/**
 * Rows visible as of `asOf`: recorded by then, not superseded by another row
 * that was also recorded by then, and not tombstones. Preserves input order.
 */
export function resolveAsOf<T extends VersionedRow>(rows: T[], asOf: Date): T[] {
  const visible = rows.filter((r) => new Date(r.recorded_at) <= asOf);
  const superseded = new Set(
    visible.map((r) => r.supersedes).filter((s): s is string => s !== null),
  );
  return visible.filter((r) => !superseded.has(r.id) && !r.is_tombstone);
}

/**
 * Full history of one logical fact: the head row followed by each row it
 * (transitively) supersedes, newest first.
 */
export function versionChain<T extends VersionedRow>(rows: T[], headId: string): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const chain: T[] = [];
  let cursor = byId.get(headId);
  while (cursor) {
    chain.push(cursor);
    cursor = cursor.supersedes ? byId.get(cursor.supersedes) : undefined;
  }
  return chain;
}
