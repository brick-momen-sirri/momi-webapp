import type { Job } from "../types.js";

export type QueuedJobCommitDependencies = {
  add: (job: Job) => void;
  remove: (jobId: string) => void;
  persist: (job: Job) => Promise<void>;
  notifyDispatcher: () => void;
};

/** Keep a failed durable write from leaving an in-memory job that can dispatch. */
export async function commitQueuedJob(job: Job, deps: QueuedJobCommitDependencies) {
  deps.add(job);
  try {
    await deps.persist(job);
  } catch (error) {
    deps.remove(job.id);
    throw error;
  }
  deps.notifyDispatcher();
}
