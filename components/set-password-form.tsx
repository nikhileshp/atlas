"use client";

import { useActionState } from "react";
import { setPassword, type AuthFormState } from "@/actions/auth";

const initial: AuthFormState = { error: null };

export function SetPasswordForm() {
  const [state, action, pending] = useActionState(setPassword, initial);

  return (
    <form
      action={action}
      className="bg-card border border-rule shadow-[3px_3px_0_0_var(--color-rule)] p-6 space-y-4"
    >
      <label className="block">
        <span className="section-label">New password</span>
        <input
          type="password"
          name="password"
          required
          minLength={8}
          autoComplete="new-password"
          className="mt-1 w-full border border-rule bg-paper px-3 py-2 font-data text-sm focus:outline-none focus:border-pine"
        />
      </label>
      {state.error && (
        <p className="text-sm text-oxblood bg-oxblood-wash border border-oxblood/30 px-3 py-2">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full bg-pine text-paper py-2.5 text-sm font-medium tracking-wide uppercase hover:bg-pine-dark transition-colors disabled:opacity-60"
      >
        {pending ? "Saving…" : "Set password"}
      </button>
    </form>
  );
}
