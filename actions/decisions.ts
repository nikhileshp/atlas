"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/supabase/server";

export interface DecisionFormState {
  error: string | null;
  ok: boolean;
}

/**
 * A decision records what was decided, who, when — and WHICH position_input
 * and quality_score rows were current at that moment, as explicit foreign
 * keys. The form is pre-filled with the current head rows; reconstructing
 * the basis later never relies on timestamp proximity.
 */
export async function createDecision(
  _prev: DecisionFormState,
  formData: FormData,
): Promise<DecisionFormState> {
  const { supabase, user, profile } = await requireUser();

  const entityId = String(formData.get("entity_id") ?? "");
  const decisionType = String(formData.get("decision_type") ?? "");
  const summary = String(formData.get("summary") ?? "").trim();
  const positionInputId = String(formData.get("position_input_id") ?? "");
  const qualityScoreId = String(formData.get("quality_score_id") ?? "") || null;
  const decidedAtRaw = String(formData.get("decided_at") ?? "");

  if (!["initiate", "increase", "decrease", "exit", "hold"].includes(decisionType)) {
    return { error: "Pick a decision type.", ok: false };
  }
  if (!summary) return { error: "Record what was decided.", ok: false };
  if (!positionInputId) {
    return {
      error: "A decision must reference the position input it was based on.",
      ok: false,
    };
  }

  // the referenced basis rows must exist in this org (RLS-scoped selects)
  const { data: pos } = await supabase
    .from("position_input")
    .select("id")
    .eq("id", positionInputId)
    .maybeSingle();
  if (!pos) return { error: "Referenced position input not found.", ok: false };
  if (qualityScoreId) {
    const { data: qs } = await supabase
      .from("quality_score")
      .select("id")
      .eq("id", qualityScoreId)
      .maybeSingle();
    if (!qs) return { error: "Referenced quality score not found.", ok: false };
  }

  const decidedAt = decidedAtRaw ? new Date(decidedAtRaw) : new Date();

  const { error } = await supabase.from("decision").insert({
    org_id: profile.org_id,
    entity_id: entityId,
    decision_type: decisionType,
    summary,
    position_input_id: positionInputId,
    quality_score_id: qualityScoreId,
    created_by: user.id,
    valid_at: decidedAt.toISOString(),
  });
  if (error) {
    return {
      error:
        error.code === "42501" ? "Only the PM can record decisions." : error.message,
      ok: false,
    };
  }

  revalidatePath(`/entities/${entityId}/position`);
  revalidatePath("/positions");
  return { error: null, ok: true };
}
