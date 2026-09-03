// Saving a spend limit used to blank the figures the limit is measured against:
// the project read 0 jobs and $0.00 spent until the next full refresh, so the cap
// looked like it had reset the history it is meant to be judged against. The
// mutation routes answer with the stored project, and the store strips the derived
// stats before writing, so the reply genuinely has no spend in it.

import { describe, expect, it } from "vitest";
import type { Project } from "../../types";
import { withKnownProjectStats } from "./projectStats";

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "prj_playground",
    name: "Playground",
    shortName: "1234",
    ownerId: "usr_owner",
    members: [],
    groupMembers: [],
    jobCount: 0,
    memberCount: 0,
    createdAt: "2026-09-03T00:00:00.000Z",
    visibility: "team",
    ...overrides,
  } as Project;
}

/** What a mutation route actually returns: stored config, stats stripped. */
function mutationReply(overrides: Partial<Project> = {}) {
  return project({ jobCount: 0, spendLimitUsd: 2, ...overrides });
}

describe("withKnownProjectStats", () => {
  it("keeps the spend the mutation reply omits", () => {
    const previous = project({ jobCount: 42, creditsUsed: 368.79, monthCreditsUsed: 12.5, usdUsed: 1.7478 });

    const merged = withKnownProjectStats(previous, mutationReply());

    expect(merged.usdUsed).toBe(1.7478);
    expect(merged.creditsUsed).toBe(368.79);
    expect(merged.monthCreditsUsed).toBe(12.5);
    expect(merged.jobCount).toBe(42);
  });

  it("still applies the configuration the reply is authoritative about", () => {
    const previous = project({ usdUsed: 1.7478, spendLimitUsd: null, description: "before" });

    const merged = withKnownProjectStats(previous, mutationReply({ description: "after", visibility: "private" }));

    expect(merged.spendLimitUsd).toBe(2);
    expect(merged.description).toBe("after");
    expect(merged.visibility).toBe("private");
  });

  it("lets a cleared limit through rather than reviving the old one", () => {
    // null is how the UI clears a limit, and it must not be mistaken for "absent".
    const previous = project({ spendLimitUsd: 25, usdUsed: 1.7478 });

    const merged = withKnownProjectStats(previous, mutationReply({ spendLimitUsd: null }));

    expect(merged.spendLimitUsd).toBeNull();
    expect(merged.usdUsed).toBe(1.7478);
  });

  it("prefers real figures when a reply does carry them", () => {
    const previous = project({ jobCount: 42, creditsUsed: 368.79, usdUsed: 1.7478 });

    const merged = withKnownProjectStats(previous, mutationReply({ jobCount: 43, creditsUsed: 400, usdUsed: 2.5 }));

    expect(merged.jobCount).toBe(43);
    expect(merged.creditsUsed).toBe(400);
    expect(merged.usdUsed).toBe(2.5);
  });

  it("reports a genuine zero as zero rather than falling back", () => {
    // A project with no spend must not inherit a stale figure.
    const previous = project({ creditsUsed: 0, monthCreditsUsed: 0, usdUsed: 0 });

    const merged = withKnownProjectStats(previous, mutationReply());

    expect(merged.usdUsed).toBe(0);
    expect(merged.creditsUsed).toBe(0);
  });
});
