import { createHash } from "node:crypto";

/** sha256 hex digest of a buffer — the artifact content hash. */
export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
