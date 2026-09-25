import { requireUser } from "@/lib/supabase/server";
import { getAsOf } from "@/lib/asof-server";
import { fetchEntitiesAsOf, fetchAliasesAsOf, identityFromAliases } from "@/lib/queries";
import { ArtifactForm } from "@/components/artifact-form";
import { canWriteResearch } from "@/lib/roles";

export default async function NewArtifactPage({
  searchParams,
}: PageProps<"/artifacts/new">) {
  const { supabase, profile } = await requireUser();
  const asOf = await getAsOf();
  const params = await searchParams;
  const preselected = typeof params.entity === "string" ? params.entity : null;

  const [entities, aliases] = await Promise.all([
    fetchEntitiesAsOf(supabase, asOf),
    fetchAliasesAsOf(supabase, asOf),
  ]);
  const identity = identityFromAliases(aliases);
  const options = entities.map((e) => ({
    id: e.id,
    label: `${identity.get(e.id)?.legalName ?? e.cik} (${
      identity.get(e.id)?.tickers.join(", ") || "CIK " + e.cik
    })`,
  }));

  const canWrite = canWriteResearch(profile.role);

  return (
    <div className="max-w-3xl rise">
      <h1 className="font-display text-3xl text-pine-dark mb-2">Ingest an artifact</h1>
      <p className="text-sm text-ink-soft mb-6">
        Three paths — file, URL, paste — one artifact table. Everything must be
        linked to at least one entity before it can be saved.
      </p>
      {canWrite ? (
        <ArtifactForm entities={options} preselected={preselected} />
      ) : (
        <p className="text-sm text-ink-soft border border-rule bg-paper-deep px-4 py-3">
          Your role cannot write artifacts.
        </p>
      )}
    </div>
  );
}
