// The feed loads thirty jobs at a time out of a store holding thousands, so what
// jobPageParams asks the server for decides what any client-side filter is even
// able to find. A filter left out of this object silently becomes "search the last
// page" instead of "search the workspace".

import { describe, expect, it } from "vitest";
import { ALL_JOB_OWNERS, ALL_PROJECTS_ID, JOB_PAGE_SIZE, jobPageParams } from "./workspaceUtils";

describe("jobPageParams", () => {
  it("asks for a whole page of every user's jobs by default", () => {
    expect(jobPageParams(ALL_PROJECTS_ID, "all", 0)).toEqual({
      limit: JOB_PAGE_SIZE,
      offset: 0,
      projectId: undefined,
      folderId: undefined,
      archived: false,
      userId: undefined,
    });
  });

  it("sends the chosen owner to the server rather than leaving it to the page", () => {
    expect(jobPageParams(ALL_PROJECTS_ID, "all", 0, false, "usr_other").userId).toBe("usr_other");
  });

  it("treats the 'anyone' choice as no filter, not as a user named 'all'", () => {
    expect(jobPageParams(ALL_PROJECTS_ID, "all", 0, false, ALL_JOB_OWNERS).userId).toBeUndefined();
  });

  it("keeps the owner filter while paging, so 'load more' stays inside that user", () => {
    expect(jobPageParams(ALL_PROJECTS_ID, "all", JOB_PAGE_SIZE, false, "usr_other")).toMatchObject({
      offset: JOB_PAGE_SIZE,
      userId: "usr_other",
    });
  });

  it("combines the owner with a project and folder, since both narrow the same query", () => {
    expect(jobPageParams("proj_1", "fld_2", 0, true, "usr_other")).toEqual({
      limit: JOB_PAGE_SIZE,
      offset: 0,
      projectId: "proj_1",
      folderId: "fld_2",
      archived: true,
      userId: "usr_other",
    });
  });
});
