import type { AuthUser } from "../../services/backendApi";
import type { Job, Project } from "../../types";
import { isStillImageJob } from "../still-images/jobSection";

export const JOB_PAGE_SIZE = 30;
export const ALL_PROJECTS_ID = "all";
/** No owner filter: every user's jobs, which is what the feed shows by default. */
export const ALL_JOB_OWNERS = "all";

/**
 * What a job contributes to a credit total.
 *
 * Still Images presets contribute nothing: their pods report no usage, so the
 * only figure they ever carried was a flat estimate, and counting an estimate as
 * spend inflates the total with something nobody measured. Mirrors
 * isCreditExemptJob on the backend.
 *
 * Checked here rather than trusting the absence of creditsUsed, because jobs
 * that ran before the exemption still have a number persisted on them and would
 * otherwise keep counting forever.
 */
function creditsCountedFor(job: Job) {
  return isStillImageJob(job) ? 0 : (job.creditsUsed ?? 0);
}

export function getMonthlyUsageForUser(jobs: Job[], userId?: string) {
  if (!userId) return { creditsSpent: 0, jobsCompleted: 0 };
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  return jobs.reduce(
    (stats, job) => {
      if (job.userId !== userId || job.status !== "completed") return stats;
      const timestamp = new Date(job.completedAt ?? job.createdAt).getTime();
      if (!Number.isFinite(timestamp) || timestamp < start || timestamp >= end) return stats;
      return {
        creditsSpent: roundCredits(stats.creditsSpent + creditsCountedFor(job)),
        jobsCompleted: stats.jobsCompleted + 1,
      };
    },
    { creditsSpent: 0, jobsCompleted: 0 },
  );
}

export function getWorkspaceMonthlyUsage(
  monthlyUsageByUser: Record<string, { creditsSpent: number; jobsCompleted: number }>,
  jobs: Job[],
) {
  const usageRows = Object.values(monthlyUsageByUser);
  if (usageRows.length) {
    return usageRows.reduce(
      (stats, usage) => ({
        creditsSpent: roundCredits(stats.creditsSpent + usage.creditsSpent),
        jobsCompleted: stats.jobsCompleted + usage.jobsCompleted,
      }),
      { creditsSpent: 0, jobsCompleted: 0 },
    );
  }

  return getMonthlyUsageForJobs(jobs);
}

function getMonthlyUsageForJobs(jobs: Job[]) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  return jobs.reduce(
    (stats, job) => {
      if (job.status !== "completed") return stats;
      const timestamp = new Date(job.completedAt ?? job.createdAt).getTime();
      if (!Number.isFinite(timestamp) || timestamp < start || timestamp >= end) return stats;
      return {
        creditsSpent: roundCredits(stats.creditsSpent + creditsCountedFor(job)),
        jobsCompleted: stats.jobsCompleted + 1,
      };
    },
    { creditsSpent: 0, jobsCompleted: 0 },
  );
}

export function mapMonthlyUsageByUser(usageUsers: Array<{ userId: string; creditsSpent: number; jobsCompleted: number }>) {
  return usageUsers.reduce<Record<string, { creditsSpent: number; jobsCompleted: number }>>((map, user) => {
    map[user.userId] = {
      creditsSpent: roundCredits(user.creditsSpent),
      jobsCompleted: user.jobsCompleted,
    };
    return map;
  }, {});
}

export function mergeUsers(incoming: AuthUser[], existing: AuthUser[]) {
  const map = new Map<string, AuthUser>();
  for (const user of existing) map.set(user.id, user);
  for (const user of incoming) map.set(user.id, user);
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function mergeJobs(incoming: Job[], existing: Job[]) {
  const map = new Map<string, Job>();
  for (const job of incoming) map.set(job.id, job);
  for (const job of existing) {
    if (!map.has(job.id)) map.set(job.id, job);
  }
  return Array.from(map.values()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function incrementProjectJobCount(projects: Project[], projectId: string) {
  return projects.map((project) =>
    project.id === projectId
      ? { ...project, jobCount: project.jobCount + 1, unreadCount: (project.unreadCount ?? 0) + 1 }
      : project,
  );
}

export function matchesFolder(job: Job, folderId: "all" | "root" | string) {
  if (folderId === "all") return true;
  if (folderId === "root") return !job.folderId;
  return job.folderId === folderId;
}

/**
 * The query for one page of the feed.
 *
 * `ownerId` is sent to the server rather than applied to the page after it
 * arrives. A page is thirty jobs out of a couple of thousand, and picking a name
 * out of a workspace-wide list is precisely the case where the person you want is
 * not in the newest thirty -- most of the workspace has never appeared there at
 * all. Filtering client-side made those users read as "no jobs" instead of "not on
 * this page". `/api/jobs` has taken `userId` since it was written; nothing was
 * passing it.
 */
export function jobPageParams(
  projectId: string,
  folderId: "all" | "root" | string,
  offset: number,
  archived = false,
  ownerId: string = ALL_JOB_OWNERS,
) {
  return {
    limit: JOB_PAGE_SIZE,
    offset,
    projectId: projectId === ALL_PROJECTS_ID ? undefined : projectId,
    folderId: projectId === ALL_PROJECTS_ID || folderId === "all" ? undefined : folderId,
    archived,
    userId: ownerId === ALL_JOB_OWNERS ? undefined : ownerId,
  };
}

export function slugify(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "folder"
  );
}

function roundCredits(value: number) {
  return Math.round(value * 100) / 100;
}
