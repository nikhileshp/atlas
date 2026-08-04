"use client";

import { useState, useTransition } from "react";
import { createQualityScore, type ScoreMetricInput } from "@/actions/scores";
import { METRICS, type MetricKey, type QualityScoreRow } from "@/lib/types";

interface EvidenceOption {
  id: string;
  label: string;
}

type Draft = Record<MetricKey, ScoreMetricInput>;

const emptyDraft = (): Draft =>
  Object.fromEntries(
    METRICS.map((m) => [m.key, { score: 0, reasoning: "", evidence: [] }]),
  ) as unknown as Draft;

/**
 * The five metrics are a causal chain, not five sliders on one screen:
 * management stewards allocation → pricing power sources the moat → the moat
 * sustains ROIIC → the balance sheet governs fundability → growth durability
 * is the conclusion. The wizard walks that order, shows what was entered
 * upstream, refuses to advance without evidence, and — when a prior session
 * exists — shows the previous view beside each section and requires marking
 * the new one as refinement or change of mind.
 */
export function ScoreWizard({
  entityId,
  entityName,
  evidence,
  prior,
}: {
  entityId: string;
  entityName: string;
  evidence: EvidenceOption[];
  prior: QualityScoreRow | null;
}) {
  const [step, setStep] = useState(0); // 0..4 metrics, 5 = review
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [revisionKind, setRevisionKind] = useState<"refinement" | "change_of_mind" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const metric = step < METRICS.length ? METRICS[step] : null;
  const current = metric ? draft[metric.key] : null;

  const sectionComplete = (key: MetricKey) => {
    const m = draft[key];
    return m.score >= 1 && m.reasoning.trim().length > 0 && m.evidence.length >= 1;
  };

  const patch = (key: MetricKey, p: Partial<ScoreMetricInput>) =>
    setDraft((d) => ({ ...d, [key]: { ...d[key], ...p } }));

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const result = await createQualityScore({
        entityId,
        revisionKind,
        metrics: draft,
      });
      if (result?.error) setError(result.error);
      // on success the action redirects
    });

  return (
    <div className="grid lg:grid-cols-[240px_1fr] gap-6">
      {/* upstream rail: the chain so far */}
      <aside className="space-y-1">
        <div className="section-label mb-2">Causal chain</div>
        {METRICS.map((m, i) => (
          <button
            key={m.key}
            onClick={() => i <= step && setStep(i)}
            disabled={i > step}
            className={`w-full text-left border px-3 py-2 text-sm ${
              i === step
                ? "border-pine bg-pine-wash"
                : sectionComplete(m.key)
                  ? "border-rule bg-card"
                  : "border-rule bg-paper-deep text-ink-faint"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs">{m.label}</span>
              {sectionComplete(m.key) && (
                <span className="font-data text-base text-pine">{draft[m.key].score}</span>
              )}
            </div>
            {sectionComplete(m.key) && (
              <p className="text-[11px] text-ink-soft mt-0.5 line-clamp-2">
                {draft[m.key].reasoning}
              </p>
            )}
          </button>
        ))}
        <button
          onClick={() => setStep(5)}
          disabled={!METRICS.every((m) => sectionComplete(m.key))}
          className={`w-full text-left border px-3 py-2 text-sm ${
            step === 5 ? "border-pine bg-pine-wash" : "border-rule bg-paper-deep"
          } disabled:text-ink-faint`}
        >
          <span className="text-xs">Review &amp; record</span>
        </button>
      </aside>

      {/* active section */}
      <div className="bg-card border border-rule p-6">
        {metric && current && (
          <>
            <div className="section-label">
              Section {step + 1} of 5 — {entityName}
            </div>
            <h2 className="font-display text-2xl text-pine-dark mt-1">{metric.label}</h2>
            <p className="text-sm text-ink-soft mt-1 mb-5 italic">{metric.rationale}</p>

            {prior && (
              <div className="mb-5 border border-timewarp/40 bg-timewarp-wash px-4 py-3">
                <div className="section-label text-timewarp">
                  Previous view — {new Date(prior.valid_at).toLocaleDateString()} ·{" "}
                  {prior[`${metric.key}_score`]}/10
                </div>
                <p className="text-sm text-ink-soft mt-1">
                  {prior[`${metric.key}_reasoning`]}
                </p>
              </div>
            )}

            <div className="mb-5">
              <div className="section-label mb-1.5">Score</div>
              <div className="flex gap-1">
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    onClick={() => patch(metric.key, { score: n })}
                    className={`w-9 h-9 border font-data text-sm ${
                      current.score === n
                        ? "bg-pine text-paper border-pine"
                        : "bg-paper border-rule hover:border-pine"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <label className="block mb-5">
              <span className="section-label">Reasoning</span>
              <textarea
                value={current.reasoning}
                onChange={(e) => patch(metric.key, { reasoning: e.target.value })}
                rows={4}
                placeholder="Why this score — the argument, not just the number."
                className="mt-1 w-full border border-rule bg-paper px-3 py-2 text-sm focus:outline-none focus:border-pine"
              />
            </label>

            <fieldset className="mb-6">
              <div className="section-label mb-1.5">
                Supporting artifacts — at least one required
              </div>
              {evidence.length === 0 ? (
                <p className="text-sm text-oxblood">
                  No artifacts are attached to this company yet. Ingest evidence
                  first — a score with no evidence pointer is not accepted.
                </p>
              ) : (
                <div className="space-y-1 max-h-44 overflow-y-auto border border-rule bg-paper px-3 py-2">
                  {evidence.map((ev) => (
                    <label key={ev.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={current.evidence.includes(ev.id)}
                        onChange={(e) =>
                          patch(metric.key, {
                            evidence: e.target.checked
                              ? [...current.evidence, ev.id]
                              : current.evidence.filter((x) => x !== ev.id),
                          })
                        }
                        className="accent-[var(--color-pine)]"
                      />
                      {ev.label}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>

            <div className="flex justify-between">
              <button
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                disabled={step === 0}
                className="text-xs font-data uppercase tracking-wider text-ink-soft disabled:opacity-40"
              >
                ← Back
              </button>
              <button
                onClick={() => setStep((s) => s + 1)}
                disabled={!sectionComplete(metric.key)}
                className="bg-pine text-paper px-5 py-2 text-xs font-data uppercase tracking-wider hover:bg-pine-dark disabled:opacity-50"
                title={
                  !sectionComplete(metric.key)
                    ? "Score, reasoning, and at least one evidence link are required"
                    : undefined
                }
              >
                Continue →
              </button>
            </div>
          </>
        )}

        {step === 5 && (
          <>
            <h2 className="font-display text-2xl text-pine-dark">Review &amp; record</h2>
            <table className="w-full text-sm my-4">
              <tbody>
                {METRICS.map((m) => (
                  <tr key={m.key} className="border-b border-rule">
                    <td className="py-2 pr-3">{m.label}</td>
                    <td className="py-2 font-data text-lg text-right w-10">
                      {draft[m.key].score}
                    </td>
                    {prior && (
                      <td className="py-2 pl-3 font-data text-xs text-ink-faint w-20 text-right">
                        was {prior[`${m.key}_score`]}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>

            {prior && (
              <fieldset className="mb-5 border border-rule bg-paper px-4 py-3">
                <div className="section-label mb-2">
                  This company was scored before. What is this new session?
                </div>
                <label className="flex items-start gap-2 text-sm mb-1.5">
                  <input
                    type="radio"
                    name="revision_kind"
                    checked={revisionKind === "refinement"}
                    onChange={() => setRevisionKind("refinement")}
                    className="mt-1 accent-[var(--color-pine)]"
                  />
                  <span>
                    <strong>Refinement</strong> — same view, sharper evidence or
                    updated detail.
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="revision_kind"
                    checked={revisionKind === "change_of_mind"}
                    onChange={() => setRevisionKind("change_of_mind")}
                    className="mt-1 accent-[var(--color-oxblood)]"
                  />
                  <span>
                    <strong>Change of mind</strong> — the thesis genuinely moved.
                    This distinction is invisible in the numbers alone, which is
                    why it is recorded.
                  </span>
                </label>
              </fieldset>
            )}

            {error && (
              <p className="text-sm text-oxblood bg-oxblood-wash border border-oxblood/30 px-3 py-2 mb-4">
                {error}
              </p>
            )}

            <div className="flex justify-between">
              <button
                onClick={() => setStep(4)}
                className="text-xs font-data uppercase tracking-wider text-ink-soft"
              >
                ← Back
              </button>
              <button
                onClick={submit}
                disabled={pending || (prior !== null && revisionKind === null)}
                className="bg-pine text-paper px-6 py-2.5 text-sm font-data uppercase tracking-wider hover:bg-pine-dark disabled:opacity-50"
              >
                {pending ? "Recording…" : "Record score"}
              </button>
            </div>
            <p className="text-xs text-ink-faint mt-3">
              Recording writes a new row. {prior ? "The previous session stays in the history untouched." : ""}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
