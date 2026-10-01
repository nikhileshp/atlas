/**
 * The export is uploaded as one Storage object, so it is bound by the
 * bucket's per-file limit (50 MiB on the current plan; supabase/config.toml
 * file_size_limit). Checked in the browser before uploading so the user gets
 * a clear instruction instead of a bare 413.
 */
export const MAX_EXPORT_BYTES = 50 * 1024 * 1024;

export function exportTooLarge(bytes: number): boolean {
  return bytes > MAX_EXPORT_BYTES;
}
