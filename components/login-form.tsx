"use client";

import { useActionState } from "react";
import { signIn, type AuthFormState } from "@/actions/auth";

const initial: AuthFormState = { error: null };

export function LoginForm() {
  const [state, action, pending] = useActionState(signIn, initial);

  return (
    <form
      action={action}
      className="space-y-4"
    >
      <label className="block">
        <span className="section-label">Email</span>
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          className="mt-1 w-full border border-rule bg-paper px-3.5 py-2.5 font-data text-sm focus:outline-none focus:border-pine"
        />
      </label>
      <label className="block">
        <span className="section-label">Password</span>
        <input
          type="password"
          name="password"
          required
          autoComplete="current-password"
          className="mt-1 w-full border border-rule bg-paper px-3.5 py-2.5 font-data text-sm focus:outline-none focus:border-pine"
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
        className="w-full bg-pine text-paper py-3 text-sm font-medium hover:bg-pine-dark transition-colors disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
