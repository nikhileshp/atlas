"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { createEntity, type CreateEntityState } from "@/actions/entities";

interface Match {
  cik: string;
  ticker: string;
  name: string;
}

const initial: CreateEntityState = { error: null };

/**
 * The default path: search EDGAR (proxied through our server — EDGAR sends
 * no CORS headers), pick a match, and the CIK comes back with it. Manual CIK
 * entry is the fallback, not the default.
 */
export function EntitySearch({ canCreate }: { canCreate: boolean }) {
  const [q, setQ] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [state, formAction, pending] = useActionState(createEntity, initial);
  const debounce = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (q.trim().length < 2) {
      setMatches([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const res = await fetch(`/api/edgar/search?q=${encodeURIComponent(q)}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "search failed");
        setMatches(json.matches);
      } catch (e) {
        setSearchError(e instanceof Error ? e.message : "EDGAR search failed");
        setMatches([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  }, [q]);

  return (
    <div className="space-y-8">
      <div>
        <label className="block mb-2">
          <span className="section-label">Search SEC EDGAR</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Company name or ticker — e.g. “costco” or “V”"
            autoFocus
            className="mt-1 w-full border border-rule bg-card px-4 py-3 text-base focus:outline-none focus:border-pine"
          />
        </label>
        {searching && <p className="text-xs font-data text-ink-faint">searching EDGAR…</p>}
        {searchError && <p className="text-sm text-oxblood">{searchError}</p>}

        {matches.length > 0 && (
          <ul className="border border-rule divide-y divide-rule bg-card">
            {matches.map((m) => (
              <li key={m.cik} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <span className="font-medium">{m.name}</span>{" "}
                  <span className="font-data text-xs text-ink-soft">
                    {m.ticker} · CIK {m.cik}
                  </span>
                </div>
                {canCreate && (
                  <form action={formAction}>
                    <input type="hidden" name="cik" value={m.cik} />
                    <button
                      disabled={pending}
                      className="bg-pine text-paper px-3 py-1.5 text-xs font-data uppercase tracking-wider hover:bg-pine-dark disabled:opacity-60"
                    >
                      {pending ? "Adding…" : "Add"}
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {canCreate && (
        <details className="border border-rule bg-paper-deep px-4 py-3">
          <summary className="section-label cursor-pointer">
            Fallback: enter a CIK manually
          </summary>
          <form action={formAction} className="mt-3 flex gap-2">
            <input
              name="cik"
              placeholder="e.g. 320193"
              pattern="[0-9]{1,10}"
              className="border border-rule bg-card px-3 py-2 font-data text-sm focus:outline-none focus:border-pine"
            />
            <button
              disabled={pending}
              className="bg-pine text-paper px-4 py-2 text-xs font-data uppercase tracking-wider hover:bg-pine-dark disabled:opacity-60"
            >
              Add by CIK
            </button>
          </form>
        </details>
      )}

      {state.error && (
        <p className="text-sm text-oxblood bg-oxblood-wash border border-oxblood/30 px-3 py-2">
          {state.error}
        </p>
      )}
      {!canCreate && (
        <p className="text-sm text-ink-soft border border-rule bg-paper-deep px-4 py-3">
          Entity records are managed by admins. You can search, but adding a
          company requires the admin role (row-level security enforces this
          below the UI as well).
        </p>
      )}
    </div>
  );
}
