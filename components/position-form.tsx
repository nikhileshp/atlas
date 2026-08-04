"use client";

import { useActionState } from "react";
import { createPositionInput, type PositionFormState } from "@/actions/positions";

const initial: PositionFormState = { error: null, ok: false };

/**
 * The dual-weight capture. computed_weight is whatever the sizing formula or
 * model produced (entered manually — model integration is a separate
 * workstream, out of scope here). chosen_weight is what the human actually
 * picked. They are separate fields, stored separately, and the computed value
 * never disappears once a human overrides it: the gap IS the data.
 */
export function PositionForm({ entityId }: { entityId: string }) {
  const [state, action, pending] = useActionState(createPositionInput, initial);

  const num = (
    name: string,
    label: string,
    hint: string,
    opts: { required?: boolean; step?: string } = {},
  ) => (
    <label className="block">
      <span className="section-label">{label}</span>
      <input
        type="number"
        name={name}
        step={opts.step ?? "any"}
        required={opts.required !== false}
        className="mt-1 w-full border border-rule bg-paper px-3 py-2 font-data text-sm focus:outline-none focus:border-pine"
      />
      <span className="text-[11px] text-ink-faint">{hint}</span>
    </label>
  );

  return (
    <form action={action} className="bg-card border border-rule p-5 space-y-4">
      <input type="hidden" name="entity_id" value={entityId} />
      <div className="grid sm:grid-cols-4 gap-4">
        {num("irr", "IRR", "expected, decimal — 0.12 = 12%")}
        {num("skew", "Skew", "upside : downside ratio")}
        {num("conviction", "Conviction", "conviction / model edge")}
        {num("fcf_growth", "FCF growth", "decimal — 0.10 = 10%")}
      </div>

      <div className="grid sm:grid-cols-2 gap-4 border-t-2 border-rule-strong pt-4">
        <label className="block">
          <span className="section-label">Computed weight (%)</span>
          <input
            type="number"
            name="computed_weight"
            step="any"
            className="mt-1 w-full border border-rule bg-paper px-3 py-2 font-data text-sm focus:outline-none focus:border-pine"
          />
          <span className="text-[11px] text-ink-faint">
            What the formula/model produced. Enter the model&rsquo;s output here —
            model integration is a separate workstream. Leave blank only if no
            model ran.
          </span>
        </label>
        <label className="block">
          <span className="section-label text-oxblood">Chosen weight (%) — the human call</span>
          <input
            type="number"
            name="chosen_weight"
            step="any"
            required
            className="mt-1 w-full border-2 border-oxblood/40 bg-paper px-3 py-2 font-data text-sm focus:outline-none focus:border-oxblood"
          />
          <span className="text-[11px] text-ink-faint">
            Stored separately from the computed value — the gap between them is
            the judgment being recorded. Neither ever overwrites the other.
          </span>
        </label>
      </div>

      <label className="block">
        <span className="section-label">Rationale</span>
        <textarea
          name="rationale"
          rows={2}
          placeholder="Why this size — especially if it differs from the model."
          className="mt-1 w-full border border-rule bg-paper px-3 py-2 text-sm focus:outline-none focus:border-pine"
        />
      </label>

      {state.error && (
        <p className="text-sm text-oxblood bg-oxblood-wash border border-oxblood/30 px-3 py-2">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p className="text-sm text-pine font-data">
          Recorded as a new row — prior inputs below are untouched.
        </p>
      )}
      <button
        disabled={pending}
        className="bg-pine text-paper px-5 py-2 text-xs font-data uppercase tracking-wider hover:bg-pine-dark disabled:opacity-60"
      >
        {pending ? "Recording…" : "Record position input"}
      </button>
    </form>
  );
}
