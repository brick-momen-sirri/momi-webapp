import type { Project } from "../../types";

/**
 * A mutation response merged over the project we already had, keeping the stats
 * it does not carry.
 *
 * jobCount, creditsUsed, monthCreditsUsed and usdUsed are derived on read: only
 * `GET /api/projects` computes them, by summing the jobs. Every mutation route
 * instead answers with the *stored* project, and the store strips those fields on
 * the way to disk (projectForPersistence) -- so a PATCH reply carries jobCount 0
 * and no spend at all.
 *
 * Taking that reply as the new state therefore blanked the numbers: save a spend
 * limit and the project read 0 jobs and $0.00 spent until the next full refresh,
 * which made the limit look like it had reset the very history it is measured
 * against. A member edit or a folder rename did the same, less visibly.
 *
 * The reply is authoritative about configuration and silent about spend, so the
 * fields it omits are carried over rather than overwritten. They are not
 * recomputed server-side on mutation on purpose: that would put a full job scan
 * plus the external credit-tracker call behind every folder rename.
 */
export function withKnownProjectStats(previous: Project, updated: Project): Project {
  return {
    ...updated,
    jobCount: updated.jobCount || previous.jobCount,
    creditsUsed: updated.creditsUsed ?? previous.creditsUsed,
    monthCreditsUsed: updated.monthCreditsUsed ?? previous.monthCreditsUsed,
    usdUsed: updated.usdUsed ?? previous.usdUsed,
  };
}
