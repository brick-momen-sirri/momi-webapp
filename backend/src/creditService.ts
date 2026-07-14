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

  const results = await Promise.all(candidates.map(async (candidate) => {
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
  }));

  for (const result of results) {
    if (result) return result;
  }

  return {
    creditsLeft: null,
    source: "unavailable",
    missing: ["creditsLeft", "creditsUsed", "currency", "updatedAt"],
  };
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
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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
