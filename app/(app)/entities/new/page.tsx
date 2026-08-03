import { requireUser } from "@/lib/supabase/server";
import { EntitySearch } from "@/components/entity-search";

export default async function NewEntityPage() {
  const { profile } = await requireUser();

  return (
    <div className="max-w-2xl rise">
      <h1 className="font-display text-3xl text-pine-dark mb-2">Add a company</h1>
      <p className="text-sm text-ink-soft mb-6">
        Companies are keyed on their SEC CIK — names and tickers change, CIKs
        do not. Aliases (every name and ticker EDGAR knows) are seeded
        automatically on creation.
      </p>
      <EntitySearch canCreate={profile.role === "admin"} />
    </div>
  );
}
