const KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "SITE_URL",
  "SUPABASE_STORAGE_BUCKET",
  "EDGAR_BASE_URL",
  "EDGAR_DATA_BASE_URL",
  "EDGAR_USER_AGENT",
  "EDGAR_CACHE_DIR",
  "SEED_USER_PASSWORD",
] as const;

export type EnvKey = (typeof KEYS)[number];

/** Read a required environment variable; throws if unset or empty. */
export function env(name: EnvKey): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}
