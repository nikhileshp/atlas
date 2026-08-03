import Link from "next/link";
import { requireUser } from "@/lib/supabase/server";
import { getAsOf } from "@/lib/asof-server";
import { fetchEntitiesAsOf, fetchAliasesAsOf, identityFromAliases } from "@/lib/queries";

export default async function EntitiesPage() {
  const { supabase, profile } = await requireUser();
  const asOf = await getAsOf();

  const [entities, aliases] = await Promise.all([
    fetchEntitiesAsOf(supabase, asOf),
    fetchAliasesAsOf(supabase, asOf),
  ]);
  const identity = identityFromAliases(aliases);

  return (
    <div className="rise">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="font-display text-3xl text-pine-dark">Coverage</h1>
        {profile.role === "admin" && (
          <Link
            href="/entities/new"
            className="bg-pine text-paper px-4 py-2 text-xs font-data uppercase tracking-wider hover:bg-pine-dark"
          >
            + Add company
          </Link>
        )}
      </div>

      {entities.length === 0 ? (
        <p className="text-ink-soft">
          No companies yet{" "}
          {profile.role === "admin"
            ? "— add one from EDGAR."
            : "— an admin can add them from EDGAR."}
        </p>
      ) : (
        <table className="w-full bg-card border border-rule text-sm">
          <thead>
            <tr className="text-left">
              <th className="section-label px-4 py-2.5 border-b-2 border-rule-strong">Company</th>
              <th className="section-label px-4 py-2.5 border-b-2 border-rule-strong">Ticker</th>
              <th className="section-label px-4 py-2.5 border-b-2 border-rule-strong">CIK</th>
              <th className="section-label px-4 py-2.5 border-b-2 border-rule-strong">Covered since</th>
            </tr>
          </thead>
          <tbody>
            {entities.map((e) => {
              const id = identity.get(e.id);
              return (
                <tr key={e.id} className="border-b border-rule hover:bg-pine-wash/40">
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/entities/${e.id}`}
                      className="font-medium text-pine-dark hover:underline"
                    >
                      {id?.legalName ?? "(unnamed)"}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 font-data">{id?.tickers.join(", ") || "—"}</td>
                  <td className="px-4 py-2.5 font-data text-ink-soft">{e.cik}</td>
                  <td className="px-4 py-2.5 font-data text-ink-soft">
                    {new Date(e.recorded_at).toLocaleDateString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
