/**
 * Company suggestions for imported items, from the aliases the org already
 * maintains. Tickers: whole word, case-sensitive. Names (legal, former,
 * internal): whole phrase, case-insensitive, >= 3 chars. Title beats body.
 * Pure; the caller supplies alias rows already resolved as-of now.
 */
import type { AliasRow } from "@/lib/types";

interface Entry {
  entityId: string;
  kind: "ticker" | "name";
  value: string;
  re: RegExp;
}

export interface AliasIndex {
  entries: Entry[];
}

const NAME_TYPES = new Set(["legal_name", "former_name", "internal"]);

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildAliasIndex(aliases: AliasRow[]): AliasIndex {
  const entries: Entry[] = [];
  for (const a of aliases) {
    const value = a.value.trim();
    if (a.alias_type === "ticker" && value) {
      entries.push({ entityId: a.entity_id, kind: "ticker", value, re: new RegExp(`(?<![\\w])${escape(value)}(?![\\w])`) });
    } else if (NAME_TYPES.has(a.alias_type) && value.length >= 3) {
      entries.push({ entityId: a.entity_id, kind: "name", value, re: new RegExp(`(?<![\\w])${escape(value)}(?![\\w])`, "i") });
    }
  }
  return { entries };
}

export function suggestEntities(index: AliasIndex, title: string, body: string): string[] {
  const best = new Map<string, { score: number; len: number }>();
  for (const e of index.entries) {
    let score = 0;
    if (e.re.test(title)) score = 2;
    else if (e.re.test(body)) score = 1;
    if (!score) continue;
    const prev = best.get(e.entityId);
    if (!prev || score > prev.score || (score === prev.score && e.value.length > prev.len)) {
      best.set(e.entityId, { score, len: e.value.length });
    }
  }
  return [...best.entries()]
    .sort((a, b) => b[1].score - a[1].score || b[1].len - a[1].len)
    .map(([id]) => id);
}

export function initialStatus(
  suggested: string[],
  duplicateOf: string | null,
): { status: "pending" | "duplicate" | "unmatched"; include: boolean } {
  if (duplicateOf) return { status: "duplicate", include: false };
  if (suggested.length === 0) return { status: "unmatched", include: false };
  return { status: "pending", include: true };
}
