// The dashboard reports what the company spent. It is a collapsed summary button
// that opens a portalled modal, and only fetches once opened -- so "does it
// render numbers" and "does it fetch" are two separate tests, not one.
//
// The API module is mocked: this is about presentation and failure handling, not
// about the arithmetic (that lives in creditDashboardService and is tested there).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const fetchBackendCreditDashboard = vi.fn();

vi.mock("../services/backendApi", () => ({
  fetchBackendCreditDashboard: (...args: unknown[]) => fetchBackendCreditDashboard(...args),
  thumbnailMediaUrl: (url: string) => url,
  THUMBNAIL_WIDTH: { chip: 240, grid: 480, preview: 960 },
}));

const { CreditUsageDashboard } = await import("./CreditUsageDashboard");

// Mirrors BackendCreditDashboard exactly. Worth keeping faithful: an invented
// shape here produces tests that pass against a component the real backend would
// break.
function emptyPayload() {
  return {
    generatedAt: "2026-08-04T12:00:00.000Z",
    month: "2026-08",
    range: { preset: "last30", label: "Last 30 days", startAt: "2026-07-06", endAt: "2026-08-05" },
    summary: {
      totalCredits: 0,
      totalUsd: 0,
      todayCredits: 0,
      todayUsd: 0,
      todayRuns: 0,
      monthCredits: 0,
      monthUsd: 0,
      monthRuns: 0,
      projectedMonthCredits: 0,
      projectedMonthUsd: 0,
      periodCredits: 0,
      periodUsd: 0,
      periodRuns: 0,
      averageCreditsPerRun: 0,
      burnRateCreditsPerDay: 0,
      jobsWithUsage: 0,
      totalJobs: 0,
    },
    byProject: [],
    byUser: [],
    byModel: [],
    byDay: [],
    anomalies: [],
    recent: [],
    nodeRows: [],
  };
}

function group(id: string, label: string, credits: number) {
  return {
    id,
    label,
    credits,
    usd: credits / 25,
    jobs: 1,
    percentage: credits,
    averageCreditsPerRun: credits,
    minCredits: credits,
    maxCredits: credits,
  };
}

function renderDashboard(overrides: Record<string, unknown> = {}) {
  return render(<CreditUsageDashboard creditsRemaining={1234.5} monthlyCreditsSpent={678.25} {...overrides} />);
}

async function openDashboard(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Credit usage/i }));
  await waitFor(() => expect(fetchBackendCreditDashboard).toHaveBeenCalled());
}

beforeEach(() => {
  fetchBackendCreditDashboard.mockReset();
  fetchBackendCreditDashboard.mockResolvedValue(emptyPayload());
  document.body.style.overflow = "";
});

describe("collapsed summary", () => {
  it("shows the balance and month-to-date spend from props", () => {
    renderDashboard();
    const summary = screen.getByRole("button", { name: /Credit usage/i });
    // Both figures come from props, so they are on screen before any fetch.
    expect(summary.textContent).toMatch(/678/);
    expect(summary.textContent).toMatch(/1[,.\s]?23[45]/);
  });

  it("uses a custom month label when one is supplied", () => {
    renderDashboard({ monthlyCreditsLabel: "spent in August" });
    expect(screen.getByText(/spent in August/)).toBeInTheDocument();
  });

  it("does not fetch until it is opened", () => {
    renderDashboard();
    // Opening is a deliberate action; the panel must not spend a request on every
    // page load for a panel nobody looked at.
    expect(fetchBackendCreditDashboard).not.toHaveBeenCalled();
  });
});

describe("opening", () => {
  it("fetches once opened", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await openDashboard(user);
    expect(fetchBackendCreditDashboard).toHaveBeenCalledTimes(1);
  });

  it("asks the backend for the selected range rather than filtering locally", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await openDashboard(user);

    const args = fetchBackendCreditDashboard.mock.calls[0][0] as { range?: string };
    expect(args.range).toBe("last30");
  });

  it("renders an empty payload without crashing", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await expect(openDashboard(user)).resolves.toBeUndefined();
  });

  it("restores body scrolling and removes the dialog when Escape closes it", async () => {
    const user = userEvent.setup();
    document.body.style.overflow = "clip";
    renderDashboard();
    await openDashboard(user);
    expect(document.body.style.overflow).toBe("hidden");

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe("clip");
  });
});

describe("failure handling", () => {
  it("shows the backend's error rather than an empty dashboard that looks like zero spend", async () => {
    const user = userEvent.setup();
    fetchBackendCreditDashboard.mockRejectedValue(new Error("Credit tracker unreachable"));
    renderDashboard();

    await user.click(screen.getByRole("button", { name: /Credit usage/i }));
    // Zero-looking numbers with no error would be read as "we spent nothing".
    await waitFor(() => expect(screen.getByText(/Credit tracker unreachable/)).toBeInTheDocument());
  });

  it("falls back to a generic message when the rejection is not an Error", async () => {
    const user = userEvent.setup();
    fetchBackendCreditDashboard.mockRejectedValue("socket hang up");
    renderDashboard();

    await user.click(screen.getByRole("button", { name: /Credit usage/i }));
    await waitFor(() => expect(screen.getByText(/Could not load credit usage/i)).toBeInTheDocument());
  });
});

describe("populated data", () => {
  it("lists the per-project rows the backend returned", async () => {
    const user = userEvent.setup();
    fetchBackendCreditDashboard.mockResolvedValue({
      ...emptyPayload(),
      byProject: [group("p1", "Glass Tower", 75), group("p2", "Timber Cabin", 25)],
    });

    renderDashboard();
    await openDashboard(user);
    await waitFor(() => expect(screen.getByText(/Glass Tower/)).toBeInTheDocument());
    expect(screen.getByText(/Timber Cabin/)).toBeInTheDocument();
  });

  it("surfaces anomalies the backend flagged", async () => {
    const user = userEvent.setup();
    fetchBackendCreditDashboard.mockResolvedValue({
      ...emptyPayload(),
      anomalies: [
        {
          id: "a1",
          type: "daily_high" as const,
          severity: "warning" as const,
          message: "Spend spike: 3x the daily average",
          credits: 300,
          threshold: 100,
        },
      ],
    });

    renderDashboard();
    await openDashboard(user);
    await waitFor(() => expect(screen.getByText(/Spend spike/)).toBeInTheDocument());
  });
});
