import { afterEach, describe, expect, it, vi } from "vitest";

import type { BackendCreditDashboardGroup, BackendCreditDashboardRecentJob } from "../../services/backendApi";
import {
  buildChartRows,
  dashboardRangeParams,
  exportRecentCsv,
  filterRecentJobs,
  formatCredits,
  formatExpectedDelta,
  formatUsd,
  recentJobsCsv,
  sortRecentJobs,
} from "./creditUsageDashboardUtils";

function event(overrides: Partial<BackendCreditDashboardRecentJob> = {}): BackendCreditDashboardRecentJob {
  return {
    jobId: "job_1",
    projectId: "project_1",
    projectName: "Glass Tower",
    userId: "user_1",
    userName: "Momen",
    modelId: "model_1",
    modelName: "Comfy",
    status: "completed",
    credits: 10,
    usd: 0.4,
    expectedCredits: 8,
    source: "comfy",
    resolution: "1080p",
    createdAt: "2026-08-01T10:00:00.000Z",
    completedAt: "2026-08-01T10:01:00.000Z",
    timestamp: "2026-08-01T10:01:00.000Z",
    ...overrides,
  };
}

const days = [{ date: "2026-08-01", credits: 30, usd: 1.2, jobs: 2 }];

describe("dashboard range selection", () => {
  it("sends explicit dates only for a custom range", () => {
    expect(dashboardRangeParams("custom", "2026-07-01", "2026-07-31")).toEqual({
      range: "custom",
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(dashboardRangeParams("last30", "2020-01-01", "2020-01-02")).toEqual({
      range: "last30",
      from: undefined,
      to: undefined,
    });
  });

  it.each(["today", "last7", "last30", "thisMonth", "lastMonth"] as const)(
    "leaves date-boundary calculation to the backend for %s",
    (range) => {
      expect(dashboardRangeParams(range, "1900-01-01", "2999-12-31")).toEqual({
        range,
        from: undefined,
        to: undefined,
      });
    },
  );
});

describe("chart aggregation", () => {
  it("groups equivalent project names after trimming and preserves totals", () => {
    const chart = buildChartRows(
      days,
      [event(), event({ jobId: "job_2", projectName: "  Glass Tower  ", credits: 20 })],
      "project",
    );
    expect(chart.legend.map((row) => row.label)).toEqual(["Glass Tower"]);
    expect(chart.rows[0].segments).toMatchObject([{ label: "Glass Tower", credits: 30 }]);
    expect(chart.rows[0].total).toBe(30);
  });

  it("does not double-count a duplicate job record", () => {
    const chart = buildChartRows([{ date: "2026-08-01", credits: 10, usd: 0.4, jobs: 1 }], [event(), event()], "project");
    expect(chart.rows[0].segments).toMatchObject([{ label: "Glass Tower", credits: 10 }]);
  });

  it("ignores malformed and zero-usage records and labels missing project names", () => {
    const chart = buildChartRows(
      [{ date: "2026-08-01", credits: 5, usd: 0.2, jobs: 1 }],
      [
        event({ jobId: "bad-date", timestamp: "not-a-date", credits: 999 }),
        event({ jobId: "nan", credits: Number.NaN }),
        event({ jobId: "zero", credits: 0 }),
        event({ jobId: "unknown", projectName: " ", credits: 5 }),
      ],
      "project",
    );
    expect(chart.legend.map((row) => row.label)).toEqual(["Unknown project"]);
    expect(chart.rows[0].segments).toMatchObject([{ label: "Unknown project", credits: 5 }]);
  });

  it("keeps a zero-usage day finite and empty", () => {
    const chart = buildChartRows([{ date: "2026-08-01", credits: 0, usd: 0, jobs: 0 }], [], "total");
    expect(chart.rows).toEqual([{ date: "2026-08-01", total: 0, segments: [] }]);
  });

  it("preserves four-digit project names as labels", () => {
    const chart = buildChartRows(
      [{ date: "2026-08-01", credits: 12, usd: 0.48, jobs: 1 }],
      [event({ projectName: "2024 Glass Tower", credits: 12 })],
      "project",
    );
    expect(chart.legend.map((row) => row.label)).toEqual(["2024 Glass Tower"]);
    expect(chart.rows[0].segments[0]).toMatchObject({ label: "2024 Glass Tower", credits: 12 });
  });

  it("keeps the top five groups, rolls the rest into Other, and produces finite totals", () => {
    const events = Array.from({ length: 2_000 }, (_, index) =>
      event({
        jobId: `job_${index}`,
        projectName: `Project ${index % 10}`,
        credits: (index % 10) + 1,
      }),
    );
    const total = events.reduce((sum, row) => sum + row.credits, 0);
    const chart = buildChartRows([{ date: "2026-08-01", credits: total, usd: 0, jobs: events.length }], events, "project");

    expect(chart.legend).toHaveLength(6);
    expect(chart.legend.at(-1)?.label).toBe("Other");
    expect(chart.rows[0].segments.reduce((sum, segment) => sum + segment.credits, 0)).toBe(total);
    expect(chart.rows[0].segments.every((segment) => Number.isFinite(segment.credits))).toBe(true);
  });
});

describe("cost and comparison formatting", () => {
  it("formats Comfy and Project Dream actual-versus-expected comparisons", () => {
    const group = (label: string, expectedCredits: number, actualVsExpectedCredits: number) =>
      ({ label, expectedCredits, actualVsExpectedCredits }) as BackendCreditDashboardGroup;

    expect(formatExpectedDelta(group("Comfy", 10, 2.5))).toBe("10 expected / +2.5 cr");
    expect(formatExpectedDelta(group("Project Dream", 10, -1))).toBe("10 expected / -1 cr");
    expect(formatExpectedDelta(group("Unknown", 0, 0))).toBe("No expected price");
    expect(formatCredits(Number.NaN)).toBe("0");
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.123456)).toBe("$0.1235");
  });
});

