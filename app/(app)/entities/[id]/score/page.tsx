import { notFound } from "next/navigation";
import { requireUser } from "@/lib/supabase/server";
import { fetchEntityBundleNow } from "@/lib/queries";
import { ScoreWizard } from "@/components/score-wizard";
import { canWriteResearch } from "@/lib/roles";

export default async function ScorePage({ params }: PageProps<"/entities/[id]/score">) {
  const { id } = await params;
  const { supabase, profile } = await requireUser();

  // Scoring writes at now; the wizard always reads the present state
  // (the as-of control is for reading history, not rewriting it).
  const bundle = await fetchEntityBundleNow(supabase, id);
  if (!bundle) notFound();

  const legalName =
    bundle.aliases.find((a) => a.alias_type === "legal_name")?.value ?? "(unnamed)";
  const prior = bundle.scores[0] ?? null;

  const canWrite = canWriteResearch(profile.role);
  if (!canWrite) {
    return (
      <p className="text-sm text-ink-soft border border-rule bg-paper-deep px-4 py-3 max-w-xl">
        Quality scores are written by analysts and PMs.
      </p>
    );
  }

  return (
    <div className="rise">
      <h1 className="font-display text-3xl text-pine-dark mb-1">
        Score {legalName}
      </h1>
      <p className="text-sm text-ink-soft mb-6 max-w-2xl">
        Five metrics, walked in dependency order. Every score needs its
        reasoning and at least one supporting artifact.
        {prior && " A prior session exists — it will be shown beside each section."}
      </p>
      <ScoreWizard
        entityId={id}
        entityName={legalName}
        evidence={bundle.artifacts.map((a) => ({
          id: a.id,
          label: `${a.title} (${a.artifact_type})`,
        }))}
        prior={prior}
      />
    </div>
  );
}
