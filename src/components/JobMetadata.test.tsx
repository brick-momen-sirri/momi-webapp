import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { JobMetadata } from "./JobMetadata";
import type { Job } from "../types";

// Still Images presets run on their own pods, which return no usage figures. The
// only number that ever existed for them was a flat per-preset estimate, and they
// are excluded from every credit total (isCreditExemptJob on the backend). The
// panel has to say so rather than print a figure that contradicts the totals.

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    projectId: "prj_1",
    userId: "usr_1",
    modelType: "Veo 3",
    inputType: "single_image",
    prompt: "a shot",
    resolution: "1080p",
    status: "completed",
    inputImages: [],
    createdAt: "2026-08-12T10:00:00.000Z",
    ...overrides,
  } as Job;
}

const stillImageOptions = { stillImage: { categoryId: "reference-generator", settings: {} } } as Job["workflowOptions"];

function creditCell() {
  const label = screen.queryByText("Credits") ?? screen.queryByText("Estimate");
  return label?.parentElement?.parentElement?.textContent ?? "";
}

describe("JobMetadata credits", () => {
  it("shows -- for a still image job instead of a credit figure", () => {
    render(<JobMetadata job={job({ workflowOptions: stillImageOptions, creditsUsed: 10 })} />);
    expect(creditCell()).toContain("--");
    expect(creditCell()).not.toContain("10");
  });

  it("shows -- rather than falling back to the preset's estimate", () => {
    // The estimate branch is the one that would otherwise leak a number here,
    // and "10 est." reads as a cost that is going to be charged.
    render(<JobMetadata job={job({ workflowOptions: stillImageOptions, creditsEstimated: 10 })} />);
    expect(creditCell()).toContain("--");
    expect(screen.queryByText("Estimate")).not.toBeInTheDocument();
  });

  it("still reports real credits for an animation job", () => {
    render(<JobMetadata job={job({ workflowOptions: { save: { shotNumber: "0007" } }, creditsUsed: 32 })} />);
    expect(creditCell()).toContain("32");
    expect(creditCell()).not.toContain("--");
  });
});
