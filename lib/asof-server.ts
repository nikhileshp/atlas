import { cookies } from "next/headers";

export const AS_OF_COOKIE = "atlas-as-of";

/**
 * The "as of" instant every view renders against. Default: now.
 * Set via the header control (actions/asof.ts); stored in a cookie so a
 * single control re-renders every list and detail view in the app.
 */
export async function getAsOf(): Promise<Date> {
  const store = await cookies();
  const raw = store.get(AS_OF_COOKIE)?.value;
  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** True when the user has pinned a historical as-of instant. */
export async function isTimeTraveling(): Promise<boolean> {
  const store = await cookies();
  return Boolean(store.get(AS_OF_COOKIE)?.value);
}
