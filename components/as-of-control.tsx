"use client";

import { useTransition } from "react";
import { setAsOf } from "@/actions/asof";

/**
 * The global bitemporal control. Default is now; pinning a date re-renders
 * every view as the system saw the world at that instant.
 */
export function AsOfControl({ asOfIso, pinned }: { asOfIso: string; pinned: boolean }) {
  const [isPending, startTransition] = useTransition();

  // datetime-local wants "YYYY-MM-DDTHH:mm" in local time
  const local = new Date(asOfIso);
  const pad = (n: number) => String(n).padStart(2, "0");
  const inputValue = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(
    local.getDate(),
  )}T${pad(local.getHours())}:${pad(local.getMinutes())}`;

  return (
    <div className="flex items-center gap-2">
      <span className="section-label whitespace-nowrap">As of</span>
      <input
        type="datetime-local"
        value={inputValue}
        disabled={isPending}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          startTransition(() => setAsOf(new Date(v).toISOString()));
        }}
        className={`border px-2 py-1 font-data text-xs bg-card focus:outline-none ${
          pinned ? "border-timewarp text-timewarp" : "border-rule text-ink-soft"
        }`}
      />
      {pinned && (
        <button
          onClick={() => startTransition(() => setAsOf(null))}
          disabled={isPending}
          className="text-xs font-data uppercase tracking-wide text-timewarp underline decoration-dotted hover:text-ink"
        >
          Now
        </button>
      )}
    </div>
  );
}

/** Amber strip shown app-wide while time-traveling. */
export function TimewarpBanner({ asOfIso }: { asOfIso: string }) {
  const [isPending, startTransition] = useTransition();
  const d = new Date(asOfIso);

  return (
    <div className="bg-timewarp-wash border-y border-timewarp/40 text-timewarp px-6 py-1.5 text-xs font-data flex items-center justify-center gap-3">
      <span>
        ⧗ Viewing the world as Atlas knew it on{" "}
        <strong>{d.toLocaleString()}</strong> — later records are hidden,
        superseded views restored.
      </span>
      <button
        onClick={() => startTransition(() => setAsOf(null))}
        disabled={isPending}
        className="underline decoration-dotted uppercase tracking-wide hover:text-ink"
      >
        Return to now
      </button>
    </div>
  );
}
