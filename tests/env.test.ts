import { describe, it, expect } from "vitest";
import { env } from "@/lib/env";

describe("env", () => {
  it("returns a set variable", () => {
    process.env.SITE_URL = "http://localhost:3000";
    expect(env("SITE_URL")).toBe("http://localhost:3000");
  });

  it("throws on a missing variable", () => {
    delete process.env.SUPABASE_STORAGE_BUCKET;
    expect(() => env("SUPABASE_STORAGE_BUCKET")).toThrow(
      /SUPABASE_STORAGE_BUCKET/,
    );
  });
});