describe("recent-event preparation", () => {
  it("filters by status and searches project, user, workflow, resolution, and id fields", () => {
    const rows = [event(), event({ jobId: "job_2", projectName: "Timber Cabin", status: "failed" })];
    expect(filterRecentJobs(rows, "timber", "failed").map((row) => row.jobId)).toEqual(["job_2"]);
    expect(filterRecentJobs(rows, "momen", "completed").map((row) => row.jobId)).toEqual(["job_1"]);
  });

  it("sorts malformed numeric values as zero without mutating the input", () => {
    const rows = [event(), event({ jobId: "job_2", credits: Number.NaN })];
    expect(sortRecentJobs(rows, "credits", "asc").map((row) => row.jobId)).toEqual(["job_2", "job_1"]);
    expect(rows.map((row) => row.jobId)).toEqual(["job_1", "job_2"]);
  });

  it.each(["asc", "desc"] as const)("preserves source order for equal values when sorting %s", (direction) => {
    const rows = [
      event({ jobId: "job_first", credits: 10 }),
      event({ jobId: "job_middle", credits: 5 }),
      event({ jobId: "job_second", credits: 10 }),
    ];
    const sorted = sortRecentJobs(rows, "credits", direction).filter((row) => row.credits === 10);
    expect(sorted.map((row) => row.jobId)).toEqual(["job_first", "job_second"]);
  });

  it("produces escaped, machine-readable CSV", () => {
    const csv = recentJobsCsv([event({ projectName: 'Tower, "North"' })]);
    expect(csv).toContain('"Tower, ""North"""');
    expect(csv.split("\n")).toHaveLength(2);
  });
});

describe("CSV export lifecycle", () => {
  afterEach(() => vi.restoreAllMocks());

  it("clicks a temporary download and revokes its object URL", () => {
    const createObjectURL = vi.fn(() => "blob:credit-events");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const click = vi.fn();
    const remove = vi.fn();
    const link = { href: "", download: "", click, remove } as unknown as HTMLAnchorElement;
    vi.spyOn(document, "createElement").mockReturnValue(link);
    const appendChild = vi.spyOn(document.body, "appendChild").mockImplementation((node) => node);

    exportRecentCsv([event()]);

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(link.download).toMatch(/^credit-events-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(appendChild).toHaveBeenCalledWith(link);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:credit-events");
  });
});
