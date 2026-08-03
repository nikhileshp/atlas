"use client";

import { useActionState } from "react";
import { addAlias, type AddAliasState } from "@/actions/entities";

const initial: AddAliasState = { error: null, warning: null, ok: false };

/**
 * Admin-only alias entry, including informal internal names (Evernote folder
 * names, Excel file stems). If the value already resolves to a different
 * entity, a warning is surfaced and the admin must explicitly confirm.
 */
export function AliasAddForm({ entityId }: { entityId: string }) {
  const [state, action, pending] = useActionState(addAlias, initial);

  return (
    <form action={action} className="mt-3 space-y-2">
      <input type="hidden" name="entity_id" value={entityId} />
      {state.warning && <input type="hidden" name="confirmed" value="true" />}
      <div className="flex gap-2">
        <select
          name="alias_type"
          className="border border-rule bg-card px-2 py-1.5 font-data text-xs focus:outline-none"
          defaultValue="internal"
        >
          <option value="internal">internal</option>
          <option value="ticker">ticker</option>
          <option value="figi">FIGI</option>
          <option value="lei">LEI</option>
          <option value="former_name">former name</option>
          <option value="legal_name">legal name</option>
        </select>
        <input
          name="value"
          required
          placeholder="e.g. Evernote folder name"
          className="flex-1 border border-rule bg-card px-3 py-1.5 text-sm focus:outline-none focus:border-pine"
        />
        <button
          disabled={pending}
          className={`px-3 py-1.5 text-xs font-data uppercase tracking-wider text-paper disabled:opacity-60 ${
            state.warning ? "bg-oxblood hover:bg-oxblood/80" : "bg-pine hover:bg-pine-dark"
          }`}
        >
          {state.warning ? "Add anyway" : "Add alias"}
        </button>
      </div>
      {state.warning && (
        <p className="text-xs text-oxblood bg-oxblood-wash border border-oxblood/30 px-3 py-2">
          ⚠ {state.warning} Re-enter the value and press “Add anyway” to confirm.
        </p>
      )}
      {state.error && <p className="text-xs text-oxblood">{state.error}</p>}
      {state.ok && <p className="text-xs text-pine font-data">Alias recorded.</p>}
    </form>
  );
}
