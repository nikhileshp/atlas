import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/supabase/server";
import { getAsOf } from "@/lib/asof-server";
import { fetchEntityBundle, profileName } from "@/lib/queries";
import { METRICS } from "@/lib/types";
import type { ArtifactRow, DecisionRow, PositionInputRow } from "@/lib/types";
import { AliasAddForm } from "@/components/alias-add-form";
import { ScenarioForm } from "@/components/scenario-form";
import { canWriteResearch as canWriteResearchFor } from "@/lib/roles";

const ALIAS_ORDER = ["legal_name", "ticker", "former_name", "figi", "lei", "internal"] as const;
const ALIAS_LABEL: Record<string, string> = {
  legal_name: "Legal name",
  ticker: "Ticker",
  former_name: "Former names",
  figi: "FIGI",
  lei: "LEI",
  internal: "Internal names",
};

const SCENARIO_STYLE: Record<string, string> = {
  bull: "border-pine text-pine",
  base: "border-rule-strong text-ink-soft",
  bear: "border-oxblood text-oxblood",
  other: "border-rule text-ink-faint",
};

export default async function EntityDetailPage({
  params,
}: PageProps<"/entities/[id]">) {
  const { id } = await params;
  const { supabase, profile } = await requireUser();
  const asOf = await getAsOf();

  const bundle = await fetchEntityBundle(supabase, id, asOf);
  if (!bundle) notFound();

  const {
    entity,
    aliases,
    artifacts,
    scores,
    scoreHistory,
    scenarios,
    positionHistory,
    decisions,
    profiles,
  } = bundle;

  const legalName =
    aliases.find((a) => a.alias_type === "legal_name")?.value ?? "(unnamed)";
  const tickers = aliases.filter((a) => a.alias_type === "ticker").map((a) => a.value);

  const byType = new Map<string, ArtifactRow[]>();
  for (const a of artifacts) {
    byType.set(a.artifact_type, [...(byType.get(a.artifact_type) ?? []), a]);
  }

  const sessions = [...scoreHistory]
    .filter((s) => !s.is_tombstone)
    .sort((a, b) => a.valid_at.localeCompare(b.valid_at));
  const currentScoreIds = new Set(scores.map((s) => s.id));

  // chronological merged timeline of position inputs and decisions
  const timeline: (
    | { kind: "position"; at: string; row: PositionInputRow }
    | { kind: "decision"; at: string; row: DecisionRow }
  )[] = [
    ...positionHistory
      .filter((p) => !p.is_tombstone)
      .map((row) => ({ kind: "position" as const, at: row.valid_at, row })),
    ...decisions.map((row) => ({ kind: "decision" as const, at: row.valid_at, row })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const canWriteResearch = canWriteResearchFor(profile.role);

  return (
    <div className="space-y-10">
      {/* ── identity block ─────────────────────────────────────────────── */}
      <header className="rise rise-1">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="font-display text-4xl text-pine-dark">{legalName}</h1>
          <span className="font-data text-sm text-ink-soft">
            CIK {entity.cik}
            {tickers.length > 0 && <> · {tickers.join(", ")}</>}
          </span>
        </div>
        <div className="rule-double mt-3 mb-4" />
        <div className="grid sm:grid-cols-3 gap-x-8 gap-y-3 text-sm">
          {ALIAS_ORDER.filter((t) => aliases.some((a) => a.alias_type === t)).map((t) => (
            <div key={t}>
              <div className="section-label mb-1">{ALIAS_LABEL[t]}</div>
              <ul className="space-y-0.5">
                {aliases
                  .filter((a) => a.alias_type === t)
                  .map((a) => (
                    <li key={a.id} className={t === "ticker" ? "font-data" : ""}>
                      {a.value}
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
        {profile.role === "admin" && <AliasAddForm entityId={entity.id} />}
      </header>

      {/* ── artifacts ──────────────────────────────────────────────────── */}
      <section className="rise rise-2">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="font-display text-2xl text-pine-dark">Artifacts</h2>
          {canWriteResearch && (
            <Link
              href={`/artifacts/new?entity=${entity.id}`}
              className="text-xs font-data uppercase tracking-wider text-pine hover:underline"
            >
              + Ingest
            </Link>
          )}
        </div>
        {artifacts.length === 0 ? (
          <p className="text-sm text-ink-soft">Nothing attached as of this instant.</p>
        ) : (
          <div className="grid md:grid-cols-2 gap-4">
            {[...byType.entries()].map(([type, rows]) => (
              <div key={type} className="bg-card border border-rule">
                <div className="section-label px-4 py-2 border-b border-rule bg-paper-deep">
                  {type} · {rows.length}
                </div>
                <ul className="divide-y divide-rule">
                  {rows.map((a) => (
                    <li key={a.id} className="px-4 py-2.5 text-sm">
                      <Link
                        href={`/artifacts/${a.id}`}
                        className="font-medium text-pine-dark hover:underline"
                      >
                        {a.title}
                      </Link>
                      <div className="font-data text-xs text-ink-faint mt-0.5">
                        {a.author} · refers to {new Date(a.valid_at).toLocaleDateString()} ·
                        entered {new Date(a.recorded_at).toLocaleDateString()}
                        {a.supersedes && " · rev"}
                      </div>
                      {a.summary && (
                        <p className="text-xs text-ink-soft mt-1 line-clamp-2">{a.summary}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── quality score history ──────────────────────────────────────── */}
      <section className="rise rise-3">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="font-display text-2xl text-pine-dark">Quality scores</h2>
          {canWriteResearch && (
            <Link
              href={`/entities/${entity.id}/score`}
              className="text-xs font-data uppercase tracking-wider text-pine hover:underline"
            >
              + Score {sessions.length > 0 ? "again" : "now"}
            </Link>
          )}
        </div>
        {sessions.length === 0 ? (
          <p className="text-sm text-ink-soft">Not yet scored as of this instant.</p>
        ) : (
          <div className="bg-card border border-rule overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left">
                  <th className="section-label px-4 py-2.5 border-b-2 border-rule-strong">
                    Session
                  </th>
                  {METRICS.map((m) => (
                    <th
                      key={m.key}
                      className="section-label px-3 py-2.5 border-b-2 border-rule-strong text-center"
                    >
                      {m.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sessions.map((s, i) => {
                  const prev = i > 0 ? sessions[i - 1] : null;
                  return (
                    <tr
                      key={s.id}
                      className={`border-b border-rule ${currentScoreIds.has(s.id) ? "" : "opacity-60"}`}
                    >
                      <td className="px-4 py-2.5">
                        <div className="font-data text-xs">
                          {new Date(s.valid_at).toLocaleDateString()}
                        </div>
                        <div className="mt-0.5 flex gap-1.5 items-center flex-wrap">
                          <span
                            className={`text-[10px] font-data uppercase tracking-wider px-1.5 py-0.5 ${
                              s.revision_kind === "change_of_mind"
                                ? "bg-oxblood-wash text-oxblood"
                                : s.revision_kind === "refinement"
                                  ? "bg-timewarp-wash text-timewarp"
                                  : "bg-pine-wash text-pine"
                            }`}
                          >
                            {s.revision_kind === "change_of_mind"
                              ? "changed view"
                              : s.revision_kind}
                          </span>
                          <span className="text-[10px] font-data text-ink-faint">
                            {profileName(profiles, s.created_by)}
                          </span>
                        </div>
                      </td>
                      {METRICS.map((m) => {
                        const v = s[`${m.key}_score`];
                        const pv = prev?.[`${m.key}_score`];
                        const delta = pv === undefined ? 0 : v - pv;
                        return (
                          <td key={m.key} className="px-3 py-2.5 text-center">
                            <span className="font-data text-lg">{v}</span>
                            {delta !== 0 && (
                              <span
                                className={`ml-1 text-xs font-data ${delta > 0 ? "text-pine" : "text-oxblood"}`}
                              >
                                {delta > 0 ? `▲${delta}` : `▼${-delta}`}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="divide-y divide-rule border-t border-rule">
              {sessions.map((s) => (
                <details key={s.id} className="px-4 py-2">
                  <summary className="cursor-pointer text-xs font-data text-ink-soft">
                    {new Date(s.valid_at).toLocaleDateString()} — reasoning &amp; evidence
                  </summary>
                  <dl className="mt-2 space-y-3 pb-2">
                    {METRICS.map((m) => (
                      <div key={m.key}>
                        <dt className="section-label">
                          {m.label} — {s[`${m.key}_score`]}/10
                        </dt>
                        <dd className="text-sm text-ink-soft mt-0.5">
                          {s[`${m.key}_reasoning`]}
                        </dd>
                        <dd className="mt-1 flex gap-2 flex-wrap">
                          {(s[`${m.key}_evidence`] ?? []).map((eid) => {
                            const ev = bundle.artifactHistory.find((a) => a.id === eid);
                            return (
                              <Link
                                key={eid}
                                href={`/artifacts/${eid}`}
                                className="text-xs font-data text-pine hover:underline"
                              >
                                ⎘ {ev?.title ?? "artifact"}
                              </Link>
                            );
                          })}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── scenarios ──────────────────────────────────────────────────── */}
      <section className="rise rise-4">
        <h2 className="font-display text-2xl text-pine-dark mb-3">Scenarios</h2>
        {scenarios.length === 0 && (
          <p className="text-sm text-ink-soft mb-3">No scenarios as of this instant.</p>
        )}
        <div className="grid md:grid-cols-3 gap-4">
          {scenarios.map((s) => (
            <div key={s.id} className={`bg-card border-2 p-4 ${SCENARIO_STYLE[s.scenario_kind]}`}>
              <div className="flex items-baseline justify-between">
                <span className="section-label">{s.scenario_kind}</span>
                {s.probability !== null && (
                  <span className="font-data text-sm">
                    p={Number(s.probability).toFixed(2)}
                  </span>
                )}
              </div>
              <h3 className="font-medium mt-1">{s.title}</h3>
              <p className="text-sm text-ink-soft mt-1">{s.narrative}</p>
            </div>
          ))}
        </div>
        {canWriteResearch && <ScenarioForm entityId={entity.id} />}
      </section>

      {/* ── positions & decisions ──────────────────────────────────────── */}
      <section className="rise rise-5">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="font-display text-2xl text-pine-dark">
            Position inputs &amp; decisions
          </h2>
          <Link
            href={`/entities/${entity.id}/position`}
            className="text-xs font-data uppercase tracking-wider text-pine hover:underline"
          >
            Sizing desk →
          </Link>
        </div>
        {timeline.length === 0 ? (
          <p className="text-sm text-ink-soft">No sizing history as of this instant.</p>
        ) : (
          <ol className="relative border-l-2 border-rule-strong ml-2 space-y-4">
            {timeline.map((item) => (
              <li key={`${item.kind}-${item.row.id}`} className="ml-5">
                <span
                  className={`absolute -left-[7px] mt-1.5 h-3 w-3 rounded-full border-2 border-paper ${
                    item.kind === "decision" ? "bg-oxblood" : "bg-pine"
                  }`}
                />
                <div className="font-data text-xs text-ink-faint">
                  {new Date(item.at).toLocaleDateString()} ·{" "}
                  {profileName(profiles, item.row.created_by)}
                </div>
                {item.kind === "position" ? (
                  <div className="text-sm">
                    <span className="section-label mr-2">input</span>
                    IRR {(Number(item.row.irr) * 100).toFixed(1)}% · skew{" "}
                    {Number(item.row.skew).toFixed(1)}× · conviction {String(item.row.conviction)} ·
                    FCF growth {(Number(item.row.fcf_growth) * 100).toFixed(1)}% ·{" "}
                    <span className="font-data">
                      model {item.row.computed_weight ?? "—"}%
                      {" / "}
                      chosen {item.row.chosen_weight}%
                    </span>
                    {item.row.computed_weight !== null &&
                      Number(item.row.computed_weight) !== Number(item.row.chosen_weight) && (
                        <span className="ml-2 text-[10px] font-data uppercase tracking-wider bg-oxblood-wash text-oxblood px-1.5 py-0.5">
                          override{" "}
                          {Number(item.row.chosen_weight) > Number(item.row.computed_weight)
                            ? "+"
                            : ""}
                          {(
                            Number(item.row.chosen_weight) - Number(item.row.computed_weight)
                          ).toFixed(1)}
                        </span>
                      )}
                  </div>
                ) : (
                  <div className="text-sm">
                    <span className="text-[10px] font-data uppercase tracking-wider bg-oxblood text-paper px-1.5 py-0.5 mr-2">
                      {item.row.decision_type}
                    </span>
                    {item.row.summary}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Out of scope by design: no similarity, no ranking, no auto-scoring. */}
    </div>
  );
}
