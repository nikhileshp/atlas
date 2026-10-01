import { describe, it, expect } from "vitest";
import { buildAliasIndex, suggestEntities, initialStatus } from "@/lib/import/match";
import type { AliasRow } from "@/lib/types";

const base = { id: "", org_id: "o", created_by: "u", valid_at: "2024-01-01T00:00:00Z", recorded_at: "2024-01-01T00:00:00Z", supersedes: null, is_tombstone: false };
const alias = (entity_id: string, alias_type: AliasRow["alias_type"], value: string): AliasRow =>
  ({ ...base, id: `${entity_id}-${alias_type}-${value}`, entity_id, alias_type, value }) as AliasRow;

const aliases: AliasRow[] = [
  alias("apple", "legal_name", "Apple Inc."),
  alias("apple", "ticker", "AAPL"),
  alias("visa", "legal_name", "Visa Inc."),
  alias("visa", "ticker", "V"),
  alias("visa", "internal", "Visa"),
  alias("costco", "legal_name", "Costco Wholesale Corporation"),
  alias("costco", "ticker", "COST"),
  alias("costco", "internal", "Costco"),
];
const index = buildAliasIndex(aliases);

describe("suggestEntities", () => {
  it("matches a ticker as a whole uppercase word", () => {
    expect(suggestEntities(index, "AAPL mgmt call", "")).toEqual(["apple"]);
    expect(suggestEntities(index, "", "the AAPLE thing")).toEqual([]);
    expect(suggestEntities(index, "", "we like aapl")).toEqual([]); // case-sensitive tickers
  });

  it("does not match a one-letter ticker inside ordinary words but does as a word", () => {
    expect(suggestEntities(index, "", "a very good quarter")).toEqual([]);
    expect(suggestEntities(index, "", "V takes price in cross-border")).toEqual(["visa"]);
  });

  it("matches names case-insensitively, including punctuation in the alias", () => {
    expect(suggestEntities(index, "", "long apple inc. since 2019")).toEqual(["apple"]);
    expect(suggestEntities(index, "", "Costco keeps fees flat")).toEqual(["costco"]);
  });

  it("ranks a title match above a body match", () => {
    expect(suggestEntities(index, "Costco vs Visa: pricing", "Apple Inc. mentioned in passing")).toEqual(["costco", "visa", "apple"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(suggestEntities(index, "General market thoughts", "Rates higher for longer.")).toEqual([]);
  });
});

describe("initialStatus", () => {
  it("duplicates are excluded regardless of matches", () => {
    expect(initialStatus(["apple"], "art-1")).toEqual({ status: "duplicate", include: false });
  });
  it("unmatched items are excluded", () => {
    expect(initialStatus([], null)).toEqual({ status: "unmatched", include: false });
  });
  it("matched items are pending and included", () => {
    expect(initialStatus(["apple"], null)).toEqual({ status: "pending", include: true });
  });
});
