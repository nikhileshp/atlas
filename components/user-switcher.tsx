"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { devSwitchUser } from "@/actions/dev";
import type { Profile } from "@/lib/types";

/**
 * Dev-only role switcher. Rendered exclusively when NODE_ENV === "development"
 * (the server layout gates it), so it cannot ship. Lets RLS behavior be
 * checked across analyst / pm / admin without logging out.
 */
export function UserSwitcher({
  profiles,
  currentEmail,
}: {
  profiles: Pick<Profile, "email" | "display_name" | "role">[];
  currentEmail: string;
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <label className="flex items-center gap-1.5 rounded-full border border-dashed border-oxblood/50 bg-oxblood-wash px-3 py-1.5">
      <span className="text-[11px] font-medium text-oxblood">
        dev · view as
      </span>
      <select
        value={currentEmail}
        disabled={isPending}
        onChange={(e) =>
          startTransition(async () => {
            await devSwitchUser(e.target.value);
            router.refresh();
          })
        }
        data-bare
        className="bg-transparent font-data text-xs text-oxblood focus:outline-none"
      >
        {profiles.map((p) => (
          <option key={p.email} value={p.email}>
            {p.display_name} ({p.role})
          </option>
        ))}
      </select>
    </label>
  );
}
