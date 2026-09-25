"use client";

import { useActionState } from "react";
import { removeUser, type RemoveUserState } from "@/actions/admin";

const initial: RemoveUserState = { error: null, outcome: null };

export function RemoveUserButton({ userId, email }: { userId: string; email: string }) {
  const [state, action, pending] = useActionState(removeUser, initial);

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(`Remove ${email}? Anything they wrote stays on the record.`)) {
          e.preventDefault();
        }
      }}
      className="inline"
    >
      <input type="hidden" name="user_id" value={userId} />
      <button
        type="submit"
        disabled={pending}
        className="text-xs font-data text-oxblood underline decoration-dotted disabled:opacity-50"
      >
        {pending ? "Removing…" : "Remove"}
      </button>
      {state.error && <span className="ml-2 text-xs text-oxblood">{state.error}</span>}
    </form>
  );
}
