import { notFound } from "next/navigation";
import { requireUser } from "@/lib/supabase/server";
import { InviteForm } from "@/components/invite-form";
import type { Profile } from "@/lib/types";

export default async function AdminUsersPage() {
  const { supabase, profile } = await requireUser();
  if (profile.role !== "admin") notFound();

  const { data } = await supabase
    .from("profile")
    .select("*")
    .order("created_at");
  const profiles = (data ?? []) as Profile[];

  return (
    <div className="max-w-3xl rise space-y-8">
      <header>
        <h1 className="font-display text-3xl text-pine-dark">Users</h1>
        <p className="text-sm text-ink-soft mt-1">
          Membership is invite-only — there is no public signup. Invites go
          through local Supabase Auth; on this machine the email lands in the
          mail catcher at{" "}
          <a
            href="http://127.0.0.1:54324"
            target="_blank"
            rel="noreferrer"
            className="font-data text-pine underline decoration-dotted"
          >
            127.0.0.1:54324
          </a>
          .
        </p>
      </header>

      <table className="w-full bg-card border border-rule text-sm">
        <thead>
          <tr className="text-left">
            <th className="section-label px-4 py-2.5 border-b-2 border-rule-strong">Name</th>
            <th className="section-label px-4 py-2.5 border-b-2 border-rule-strong">Email</th>
            <th className="section-label px-4 py-2.5 border-b-2 border-rule-strong">Role</th>
            <th className="section-label px-4 py-2.5 border-b-2 border-rule-strong">Joined</th>
          </tr>
        </thead>
        <tbody>
          {profiles.map((p) => (
            <tr key={p.user_id} className="border-b border-rule">
              <td className="px-4 py-2.5">{p.display_name}</td>
              <td className="px-4 py-2.5 font-data text-xs">{p.email}</td>
              <td className="px-4 py-2.5">
                <span className="text-[10px] font-data uppercase tracking-wider bg-pine-wash text-pine px-1.5 py-0.5">
                  {p.role}
                </span>
              </td>
              <td className="px-4 py-2.5 font-data text-xs text-ink-soft">
                {new Date(p.created_at).toLocaleDateString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <section>
        <h2 className="font-display text-2xl text-pine-dark mb-3">Invite</h2>
        <InviteForm />
      </section>
    </div>
  );
}
