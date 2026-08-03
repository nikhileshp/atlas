import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchCached, searchCompanies, padCik } from "@/lib/edgar";

const UA = "Atlas test test@example.com";

function makeFetch(payload: unknown) {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      headersSent: init?.headers,
    } as unknown as Response;
  });
}

beforeEach(() => {
  process.env.EDGAR_CACHE_DIR = mkdtempSync(path.join(tmpdir(), "edgar-cache-"));
  process.env.EDGAR_USER_AGENT = UA;
  process.env.EDGAR_BASE_URL = "https://edgar.invalid";
  process.env.EDGAR_DATA_BASE_URL = "https://edgar-data.invalid";
});

describe("fetchCached", () => {
  it("fetches on a cache miss and writes the cache file", async () => {
    const f = makeFetch({ hello: 1 });
    const data = await fetchCached("https://edgar.invalid/a.json", 60_000, f);
    expect(data).toEqual({ hello: 1 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("serves from cache within the TTL without touching the network", async () => {
    const f = makeFetch({ hello: 2 });
    await fetchCached("https://edgar.invalid/b.json", 60_000, f);
    const again = await fetchCached("https://edgar.invalid/b.json", 60_000, f);
    expect(again).toEqual({ hello: 2 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("refetches once the TTL has expired", async () => {
    const f = makeFetch({ hello: 3 });
    await fetchCached("https://edgar.invalid/c.json", 60_000, f);
    await fetchCached("https://edgar.invalid/c.json", -1, f); // everything expired
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("sends the SEC-required User-Agent on every request", async () => {
    const f = makeFetch({});
    await fetchCached("https://edgar.invalid/d.json", 60_000, f);
    const init = f.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("User-Agent")).toBe(UA);
  });

  it("throws a typed error on a non-200 response", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 403 }) as Response);
    await expect(fetchCached("https://edgar.invalid/e.json", 60_000, f)).rejects.toThrow(/403/);
  });
});

describe("searchCompanies", () => {
  const tickers = {
    "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
    "1": { cik_str: 789019, ticker: "MSFT", title: "MICROSOFT CORP" },
    "2": { cik_str: 909832, ticker: "COST", title: "COSTCO WHOLESALE CORP /NEW" },
  };

  it("matches by name or ticker, case-insensitive, with zero-padded CIKs", async () => {
    const f = makeFetch(tickers);
    const apple = await searchCompanies("apple", f);
    expect(apple).toEqual([{ cik: "0000320193", ticker: "AAPL", name: "Apple Inc." }]);
    const cost = await searchCompanies("cost", f);
    expect(cost.map((m) => m.ticker)).toEqual(["COST"]);
  });

  it("returns nothing for a blank query", async () => {
    const f = makeFetch(tickers);
    expect(await searchCompanies("   ", f)).toEqual([]);
  });
});

describe("padCik", () => {
  it("zero-pads to ten digits", () => {
    expect(padCik(320193)).toBe("0000320193");
    expect(padCik("0000320193")).toBe("0000320193");
  });
});
