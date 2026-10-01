import { describe, it, expect } from "vitest";
import { isDocument, defaultArtifactType } from "@/lib/import/classify";

describe("classify", () => {
  it("accepts office documents, pdf, csv by mime", () => {
    expect(isDocument("application/pdf", "a.pdf")).toBe(true);
    expect(isDocument("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "m.xlsx")).toBe(true);
    expect(isDocument("text/csv", "d.csv")).toBe(true);
  });
  it("falls back to the extension when mime is generic", () => {
    expect(isDocument("application/octet-stream", "deck.pptx")).toBe(true);
    expect(isDocument(null, "model.xls")).toBe(true);
  });
  it("rejects images and unknown types", () => {
    expect(isDocument("image/png", "shot.png")).toBe(false);
    expect(isDocument("application/octet-stream", "blob.bin")).toBe(false);
  });
  it("defaults note->note, spreadsheet->model, other docs->other", () => {
    expect(defaultArtifactType("note", null)).toBe("note");
    expect(defaultArtifactType("attachment", "m.xlsx")).toBe("model");
    expect(defaultArtifactType("attachment", "d.CSV")).toBe("model");
    expect(defaultArtifactType("attachment", "primer.pdf")).toBe("other");
  });
});
