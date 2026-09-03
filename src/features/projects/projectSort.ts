import type { Project } from "../../types";

export type ProjectSortMode = "default" | "number" | "name" | "spend_desc" | "spend_asc";

export const projectSortOptions: Array<{ id: ProjectSortMode; label: string }> = [
  { id: "default", label: "Default order" },
  { id: "number", label: "Project number" },
  { id: "name", label: "Name (A-Z)" },
  { id: "spend_desc", label: "Highest spend" },
  { id: "spend_asc", label: "Lowest spend" },
];

export function isProjectSortMode(value: string): value is ProjectSortMode {
  return projectSortOptions.some((option) => option.id === value);
}

/**
 * The project number as a number, for sorting.
 *
 * shortName is a four-digit code on every project the app creates, but projects
 * discovered on disk can carry anything, and a string sort would put "999"
 * after "1000". Anything unparseable sorts to the end rather than to 0, where it
 * would sit above every real project.
 */
function projectNumber(project: Project) {
  const parsed = Number.parseInt(project.shortName ?? "", 10);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function spend(project: Project) {
  return project.usdUsed ?? 0;
}

/**
 * Projects in display order.
 *
 * Pins float to the top in the default view only. Picking a sort is a request to
 * rank *everything* by it: there are eight pinned projects here, so a spend sort
 * that kept them above the ranking would answer "which project costs the most"
 * with two separate blocks, the real answer buried in the second one. In the
 * default view there is no ranking to compete with, so pins take the top.
 *
 * Every comparison falls back to the incoming order, which is the caller's
 * original array order. That keeps the list stable: projects that tie -- and
 * with spend, most of them tie at $0 -- do not reshuffle between renders.
 */
export function sortProjects(projects: Project[], mode: ProjectSortMode, pinnedProjectIds: string[]): Project[] {
  const pinnedRank = new Map(pinnedProjectIds.map((projectId, index) => [projectId, index]));

  return projects
    .map((project, index) => ({ project, index }))
    .sort((a, b) => {
      if (mode === "default") {
        const aPinned = pinnedRank.has(a.project.id);
        const bPinned = pinnedRank.has(b.project.id);
        if (aPinned && bPinned) return (pinnedRank.get(a.project.id) ?? 0) - (pinnedRank.get(b.project.id) ?? 0);
        if (aPinned !== bPinned) return aPinned ? -1 : 1;
        return a.index - b.index;
      }

      if (mode === "number") {
        const delta = projectNumber(a.project) - projectNumber(b.project);
        if (delta) return delta;
      } else if (mode === "name") {
        // numeric so "Shot 2" precedes "Shot 10"; base sensitivity so case and
        // accents do not split otherwise-identical names apart.
        const delta = a.project.name.localeCompare(b.project.name, undefined, { numeric: true, sensitivity: "base" });
        if (delta) return delta;
      } else if (mode === "spend_desc") {
        const delta = spend(b.project) - spend(a.project);
        if (delta) return delta;
      } else if (mode === "spend_asc") {
        const delta = spend(a.project) - spend(b.project);
        if (delta) return delta;
      }

      return a.index - b.index;
    })
    .map(({ project }) => project);
}
