"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/supabase/server";
import { resolveAsOf } from "@/lib/asof";
import type { PositionInputRow } from "@/lib/types";

export interface PositionFormState {
  error: string | null;
  ok: boolean;
}

/**
 * Every save is a new position_input row — nothing is ever overwritten; this
 * is the screen that replaces the destructive spreadsheet. computed_weight
 * (what the formula produced) and chosen_weight (what the human picked) are
 * captured separately and stored separately: the gap between them is the
 * record of human judgment.
 */
export async function createPositionInput(
  _prev: PositionFormState,
  formData: FormData,
): Promise<PositionFormState> {
  const { supabase, user, profile } = await requireUser();

  const entityId = String(formData.get("entity_id") ?? "");
  const num = (name: string) => {
    const raw = String(formData.get(name) ?? "").trim();
    if (raw === "") return null;
    const n = Number(raw);
    return Number.isNaN(n) ? undefined : n;
  };

  const irr = num("irr");
  const skew = num("skew");
  const conviction = num("conviction");
  const fcfGrowth = num("fcf_growth");
  const computedWeight = num("computed_weight"); // null allowed: no model run
  const chosenWeight = num("chosen_weight");
  const rationale = String(formData.get("rationale") ?? "").trim();

  for (const [label, v] of [
    ["IRR", irr],
    ["Skew", skew],
    ["Conviction", conviction],
    ["FCF growth", fcfGrowth],
  ] as const) {
    if (v === null || v === undefined) return { error: `${label} is required.`, ok: false };
  }
  if (computedWeight === undefined) {
    return { error: "Computed weight must be a number (or left blank if no model ran).", ok: false };
  }
  if (chosenWeight === null || chosenWeight === undefined) {
    return { error: "Chosen weight is required — it is the decision being recorded.", ok: false };
  }

  const { data: prior } = await supabase
    .from("position_input")
    .select("*")
    .eq("entity_id", entityId);
  const head = resolveAsOf((prior ?? []) as PositionInputRow[], new Date())[0] ?? null;

  const { error } = await supabase.from("position_input").insert({
    org_id: profile.org_id,
    entity_id: entityId,
    irr,
    skew,
    conviction,
    fcf_growth: fcfGrowth,
    computed_weight: computedWeight,
    chosen_weight: chosenWeight,
    rationale,
    created_by: user.id,
    valid_at: new Date().toISOString(),
    supersedes: head?.id ?? null,
  });
  if (error) {
    return {
      error:
        error.code === "42501"
          ? "Only the PM can write position inputs."
          : error.message,
      ok: false,
    };
  }

  revalidatePath(`/entities/${entityId}/position`);
  revalidatePath("/positions");
  return { error: null, ok: true };
}
