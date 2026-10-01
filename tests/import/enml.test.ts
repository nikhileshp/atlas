import { describe, it, expect } from "vitest";
import { enmlToText } from "@/lib/import/enml";

const wrap = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>${inner}</en-note>`;

describe("enmlToText", () => {
  it("turns block tags and <br> into line breaks and strips the rest", () => {
    const text = enmlToText(wrap("<div>Mgmt call <b>notes</b></div><div>Pricing power strong</div><br/><p>End</p>"), new Map());
    expect(text).toBe("Mgmt call notes\nPricing power strong\n\nEnd");
  });

  it("decodes entities and bullets list items", () => {
    const text = enmlToText(wrap("<ul><li>Q&amp;A: margins &gt; 30%</li><li>FCF&nbsp;up</li></ul>"), new Map());
    expect(text).toBe("• Q&A: margins > 30%\n• FCF up");
  });

  it("replaces document media with a placeholder and drops image media", () => {
    const names = new Map<string, string | null>([
      ["aaaa", "model.xlsx"],
      ["bbbb", null],
    ]);
    const text = enmlToText(
      wrap('<div>See <en-media hash="AAAA" type="application/vnd.ms-excel"/> and <en-media hash="bbbb" type="image/png"/></div>'),
      names,
    );
    expect(text).toBe("See [attachment: model.xlsx] and");
  });

  it("collapses runs of blank lines to one", () => {
    const text = enmlToText(wrap("<div>a</div><div><br/></div><div><br/></div><div><br/></div><div>b</div>"), new Map());
    expect(text).toBe("a\n\nb");
  });
});
