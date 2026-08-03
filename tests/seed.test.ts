/**
 * Verifies the seeded world has the shape the spec demands: three roles, five
 * CIK-spined entities, and eighteen months of staggered history including a
 * changed-view re-score, a computed-vs-chosen divergence, an artifact version
 * chain, and a tombstone. Run after `npm run seed`.
 */
import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

const admin = createClient(
  env("NEXT_PUBLIC_SUPABASE_URL"),
  env("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

async function rows<T = Record<string, unknown>>(table: string, select = "*") {
  const { data, error } = await admin.from(table).select(select);
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data ?? []) as T[];
}

describe("seeded world", () => {
  it("has one org and three users covering the three roles", async () => {
    expect((await rows("org")).length).toBe(1);
    const profiles = await rows<{ role: string }>("profile");
    expect(profiles.map((p) => p.role).sort()).toEqual(["admin", "analyst", "pm"]);
  });

  it("has five entities keyed on ten-digit CIKs", async () => {
    const entities = await rows<{ cik: string }>("entity");
    expect(entities.length).toBe(5);
    for (const e of entities) expect(e.cik).toMatch(/^[0-9]{10}$/);
  });

  it("seeds aliases: legal names, tickers, EDGAR former names, internal names", async () => {
    const aliases = await rows<{ alias_type: string; value: string }>("entity_alias");
    const byType = (t: string) => aliases.filter((a) => a.alias_type === t);
    expect(byType("legal_name").length).toBe(5);
    expect(byType("ticker").length).toBeGreaterThanOrEqual(5);
    expect(byType("former_name").length).toBeGreaterThanOrEqual(4); // Apple, Costco, Moody's histories
    expect(byType("internal").length).toBeGreaterThanOrEqual(3);
  });

  it("contains an artifact version chain (same content hash, superseding row)", async () => {
    const artifacts = await rows<{
      id: string;
      supersedes: string | null;
      content_hash: string | null;
      is_tombstone: boolean;
    }>("artifact");
    const byId = new Map(artifacts.map((a) => [a.id, a]));
    const version = artifacts.find(
      (a) =>
        a.supersedes &&
        !a.is_tombstone &&
        a.content_hash &&
        byId.get(a.supersedes)?.content_hash === a.content_hash,
    );
    expect(version).toBeDefined();
  });

  it("contains a tombstoned artifact (delete = new row with tombstone flag)", async () => {
    const artifacts = await rows<{ is_tombstone: boolean; supersedes: string | null }>(
      "artifact",
    );
    expect(artifacts.some((a) => a.is_tombstone && a.supersedes)).toBe(true);
  });

  it("scores Apple twice with a genuine change of mind, prior row intact", async () => {
    const { data: apple } = await admin
      .from("entity")
      .select("id")
      .eq("cik", "0000320193")
      .single();
    const scores = await rows<{
      entity_id: string;
      revision_kind: string;
      supersedes: string | null;
      pricing_power_score: number;
    }>("quality_score");
    const appleScores = scores.filter((s) => s.entity_id === apple!.id);
    expect(appleScores.length).toBe(2);
    const second = appleScores.find((s) => s.supersedes);
    const first = appleScores.find((s) => !s.supersedes);
    expect(second?.revision_kind).toBe("change_of_mind");
    expect(second!.pricing_power_score).toBeLessThan(first!.pricing_power_score);
  });

  it("requires evidence on every metric of every score", async () => {
    const scores = await rows<Record<string, unknown>>("quality_score");
    for (const s of scores) {
      for (const k of [
        "management_evidence",
        "pricing_power_evidence",
        "roiic_moat_evidence",
        "balance_sheet_evidence",
        "growth_durability_evidence",
      ]) {
        expect((s[k] as string[]).length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("has a position where computed and chosen weights diverge", async () => {
    const positions = await rows<{
      computed_weight: number | null;
      chosen_weight: number;
    }>("position_input");
    expect(
      positions.some(
        (p) => p.computed_weight !== null && p.computed_weight !== p.chosen_weight,
      ),
    ).toBe(true);
  });

  it("anchors decisions to explicit position/score FKs, never timestamps", async () => {
    const decisions = await rows<{
      position_input_id: string;
      quality_score_id: string | null;
    }>("decision");
    expect(decisions.length).toBeGreaterThanOrEqual(3);
    for (const d of decisions) expect(d.position_input_id).toBeTruthy();
    expect(decisions.some((d) => d.quality_score_id)).toBe(true);
  });

  it("spreads recorded_at across at least ~18 months, not a flat stamp", async () => {
    const stamps: number[] = [];
    for (const t of ["artifact", "quality_score", "position_input", "decision"]) {
      for (const r of await rows<{ recorded_at: string }>(t, "recorded_at")) {
        stamps.push(new Date(r.recorded_at).getTime());
      }
    }
    const spanDays = (Math.max(...stamps) - Math.min(...stamps)) / 86_400_000;
    expect(spanDays).toBeGreaterThanOrEqual(500);
    // and not all bunched: at least 8 distinct days
    const days = new Set(stamps.map((t) => Math.floor(t / 86_400_000)));
    expect(days.size).toBeGreaterThanOrEqual(8);
  });

  it("stores file artifacts as storage keys, never bytes in Postgres", async () => {
    const files = await rows<{ source_kind: string; storage_key: string | null }>(
      "artifact",
    );
    const fileArtifacts = files.filter((f) => f.source_kind === "file");
    expect(fileArtifacts.length).toBeGreaterThanOrEqual(2);
    for (const f of fileArtifacts) {
      expect(f.storage_key).toMatch(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/.+/);
    }
  });
});
