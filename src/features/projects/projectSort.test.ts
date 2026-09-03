// The project list is ~100 rows, so its order is how anyone finds anything. Two
// rules are easy to break: a pin outranks the sort, and ties keep the incoming
// order so the list does not reshuffle under the cursor between renders.

import { describe, expect, it } from "vitest";
import type { Project } from "../../types";
import { sortProjects } from "./projectSort";

function project(name: string, shortName: string, usdUsed?: number): Project {
  return {
    id: `prj_${name.toLowerCase().replace(/\s+/g, "_")}`,
    name,
    shortName,
    usdUsed,
    ownerId: "usr_owner",
    members: [],
    groupMembers: [],
    jobCount: 0,
    memberCount: 0,
    createdAt: "2026-09-03T00:00:00.000Z",
    visibility: "team",
  } as Project;
}

const projects = [
  project("Shark", "8325", 105.76),
  project("Urban Design", "8430", 601.72),
  project("Aramco", "7443", 54.63),
  project("Playground", "0999", 1.7478),
];

const names = (list: Project[]) => list.map((p) => p.name);

describe("sortProjects", () => {
  it("keeps the given order by default", () => {
    expect(names(sortProjects(projects, "default", []))).toEqual(["Shark", "Urban Design", "Aramco", "Playground"]);
  });

  it("sorts by project number numerically, not as text", () => {
    // "0999" must precede "7443": a string sort would not guarantee it.
    expect(names(sortProjects(projects, "number", []))).toEqual(["Playground", "Aramco", "Shark", "Urban Design"]);
  });

  it("sorts by name A-Z", () => {
    expect(names(sortProjects(projects, "name", []))).toEqual(["Aramco", "Playground", "Shark", "Urban Design"]);
  });

  it("sorts highest spend first", () => {
    expect(names(sortProjects(projects, "spend_desc", []))).toEqual(["Urban Design", "Shark", "Aramco", "Playground"]);
  });

  it("sorts lowest spend first", () => {
    expect(names(sortProjects(projects, "spend_asc", []))).toEqual(["Playground", "Aramco", "Shark", "Urban Design"]);
  });

  it("treats a project with no spend figure as zero rather than dropping it", () => {
    const withUnknown = [...projects, project("Fresh", "8500")];
    expect(names(sortProjects(withUnknown, "spend_asc", []))[0]).toBe("Fresh");
    expect(names(sortProjects(withUnknown, "spend_desc", []))).toContain("Fresh");
  });

  it("keeps pinned projects on top of any sort", () => {
    // Aramco is the cheapest of the three real spenders, so a highest-spend sort
    // would bury it -- the pin has to win.
    const sorted = sortProjects(projects, "spend_desc", ["prj_aramco"]);
    expect(names(sorted)[0]).toBe("Aramco");
  });

  it("orders several pins by pin order, not by the sort", () => {
    const sorted = sortProjects(projects, "name", ["prj_shark", "prj_aramco"]);
    expect(names(sorted).slice(0, 2)).toEqual(["Shark", "Aramco"]);
  });

  it("sorts unparseable project numbers to the end, not to the front", () => {
    // Sorting these as 0 would float discovered folders above every real project.
    const withOddCode = [project("Legacy", "no-code"), ...projects];
    expect(names(sortProjects(withOddCode, "number", [])).at(-1)).toBe("Legacy");
  });

  it("is stable when everything ties", () => {
    const flat = [project("B", "1000", 0), project("A", "1000", 0), project("C", "1000", 0)];
    expect(names(sortProjects(flat, "spend_desc", []))).toEqual(["B", "A", "C"]);
  });
});
