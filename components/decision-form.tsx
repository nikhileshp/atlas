"use client";

import { useActionState } from "react";
import { createDecision, type DecisionFormState } from "@/actions/decisions";

const initial: DecisionFormState = { error: null, ok: false };

interface BasisPosition {
  id: string;
  chosen_weight: number;
  computed_weight: number | null;
  valid_at: string;
}

interface BasisScore {
  id: string;
  valid_at: string;
  revision_kind: string;
}

/**
 * Records what was decided — anchored to the exact position_input and
 * quality_score rows that are current right now, shown as "basis" cards and
 * written as explicit foreign keys. Never reconstructed from timestamps.
 */
export function DecisionForm({
  entityId,
  basisPosition,
  basisScore,
}: {
  entityId: string;
  basisPosition: BasisPosition | null;
  basisScore: BasisScore | null;
}) {
  const [state, action, pending] = useActionState(createDecision, initial);

  if (!basisPosition) {
    return (
      <p className="text-sm text-ink-soft border border-rule bg-paper-deep px-4 py-3">
        Record a position input first — a decision must reference the position
        input it was based on.
      </p>
    );
  }

  return (
    <form action={action} className="bg-card border border-rule p-5 space-y-4">
      <input type="hidden" name="entity_id" value={entityId} />
      <input type="hidden" name="position_input_id" value={basisPosition.id} />
      {basisScore && <input type="hidden" name="quality_score_id" value={basisScore.id} />}

      <div>
        <div className="section-label mb-1.5">Deciding on the basis of</div>
        <div className="grid sm:grid-cols-2 gap-2">
          <div className="border border-pine/40 bg-pine-wash px-3 py-2 text-sm">
            <div className="section-label">position input · {new Date(basisPosition.valid_at).toLocaleDateString()}</div>
            <span className="font-data">
              model {basisPosition.computed_weight ?? "—"}% / chosen{" "}
              {basisPosition.chosen_weight}%
            </span>
            <div className="font-data text-[10px] text-ink-faint mt-0.5">
              fk {basisPosition.id.slice(0, 8)}…
            </div>
          </div>
          <div className="border border-rule bg-paper-deep px-3 py-2 text-sm">
            {basisScore ? (
              <>
                <div className="section-label">
                  quality score · {new Date(basisScore.valid_at).toLocaleDateString()}
                </div>
                <span>{basisScore.revision_kind.replace("_", " ")}</span>
                <div className="font-data text-[10px] text-ink-faint mt-0.5">
                  fk {basisScore.id.slice(0, 8)}…
                </div>
              </>
            ) : (
              <span className="text-ink-faint text-xs">
                no quality score on record — decision will reference the
                position input only
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="grid sm:grid-cols-[auto_1fr] gap-4">
        <label className="block">
          <span className="section-label">Decision</span>
          <select
            name="decision_type"
            className="mt-1 border border-rule bg-paper px-3 py-2 font-data text-sm"
            defaultValue="hold"
          >
            {["initiate", "increase", "decrease", "exit", "hold"].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="section-label">What was decided</span>
          <input
            name="summary"
            required
            placeholder="e.g. Increase to 6.5% — override of model weight, see rationale"
            className="mt-1 w-full border border-rule bg-paper px-3 py-2 text-sm focus:outline-none focus:border-pine"
          />
        </label>
      </div>

      {state.error && (
        <p className="text-sm text-oxblood bg-oxblood-wash border border-oxblood/30 px-3 py-2">
          {state.error}
        </p>
      )}
      {state.ok && <p className="text-sm text-pine font-data">Decision recorded.</p>}
      <button
        disabled={pending}
        className="bg-oxblood text-paper px-5 py-2 text-xs font-data uppercase tracking-wider hover:bg-oxblood/80 disabled:opacity-60"
      >
        {pending ? "Recording…" : "Record decision"}
      </button>
    </form>
  );
}
