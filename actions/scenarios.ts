"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/supabase/server";

export interface ScenarioFormState {
  error: string | null;
  ok: boolean;
}

export async function createScenario(
  _prev: ScenarioFormState,
  formData: FormData,
): Promise<ScenarioFormState> {
  const { supabase, user, profile } = await requireUser();

  const entityId = String(formData.get("entity_id") ?? "");
  const kind = String(formData.get("scenario_kind") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const narrative = String(formData.get("narrative") ?? "").trim();
  const probabilityRaw = String(formData.get("probability") ?? "").trim();

  if (!["bull", "base", "bear", "other"].includes(kind)) {
    return { error: "Pick a scenario kind.", ok: false };
  }
  if (!title) return { error: "Title is required.", ok: false };
  if (!narrative) return { error: "Narrative is required.", ok: false };

  let probability: number | null = null;
  if (probabilityRaw !== "") {
    probability = Number(probabilityRaw);
    if (Number.isNaN(probability) || probability < 0 || probability > 1) {
      return { error: "Probability must be between 0 and 1.", ok: false };
    }
  }

  const { error } = await supabase.from("scenario").insert({
    org_id: profile.org_id,
    entity_id: entityId,
    scenario_kind: kind,
    title,
    narrative,
    probability,
    created_by: user.id,
    valid_at: new Date().toISOString(),
  });
  if (error) {
    return {
      error:
        error.code === "42501"
          ? "Your role cannot write scenarios (analyst or pm required)."
          : error.message,
      ok: false,
    };
  }

  revalidatePath(`/entities/${entityId}`);
  return { error: null, ok: true };
}
