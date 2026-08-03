"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/supabase/server";
import { resolveAsOf } from "@/lib/asof";
import { METRICS, type MetricKey, type QualityScoreRow } from "@/lib/types";

export interface ScoreFormState {
  error: string | null;
}

export interface ScoreMetricInput {
  score: number;
  reasoning: string;
  evidence: string[];
}

export interface ScoreSubmission {
  entityId: string;
  revisionKind: "refinement" | "change_of_mind" | null; // null when no prior score
  metrics: Record<MetricKey, ScoreMetricInput>;
}

/**
 * One new quality_score row per scoring session. Prior sessions are never
 * touched; re-scoring supersedes the current head and must be marked as a
 * refinement or a genuine change of mind. Every metric requires reasoning
 * and at least one supporting artifact — an unsourced score is noise and is
 * not accepted (mirrored by DB check constraints).
 */
export async function createQualityScore(
  submission: ScoreSubmission,
): Promise<ScoreFormState> {
  const { supabase, user, profile } = await requireUser();
  const { entityId, metrics } = submission;

  const allEvidence = new Set<string>();
  for (const { key, label } of METRICS) {
    const m = metrics[key];
    if (!m) return { error: `Missing section: ${label}` };
    if (!Number.isInteger(m.score) || m.score < 1 || m.score > 10) {
      return { error: `${label}: score must be an integer from 1 to 10.` };
    }
    if (!m.reasoning.trim()) {
      return { error: `${label}: reasoning is required.` };
    }
    if (m.evidence.length < 1) {
      return { error: `${label}: link at least one supporting artifact.` };
    }
    m.evidence.forEach((e) => allEvidence.add(e));
  }

  // evidence artifacts must exist in this org
  const { data: found } = await supabase
    .from("artifact")
    .select("id")
    .in("id", [...allEvidence]);
  if ((found ?? []).length !== allEvidence.size) {
    return { error: "One or more evidence artifacts could not be found." };
  }

  // supersede the current head, if any
  const { data: prior } = await supabase
    .from("quality_score")
    .select("*")
    .eq("entity_id", entityId);
  const head = resolveAsOf((prior ?? []) as QualityScoreRow[], new Date())[0] ?? null;

  const revisionKind = head ? submission.revisionKind : "initial";
  if (head && !revisionKind) {
    return {
      error:
        "This company has a prior score: mark whether this is a refinement of the old view or a genuine change of mind.",
    };
  }

  const row: Record<string, unknown> = {
    org_id: profile.org_id,
    entity_id: entityId,
    revision_kind: revisionKind,
    created_by: user.id,
    valid_at: new Date().toISOString(),
    supersedes: head?.id ?? null,
  };
  for (const { key } of METRICS) {
    row[`${key}_score`] = metrics[key].score;
    row[`${key}_reasoning`] = metrics[key].reasoning.trim();
    row[`${key}_evidence`] = metrics[key].evidence;
  }

  const { error } = await supabase.from("quality_score").insert(row);
  if (error) {
    return {
      error:
        error.code === "42501"
          ? "Your role cannot write quality scores (analyst or pm required)."
          : error.message,
    };
  }

  redirect(`/entities/${entityId}`);
}
