import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/supabase/server";
import { getAsOf } from "@/lib/asof-server";
import { versionChain, resolveAsOf } from "@/lib/asof";
import { env } from "@/lib/env";
import { tombstoneArtifact } from "@/actions/artifacts";
import type { AliasRow, ArtifactEntityRow, ArtifactRow } from "@/lib/types";
import { canWriteResearch } from "@/lib/roles";

export default async function ArtifactDetailPage({
  params,
  searchParams,
}: PageProps<"/artifacts/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const { supabase, profile } = await requireUser();
  const asOf = await getAsOf();

  const { data: artifactRow } = await supabase
    .from("artifact")
    .select("*")
    .eq("id", id)
    .single();
  if (!artifactRow || new Date((artifactRow as ArtifactRow).recorded_at) > asOf) {
    notFound();
  }
  const artifact = artifactRow as ArtifactRow;

  // full chain: rows this supersedes + rows that supersede this
  const { data: sameHashOrChain } = await supabase
    .from("artifact")
    .select("*")
    .or(
      artifact.content_hash
        ? `content_hash.eq.${artifact.content_hash},id.eq.${artifact.id}`
        : `id.eq.${artifact.id}`,
    );
  const chainRows = ((sameHashOrChain ?? []) as ArtifactRow[]).filter(
    (r) => new Date(r.recorded_at) <= asOf,
  );
  const headCandidates = resolveAsOf(chainRows, asOf);
  const head = headCandidates.find((r) =>
    versionChain(chainRows, r.id).some((v) => v.id === artifact.id),
  );
  const chain = versionChain(chainRows, head?.id ?? artifact.id);
  const retracted = !head && chainRows.some((r) => r.is_tombstone);

  const { data: linkRows } = await supabase
    .from("artifact_entity")
    .select("*")
    .in(
      "artifact_id",
      chain.map((c) => c.id),
    );
  const links = resolveAsOf((linkRows ?? []) as ArtifactEntityRow[], asOf);
  const entityIds = [...new Set(links.map((l) => l.entity_id))];
  const { data: aliasRows } = entityIds.length
    ? await supabase
        .from("entity_alias")
        .select("*")
        .in("entity_id", entityIds)
        .eq("alias_type", "legal_name")
    : { data: [] };
  const names = resolveAsOf((aliasRows ?? []) as AliasRow[], asOf);

  let signedUrl: string | null = null;
  if (artifact.storage_key) {
    const { data } = await supabase.storage
      .from(env("SUPABASE_STORAGE_BUCKET"))
      .createSignedUrl(artifact.storage_key, 600);
    signedUrl = data?.signedUrl ?? null;
  }

  const canWrite = canWriteResearch(profile.role);

  return (
    <div className="max-w-3xl rise space-y-6">
      {sp.version === "of-existing" && (
        <p className="text-sm bg-pine-wash border border-pine/40 text-pine-dark px-4 py-2.5">
          Identical content already existed — this was recorded as a new
          version of the existing artifact, not a duplicate.
        </p>
      )}
      {retracted && (
        <p className="text-sm bg-oxblood-wash border border-oxblood/40 text-oxblood px-4 py-2.5">
          This artifact was retracted (tombstoned) as of the pinned instant.
          The historical record below is preserved.
        </p>
      )}

      <header>
        <div className="section-label mb-1">
          {artifact.artifact_type} · {artifact.source_kind}
          {artifact.supersedes && " · revision"}
        </div>
        <h1 className="font-display text-3xl text-pine-dark">{artifact.title}</h1>
        <div className="rule-double mt-3 mb-3" />
        <div className="font-data text-xs text-ink-soft space-x-3">
          <span>author: {artifact.author}</span>
          <span>refers to {new Date(artifact.valid_at).toLocaleDateString()}</span>
          <span>entered {new Date(artifact.recorded_at).toLocaleDateString()}</span>
          {artifact.content_hash && (
            <span title={artifact.content_hash}>
              sha256 {artifact.content_hash.slice(0, 12)}…
            </span>
          )}
        </div>
      </header>

      {artifact.summary && <p className="text-sm text-ink-soft">{artifact.summary}</p>}

      {artifact.url && (
        <p>
          <a
            href={artifact.url}
            target="_blank"
            rel="noreferrer"
            className="font-data text-sm text-pine underline decoration-dotted"
          >
            {artifact.url}
          </a>
        </p>
      )}
      {artifact.body && (
        <blockquote className="bg-card border-l-4 border-pine px-4 py-3 text-sm whitespace-pre-wrap">
          {artifact.body}
        </blockquote>
      )}
      {signedUrl && (
        <p>
          <a
            href={signedUrl}
            className="inline-block bg-pine text-paper px-4 py-2 text-xs font-data uppercase tracking-wider hover:bg-pine-dark"
          >
            Download file
          </a>
          <span className="ml-3 font-data text-xs text-ink-faint">
            object key: {artifact.storage_key}
          </span>
        </p>
      )}

      <section>
        <div className="section-label mb-1">Linked entities</div>
        <ul className="flex gap-2 flex-wrap">
          {entityIds.map((eid) => (
            <li key={eid}>
              <Link
                href={`/entities/${eid}`}
                className="inline-block bg-pine-wash text-pine-dark px-2.5 py-1 text-sm hover:underline"
              >
                {names.find((n) => n.entity_id === eid)?.value ?? "entity"}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {chain.length > 1 && (
        <section>
          <div className="section-label mb-1">Version history</div>
          <ol className="text-sm divide-y divide-rule border border-rule bg-card">
            {chain.map((v, i) => (
              <li
                key={v.id}
                className={`px-4 py-2 flex justify-between ${v.id === artifact.id ? "bg-pine-wash/50" : ""}`}
              >
                <span>
                  {v.is_tombstone ? "⌫ retracted" : `v${chain.length - i}`}
                  {v.id === artifact.id && " (viewing)"}
                </span>
                <span className="font-data text-xs text-ink-soft">
                  {new Date(v.recorded_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {canWrite && !retracted && !artifact.is_tombstone && (
        <form action={tombstoneArtifact} className="border-t border-rule pt-4">
          <input type="hidden" name="artifact_id" value={artifact.id} />
          <button className="text-xs font-data uppercase tracking-wider text-oxblood underline decoration-dotted hover:no-underline">
            Retract artifact
          </button>
          <span className="ml-2 text-xs text-ink-faint">
            writes a tombstone row — removes it from view, preserves history
            (nothing in Atlas is ever deleted)
          </span>
        </form>
      )}
    </div>
  );
}
