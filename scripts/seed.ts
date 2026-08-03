/**
 * Atlas seed: one org, three users (analyst / pm / admin), five entities from
 * EDGAR, and eighteen months of research history with explicit recorded_at
 * timestamps — so the "as of" control is testable and append-only behavior
 * is visible from the first boot.
 *
 * Runs with the service role (bypasses RLS): seeding is infrastructure, not
 * an application write. The app itself never sets recorded_at and never
 * updates or deletes.
 *
 * Includes, per spec:
 *  - Apple scored twice with a genuine change of mind (pricing power 9 -> 6)
 *  - Visa position where computed weight (4.0) and chosen weight (6.5) diverge
 *  - an artifact version chain (Costco model re-uploaded, same content hash)
 *  - a tombstoned artifact (Moody's stale note retracted in 2026)
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { env } from "../lib/env";
import { sha256Hex } from "../lib/hash";

const admin = createClient(
  env("NEXT_PUBLIC_SUPABASE_URL"),
  env("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const BUCKET = env("SUPABASE_STORAGE_BUCKET");

// ── helpers ─────────────────────────────────────────────────────────────────

function fail(step: string, error: unknown): never {
  console.error(`Seed failed at: ${step}`);
  console.error(error);
  process.exit(1);
}

async function insert<T extends object>(
  table: string,
  row: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await admin.from(table).insert(row).select().single();
  if (error) fail(`insert into ${table}: ${JSON.stringify(row).slice(0, 120)}`, error);
  return data as T;
}

interface EdgarIdentity {
  name: string;
  tickers: string[];
  formerNames: { name: string; from: string | null; to: string | null }[];
}

/** Live EDGAR fetch (proper User-Agent) with checked-in fixture fallback. */
async function edgarCompany(cik: string): Promise<EdgarIdentity> {
  try {
    const res = await fetch(
      `${env("EDGAR_DATA_BASE_URL")}/submissions/CIK${cik}.json`,
      { headers: { "User-Agent": env("EDGAR_USER_AGENT") } },
    );
    if (res.ok) {
      const j = (await res.json()) as EdgarIdentity & Record<string, unknown>;
      return {
        name: j.name,
        tickers: j.tickers ?? [],
        formerNames: (j.formerNames ?? []).map((f) => ({
          name: f.name,
          from: f.from ?? null,
          to: f.to ?? null,
        })),
      };
    }
    console.warn(`EDGAR ${cik}: HTTP ${res.status}, using fixture`);
  } catch {
    console.warn(`EDGAR ${cik}: network unavailable, using fixture`);
  }
  const j = JSON.parse(await readFile(`fixtures/edgar/CIK${cik}.json`, "utf8"));
  return { name: j.name, tickers: j.tickers ?? [], formerNames: j.formerNames ?? [] };
}

// ── wipe (idempotent re-seed) ───────────────────────────────────────────────

