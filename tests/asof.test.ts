import { describe, it, expect } from "vitest";
import { resolveAsOf, versionChain } from "@/lib/asof";

const rows = [
  { id: "a1", recorded_at: "2025-03-01T00:00:00Z", supersedes: null, is_tombstone: false },
  { id: "a2", recorded_at: "2026-01-01T00:00:00Z", supersedes: "a1", is_tombstone: false },
  { id: "b1", recorded_at: "2025-06-01T00:00:00Z", supersedes: null, is_tombstone: false },
  { id: "b2", recorded_at: "2026-03-01T00:00:00Z", supersedes: "b1", is_tombstone: true },
];

const ids = (asOf: string) =>
  resolveAsOf(rows, new Date(asOf)).map((r) => r.id);

describe("resolveAsOf", () => {
  it("hides rows the system had not yet recorded", () => {
    expect(ids("2025-04-01T00:00:00Z")).toEqual(["a1"]);
  });

  it("shows all current facts once recorded", () => {
    expect(ids("2025-07-01T00:00:00Z")).toEqual(["a1", "b1"]);
  });

  it("replaces a fact with its superseding version", () => {
    expect(ids("2026-02-01T00:00:00Z")).toEqual(["a2", "b1"]);
  });

  it("retracts a fact whose tombstone has been recorded", () => {
    expect(ids("2026-04-01T00:00:00Z")).toEqual(["a2"]);
  });

  it("shows nothing before anything was recorded", () => {
    expect(ids("2024-01-01T00:00:00Z")).toEqual([]);
  });
});

describe("versionChain", () => {
  it("walks a head back through its predecessors, newest first", () => {
    expect(versionChain(rows, "a2").map((r) => r.id)).toEqual(["a2", "a1"]);
  });

  it("returns just the head when it has no predecessors", () => {
    expect(versionChain(rows, "b1").map((r) => r.id)).toEqual(["b1"]);
  });
});
