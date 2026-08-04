import { describe, expect, it } from "vitest";

import { emptyJobs, emptyProjects, emptyUsers } from "./productionDefaults";

describe("production workspace defaults", () => {
  it("start empty instead of exposing fixture users, projects, or jobs", () => {
    expect(emptyUsers()).toEqual([]);
    expect(emptyProjects()).toEqual([]);
    expect(emptyJobs()).toEqual([]);
  });

  it("return fresh arrays so one session cannot mutate another session's defaults", () => {
    expect(emptyUsers()).not.toBe(emptyUsers());
    expect(emptyProjects()).not.toBe(emptyProjects());
    expect(emptyJobs()).not.toBe(emptyJobs());
  });
});
