"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/supabase/server";
import { getCompany, padCik } from "@/lib/edgar";
import { resolveAsOf } from "@/lib/asof";
import type { AliasRow, AliasType } from "@/lib/types";

export interface CreateEntityState {
  error: string | null;
}

/**
 * Create an entity from a CIK (EDGAR-picked or manually entered) and seed
 * entity_alias with every name and ticker EDGAR returns — the CIK is the
 * spine; everything else is an alias.
 */
export async function createEntity(
  _prev: CreateEntityState,
  formData: FormData,
): Promise<CreateEntityState> {
  const { supabase, user, profile } = await requireUser();

  const cik = padCik(String(formData.get("cik") ?? "").trim());
  if (!/^[0-9]{10}$/.test(cik)) {
    return { error: "A CIK is required (up to ten digits)." };
  }

  const { data: existing } = await supabase
    .from("entity")
    .select("id")
    .eq("cik", cik)
    .maybeSingle();
  if (existing) redirect(`/entities/${existing.id}?note=exists`);

  let identity;
  try {
    identity = await getCompany(cik);
  } catch {
    return {
      error: `EDGAR has no company for CIK ${cik}. Check the number, or try again when EDGAR is reachable.`,
    };
  }

  const nowIso = new Date().toISOString();
  const { data: entity, error } = await supabase
    .from("entity")
    .insert({
      org_id: profile.org_id,
      cik,
      created_by: user.id,
      valid_at: nowIso,
    })
    .select()
    .single();
  if (error) {
    return {
      error:
        error.code === "42501"
          ? "Only admins can create entity records."
          : error.message,
    };
  }

  const aliasRows = [
    { alias_type: "legal_name", value: identity.name, valid_at: nowIso },
    ...identity.tickers.map((t) => ({
      alias_type: "ticker",
      value: t,
      valid_at: nowIso,
    })),
    ...identity.formerNames.map((f) => ({
      alias_type: "former_name",
      value: f.name,
      valid_at: f.from ?? nowIso,
    })),
  ].map((a) => ({
    ...a,
    org_id: profile.org_id,
    entity_id: entity.id,
    created_by: user.id,
  }));

  const { error: aliasError } = await supabase.from("entity_alias").insert(aliasRows);
  if (aliasError) return { error: `Entity created but alias seeding failed: ${aliasError.message}` };

  redirect(`/entities/${entity.id}`);
}

export interface AddAliasState {
  error: string | null;
  warning: string | null;
  ok: boolean;
}

/**
 * Add an alias (including informal internal names from Evernote folders and
 * Excel filenames). Warns when the value already resolves to a different
 * entity; resubmit with confirmed=true to add anyway.
 */
export async function addAlias(
  _prev: AddAliasState,
  formData: FormData,
): Promise<AddAliasState> {
  const { supabase, user, profile } = await requireUser();

  const entityId = String(formData.get("entity_id") ?? "");
  const aliasType = String(formData.get("alias_type") ?? "") as AliasType;
  const value = String(formData.get("value") ?? "").trim();
  const confirmed = formData.get("confirmed") === "true";

  if (!entityId || !value) return { error: "Alias value is required.", warning: null, ok: false };

  if (!confirmed) {
    const { data: sameValue } = await supabase
      .from("entity_alias")
      .select("*")
      .ilike("value", value);
    const current = resolveAsOf((sameValue ?? []) as AliasRow[], new Date());
    const clash = current.find((a) => a.entity_id !== entityId);
    if (clash) {
      const { data: clashName } = await supabase
        .from("entity_alias")
        .select("value, entity:entity_id(cik)")
        .eq("entity_id", clash.entity_id)
        .eq("alias_type", "legal_name")
        .limit(1)
        .maybeSingle();
      const who = clashName
        ? `${clashName.value} (CIK ${(clashName.entity as unknown as { cik: string }).cik})`
        : "another entity";
      return {
        error: null,
        warning: `“${value}” already resolves to ${who}. Add it here anyway?`,
        ok: false,
      };
    }
  }

  const { error } = await supabase.from("entity_alias").insert({
    org_id: profile.org_id,
    entity_id: entityId,
    alias_type: aliasType,
    value,
    created_by: user.id,
    valid_at: new Date().toISOString(),
  });
  if (error) {
    return {
      error:
        error.code === "42501" ? "Only admins can manage entity records." : error.message,
      warning: null,
      ok: false,
    };
  }

  revalidatePath(`/entities/${entityId}`);
  return { error: null, warning: null, ok: true };
}
