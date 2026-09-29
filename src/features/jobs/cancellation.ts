// Who may stop a job, and how a card says who did.
//
// canCancelJob mirrors backend/src/jobPermissions.ts: the submitter or an admin.
// The server enforces it; this copy only keeps the Cancel button off cards the
// viewer would be refused on.

import type { Job, User } from "../../types";

type Viewer = Pick<User, "id" | "role"> | null | undefined;

export function canCancelJob(viewer: Viewer, job: Pick<Job, "userId">) {
  if (!viewer?.id) return false;
  return viewer.role === "admin" || job.userId === viewer.id;
}

/**
 * "Canceled by the owner" or "Canceled by admin <name>" -- or "Cancel requested
 * by ..." while the pod is still being stopped. Undefined when there is nothing
 * to say, including jobs canceled before the canceller was recorded.
 *
 * Only an admin can cancel someone else's job, so a canceller who is not the
 * submitter is named as an admin.
 */
export function cancellationNote(
  job: Pick<Job, "userId" | "status" | "cancelRequested" | "canceledBy">,
  users: Array<Pick<User, "id" | "name">>,
) {
  if (!job.canceledBy) return undefined;
  const settled = job.status === "canceled";
  if (!settled && !job.cancelRequested) return undefined;

  let actor = "the owner";
  if (job.canceledBy !== job.userId) {
    const name = users.find((user) => user.id === job.canceledBy)?.name;
    actor = name ? `admin ${name}` : "an admin";
  }
  return `${settled ? "Canceled" : "Cancel requested"} by ${actor}`;
}
