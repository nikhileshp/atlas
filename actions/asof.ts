"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { AS_OF_COOKIE } from "@/lib/asof-server";

/** Pin (or clear, with null) the global "as of" instant. */
export async function setAsOf(iso: string | null): Promise<void> {
  const store = await cookies();
  if (iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return;
    store.set(AS_OF_COOKIE, d.toISOString(), { path: "/" });
  } else {
    store.delete(AS_OF_COOKIE);
  }
  revalidatePath("/", "layout");
}
