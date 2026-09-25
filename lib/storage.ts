import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Object keys are '<org_id>/<uuid>/<file name>'; the storage policies gate on the first segment. */
export function buildStorageKey(orgId: string, fileName: string): string {
  const safe = fileName.replace(/[^\w.\-()+ ]/g, "_");
  return `${orgId}/${randomUUID()}/${safe}`;
}

/**
 * True only for a key this org could have built: exactly three segments,
 * org prefix matches, middle segment is a UUID, no empty or traversal parts.
 * Used by the server before trusting a key the browser sends back.
 */
export function isOwnedStorageKey(key: string, orgId: string): boolean {
  const parts = key.split("/");
  if (parts.length !== 3) return false;
  const [org, id, name] = parts;
  return org === orgId && UUID.test(id) && name.length > 0 && !name.includes("..");
}
