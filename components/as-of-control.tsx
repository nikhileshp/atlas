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
    <div
      className={`flex items-center gap-2 rounded-full border pl-4 pr-1.5 py-1.5 transition-colors ${
        pinned
          ? "bg-timewarp border-timewarp text-white shadow-[0_6px_16px_-6px_var(--color-timewarp)]"
          : "bg-card border-rule"
      }`}
    >
      <span
        className={`text-xs font-medium whitespace-nowrap ${pinned ? "text-white/80" : "text-ink-faint"}`}
      >
        {pinned ? "⧗ As of" : "As of"}
      </span>
      <input
        type="datetime-local"
        value={inputValue}
        disabled={isPending}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          startTransition(() => setAsOf(new Date(v).toISOString()));
        }}
        data-bare
        className={`rounded-full bg-transparent px-2 py-1 font-data text-xs font-medium focus:outline-none ${
          pinned ? "text-white [color-scheme:dark]" : "text-ink"
        }`}
      />
      {pinned && (
        <button
          onClick={() => startTransition(() => setAsOf(null))}
          disabled={isPending}
          className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-timewarp hover:bg-timewarp-wash"
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
    <div className="mx-5 sm:mx-8 mb-2 rounded-2xl bg-timewarp-wash border border-timewarp/30 text-timewarp px-4 py-2.5 text-xs font-data flex flex-wrap items-center justify-between gap-3">
      <span>
        ⧗ Viewing the world as Atlas knew it on{" "}
        <strong>{d.toLocaleString()}</strong> — later records are hidden,
        superseded views restored.
      </span>
      <button
        onClick={() => startTransition(() => setAsOf(null))}
        disabled={isPending}
        className="rounded-full bg-timewarp px-3 py-1 font-semibold text-white hover:bg-ink"
      >
        Return to now
      </button>
    </div>
  );
}
