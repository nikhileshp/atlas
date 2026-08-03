"use client";

import { useActionState } from "react";
import { createScenario, type ScenarioFormState } from "@/actions/scenarios";

const initial: ScenarioFormState = { error: null, ok: false };

export function ScenarioForm({ entityId }: { entityId: string }) {
  const [state, action, pending] = useActionState(createScenario, initial);

  return (
    <details className="mt-4 border border-rule bg-paper-deep px-4 py-3">
      <summary className="section-label cursor-pointer">+ Add scenario</summary>
      <form action={action} className="mt-3 grid gap-2 sm:grid-cols-[auto_1fr_auto]">
        <input type="hidden" name="entity_id" value={entityId} />
        <select
          name="scenario_kind"
          className="border border-rule bg-card px-2 py-1.5 font-data text-xs"
          defaultValue="base"
        >
          <option value="bull">bull</option>
          <option value="base">base</option>
          <option value="bear">bear</option>
          <option value="other">other</option>
        </select>
        <input
          name="title"
          required
          placeholder="Title"
          className="border border-rule bg-card px-3 py-1.5 text-sm focus:outline-none focus:border-pine"
        />
        <input
          name="probability"
          placeholder="p (0–1, optional)"
          className="w-32 border border-rule bg-card px-3 py-1.5 font-data text-sm focus:outline-none focus:border-pine"
        />
        <textarea
          name="narrative"
          required
          rows={2}
          placeholder="Narrative"
          className="sm:col-span-3 border border-rule bg-card px-3 py-1.5 text-sm focus:outline-none focus:border-pine"
        />
        <div className="sm:col-span-3 flex items-center gap-3">
          <button
            disabled={pending}
            className="bg-pine text-paper px-4 py-1.5 text-xs font-data uppercase tracking-wider hover:bg-pine-dark disabled:opacity-60"
          >
            {pending ? "Saving…" : "Save scenario"}
          </button>
          {state.error && <span className="text-xs text-oxblood">{state.error}</span>}
          {state.ok && <span className="text-xs text-pine font-data">Recorded.</span>}
        </div>
      </form>
    </details>
  );
}
