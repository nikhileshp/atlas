/**
 * Regressions from the whole-branch review: parser edge cases, short-ticker
 * matching, review-patch whitelisting, and the export size limit.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { splitCompleteNotes, parseNoteBlock } from "@/lib/import/enex";
import { enmlToText } from "@/lib/import/enml";
import { buildAliasIndex, suggestEntities } from "@/lib/import/match";
import { sanitizeItemPatch } from "@/lib/import/review";
import { exportTooLarge, MAX_EXPORT_BYTES } from "@/lib/import/limits";
import type { AliasRow } from "@/lib/types";

const EDGE = readFileSync("fixtures/enex/edge.enex");
const notes = splitCompleteNotes(EDGE, true).blocks.map((b) => parseNoteBlock(b.toString("utf8")));

describe("ENEX edge cases", () => {
  it("keeps numeric- and boolean-looking titles as text", () => {
    expect(notes.map((n) => n.title)).toEqual(["0700", "Image only clip", "Shared deck A", "Shared deck B", "true"]);
  });

  it("separates table cells and decodes typographic entities", () => {
    expect(notes[0].text).toBe("Open at 0700 — watch AT&T and IT spending. R&D up.\nRev\t100");
  });

  it("yields empty text for an image-only note", () => {
    expect(notes[1].text).toBe("");
    expect(notes[1].imagesSkipped).toBe(1);
    expect(notes[1].documents).toEqual([]);
  });

  it("gives a nameless spreadsheet resource a usable file name", () => {
    expect(notes[4].documents).toHaveLength(1);
    expect(notes[4].documents[0].fileName).toBe("attachment.xlsx");
  });

  it("does not throw on an out-of-range numeric entity", () => {
    expect(enmlToText("<en-note>a&#99999999;b</en-note>", new Map())).toBe("a&#99999999;b");
  });
});

const base = { id: "", org_id: "o", created_by: "u", valid_at: "2024-01-01T00:00:00Z", recorded_at: "2024-01-01T00:00:00Z", supersedes: null, is_tombstone: false };
const ticker = (entity_id: string, value: string): AliasRow =>
  ({ ...base, id: `${entity_id}-${value}`, entity_id, alias_type: "ticker", value }) as AliasRow;
const shortIndex = buildAliasIndex([ticker("att", "T"), ticker("gartner", "IT"), ticker("agilent", "A"), ticker("macys", "M"), ticker("visa", "V"), ticker("apple", "AAPL")]);

describe("short tickers", () => {
  it("do not match bare one- or two-letter words in prose or titles", () => {
    expect(suggestEntities(shortIndex, "Thoughts on M&A", "A quick note. AT&T and IT spending. R&D. V takes price.")).toEqual([]);
  });

  it("match in explicit forms: $T, (T), NYSE: T, NASDAQ:T", () => {
    expect(suggestEntities(shortIndex, "", "long $V here")).toEqual(["visa"]);
    expect(suggestEntities(shortIndex, "", "Gartner (IT) guided up")).toEqual(["gartner"]);
    expect(suggestEntities(shortIndex, "", "AT&T (NYSE: T) dividend")).toEqual(["att"]);
    expect(suggestEntities(shortIndex, "Agilent NASDAQ:A update", "")).toEqual(["agilent"]);
  });

  it("leave tickers of three or more characters matching as whole words", () => {
    expect(suggestEntities(shortIndex, "", "we like AAPL")).toEqual(["apple"]);
  });
});

describe("sanitizeItemPatch", () => {
  const E1 = "11111111-1111-4111-8111-111111111111";
  it("keeps only include, chosen_entity_ids, artifact_type", () => {
    const r = sanitizeItemPatch({ include: false, chosen_entity_ids: [E1, E1], artifact_type: "model", status: "imported", storage_key: "x/y/z", content_hash: "h", batch_id: "b" });
    expect(r).toEqual({ patch: { include: false, chosen_entity_ids: [E1], artifact_type: "model" }, error: null });
  });
  it("rejects an unknown artifact type and non-uuid entity ids", () => {
    expect(sanitizeItemPatch({ artifact_type: "memo" }).error).toMatch(/type/i);
    expect(sanitizeItemPatch({ chosen_entity_ids: ["not-a-uuid"] }).error).toMatch(/company/i);
    expect(sanitizeItemPatch({ include: "yes" }).error).toMatch(/include/i);
  });
  it("rejects an empty patch", () => {
    expect(sanitizeItemPatch({ status: "imported" }).error).toMatch(/nothing/i);
  });
});

describe("export size limit", () => {
  it("flags exports over the storage per-file limit", () => {
    expect(exportTooLarge(MAX_EXPORT_BYTES)).toBe(false);
    expect(exportTooLarge(MAX_EXPORT_BYTES + 1)).toBe(true);
  });
});
