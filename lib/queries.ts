import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAsOf } from "@/lib/asof";
import type {
  AliasRow,
  ArtifactEntityRow,
  ArtifactRow,
  DecisionRow,
  EntityRow,
  PositionInputRow,
  Profile,
  QualityScoreRow,
  ScenarioRow,
} from "@/lib/types";

/**
 * Read-side helpers. RLS scopes every query to the caller's org; these
 * helpers add the bitemporal resolution: fetch every version, then let
 * resolveAsOf compute what the system believed at the pinned instant.
 * History views (version chains, prior inputs) use the raw rows.
 */

export async function fetchEntitiesAsOf(supabase: SupabaseClient, asOf: Date) {
  const { data } = await supabase.from("entity").select("*").order("recorded_at");
  return ((data ?? []) as EntityRow[]).filter(
    (e) => new Date(e.recorded_at) <= asOf,
  );
}

export async function fetchAliasesAsOf(
  supabase: SupabaseClient,
  asOf: Date,
  entityId?: string,
) {
  let q = supabase.from("entity_alias").select("*").order("recorded_at");
  if (entityId) q = q.eq("entity_id", entityId);
  const { data } = await q;
  return resolveAsOf((data ?? []) as AliasRow[], asOf);
}

/** Current legal name / tickers per entity id, for lists and headers. */
export function identityFromAliases(aliases: AliasRow[]) {
  const byEntity = new Map<string, { legalName?: string; tickers: string[] }>();
  for (const a of aliases) {
    const slot = byEntity.get(a.entity_id) ?? { tickers: [] };
    if (a.alias_type === "legal_name") slot.legalName = a.value;
    if (a.alias_type === "ticker") slot.tickers.push(a.value);
    byEntity.set(a.entity_id, slot);
  }
  return byEntity;
}

export interface EntityBundle {
  entity: EntityRow;
  aliases: AliasRow[]; // current as of
  artifacts: ArtifactRow[]; // current as of
  artifactHistory: ArtifactRow[]; // every version, for chains
  scores: QualityScoreRow[]; // current heads as of
  scoreHistory: QualityScoreRow[]; // every session recorded by asOf
  scenarios: ScenarioRow[];
  positions: PositionInputRow[]; // current head(s)
  positionHistory: PositionInputRow[]; // every input recorded by asOf
  decisions: DecisionRow[];
  profiles: Profile[];
}

export async function fetchEntityBundle(
  supabase: SupabaseClient,
  entityId: string,
  asOf: Date,
): Promise<EntityBundle | null> {
  const { data: entity } = await supabase
    .from("entity")
    .select("*")
    .eq("id", entityId)
    .single();
  if (!entity || new Date((entity as EntityRow).recorded_at) > asOf) return null;

  const [aliasRes, linkRes, scoreRes, scenarioRes, positionRes, decisionRes, profileRes] =
    await Promise.all([
      supabase.from("entity_alias").select("*").eq("entity_id", entityId),
      supabase.from("artifact_entity").select("*").eq("entity_id", entityId),
      supabase
        .from("quality_score")
        .select("*")
        .eq("entity_id", entityId)
        .order("recorded_at"),
      supabase
        .from("scenario")
        .select("*")
        .eq("entity_id", entityId)
        .order("recorded_at"),
      supabase
        .from("position_input")
        .select("*")
        .eq("entity_id", entityId)
        .order("recorded_at"),
      supabase
        .from("decision")
        .select("*")
        .eq("entity_id", entityId)
        .order("recorded_at"),
      supabase.from("profile").select("*"),
    ]);

  const links = resolveAsOf((linkRes.data ?? []) as ArtifactEntityRow[], asOf);
  const artifactIds = [...new Set(links.map((l) => l.artifact_id))];

  let artifactHistory: ArtifactRow[] = [];
  if (artifactIds.length > 0) {
    // fetch the linked artifacts AND anything in their supersession chains
    // (tombstones/newer versions may not carry their own link rows)
    const { data: linked } = await supabase
      .from("artifact")
      .select("*")
      .in("id", artifactIds);
    const { data: descendants } = await supabase
      .from("artifact")
      .select("*")
      .in("supersedes", artifactIds);
    const all = new Map<string, ArtifactRow>();
    for (const a of [...(linked ?? []), ...(descendants ?? [])] as ArtifactRow[]) {
      all.set(a.id, a);
    }
    artifactHistory = [...all.values()].sort((a, b) =>
      a.recorded_at.localeCompare(b.recorded_at),
    );
  }

  const scoreHistory = ((scoreRes.data ?? []) as QualityScoreRow[]).filter(
    (s) => new Date(s.recorded_at) <= asOf,
  );
  const positionHistory = ((positionRes.data ?? []) as PositionInputRow[]).filter(
    (p) => new Date(p.recorded_at) <= asOf,
  );

  return {
    entity: entity as EntityRow,
    aliases: resolveAsOf((aliasRes.data ?? []) as AliasRow[], asOf),
    artifacts: resolveAsOf(artifactHistory, asOf),
    artifactHistory,
    scores: resolveAsOf(scoreHistory, asOf),
    scoreHistory,
    scenarios: resolveAsOf((scenarioRes.data ?? []) as ScenarioRow[], asOf),
    positions: resolveAsOf(positionHistory, asOf),
    positionHistory,
    decisions: resolveAsOf((decisionRes.data ?? []) as DecisionRow[], asOf),
    profiles: (profileRes.data ?? []) as Profile[],
  };
}

export function profileName(profiles: Profile[], userId: string): string {
  return profiles.find((p) => p.user_id === userId)?.display_name ?? "unknown";
}
