import { useEffect, useEffectEvent, useState } from "react";

import { fetchBackendJob } from "../../services/api/jobsApi";
import type { Job } from "../../types";
import { clearLinkedResultParam, linkedResultId } from "./resultLink";

/**
 * Open the result a page's address names (see resultLink.ts), once.
 *
 * Waits for `ready` -- a signed-in, loaded workspace -- so a link opened while
 * signed out survives the sign-in screen: the address is left alone until there
 * is an account to resolve it as. The job is taken from what is loaded when it is
 * there and fetched by id when it is not, which is the usual case for anything
 * older than the first page. Either way the parameter is then dropped, opened or
 * not, so it fires one time.
 */
export function useLinkedResult({
  ready,
  jobs,
  onOpen,
  onUnavailable,
  fetchJob = fetchBackendJob,
}: {
  ready: boolean;
  jobs: Job[];
  onOpen: (job: Job) => void;
  /** Not found, or not visible to this account: the API answers both the same. */
  onUnavailable: () => void;
  fetchJob?: (jobId: string) => Promise<Job>;
}) {
  const [pendingId, setPendingId] = useState(() => linkedResultId(window.location.search));
  const loadedJob = useEffectEvent((jobId: string) => jobs.find((job) => job.id === jobId));
  const open = useEffectEvent((job: Job) => onOpen(job));
  const unavailable = useEffectEvent(() => onUnavailable());

  useEffect(() => {
    if (!ready || !pendingId) return;
    let active = true;
    const loaded = loadedJob(pendingId);
    (loaded ? Promise.resolve(loaded) : fetchJob(pendingId))
      .then(
        (job) => {
          if (active) open(job);
        },
        () => {
          if (active) unavailable();
        },
      )
      .finally(() => {
        if (!active) return;
        clearLinkedResultParam();
        setPendingId(undefined);
      });
    return () => {
      active = false;
    };
  }, [ready, pendingId, fetchJob]);

  return { opening: Boolean(pendingId) };
}
