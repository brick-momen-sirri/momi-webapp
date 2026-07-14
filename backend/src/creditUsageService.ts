import { comfyServers } from "./config.js";

type CreditUsageRow = {
  prompt_id?: unknown;
  estimated_credits?: unknown;
};

type CreditUsageResponse = {
  rows?: CreditUsageRow[];
};

type CreditTrackerProjectRow = {
  project_name?: unknown;
  total_runs?: unknown;
  total_estimated_credits?: unknown;
  total_estimated_usd?: unknown;
};

type CreditTrackerSummaryResponse = {
  by_project?: CreditTrackerProjectRow[];
  federated?: {
    by_project?: CreditTrackerProjectRow[];
  };
};

export type CreditTrackerProjectStats = {
  projectName: string;
  creditsUsed: number;
  monthCreditsUsed: number;
  usdUsed: number;
  monthUsdUsed: number;
  trackedRuns: number;
  monthTrackedRuns: number;
};

const CACHE_TTL_MS = 10_000;
const ROW_LIMIT = Number(process.env.CREDIT_TRACKER_USAGE_ROWS_LIMIT ?? 500);
const PROJECT_SUMMARY_LIMIT = Number(process.env.CREDIT_TRACKER_PROJECT_SUMMARY_LIMIT ?? 200);

let cache:
  | {
      createdAt: number;
      creditsByPromptId: Map<string, number>;
    }
  | undefined;

let projectStatsCache:
  | {
      createdAt: number;
      statsByProjectName: Map<string, CreditTrackerProjectStats>;
    }
  | undefined;

export async function getActualCreditsByPromptIds(promptIds: string[]) {
  const wanted = new Set(promptIds.map((id) => id.trim()).filter(Boolean));
  if (!wanted.size) return new Map<string, number>();

  const creditsByPromptId = await loadRecentCreditUsage();
  const result = new Map<string, number>();
  for (const promptId of wanted) {
    const credits = creditsByPromptId.get(promptId);
    if (credits != null) result.set(promptId, credits);
  }
  return result;
}

async function loadRecentCreditUsage() {
  const now = Date.now();
  if (cache && now - cache.createdAt < CACHE_TTL_MS) {
    return cache.creditsByPromptId;
  }

  const merged = new Map<string, number>();
  await Promise.allSettled(
    comfyServers.map(async (serverUrl) => {
      const rows = await fetchUsageRows(serverUrl);
      for (const row of rows) {
        const promptId = typeof row.prompt_id === "string" ? row.prompt_id.trim() : "";
        const credits = numberFrom(row.estimated_credits);
        if (!promptId || credits == null) continue;
        merged.set(promptId, roundCredits((merged.get(promptId) ?? 0) + credits));
      }
    }),
  );

  cache = { createdAt: now, creditsByPromptId: merged };
  return merged;
}

async function fetchUsageRows(serverUrl: string) {
  const url = `${serverUrl}/credit-tracker/api/usage-rows?limit=${ROW_LIMIT}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!response.ok) {
    throw new Error(`Credit tracker usage request failed: ${response.status}`);
  }
  const data = (await response.json()) as CreditUsageResponse;
  return Array.isArray(data.rows) ? data.rows : [];
}

export async function getCreditTrackerProjectStats() {
  const now = Date.now();
  if (projectStatsCache && now - projectStatsCache.createdAt < CACHE_TTL_MS) {
    return projectStatsCache.statsByProjectName;
  }

  for (const serverUrl of comfyServers) {
    try {
      const allTime = await fetchProjectSummaryRows(serverUrl);
      const currentMonth = await fetchProjectSummaryRows(serverUrl, currentMonthQueryParams());
      const statsByProjectName = mergeProjectSummaryRows(allTime, currentMonth);
      projectStatsCache = { createdAt: now, statsByProjectName };
      return statsByProjectName;
    } catch {
      // Try the next configured ComfyUI server.
    }
  }

  projectStatsCache = { createdAt: now, statsByProjectName: new Map() };
  return projectStatsCache.statsByProjectName;
}

async function fetchProjectSummaryRows(serverUrl: string, extraParams: Record<string, string> = {}) {
  const params = new URLSearchParams({
    limit: String(PROJECT_SUMMARY_LIMIT),
    ...extraParams,
  });
  const url = `${serverUrl}/credit-tracker/api/summary?${params.toString()}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(3500) });
  if (!response.ok) {
    throw new Error(`Credit tracker summary request failed: ${response.status}`);
  }

  const data = (await response.json()) as CreditTrackerSummaryResponse;
  const rows = data.federated?.by_project ?? data.by_project ?? [];
  return Array.isArray(rows) ? rows : [];
}

function mergeProjectSummaryRows(
  allTimeRows: CreditTrackerProjectRow[],
  currentMonthRows: CreditTrackerProjectRow[],
) {
  const statsByProjectName = new Map<string, CreditTrackerProjectStats>();

  for (const row of allTimeRows) {
    const projectName = typeof row.project_name === "string" ? row.project_name.trim() : "";
    if (!projectName) continue;
    statsByProjectName.set(projectName, {
      projectName,
      creditsUsed: roundCredits(numberFrom(row.total_estimated_credits) ?? 0),
      monthCreditsUsed: 0,
      usdUsed: roundCredits(numberFrom(row.total_estimated_usd) ?? 0),
      monthUsdUsed: 0,
      trackedRuns: Math.max(0, Math.round(numberFrom(row.total_runs) ?? 0)),
      monthTrackedRuns: 0,
    });
  }

  for (const row of currentMonthRows) {
    const projectName = typeof row.project_name === "string" ? row.project_name.trim() : "";
    if (!projectName) continue;
    const current = statsByProjectName.get(projectName) ?? {
      projectName,
      creditsUsed: 0,
      monthCreditsUsed: 0,
      usdUsed: 0,
      monthUsdUsed: 0,
      trackedRuns: 0,
      monthTrackedRuns: 0,
    };
    current.monthCreditsUsed = roundCredits(numberFrom(row.total_estimated_credits) ?? 0);
    current.monthUsdUsed = roundCredits(numberFrom(row.total_estimated_usd) ?? 0);
    current.monthTrackedRuns = Math.max(0, Math.round(numberFrom(row.total_runs) ?? 0));
    statsByProjectName.set(projectName, current);
  }

  return statsByProjectName;
}

function currentMonthQueryParams() {
  const now = new Date();
  const startAt = new Date(now.getFullYear(), now.getMonth(), 1);
  const endAt = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return {
    from: localDateString(startAt),
    to: localDateString(endAt),
  };
}

function localDateString(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function numberFrom(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function roundCredits(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
