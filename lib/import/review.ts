import type { ArtifactType } from "@/lib/types";

const TYPES: ReadonlySet<string> = new Set(["note", "model", "primer", "thesis", "filing", "transcript", "other"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ItemPatch {
  include?: boolean;
  chosen_entity_ids?: string[];
  artifact_type?: ArtifactType;
}

/**
 * The only fields a reviewer may change on a staged item. Server Actions are
 * callable with arbitrary arguments, so the patch is rebuilt from a whitelist
 * rather than passed through: status, storage_key, content_hash, batch_id and
 * the rest are never client-settable.
 */
export function sanitizeItemPatch(input: unknown): { patch: ItemPatch; error: null } | { patch: null; error: string } {
  const src = (input ?? {}) as Record<string, unknown>;
  const patch: ItemPatch = {};

  if ("include" in src) {
    if (typeof src.include !== "boolean") return { patch: null, error: "include must be true or false." };
    patch.include = src.include;
  }
  if ("artifact_type" in src) {
    if (typeof src.artifact_type !== "string" || !TYPES.has(src.artifact_type)) {
      return { patch: null, error: "Unknown artifact type." };
    }
    patch.artifact_type = src.artifact_type as ArtifactType;
  }
  if ("chosen_entity_ids" in src) {
    const ids = src.chosen_entity_ids;
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string" || !UUID.test(x))) {
      return { patch: null, error: "Invalid company selection." };
    }
    patch.chosen_entity_ids = [...new Set(ids as string[])];
  }
  if (Object.keys(patch).length === 0) return { patch: null, error: "Nothing to change." };
  return { patch, error: null };
}
