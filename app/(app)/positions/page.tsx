import Link from "next/link";
import { requireUser } from "@/lib/supabase/server";
import { getAsOf } from "@/lib/asof-server";
import { resolveAsOf } from "@/lib/asof";
import {
  fetchAliasesAsOf,
  fetchEntitiesAsOf,
  identityFromAliases,
} from "@/lib/queries";
import type { DecisionRow, PositionInputRow } from "@/lib/types";

/**
 * The portfolio-wide sizing register — the screen that replaces the
 * spreadsheet that overwrote itself. One row per entity with position
 * history; the current head as of the pinned instant; model vs chosen
 * always side by side.
 */
export default async function PositionsPage() {
  const { supabase } = await requireUser();
  const asOf = await getAsOf();

  const [entities, aliases, positionsRes, decisionsRes] = await Promise.all([
    fetchEntitiesAsOf(supabase, asOf),
    fetchAliasesAsOf(supabase, asOf),
    supabase.from("position_input").select("*").order("recorded_at"),
    supabase.from("decision").select("*").order("recorded_at"),
  ]);
  const identity = identityFromAliases(aliases);

  const allPositions = ((positionsRes.data ?? []) as PositionInputRow[]).filter(
    (p) => new Date(p.recorded_at) <= asOf,
  );
  const currentPositions = resolveAsOf(allPositions, asOf);
  const currentDecisions = resolveAsOf(
    ((decisionsRes.data ?? []) as DecisionRow[]).filter(
      (d) => new Date(d.recorded_at) <= asOf,
    ),
    asOf,
  );

  const rows = entities
    .map((e) => {
      const head = currentPositions.find((p) => p.entity_id === e.id);
      if (!head) return null;
      const inputCount = allPositions.filter((p) => p.entity_id === e.id).length;
      const lastDecision = [...currentDecisions]
        .filter((d) => d.entity_id === e.id)
        .sort((a, b) => b.valid_at.localeCompare(a.valid_at))[0];
      return { entity: e, head, inputCount, lastDecision };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => Number(b.head.chosen_weight) - Number(a.head.chosen_weight));

  const totalChosen = rows.reduce((s, r) => s + Number(r.head.chosen_weight), 0);

  return (
    <div className="rise">
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="font-display text-3xl text-pine-dark">Positions</h1>
        <span className="font-data text-sm text-ink-soft">
          Σ chosen {totalChosen.toFixed(1)}%
        </span>
      </div>
      <p className="text-sm text-ink-soft mb-6">
        Every save is a new row; the spreadsheet that overwrote itself ends
        here. Model and chosen weights are stored separately — the divergence
        column is the record of human judgment.
      </p>

      {rows.length === 0 ? (
        <p className="text-sm text-ink-soft">No positions as of this instant.</p>
      ) : (
        <div className="bg-card border border-rule overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left">
                {["Company", "IRR", "Skew", "Conviction", "FCF gr.", "Model wt", "Chosen wt", "Δ", "Inputs", "Last decision"].map(
                  (h) => (
                    <th
                      key={h}
                      className="section-label px-3 py-2.5 border-b-2 border-rule-strong whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ entity, head, inputCount, lastDecision }) => {
                const id = identity.get(entity.id);
                const delta =
                  head.computed_weight === null
                    ? null
                    : Number(head.chosen_weight) - Number(head.computed_weight);
                return (
                  <tr key={entity.id} className="border-b border-rule hover:bg-pine-wash/40">
                    <td className="px-3 py-2.5">
                      <Link
                        href={`/entities/${entity.id}/position`}
                        className="font-medium text-pine-dark hover:underline"
                      >
                        {id?.legalName ?? entity.cik}
                      </Link>{" "}
                      <span className="font-data text-xs text-ink-faint">
                        {id?.tickers[0] ?? ""}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-data">
                      {(Number(head.irr) * 100).toFixed(1)}%
                    </td>
                    <td className="px-3 py-2.5 font-data">{Number(head.skew).toFixed(1)}×</td>
                    <td className="px-3 py-2.5 font-data">{String(head.conviction)}</td>
                    <td className="px-3 py-2.5 font-data">
                      {(Number(head.fcf_growth) * 100).toFixed(1)}%
                    </td>
                    <td className="px-3 py-2.5 font-data">
                      {head.computed_weight === null ? "—" : `${head.computed_weight}%`}
                    </td>
                    <td className="px-3 py-2.5 font-data font-semibold">
                      {head.chosen_weight}%
                    </td>
                    <td className="px-3 py-2.5 font-data">
                      {delta !== null && delta !== 0 ? (
                        <span className="bg-oxblood-wash text-oxblood px-1.5 py-0.5 text-xs">
                          {delta > 0 ? "+" : ""}
                          {delta.toFixed(1)}
                        </span>
                      ) : delta === 0 ? (
                        <span className="text-ink-faint text-xs">0</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-data text-ink-soft">{inputCount}</td>
                    <td className="px-3 py-2.5 text-xs text-ink-soft">
                      {lastDecision ? (
                        <>
                          <span className="font-data uppercase">{lastDecision.decision_type}</span>{" "}
                          {new Date(lastDecision.valid_at).toLocaleDateString()}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
