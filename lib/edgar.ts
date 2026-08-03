// SEC EDGAR access. Server-side only:
//  - EDGAR sends no permissive CORS headers, so the browser never talks to it
//    directly; our route handlers proxy it.
//  - SEC requires a User-Agent identifying the requester (env EDGAR_USER_AGENT)
//    and rate-limits (~10 req/s), so every response is cached on disk in
//    EDGAR_CACHE_DIR so UI iteration does not hammer the SEC.

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";
import { sha256Hex } from "@/lib/hash";

type Fetcher = typeof fetch;

const DAY_MS = 86_400_000;
export const TICKERS_TTL_MS = DAY_MS; // company list churns slowly
export const SUBMISSIONS_TTL_MS = 7 * DAY_MS; // per-company identity data churns slower

export async function fetchCached(
  url: string,
  ttlMs: number,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const dir = env("EDGAR_CACHE_DIR");
  const file = path.join(dir, `${sha256Hex(url)}.json`);

  try {
    const s = await stat(file);
    if (Date.now() - s.mtimeMs < ttlMs) {
      return JSON.parse(await readFile(file, "utf8"));
    }
  } catch {
    // cache miss — fall through to network
  }

  const res = await fetcher(url, {
    headers: { "User-Agent": env("EDGAR_USER_AGENT") },
  });
  if (!res.ok) throw new Error(`EDGAR request failed: ${res.status} for ${url}`);
  const data = await res.json();

  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(data));
  return data;
}

export function padCik(cik: string | number): string {
  return String(cik).padStart(10, "0");
}

export interface EdgarMatch {
  cik: string;
  ticker: string;
  name: string;
}

interface TickerRecord {
  cik_str: number;
  ticker: string;
  title: string;
}

export async function searchCompanies(
  q: string,
  fetcher: Fetcher = fetch,
): Promise<EdgarMatch[]> {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];

  const data = (await fetchCached(
    `${env("EDGAR_BASE_URL")}/files/company_tickers.json`,
    TICKERS_TTL_MS,
    fetcher,
  )) as Record<string, TickerRecord>;

  const matches = Object.values(data).filter(
    (c) =>
      c.title.toLowerCase().includes(needle) ||
      c.ticker.toLowerCase().includes(needle),
  );
  // exact ticker hits first, then the EDGAR ordering (roughly by market cap)
  matches.sort(
    (a, b) =>
      Number(b.ticker.toLowerCase() === needle) -
      Number(a.ticker.toLowerCase() === needle),
  );

  return matches.slice(0, 12).map((c) => ({
    cik: padCik(c.cik_str),
    ticker: c.ticker,
    name: c.title,
  }));
}

export interface EdgarCompany {
  cik: string;
  name: string;
  tickers: string[];
  formerNames: { name: string; from: string | null; to: string | null }[];
}

interface SubmissionsPayload {
  name: string;
  tickers?: string[];
  formerNames?: { name: string; from?: string; to?: string }[];
}

export async function getCompany(
  cik10: string,
  fetcher: Fetcher = fetch,
): Promise<EdgarCompany> {
  if (!/^[0-9]{10}$/.test(cik10)) throw new Error(`Invalid CIK: ${cik10}`);
  const data = (await fetchCached(
    `${env("EDGAR_DATA_BASE_URL")}/submissions/CIK${cik10}.json`,
    SUBMISSIONS_TTL_MS,
    fetcher,
  )) as SubmissionsPayload;

  return {
    cik: cik10,
    name: data.name,
    tickers: data.tickers ?? [],
    formerNames: (data.formerNames ?? []).map((f) => ({
      name: f.name,
      from: f.from ?? null,
      to: f.to ?? null,
    })),
  };
}
