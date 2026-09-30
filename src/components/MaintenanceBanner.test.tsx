import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getDisabledReason } from "../features/generation/generationUtils";
import { MaintenanceBanner } from "./MaintenanceBanner";

const ready = {
  isDemoAccount: false,
  hasViewOnlyProjectAccess: false,
  insufficientCredits: false,
  selectedProjectId: "prj_1",
  selectedProject: { id: "prj_1" } as never,
  hasMissingImages: false,
  hasMissingVideo: false,
  hasCropIssues: false,
  hasMissingPrompt: false,
  promptOverflowCharacters: 0,
  requiredImages: 1,
};

describe("generation pause", () => {
  it("shows the server's message while paused and nothing otherwise", () => {
    const { rerender } = render(<MaintenanceBanner message="An update is about to start. Please wait a few minutes." />);
    expect(screen.getByRole("status")).toHaveTextContent("An update is about to start. Please wait a few minutes.");

    rerender(<MaintenanceBanner message={undefined} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("is the reason Generate is disabled, ahead of anything the artist could fix", () => {
    expect(getDisabledReason(ready)).toBeUndefined();
    expect(getDisabledReason({ ...ready, maintenanceMessage: "Updating" })).toBe("Updating");
    expect(getDisabledReason({ ...ready, isDemoAccount: true, hasMissingPrompt: true, maintenanceMessage: "Updating" })).toBe(
      "Updating",
    );
  });
});
