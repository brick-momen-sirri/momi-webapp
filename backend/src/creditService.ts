import { comfyServers } from "./config.js";
import { fetchComfyCredit } from "./comfyClient.js";

export type CreditInfo = {
  creditsLeft: number | null;
  creditsUsed?: number;
  currency?: string;
  updatedAt?: string;
  source: string;
  missing?: string[];
};

async function fetchJson(url: string, timeoutMs = 3500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getCredits(): Promise<CreditInfo> {
  const directUrl = process.env.CREDIT_BADGE_URL ?? "http://127.0.0.1:8160/abuomar_credit";
  const candidates = [
    { source: directUrl, load: () => fetchJson(directUrl, 8000) },
    ...comfyServers.map((server) => ({ source: `${server}/abuomar_credit_proxy`, load: () => fetchComfyCredit(server) })),
  ];

  const results = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const data = await candidate.load();
        const nestedData = objectFrom(data.data);
        const credits = creditNumberFrom(data) ?? (nestedData ? creditNumberFrom(nestedData) : undefined);
        if (credits == null) {
          return undefined;
        }
        return {
          creditsLeft: credits,
          creditsUsed: numberFrom(data.creditsUsed) ?? numberFrom(nestedData?.creditsUsed),
          currency: stringFrom(data.currency) ?? stringFrom(nestedData?.currency),
          updatedAt: stringFrom(data.updatedAt) ?? stringFrom(nestedData?.updatedAt) ?? new Date().toISOString(),
          source: candidate.source,
        } satisfies CreditInfo;
      } catch {
        return undefined;
      }
    }),
  );

  for (const result of results) {
    if (result) return result;
  }

  return {
    creditsLeft: null,
    source: "unavailable",
    missing: ["creditsLeft", "creditsUsed", "currency", "updatedAt"],
  };
}

/**
 * A loader wrapped so callers are answered from memory: within `ttlMs` the last
 * value is returned as is; after it, up to `maxStaleMs`, the last value is still
 * returned at once while one refresh runs behind it; past that, or with nothing
 * usable yet, callers wait for a fresh read. Concurrent callers share that read.
 * A value `isUsable` rejects (the tracker unreachable) is kept only `ttlMs` and
 * never served stale, so a recovery shows within one period.
 */
export function staleWhileRevalidate<T>(
  load: () => Promise<T>,
  options: { ttlMs: number; maxStaleMs: number; isUsable?: (value: T) => boolean; now?: () => number },
) {
  const now = options.now ?? Date.now;
  const isUsable = options.isUsable ?? (() => true);
  let cached: { value: T; at: number } | undefined;
  let inflight: Promise<T> | undefined;

  function refresh() {
    inflight ??= load()
      .then((value) => {
        cached = { value, at: now() };
        return value;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  return function read(): Promise<T> {
    const age = cached ? now() - cached.at : Infinity;
    if (cached && age < options.ttlMs) return Promise.resolve(cached.value);
    if (cached && age < options.maxStaleMs && isUsable(cached.value)) {
      void refresh().catch(() => undefined);
      return Promise.resolve(cached.value);
    }
    return refresh();
  };
}

/**
 * The balance as the pages read it: GET /api/credits on every workspace load and
 * /api/snapshot on every open tab's 12 s poll.
 *
 * The tracker takes ~1.6 s per read (5 s at p90, pm2 api logs 2026-10-01), and the
 * workspace could not appear until it answered, so every page load -- a shared
 * result link included -- waited on it, and every tab's poll put another read on
 * it. Served from memory for 30 s, then stale-while-revalidate for up to 5
 * minutes. The dispatcher's per-job before/after snapshots keep calling
 * getCredits directly: a cached value would make the two readings the same.
 */
export const getCachedCredits = staleWhileRevalidate(getCredits, {
  ttlMs: positiveMs(process.env.CREDIT_CACHE_TTL_MS, 30_000),
  maxStaleMs: positiveMs(process.env.CREDIT_CACHE_MAX_STALE_MS, 5 * 60_000),
  isUsable: (credits) => typeof credits.creditsLeft === "number",
});

function positiveMs(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function numberFrom(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function stringFrom(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function objectFrom(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function creditNumberFrom(data: Record<string, unknown>) {
  return (
    numberFrom(data.credits) ??
    numberFrom(data.creditsLeft) ??
    numberFrom(data.balance) ??
    numberFrom(data.display_balance) ??
    numberFrom(data.credits_estimate)
  );
}
