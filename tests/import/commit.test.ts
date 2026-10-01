import { describe, it, expect } from "vitest";
import { artifactPayloadFor } from "@/lib/import/commit";
import type { ImportItemRow } from "@/lib/types";

const item = (over: Partial<ImportItemRow>): ImportItemRow => ({
  id: "i1", batch_id: "b1", org_id: "o1", kind: "note", parent_item_id: null, position: 0,
  title: "AAPL mgmt call", author: "Alice Okafor", valid_at: "2024-03-12T14:05:00.000Z",
  body: "Met CFO.", storage_key: null, file_name: null, mime: null, bytes: null,
  content_hash: "h1", artifact_type: "note", suggested_entity_ids: ["apple"], chosen_entity_ids: ["apple"],
  include: true, status: "pending", duplicate_of: null, artifact_id: null, error: null, ...over,
});
const ctx = { orgId: "o1", userId: "u1", importerName: "Pete Marsh", noteTitle: null, predecessorId: null };

describe("artifactPayloadFor", () => {
  it("maps a note to a paste artifact attributed to the importer, author from the note", () => {
    expect(artifactPayloadFor(item({}), ctx)).toEqual({
      org_id: "o1", artifact_type: "note", source_kind: "paste", title: "AAPL mgmt call",
      author: "Alice Okafor", summary: "", storage_key: null, url: null, body: "Met CFO.",
      content_hash: "h1", created_by: "u1", valid_at: "2024-03-12T14:05:00.000Z", supersedes: null,
    });
  });

  it("falls back to the importer's name when the note has no author", () => {
    expect(artifactPayloadFor(item({ author: null }), ctx).author).toBe("Pete Marsh");
  });

  it("maps an attachment to a file artifact titled after its note", () => {
    const p = artifactPayloadFor(
      item({ kind: "attachment", title: "apple-model-summary.pdf", body: null, storage_key: "o1/x/apple-model-summary.pdf", artifact_type: "other" }),
      { ...ctx, noteTitle: "AAPL mgmt call" },
    );
    expect(p.source_kind).toBe("file");
    expect(p.title).toBe("AAPL mgmt call — apple-model-summary.pdf");
    expect(p.storage_key).toBe("o1/x/apple-model-summary.pdf");
    expect(p.body).toBeNull();
  });

  it("supersedes the predecessor when one is given", () => {
    expect(artifactPayloadFor(item({}), { ...ctx, predecessorId: "art-9" }).supersedes).toBe("art-9");
  });
});
