import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/supabase/server";
import { getAsOf } from "@/lib/asof-server";
import { fetchEntityBundle, fetchEntityBundleNow, profileName } from "@/lib/queries";
import { PositionForm } from "@/components/position-form";
import { DecisionForm } from "@/components/decision-form";

export default async function PositionPage({
  params,
}: PageProps<"/entities/[id]/position">) {
  const { id } = await params;
  const { supabase, profile } = await requireUser();
  const asOf = await getAsOf();

  const bundle = await fetchEntityBundle(supabase, id, asOf);
  if (!bundle) notFound();

  const legalName =
    bundle.aliases.find((a) => a.alias_type === "legal_name")?.value ?? "(unnamed)";

  // Writing always happens against the present state, regardless of the
  // pinned reading instant — so basis rows come from a fresh "now" resolve.
  const nowBundle = await fetchEntityBundleNow(supabase, id);
  const basisPosition = nowBundle?.positions[0] ?? null;
  const basisScore = nowBundle?.scores[0] ?? null;

  const isPm = profile.role === "pm";
  const history = [...bundle.positionHistory]
    .filter((p) => !p.is_tombstone)
    .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));

  return (
    <div className="space-y-8 rise">
      <header>
        <div className="section-label mb-1">Sizing desk</div>
        <h1 className="font-display text-3xl text-pine-dark">
          {legalName}
          <Link
            href={`/entities/${id}`}
            className="ml-3 text-sm font-body text-pine align-middle hover:underline"
          >
            ← entity page
          </Link>
        </h1>
        <div className="rule-double mt-3" />
      </header>

      {isPm ? (
        <PositionForm entityId={id} />
      ) : (
        <p className="text-sm text-ink-soft border border-rule bg-paper-deep px-4 py-3">
          Position inputs are written by the PM. Your role ({profile.role}) has
          read access to the full history below.
        </p>
      )}

      {/* full prior-input history, inline — how the view has moved */}
      <section>
        <h2 className="font-display text-2xl text-pine-dark mb-3">
          Input history
          <span className="ml-2 text-sm font-body text-ink-faint">
            every row kept; nothing overwritten
          </span>
        </h2>
        {history.length === 0 ? (
          <p className="text-sm text-ink-soft">No inputs as of this instant.</p>
        ) : (
          <div className="bg-card border border-rule overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left">
                  {["When", "IRR", "Skew", "Conviction", "FCF growth", "Model wt", "Chosen wt", "Δ", "By"].map(
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
              <tbody className="font-data">
                {history.map((p, i) => {
                  const delta =
                    p.computed_weight === null
                      ? null
                      : Number(p.chosen_weight) - Number(p.computed_weight);
                  return (
                    <tr
                      key={p.id}
                      className={`border-b border-rule ${i === 0 ? "" : "text-ink-soft"}`}
                    >
                      <td className="px-3 py-2 whitespace-nowrap">
                        {new Date(p.valid_at).toLocaleDateString()}
                        {i === 0 && (
                          <span className="ml-1.5 text-[10px] uppercase tracking-wider bg-pine-wash text-pine px-1 py-0.5">
                            current
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">{(Number(p.irr) * 100).toFixed(1)}%</td>
                      <td className="px-3 py-2">{Number(p.skew).toFixed(1)}×</td>
                      <td className="px-3 py-2">{String(p.conviction)}</td>
                      <td className="px-3 py-2">{(Number(p.fcf_growth) * 100).toFixed(1)}%</td>
                      <td className="px-3 py-2">
                        {p.computed_weight === null ? "—" : `${p.computed_weight}%`}
                      </td>
                      <td className="px-3 py-2 font-semibold">{p.chosen_weight}%</td>
                      <td className="px-3 py-2">
                        {delta !== null && delta !== 0 ? (
                          <span className="text-oxblood">
                            {delta > 0 ? "+" : ""}
                            {delta.toFixed(1)}
                          </span>
                        ) : delta === 0 ? (
                          <span className="text-ink-faint">0</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2 font-body text-xs">
                        {profileName(bundle.profiles, p.created_by)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {history.some((p) => p.rationale) && (
              <div className="divide-y divide-rule border-t border-rule">
                {history
                  .filter((p) => p.rationale)
                  .map((p) => (
                    <div key={p.id} className="px-4 py-2 text-xs">
                      <span className="font-data text-ink-faint mr-2">
                        {new Date(p.valid_at).toLocaleDateString()}
                      </span>
                      <span className="text-ink-soft">{p.rationale}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* decisions */}
      <section>
        <h2 className="font-display text-2xl text-pine-dark mb-3">Decisions</h2>
        {isPm && (
          <div className="mb-4">
            <DecisionForm
              entityId={id}
              basisPosition={basisPosition}
              basisScore={basisScore}
            />
          </div>
        )}
        {bundle.decisions.length === 0 ? (
          <p className="text-sm text-ink-soft">No decisions as of this instant.</p>
        ) : (
          <ul className="space-y-2">
            {[...bundle.decisions]
              .sort((a, b) => b.valid_at.localeCompare(a.valid_at))
              .map((d) => {
                const basis = bundle.positionHistory.find(
                  (p) => p.id === d.position_input_id,
                );
                return (
                  <li key={d.id} className="bg-card border border-rule px-4 py-3 text-sm">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-[10px] font-data uppercase tracking-wider bg-oxblood text-paper px-1.5 py-0.5">
                        {d.decision_type}
                      </span>
                      <span className="font-data text-xs text-ink-faint">
                        {new Date(d.valid_at).toLocaleDateString()} ·{" "}
                        {profileName(bundle.profiles, d.created_by)}
                      </span>
                    </div>
                    <p className="mt-1">{d.summary}</p>
                    <p className="font-data text-[11px] text-ink-faint mt-1">
                      basis: position_input {d.position_input_id.slice(0, 8)}…
                      {basis &&
                        ` (model ${basis.computed_weight ?? "—"}% / chosen ${basis.chosen_weight}%)`}
                      {d.quality_score_id &&
                        ` · quality_score ${d.quality_score_id.slice(0, 8)}…`}
                    </p>
                  </li>
                );
              })}
          </ul>
        )}
      </section>
    </div>
  );
}
