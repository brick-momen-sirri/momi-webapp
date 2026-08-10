import { apiRequest } from "./client";
import type { BackendCreditDashboard, BackendMonthlyUsage } from "./types";

export async function fetchBackendCredits() {
  return apiRequest<{ creditsLeft: number | null; creditsUsed?: number; currency?: string; updatedAt?: string; source: string }>(
    "/api/credits",
  );
}

export async function fetchBackendMonthlyUsage() {
  return apiRequest<BackendMonthlyUsage>("/api/usage/monthly");
}

export async function fetchBackendCreditDashboard(params?: {
  range?: string;
  from?: string;
  to?: string;
  granularity?: string;
}) {
  const search = new URLSearchParams();
  if (params?.range) search.set("range", params.range);
  if (params?.from) search.set("from", params.from);
  if (params?.to) search.set("to", params.to);
  if (params?.granularity) search.set("granularity", params.granularity);
  const suffix = search.size ? `?${search.toString()}` : "";
  const data = await apiRequest<{ dashboard: BackendCreditDashboard }>(`/api/credits/dashboard${suffix}`);
  return data.dashboard;
}
