// Links that open one result in Momi, for sharing inside the studio.
//
// A link names the job and nothing else: `/?result=<jobId>`. Project, folder and
// workspace all come from the job itself once it is loaded, and loading it goes
// through GET /api/jobs/:id, which answers 404 to anyone who cannot see its
// project. So a link grants nothing: whoever opens it signs in as themselves and
// sees the result only if they could already have found it in the app.

export const RESULT_LINK_PARAM = "result";

/** Job ids are `job_<hex>`; anything else in the parameter is ignored, not fetched. */
const JOB_ID = /^[A-Za-z0-9_-]{1,120}$/;

/** The link to share, on whatever address the sharer is using Momi from. */
export function resultLinkUrl(jobId: string, location: Pick<Location, "origin" | "pathname"> = window.location) {
  const url = new URL(location.pathname || "/", location.origin);
  url.searchParams.set(RESULT_LINK_PARAM, jobId);
  return url.toString();
}

/** The job a page was opened for, if its address carries a well-formed one. */
export function linkedResultId(search: string) {
  const id = new URLSearchParams(search).get(RESULT_LINK_PARAM)?.trim();
  return id && JOB_ID.test(id) ? id : undefined;
}

/**
 * Drop the parameter once the link has been acted on, so a reload lands on the
 * workspace as the artist left it rather than jumping back to the shared result.
 * Everything else in the address is kept.
 */
export function clearLinkedResultParam(win: Pick<Window, "location" | "history"> = window) {
  const url = new URL(win.location.href);
  if (!url.searchParams.has(RESULT_LINK_PARAM)) return;
  url.searchParams.delete(RESULT_LINK_PARAM);
  win.history.replaceState(win.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
