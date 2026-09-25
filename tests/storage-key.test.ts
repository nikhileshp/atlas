import { describe, it, expect } from "vitest";
import { buildStorageKey, isOwnedStorageKey } from "@/lib/storage";

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("storage keys", () => {
  it("builds <org>/<uuid>/<sanitized name>", () => {
    const key = buildStorageKey(ORG, "Q3 primer (final)?.pdf");
    const [org, id, name] = key.split("/");
    expect(org).toBe(ORG);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(name).toBe("Q3 primer (final)_.pdf");
    expect(key.split("/")).toHaveLength(3);
  });

  it("accepts a key it built for the same org", () => {
    expect(isOwnedStorageKey(buildStorageKey(ORG, "a.pdf"), ORG)).toBe(true);
  });

  it("rejects another org's prefix, traversal, and malformed keys", () => {
    expect(isOwnedStorageKey(buildStorageKey(OTHER, "a.pdf"), ORG)).toBe(false);
    expect(isOwnedStorageKey(`${ORG}/../${OTHER}/x/a.pdf`, ORG)).toBe(false);
    expect(isOwnedStorageKey(`${ORG}/a.pdf`, ORG)).toBe(false);
    expect(isOwnedStorageKey(`${ORG}//a.pdf`, ORG)).toBe(false);
    expect(isOwnedStorageKey(`${ORG}/not-a-uuid/a.pdf`, ORG)).toBe(false);
    expect(isOwnedStorageKey("", ORG)).toBe(false);
  });
});
