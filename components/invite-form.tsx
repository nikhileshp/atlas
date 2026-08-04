"use client";

import { useActionState } from "react";
import { inviteUser, type InviteFormState } from "@/actions/admin";

const initial: InviteFormState = { error: null, ok: false };

export function InviteForm() {
  const [state, action, pending] = useActionState(inviteUser, initial);

  return (
    <form action={action} className="bg-card border border-rule p-5 space-y-4">
      <div className="grid sm:grid-cols-[1fr_1fr_auto] gap-4">
        <label className="block">
          <span className="section-label">Email</span>
          <input
            type="email"
            name="email"
            required
            className="mt-1 w-full border border-rule bg-paper px-3 py-2 font-data text-sm focus:outline-none focus:border-pine"
          />
        </label>
        <label className="block">
          <span className="section-label">Display name</span>
          <input
            name="display_name"
            required
            className="mt-1 w-full border border-rule bg-paper px-3 py-2 text-sm focus:outline-none focus:border-pine"
          />
        </label>
        <label className="block">
          <span className="section-label">Role</span>
          <select
            name="role"
            className="mt-1 border border-rule bg-paper px-3 py-2 font-data text-sm"
            defaultValue="analyst"
          >
            <option value="analyst">analyst</option>
            <option value="pm">pm</option>
            <option value="admin">admin</option>
          </select>
        </label>
      </div>
      {state.error && (
        <p className="text-sm text-oxblood bg-oxblood-wash border border-oxblood/30 px-3 py-2">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p className="text-sm text-pine font-data">
          Invite sent — check the mail catcher at 127.0.0.1:54324.
        </p>
      )}
      <button
        disabled={pending}
        className="bg-pine text-paper px-5 py-2 text-xs font-data uppercase tracking-wider hover:bg-pine-dark disabled:opacity-60"
      >
        {pending ? "Inviting…" : "Send invite"}
      </button>
    </form>
  );
}
