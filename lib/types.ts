// Row types for the Atlas schema (supabase/migrations/20260803000001_schema.sql).

export type Role = "analyst" | "pm" | "admin";

export interface Profile {
  user_id: string;
  org_id: string;
  email: string;
  display_name: string;
  role: Role;
  created_at: string;
  removed_at: string | null;
}

/** Uniform bitemporal/append-only base columns on research tables. */
export interface BaseRow {
  id: string;
  org_id: string;
  created_by: string;
  valid_at: string;
  recorded_at: string;
  supersedes: string | null;
  is_tombstone: boolean;
}

export interface EntityRow {
  id: string;
  org_id: string;
  cik: string;
  created_by: string;
  valid_at: string;
  recorded_at: string;
}

export type AliasType =
  | "legal_name"
  | "ticker"
  | "former_name"
  | "figi"
  | "lei"
  | "internal";

export interface AliasRow extends BaseRow {
  entity_id: string;
  alias_type: AliasType;
  value: string;
}

export type ArtifactType =
  | "note"
  | "model"
  | "primer"
  | "thesis"
  | "filing"
  | "transcript"
  | "other";

export type SourceKind = "file" | "url" | "paste";

export interface ArtifactRow extends BaseRow {
  artifact_type: ArtifactType;
  source_kind: SourceKind;
  title: string;
  author: string;
  summary: string;
  storage_key: string | null;
  url: string | null;
  body: string | null;
  content_hash: string | null;
}

export interface ArtifactEntityRow extends BaseRow {
  artifact_id: string;
  entity_id: string;
}

// The five metrics form a causal chain, not orthogonal axes; the scoring
// form walks them in this order and shows upstream answers as it goes.
export const METRICS = [
  {
    key: "management",
    label: "Management quality",
    rationale:
      "Management stewards capital allocation — every downstream judgment assumes these hands on the wheel.",
  },
  {
    key: "pricing_power",
    label: "Pricing power",
    rationale: "Pricing power is a source of moat, not a consequence of it.",
  },
  {
    key: "roiic_moat",
    label: "ROIIC & economic moat",
    rationale:
      "The moat sustains returns on incremental invested capital; without one, high ROIIC mean-reverts.",
  },
  {
    key: "balance_sheet",
    label: "Balance sheet quality",
    rationale:
      "The balance sheet governs whether the growth you are about to underwrite is fundable.",
  },
  {
    key: "growth_durability",
    label: "FCF & earnings growth durability",
    rationale:
      "Growth durability is the conclusion of the chain above, not an independent premise.",
  },
] as const;

export type MetricKey = (typeof METRICS)[number]["key"];

export type RevisionKind = "initial" | "refinement" | "change_of_mind";

export type QualityScoreRow = BaseRow & {
  entity_id: string;
  revision_kind: RevisionKind;
} & {
  [K in MetricKey as `${K}_score`]: number;
} & {
  [K in MetricKey as `${K}_reasoning`]: string;
} & {
  [K in MetricKey as `${K}_evidence`]: string[];
};

export type ScenarioKind = "bull" | "base" | "bear" | "other";

export interface ScenarioRow extends BaseRow {
  entity_id: string;
  scenario_kind: ScenarioKind;
  title: string;
  narrative: string;
  probability: number | null;
}

export interface PositionInputRow extends BaseRow {
  entity_id: string;
  irr: number;
  skew: number;
  conviction: number;
  fcf_growth: number;
  computed_weight: number | null;
  chosen_weight: number;
  rationale: string;
}

export type DecisionType = "initiate" | "increase" | "decrease" | "exit" | "hold";

export interface DecisionRow extends BaseRow {
  entity_id: string;
  decision_type: DecisionType;
  summary: string;
  position_input_id: string;
  quality_score_id: string | null;
}