async function wipe() {
  // FK-safe order. Service-role deletes are seed infrastructure only; the
  // application role cannot delete anything (see 20260803000002_rls.sql).
  for (const table of [
    "decision",
    "position_input",
    "scenario",
    "quality_score",
    "artifact_entity",
    "artifact",
    "entity_alias",
    "entity",
    "profile",
    "org",
  ]) {
    const { error } = await admin
      .from(table)
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000")
      .select();
    // profile keys on user_id, not id
    if (error && table === "profile") {
      await admin.from(table).delete().neq("user_id", "00000000-0000-0000-0000-000000000000");
    } else if (error) {
      fail(`wipe ${table}`, error);
    }
  }

  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of users?.users ?? []) {
    if (u.email?.endsWith("@atlas.test")) await admin.auth.admin.deleteUser(u.id);
  }

  const { data: objects } = await admin.storage.from(BUCKET).list(undefined, { limit: 1 });
  if (objects) {
    // bucket exists; clear org folders
    const { data: tops } = await admin.storage.from(BUCKET).list();
    for (const top of tops ?? []) {
      const { data: mids } = await admin.storage.from(BUCKET).list(top.name);
      for (const mid of mids ?? []) {
        const { data: leaves } = await admin.storage
          .from(BUCKET)
          .list(`${top.name}/${mid.name}`);
        if (leaves?.length) {
          await admin.storage
            .from(BUCKET)
            .remove(leaves.map((l) => `${top.name}/${mid.name}/${l.name}`));
        }
      }
    }
  }
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Seeding Atlas…");
  await wipe();

  // storage bucket (name from env — repointing later is a config change)
  const { error: bucketErr } = await admin.storage.createBucket(BUCKET, {
    public: false,
  });
  if (bucketErr && !/already exists/i.test(bucketErr.message)) {
    fail("create bucket", bucketErr);
  }

  // org
  const org = await insert<{ id: string }>("org", {
    name: "Meridian Capital Partners",
  });
  const orgId = org.id;

  // users — app_metadata carries the org and role claims RLS keys on
  const password = env("SEED_USER_PASSWORD");
  const mkUser = async (email: string, displayName: string, role: string) => {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { org_id: orgId, role },
    });
    if (error || !data.user) fail(`create user ${email}`, error);
    await insert("profile", {
      user_id: data.user.id,
      org_id: orgId,
      email,
      display_name: displayName,
      role,
    });
    return data.user.id;
  };

  const alice = await mkUser("alice.analyst@atlas.test", "Alice Okafor", "analyst");
  const pete = await mkUser("pete.pm@atlas.test", "Pete Marsh", "pm");
  const ada = await mkUser("ada.admin@atlas.test", "Ada Voss", "admin");

  // ── entities + aliases from EDGAR (created by admin, Feb 2025) ────────────
  const CIKS = {
    apple: "0000320193",
    microsoft: "0000789019",
    costco: "0000909832",
    visa: "0001403161",
    moodys: "0001059556",
  } as const;

  const entities: Record<keyof typeof CIKS, string> = {} as never;
  const T0 = "2025-02-03T09:00:00Z"; // eighteen months before today (2026-08-03)

  let entityHour = 9;
  for (const [key, cik] of Object.entries(CIKS) as [keyof typeof CIKS, string][]) {
    const identity = await edgarCompany(cik);
    const recordedAt = `2025-02-03T${String(entityHour++).padStart(2, "0")}:00:00Z`;

    const entity = await insert<{ id: string }>("entity", {
      org_id: orgId,
      cik,
      created_by: ada,
      valid_at: recordedAt,
      recorded_at: recordedAt,
    });
    entities[key] = entity.id;

    const alias = (
      alias_type: string,
      value: string,
      valid_at: string = recordedAt,
    ) =>
      insert("entity_alias", {
        org_id: orgId,
        entity_id: entity.id,
        alias_type,
        value,
        created_by: ada,
        valid_at,
        recorded_at: recordedAt,
      });

    await alias("legal_name", identity.name);
    for (const t of identity.tickers) await alias("ticker", t);
    for (const f of identity.formerNames) {
      await alias("former_name", f.name, f.from ?? recordedAt);
    }
  }

  // internal aliases — the names the old Evernote folders / Excel files use,
  // so later import passes can match against them
  const internalAlias = (
    entity: string,
    value: string,
    recorded_at: string,
  ) =>
    insert("entity_alias", {
      org_id: orgId,
      entity_id: entity,
      alias_type: "internal",
      value,
      created_by: ada,
      valid_at: recorded_at,
      recorded_at,
    });

  await internalAlias(entities.apple, "Project Orchard", "2025-02-05T10:00:00Z");
  await internalAlias(entities.costco, "COST primer folder", "2025-02-05T10:05:00Z");
  // recorded much later: flips visibility under the as-of control
  await internalAlias(entities.visa, "V — payments primer", "2026-04-01T09:30:00Z");

  // ── artifacts ─────────────────────────────────────────────────────────────
  interface ArtifactSpec {
    entity: string;
    artifact_type: string;
    source_kind: "url" | "paste" | "file";
    title: string;
    author: string;
    summary: string;
    url?: string;
    body?: string;
    valid_at: string;
    recorded_at: string;
    supersedes?: string;
    fileBytes?: Buffer;
    fileName?: string;
  }

  const artifactIds: Record<string, string> = {};

  const addArtifact = async (key: string, spec: ArtifactSpec) => {
    let storage_key: string | null = null;
    let content_hash: string;

    if (spec.source_kind === "file") {
      const bytes = spec.fileBytes ?? Buffer.from("");
      content_hash = sha256Hex(bytes);
      storage_key = `${orgId}/${randomUUID()}/${spec.fileName}`;
      const { error } = await admin.storage
        .from(BUCKET)
        .upload(storage_key, bytes, { contentType: "text/csv" });
      if (error) fail(`upload ${spec.fileName}`, error);
    } else if (spec.source_kind === "paste") {
      content_hash = sha256Hex(spec.body ?? "");
    } else {
      content_hash = sha256Hex(spec.url ?? "");
    }

    const row = await insert<{ id: string }>("artifact", {
      org_id: orgId,
      artifact_type: spec.artifact_type,
      source_kind: spec.source_kind,
      title: spec.title,
      author: spec.author,
      summary: spec.summary,
      storage_key,
      url: spec.url ?? null,
      body: spec.body ?? null,
      content_hash,
      created_by: alice,
      valid_at: spec.valid_at,
      recorded_at: spec.recorded_at,
      supersedes: spec.supersedes ?? null,
    });
    artifactIds[key] = row.id;

    await insert("artifact_entity", {
      org_id: orgId,
      artifact_id: row.id,
      entity_id: spec.entity,
      created_by: alice,
      valid_at: spec.valid_at,
      recorded_at: spec.recorded_at,
    });
    return row.id;
  };

  // Apple
  await addArtifact("apple_primer", {
    entity: entities.apple,
    artifact_type: "primer",
    source_kind: "paste",
    title: "Apple — franchise primer",
    author: "Alice Okafor",
    summary: "Installed base economics, services attach, capital return machine.",
    body: "Lifted from Evernote: Apple's installed base exceeds 2.2bn devices. Services gross margin ~74% vs hardware ~37%. The franchise question is whether the attach rate keeps compounding once hardware upgrade cycles lengthen…",
    valid_at: "2025-02-20T00:00:00Z",
    recorded_at: "2025-02-21T14:00:00Z",
  });
  await addArtifact("apple_10k", {
    entity: entities.apple,
    artifact_type: "filing",
    source_kind: "url",
    title: "Apple 10-K FY2024",
    author: "SEC EDGAR",
    summary: "Annual report; segment detail for services vs products.",
    url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=10-K",
    valid_at: "2024-11-01T00:00:00Z",
    recorded_at: "2025-02-22T09:30:00Z",
  });
  await addArtifact("apple_call", {
    entity: entities.apple,
    artifact_type: "transcript",
    source_kind: "url",
    title: "Apple Q1 FY2026 earnings call",
    author: "IR",
    summary: "Management on services deceleration and China hardware softness.",
    url: "https://www.apple.com/investor/earnings-call/",
    valid_at: "2026-01-30T00:00:00Z",
    recorded_at: "2026-02-02T08:15:00Z",
  });
  await addArtifact("apple_attach_note", {
    entity: entities.apple,
    artifact_type: "note",
    source_kind: "paste",
    title: "Services attach-rate concern",
    author: "Alice Okafor",
    summary: "Attach-rate curve is flattening; pricing umbrella narrower than assumed.",
    body: "Q1 FY26 detail implies services net adds per active device declined y/y for the second straight quarter. If the attach curve is flattening, the pricing umbrella over the ecosystem is narrower than we assumed in the 2025 scoring…",
    valid_at: "2026-02-10T00:00:00Z",
    recorded_at: "2026-02-12T16:45:00Z",
  });

  // Microsoft
  await addArtifact("msft_primer", {
    entity: entities.microsoft,
    artifact_type: "primer",
    source_kind: "paste",
    title: "Microsoft — hyperscale annuity primer",
    author: "Alice Okafor",
    summary: "Azure consumption + M365 seat annuity; capex intensity the swing factor.",
    body: "Commercial bookings growth vs capex intensity is the tension. The annuity base (M365 E5, GitHub, Dynamics) funds the Azure land-grab…",
    valid_at: "2025-05-10T00:00:00Z",
    recorded_at: "2025-05-12T11:00:00Z",
  });
  await addArtifact("msft_10k", {
    entity: entities.microsoft,
    artifact_type: "filing",
    source_kind: "url",
    title: "Microsoft 10-K FY2024",
    author: "SEC EDGAR",
    summary: "Annual report; segment KPIs and lease commitments.",
    url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000789019&type=10-K",
    valid_at: "2024-07-30T00:00:00Z",
    recorded_at: "2025-05-12T11:05:00Z",
  });
  await addArtifact("msft_capex_note", {
    entity: entities.microsoft,
    artifact_type: "note",
    source_kind: "paste",
    title: "Azure capex step-up — durability check",
    author: "Alice Okafor",
    summary: "AI capex pushes incremental capital intensity up; ROIIC math still holds if utilization ramps.",
    body: "FY26 capex guide implies ~2x the FY24 run-rate. Incremental ROIC dips near-term; the question is contracted backlog coverage…",
    valid_at: "2025-11-05T00:00:00Z",
    recorded_at: "2025-11-10T10:30:00Z",
  });

  // Costco — file artifact with a genuine version chain (same content hash)
  const costcoModelBytes = Buffer.from(
    "metric,FY24,FY25E,FY26E\nmembership_fee_income,4800,5300,5900\nrenewal_rate_us,0.927,0.93,0.93\nwarehouse_count,890,914,940\nfcf,7500,8200,9100\n",
  );
  const costcoV1 = await addArtifact("costco_model_v1", {
    entity: entities.costco,
    artifact_type: "model",
    source_kind: "file",
    title: "Costco membership model",
    author: "Alice Okafor",
    summary: "Membership economics model; fee income and renewal-rate drivers.",
    fileBytes: costcoModelBytes,
    fileName: "costco-membership-model.csv",
    valid_at: "2025-05-15T00:00:00Z",
    recorded_at: "2025-05-20T15:00:00Z",
  });
  await addArtifact("costco_model_v2", {
    entity: entities.costco,
    artifact_type: "model",
    source_kind: "file",
    title: "Costco membership model",
    author: "Alice Okafor",
    summary: "Re-uploaded from shared drive during migration; content identical (hash match) — recorded as a new version, not a duplicate.",
    fileBytes: costcoModelBytes,
    fileName: "costco-membership-model.csv",
    valid_at: "2025-05-15T00:00:00Z",
    recorded_at: "2026-01-22T09:00:00Z",
    supersedes: costcoV1,
  });
  await addArtifact("costco_fee_note", {
    entity: entities.costco,
    artifact_type: "note",
    source_kind: "paste",
    title: "Membership fee increase — timing",
    author: "Alice Okafor",
    summary: "Fee hike cadence suggests 2025 increase; elasticity near zero historically.",
    body: "Historical cadence: 2011, 2017, 2024. Renewal rates held >90% through every increase — the cleanest pricing-power series we track…",
    valid_at: "2025-07-01T00:00:00Z",
    recorded_at: "2025-07-03T13:20:00Z",
  });

  // Visa
  await addArtifact("visa_primer", {
    entity: entities.visa,
    artifact_type: "primer",
    source_kind: "paste",
    title: "Visa — network economics primer",
    author: "Alice Okafor",
    summary: "Four-party model; take-rate stability; cross-border mix as the margin lever.",
    body: "The network is the moat: 4.5bn credentials × 130m acceptance points. Incremental transaction cost ≈ zero…",
    valid_at: "2025-03-25T00:00:00Z",
    recorded_at: "2025-03-28T10:00:00Z",
  });
  await addArtifact("visa_thesis", {
    entity: entities.visa,
    artifact_type: "thesis",
    source_kind: "paste",
    title: "Visa — long thesis",
    author: "Alice Okafor",
    summary: "Cash-to-card runway + new flows; entry IRR ~12% at prevailing multiple.",
    body: "Thesis: volume growth 9-11%, buybacks ~2%, modest multiple compression still yields low-teens IRR. Key risk: regulated interchange contagion…",
    valid_at: "2025-04-10T00:00:00Z",
    recorded_at: "2025-04-12T09:45:00Z",
  });
  await addArtifact("visa_reg_note", {
    entity: entities.visa,
    artifact_type: "note",
    source_kind: "paste",
    title: "Interchange headline risk — reassessment",
    author: "Alice Okafor",
    summary: "CCCA re-introduction chatter; network take-rates likely insulated.",
    body: "Even under credit routing mandates, network fees (vs interchange) are not the bill's target. Skew improves as headline discount widens…",
    valid_at: "2026-05-01T00:00:00Z",
    recorded_at: "2026-07-20T11:10:00Z",
  });

  // Moody's — one artifact that gets tombstoned in 2026
  const moodysStale = await addArtifact("moodys_stale_note", {
    entity: entities.moodys,
    artifact_type: "note",
    source_kind: "paste",
    title: "Moody's — issuance recovery note (stale)",
    author: "Alice Okafor",
    summary: "2025 issuance recovery scenario. Retracted in 2026: superseded by events.",
    body: "Refi wall math from 2024 vintage data. NOTE (2026): thesis text referenced maturity schedules that were refinanced early; retracted rather than edited — the record stands…",
    valid_at: "2025-03-01T00:00:00Z",
    recorded_at: "2025-03-05T14:30:00Z",
  });
  await addArtifact("moodys_primer", {
    entity: entities.moodys,
    artifact_type: "primer",
    source_kind: "paste",
    title: "Moody's — ratings duopoly primer",
    author: "Alice Okafor",
    summary: "Issuer-pays duopoly; pricing +3-4%/yr; analytics as the second engine.",
    body: "Ratings: regulatory moat via NRSRO status plus network effects in benchmark curves. MA: sticky risk/compliance data subscriptions…",
    valid_at: "2025-08-15T00:00:00Z",
    recorded_at: "2025-08-18T10:00:00Z",
  });

  // tombstone row: "deleting" is a new row with the tombstone flag
  await insert("artifact", {
    org_id: orgId,
    artifact_type: "note",
    source_kind: "paste",
    title: "Moody's — issuance recovery note (stale)",
    author: "Alice Okafor",
    summary: "Tombstone: note retracted, history preserved.",
    body: null,
    content_hash: null,
    created_by: alice,
    valid_at: "2026-03-15T00:00:00Z",
    recorded_at: "2026-03-15T09:00:00Z",
    supersedes: moodysStale,
    is_tombstone: true,
  });

  // ── quality scores ────────────────────────────────────────────────────────
  const a = artifactIds;

  const score = (
    entity: string,
    revision_kind: string,
    valid_at: string,
    recorded_at: string,
    metrics: Record<string, [number, string, string[]]>,
    supersedes: string | null = null,
  ) =>
    insert<{ id: string }>("quality_score", {
      org_id: orgId,
      entity_id: entity,
      revision_kind,
      management_score: metrics.management[0],
      management_reasoning: metrics.management[1],
      management_evidence: metrics.management[2],
      pricing_power_score: metrics.pricing_power[0],
      pricing_power_reasoning: metrics.pricing_power[1],
      pricing_power_evidence: metrics.pricing_power[2],
      roiic_moat_score: metrics.roiic_moat[0],
      roiic_moat_reasoning: metrics.roiic_moat[1],
      roiic_moat_evidence: metrics.roiic_moat[2],
      balance_sheet_score: metrics.balance_sheet[0],
      balance_sheet_reasoning: metrics.balance_sheet[1],
      balance_sheet_evidence: metrics.balance_sheet[2],
      growth_durability_score: metrics.growth_durability[0],
      growth_durability_reasoning: metrics.growth_durability[1],
      growth_durability_evidence: metrics.growth_durability[2],
      created_by: alice,
      valid_at,
      recorded_at,
      supersedes,
    });

  const appleScore1 = await score(
    entities.apple,
    "initial",
    "2025-03-10T00:00:00Z",
    "2025-03-10T15:00:00Z",
    {
      management: [8, "Disciplined capital allocators; buyback machine offsets modest strategic risk appetite.", [a.apple_primer]],
      pricing_power: [9, "Ecosystem lock-in supports premium pricing across hardware and services; no discounting behavior observed.", [a.apple_primer, a.apple_10k]],
      roiic_moat: [9, "Installed-base moat converts to extraordinary returns on the incremental dollar; services mix raises it further.", [a.apple_10k]],
      balance_sheet: [8, "Net cash neutral target; gross cash comfortably funds any plausible capital program.", [a.apple_10k]],
      growth_durability: [7, "Hardware cycle dependence tempers durability; services annuity partially offsets.", [a.apple_primer, a.apple_10k]],
    },
  );

  const appleScore2 = await score(
    entities.apple,
    "change_of_mind",
    "2026-02-20T00:00:00Z",
    "2026-02-20T16:30:00Z",
    {
      management: [8, "Unchanged: allocation discipline intact through the cycle.", [a.apple_call]],
      pricing_power: [6, "CHANGED VIEW: services attach-rate curve is flattening and China hardware pricing is under visible pressure — the pricing umbrella is narrower than we believed in 2025.", [a.apple_attach_note, a.apple_call]],
      roiic_moat: [8, "Moat intact but incremental returns compress as services growth decelerates.", [a.apple_call]],
      balance_sheet: [8, "Unchanged: fortress remains.", [a.apple_call]],
      growth_durability: [6, "Durability downgraded with the attach-rate evidence; upgrade-cycle elongation now the base case.", [a.apple_attach_note]],
    },
    appleScore1.id,
  );

  const msftScore1 = await score(
    entities.microsoft,
    "initial",
    "2025-06-15T00:00:00Z",
    "2025-06-15T11:00:00Z",
    {
      management: [9, "Exceptional strategic repositioning record; consistent ROIC discipline in M&A since 2014.", [a.msft_primer]],
      pricing_power: [8, "Seat-based annuity pricing raised repeatedly with negligible churn; E5 mix shift is a price rise in disguise.", [a.msft_primer]],
      roiic_moat: [9, "Enterprise switching costs plus hyperscale scale economics; incremental margins prove it.", [a.msft_10k]],
      balance_sheet: [9, "AAA-adjacent; capex program self-funded with room to spare.", [a.msft_10k]],
      growth_durability: [8, "Multi-engine growth (Azure, M365, gaming); AI demand extends the runway.", [a.msft_primer, a.msft_10k]],
    },
  );

  await score(
    entities.microsoft,
    "refinement",
    "2025-11-20T00:00:00Z",
    "2025-11-20T14:00:00Z",
    {
      management: [9, "Refined, not changed: capex step-up is aggressive but contract-backed.", [a.msft_capex_note]],
      pricing_power: [8, "Unchanged; Copilot seat pricing lands without pushback.", [a.msft_primer]],
      roiic_moat: [9, "Refined: near-term ROIIC dips on AI capex; backlog coverage keeps the through-cycle number intact.", [a.msft_capex_note]],
      balance_sheet: [8, "One notch down: lease obligations and capex commitments meaningfully larger.", [a.msft_capex_note]],
      growth_durability: [8, "Unchanged.", [a.msft_capex_note]],
    },
    msftScore1.id,
  );

  // ── scenarios ─────────────────────────────────────────────────────────────
  const scenario = (
    entity: string,
    kind: string,
    title: string,
    narrative: string,
    probability: number,
    valid_at: string,
    recorded_at: string,
  ) =>
    insert("scenario", {
      org_id: orgId,
      entity_id: entity,
      scenario_kind: kind,
      title,
      narrative,
      probability,
      created_by: alice,
      valid_at,
      recorded_at,
    });

  await scenario(entities.apple, "bull", "Services re-acceleration", "Attach rate re-steepens on AI features; services grows mid-teens; multiple holds.", 0.25, "2025-03-12T00:00:00Z", "2025-03-12T10:00:00Z");
  await scenario(entities.apple, "base", "Annuity grind", "Hardware flat, services low-double-digit; buybacks carry EPS; multiple drifts.", 0.55, "2025-03-12T00:00:00Z", "2025-03-12T10:05:00Z");
  await scenario(entities.apple, "bear", "Cycle + China", "Elongated upgrade cycle meets China share loss; services follows hardware down.", 0.2, "2025-03-12T00:00:00Z", "2025-03-12T10:10:00Z");
  await scenario(entities.visa, "base", "Cash-to-card grind", "Volume 9-11%, new flows accrete, take-rate stable; low-teens IRR at entry.", 0.6, "2025-04-12T00:00:00Z", "2025-04-12T10:00:00Z");

  // ── position inputs ───────────────────────────────────────────────────────
  const position = (
    entity: string,
    row: {
      irr: number;
      skew: number;
      conviction: number;
      fcf_growth: number;
      computed_weight: number | null;
      chosen_weight: number;
      rationale: string;
      valid_at: string;
      recorded_at: string;
      supersedes?: string;
    },
  ) =>
    insert<{ id: string }>("position_input", {
      org_id: orgId,
      entity_id: entity,
      created_by: pete,
      ...row,
      supersedes: row.supersedes ?? null,
    });

  const visaP1 = await position(entities.visa, {
    irr: 0.12,
    skew: 2.5,
    conviction: 7,
    fcf_growth: 0.11,
    computed_weight: 3.5,
    chosen_weight: 3.5,
    rationale: "Initiation at model weight; no reason to deviate at entry.",
    valid_at: "2025-04-14T00:00:00Z",
    recorded_at: "2025-04-14T16:00:00Z",
  });

  const visaP2 = await position(entities.visa, {
    irr: 0.13,
    skew: 2.8,
    conviction: 8,
    fcf_growth: 0.12,
    computed_weight: 4.2,
    chosen_weight: 4.5,
    rationale: "Slight overweight vs model on cross-border momentum.",
    valid_at: "2025-10-06T00:00:00Z",
    recorded_at: "2025-10-06T15:30:00Z",
    supersedes: visaP1.id,
  });

  const visaP3 = await position(entities.visa, {
    irr: 0.15,
    skew: 3.4,
    conviction: 9,
    fcf_growth: 0.13,
    computed_weight: 4.0,
    chosen_weight: 6.5,
    rationale:
      "DELIBERATE OVERRIDE: model penalizes the regulatory headline, but our work (interchange note) says network economics are insulated. Sizing on conviction; the gap vs the formula is the judgment being recorded.",
    valid_at: "2026-05-11T00:00:00Z",
    recorded_at: "2026-05-11T14:45:00Z",
    supersedes: visaP2.id,
  });

  const appleP1 = await position(entities.apple, {
    irr: 0.1,
    skew: 1.9,
    conviction: 7,
    fcf_growth: 0.07,
    computed_weight: 3.0,
    chosen_weight: 3.0,
    rationale: "At model weight.",
    valid_at: "2025-05-02T00:00:00Z",
    recorded_at: "2025-05-02T11:00:00Z",
  });

  const appleP2 = await position(entities.apple, {
    irr: 0.09,
    skew: 1.6,
    conviction: 6,
    fcf_growth: 0.05,
    computed_weight: 2.5,
    chosen_weight: 2.5,
    rationale: "Trim to model weight after the February re-score (changed view on pricing power).",
    valid_at: "2026-03-02T00:00:00Z",
    recorded_at: "2026-03-02T10:15:00Z",
    supersedes: appleP1.id,
  });

  await position(entities.costco, {
    irr: 0.08,
    skew: 1.4,
    conviction: 8,
    fcf_growth: 0.09,
    computed_weight: 2.0,
    chosen_weight: 2.5,
    rationale: "Quality premium above model; entry discipline argues small.",
    valid_at: "2025-09-08T00:00:00Z",
    recorded_at: "2025-09-08T13:00:00Z",
  });

  // ── decisions — explicit FKs to what was current at the moment ────────────
  const decision = (
    entity: string,
    row: {
      decision_type: string;
      summary: string;
      position_input_id: string;
      quality_score_id: string | null;
      valid_at: string;
      recorded_at: string;
    },
  ) =>
    insert("decision", {
      org_id: orgId,
      entity_id: entity,
      created_by: pete,
      ...row,
    });

  await decision(entities.visa, {
    decision_type: "initiate",
    summary: "Initiate Visa at 3.5% — thesis and primer complete, entry IRR ~12%.",
    position_input_id: visaP1.id,
    quality_score_id: null,
    valid_at: "2025-04-15T00:00:00Z",
    recorded_at: "2025-04-15T09:30:00Z",
  });

  await decision(entities.apple, {
    decision_type: "hold",
    summary:
      "Hold Apple at reduced 2.5% after the changed view on pricing power; not exiting — moat and balance sheet intact.",
    position_input_id: appleP2.id,
    quality_score_id: appleScore2.id,
    valid_at: "2026-03-03T00:00:00Z",
    recorded_at: "2026-03-03T09:00:00Z",
  });

  await decision(entities.visa, {
    decision_type: "increase",
    summary:
      "Increase Visa to 6.5% — deliberate override of the 4.0% model weight; divergence documented in the position input.",
    position_input_id: visaP3.id,
    quality_score_id: null,
    valid_at: "2026-05-12T00:00:00Z",
    recorded_at: "2026-05-12T10:00:00Z",
  });

  // ── summary ───────────────────────────────────────────────────────────────
  const count = async (t: string) => {
    const { count: c } = await admin.from(t).select("*", { count: "exact", head: true });
    return c ?? 0;
  };

  console.log("Seed complete:");
  for (const t of [
    "org",
    "profile",
    "entity",
    "entity_alias",
    "artifact",
    "artifact_entity",
    "quality_score",
    "scenario",
    "position_input",
    "decision",
  ]) {
    console.log(`  ${t}: ${await count(t)}`);
  }
  console.log(`
Logins (password: $SEED_USER_PASSWORD):
  alice.analyst@atlas.test  (analyst)
  pete.pm@atlas.test        (pm)
  ada.admin@atlas.test      (admin)`);
}

main().catch((e) => fail("main", e));
