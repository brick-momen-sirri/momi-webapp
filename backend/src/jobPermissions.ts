// Who may see or act on a job or project. Pure predicates over (user, entity),
// extracted from index.ts so the rules live in one place instead of being
// interleaved with the routes that call them.

import { getJobsWithExistingMedia } from "./jobQueue.js";
import { getProject } from "./projectService.js";
import { grantsWorkspaceAccess } from "./projectVisibility.js";
import type { Job, Project, User } from "./types.js";

export function canAccessJob(user: User, job: Job) {
  if (user.role === "admin" || job.userId === user.id) return true;
  const project = getProject(job.projectId);
  return Boolean(project && canViewProject(user, project));
}

export async function getVisibleJobForResult(jobId: string, user: User) {
  const activeJob = (await getJobsWithExistingMedia()).find((job) => job.id === jobId);
  if (activeJob && canAccessJob(user, activeJob)) return activeJob;
  const archivedJob = (await getJobsWithExistingMedia({ archived: true })).find((job) => job.id === jobId);
  return archivedJob && canAccessJob(user, archivedJob) ? archivedJob : undefined;
}

export function canManageJob(user: User, job: Job) {
  if (user.role === "admin" || job.userId === user.id) return true;
  const project = getProject(job.projectId);
  return Boolean(project && getProjectRole(project, user.id) === "owner");
}

export function canViewProject(user: User, project: Project) {
  if (user.role === "admin" || project.ownerId === user.id) return true;
  if (getProjectRole(project, user.id)) return true;
  return grantsWorkspaceAccess(project);
}

export function canCreateJobInProject(user: User, project: Project) {
  if (user.role === "admin") return true;
  const role = getProjectRole(project, user.id);
  if (role === "owner" || role === "editor") return true;
  // An explicit viewer row outranks the implicit team grant: pinning a client
  // review account to viewer has to work on a team project too, otherwise the
  // role is unenforceable outside private projects.
  if (role === "viewer") return false;
  // Demo accounts are refused before this point on every write route; excluding
  // them here as well keeps the implicit grant from becoming the one path that
  // hands a demo login a live project.
  return grantsWorkspaceAccess(project) && !isDemoAccount(user);
}

export function isDemoAccount(user: User) {
  const email = user.email.toLowerCase();
  const username = (user.username ?? "").toLowerCase();
  const configuredDemoEmails = (process.env.MOMI_DEMO_EMAILS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  return (
    email === "demo@brickvisual.com" ||
    email === "momi.demo@brickvisual.com" ||
    username === "demo" ||
    username === "momi-demo" ||
    configuredDemoEmails.includes(email)
  );
}

// Deliberately no implicit team grant: a team project is open to work in, not
// open to re-permission. Membership stays with admins and the project's owners.
export function canManageProject(user: User, project: Project) {
  return user.role === "admin" || project.ownerId === user.id || getProjectRole(project, user.id) === "owner";
}

export function getProjectRole(project: Project, userId: string) {
  return project.members?.find((member) => member.userId === userId)?.role;
}

export function filterJobsForUser(jobs: Job[], user: User, ownerUserId?: string) {
  return jobs.filter((job) => {
    if (!canAccessJob(user, job)) return false;
    if (ownerUserId && job.userId !== ownerUserId) return false;
    return true;
  });
}
