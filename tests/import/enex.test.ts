import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { splitCompleteNotes, parseNoteBlock, enexDateToIso } from "@/lib/import/enex";

const FIXTURE = readFileSync("fixtures/enex/sample.enex");

describe("enexDateToIso", () => {
  it("converts Evernote timestamps", () => {
    expect(enexDateToIso("20240312T140500Z")).toBe("2024-03-12T14:05:00.000Z");
  });
});

describe("splitCompleteNotes", () => {
  it("returns all three notes and consumes through the last </note> when given the whole file", () => {
    const { blocks, consumed } = splitCompleteNotes(FIXTURE, true);
    expect(blocks).toHaveLength(3);
    expect(consumed).toBe(FIXTURE.length); // EOF: trailing </en-export> consumed
    expect(blocks[0].toString("utf8").startsWith("<note>")).toBe(true);
  });

  it("returns only complete notes from a partial buffer and reports where to resume", () => {
    const cut = FIXTURE.indexOf("<title>Costco") + 10; // inside note 3, after note 2 closed
    const part = FIXTURE.subarray(0, cut);
    const { blocks, consumed } = splitCompleteNotes(part, false);
    expect(blocks).toHaveLength(2);
    const rest = FIXTURE.subarray(consumed);
    const second = splitCompleteNotes(rest, true);
    expect(second.blocks).toHaveLength(1);
    expect(second.blocks[0].toString("utf8")).toContain("Costco vs Visa");
  });

  it("consumes nothing when no note is complete yet", () => {
    const part = FIXTURE.subarray(0, 200);
    expect(splitCompleteNotes(part, false)).toEqual({ blocks: [], consumed: 0 });
  });

  it("chunked feeding in 1 KB slices yields the same notes as one pass", () => {
    const titles: string[] = [];
    let offset = 0;
    let carry = Buffer.alloc(0);
    while (offset < FIXTURE.length) {
      const slice = FIXTURE.subarray(offset, Math.min(offset + 1024, FIXTURE.length));
      offset += slice.length;
      carry = Buffer.concat([carry, slice]);
      const { blocks, consumed } = splitCompleteNotes(carry, offset >= FIXTURE.length);
      for (const b of blocks) titles.push(parseNoteBlock(b.toString("utf8")).title);
      carry = carry.subarray(consumed);
    }
    expect(titles).toEqual(["AAPL mgmt call 2024-03", "General market thoughts", "Costco vs Visa: pricing"]);
  });
});

describe("parseNoteBlock", () => {
  const { blocks } = splitCompleteNotes(FIXTURE, true);

  it("extracts title, author, created, text with a document placeholder, and documents only", () => {
    const n = parseNoteBlock(blocks[0].toString("utf8"));
    expect(n.title).toBe("AAPL mgmt call 2024-03");
    expect(n.author).toBe("Alice Okafor");
    expect(n.createdAt).toBe("2024-03-12T14:05:00.000Z");
    expect(n.text).toBe("Met CFO. Pricing power intact; services mix up.\nModel attached: [attachment: apple-model-summary.pdf]");
    expect(n.documents).toHaveLength(1);
    expect(n.documents[0].fileName).toBe("apple-model-summary.pdf");
    expect(n.documents[0].mime).toBe("application/pdf");
    expect(n.documents[0].bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(n.imagesSkipped).toBe(1);
  });

  it("handles a note without author or resources", () => {
    const n = parseNoteBlock(blocks[1].toString("utf8"));
    expect(n.author).toBeNull();
    expect(n.documents).toEqual([]);
    expect(n.imagesSkipped).toBe(0);
    expect(n.text).toBe("Rates higher for longer. No single name.");
  });
});
