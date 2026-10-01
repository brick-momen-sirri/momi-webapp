import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../types";
import { DraftCountdown, DraftCountdownChip } from "./DraftCountdown";

function draftJob(): Job {
  return {
    id: "job_draft",
    projectId: "prj_a",
    userId: "usr_a",
    modelType: "Seedance",
    backendCategory: "image_to_video",
    inputType: "single_image",
    prompt: "p",
    resolution: "480p",
    status: "completed",
    inputImages: [],
    durationSeconds: 5,
    createdAt: "2026-09-30T11:00:00.000Z",
    draft: {
      kind: "seedance-2.5-draft",
      taskId: "cgt-1",
      createdAt: "2026-09-30T11:00:00.000Z",
      expiresAt: "2026-10-07T11:00:00.000Z",
    },
  };
}

describe("draft countdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("ticks down every second and colours itself by the time left", () => {
    render(<DraftCountdown job={draftJob()} />);
    const timer = screen.getByRole("timer");
    expect(timer).toHaveAttribute("data-phase", "fresh");
    expect(timer).toHaveTextContent(/06\s*d\s*22\s*h\s*30\s*m\s*00\s*s/);
    expect(timer).toHaveTextContent(/1080p final before/);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(timer).toHaveTextContent(/06\s*d\s*22\s*h\s*29\s*m\s*59\s*s/);
  });

  it("says a final is already in Results", () => {
    render(<DraftCountdown job={draftJob()} finalStatus="completed" />);
    expect(screen.getByRole("timer")).toHaveTextContent(/final in Results/);
  });

  it("shows the expired state once the window has closed", () => {
    vi.setSystemTime(new Date("2026-10-07T10:30:00.000Z"));
    render(<DraftCountdown job={draftJob()} />);
    const timer = screen.getByRole("timer");
    expect(timer).toHaveAttribute("data-phase", "expired");
    expect(timer).toHaveTextContent(/render a new draft/);
  });

  it("fits the grid tile as a short label", () => {
    vi.setSystemTime(new Date("2026-10-07T09:49:30.000Z"));
    const { container } = render(<DraftCountdownChip job={draftJob()} />);
    const chip = container.querySelector(".draft-chip");
    expect(chip).toHaveAttribute("data-phase", "urgent");
    expect(chip).toHaveTextContent("40m");
  });

  it("renders nothing for a draft that does not expire", () => {
    const job = { ...draftJob(), draft: { kind: "minimax-h3-768p" as const, createdAt: "2026-09-30T11:00:00.000Z" } };
    const { container } = render(<DraftCountdown job={job} />);
    expect(container).toBeEmptyDOMElement();
  });
});
