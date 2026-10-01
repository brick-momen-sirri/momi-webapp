import { useEffect, useEffectEvent, useState } from "react";

import { fetchBackendJob } from "../../services/api/jobsApi";
import type { Job } from "../../types";
import { clearLinkedResultParam, linkedResultId } from "./resultLink";

/**
 * Open the result a page's address names (see resultLink.ts), once.
 *
 * Runs as soon as there is an account -- `ready` -- and before the workspace loads:
 * the host holds that load while `opening` is true, so it happens once, already
 * for the result's project and folder. Waiting for the workspace first meant
 * loading the remembered project, drawing it, then loading everything again. A
 * link opened while signed out survives the sign-in screen, because nothing is
 * resolved until there is an account. The job is always fetched by id, which
 * answers in a millisecond. Either way the parameter is then dropped, opened or
 * not, so it fires one time.
 */
export function useLinkedResult({
  ready,
  onOpen,
  onUnavailable,
  fetchJob = fetchBackendJob,
}: {
  ready: boolean;
  onOpen: (job: Job) => void;
  /** Not found, or not visible to this account: the API answers both the same. */
  onUnavailable: () => void;
  fetchJob?: (jobId: string) => Promise<Job>;
}) {
  const [pendingId, setPendingId] = useState(() => linkedResultId(window.location.search));
  const open = useEffectEvent((job: Job) => onOpen(job));
  const unavailable = useEffectEvent(() => onUnavailable());

  useEffect(() => {
    if (!ready || !pendingId) return;
    let active = true;
    fetchJob(pendingId)
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
