import { describe, it, expect } from "vitest";
import { sha256Hex } from "@/lib/hash";

describe("sha256Hex", () => {
  it("hashes a known buffer to the known digest", () => {
    // sha256("atlas") — precomputed
    expect(sha256Hex(Buffer.from("atlas"))).toBe(
      "7c82602500857aa6ed0cf38c4c3e4ec645bdcaa82c00b9155eb08be100c778a9",
    );
  });

  it("produces identical digests for identical content", () => {
    const a = sha256Hex(Buffer.from("same bytes"));
    const b = sha256Hex(Buffer.from("same bytes"));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
