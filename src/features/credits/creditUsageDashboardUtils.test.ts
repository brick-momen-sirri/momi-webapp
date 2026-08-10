import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BackendCreditDashboardBreakdownRow,
  BackendCreditDashboardBucket,
  BackendCreditDashboardGroup,
  BackendCreditDashboardRecentJob,
} from "../../services/backendApi";
import {
  buildBucketChartRows,
  bucketTotals,
  dashboardRangeParams,
  exportRecentCsv,
  filterRecentJobs,
  formatCredits,
  formatExpectedDelta,
  formatUsd,
  isOtherRow,
  matchesPivotCell,
  maxPivotCell,
  pivotCellTint,
  pivotCsv,
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

// Grouping, deduplication and the top-N fold now happen on the server, over
// every event in the range rather than the 500 the API returns in `recent`.
// What is left to prove here is that the chart and pivot read those buckets
// faithfully -- above all that perBucket stays aligned with its column.
function bucket(key: string, label: string, credits: number, usd = 0, jobs = 1): BackendCreditDashboardBucket {
  return {
    key,
    label,
    startAt: `${key}T00:00:00.000Z`,
    endAt: `${key}T23:59:59.999Z`,
    credits,
    usd,
    jobs,
  };
}

function breakdownRow(
  overrides: Partial<BackendCreditDashboardBreakdownRow> & { id: string; perBucket: number[] },
): BackendCreditDashboardBreakdownRow {
  const credits = overrides.perBucket.reduce((sum, value) => sum + value, 0);
  return {
    label: overrides.id,
    credits,
    usd: 0,
    jobs: 1,
    percentage: 0,
    ...overrides,
  };
}

const buckets = [bucket("2026-08-01", "Aug 01", 30), bucket("2026-08-02", "Aug 02", 20)];

describe("chart aggregation", () => {
  it("reads bucket totals straight through for the total view", () => {
    const chart = buildBucketChartRows(buckets, { project: [], user: [], model: [] }, "total");
    expect(chart.rows.map((row) => [row.key, row.label, row.total])).toEqual([
      ["2026-08-01", "Aug 01", 30],
      ["2026-08-02", "Aug 02", 20],
    ]);
    expect(chart.legend).toEqual([{ label: "Total", color: expect.any(String) }]);
  });

  it("keeps a zero-usage bucket present but empty", () => {
    const chart = buildBucketChartRows([bucket("2026-08-01", "Aug 01", 0, 0, 0)], { project: [], user: [], model: [] }, "total");
    expect(chart.rows[0]).toMatchObject({ key: "2026-08-01", total: 0, segments: [] });
  });

  it("stacks each breakdown row into the column its perBucket index names", () => {
    const chart = buildBucketChartRows(
      buckets,
      {
        project: [
          breakdownRow({ id: "p1", label: "Glass Tower", perBucket: [30, 5] }),
          breakdownRow({ id: "p2", label: "Riverside", perBucket: [0, 15] }),
        ],
        user: [],
        model: [],
      },
      "project",
    );
    // A row with no spend in a bucket must not emit a zero-height segment.
    expect(chart.rows[0].segments).toMatchObject([{ label: "Glass Tower", credits: 30 }]);
    expect(chart.rows[1].segments).toMatchObject([
      { label: "Glass Tower", credits: 5 },
      { label: "Riverside", credits: 15 },
    ]);
    expect(chart.legend.map((row) => row.label)).toEqual(["Glass Tower", "Riverside"]);
  });

  it("gives every breakdown row a distinct colour and greys the collapsed Other row", () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, index) => breakdownRow({ id: `m${index}`, perBucket: [1, 1] })),
      breakdownRow({ id: "__other__", label: "Other (4)", perBucket: [2, 2] }),
    ];
    const chart = buildBucketChartRows(buckets, { project: [], user: [], model: rows }, "model");
    const colors = chart.legend.map((row) => row.color);
    // Eight categories must not reuse a colour, or two models read as one.
    expect(new Set(colors.slice(0, 8)).size).toBe(8);
    expect(colors.at(-1)).not.toBe(colors[0]);
    expect(isOtherRow(rows.at(-1) as BackendCreditDashboardBreakdownRow)).toBe(true);
  });

  it("tolerates a perBucket shorter than the bucket list rather than emitting NaN", () => {
    const chart = buildBucketChartRows(
      buckets,
      { project: [breakdownRow({ id: "p1", perBucket: [30] })], user: [], model: [] },
      "project",
    );
    expect(chart.rows[1].segments).toEqual([]);
    expect(chart.rows.every((row) => Number.isFinite(row.total))).toBe(true);
  });
});

describe("pivot helpers", () => {
  it("scales cell tint against the largest cell and floors non-zero spend visible", () => {
    const rows = [breakdownRow({ id: "a", perBucket: [100, 1] }), breakdownRow({ id: "b", perBucket: [0, 50] })];
    const max = maxPivotCell(rows);
    expect(max).toBe(100);
    expect(pivotCellTint(100, max)).toBe(1);
    expect(pivotCellTint(50, max)).toBe(0.5);
    // A tiny-but-real value must still tint, otherwise it reads as an empty cell.
    expect(pivotCellTint(1, max)).toBe(0.06);
    expect(pivotCellTint(0, max)).toBe(0);
    expect(pivotCellTint(10, 0)).toBe(0);
  });

  it("sums bucket totals for the pivot footer", () => {
    expect(bucketTotals(buckets)).toEqual({ credits: 50, usd: 0, jobs: 2 });
    expect(bucketTotals([])).toEqual({ credits: 0, usd: 0, jobs: 0 });
  });

  it("matches an event to a cell only on the right id inside the bucket window", () => {
    const cellBucket: BackendCreditDashboardBucket = {
      key: "2026-W32",
      label: "Aug 3 - Aug 9",
      startAt: "2026-08-03T00:00:00.000Z",
      endAt: "2026-08-10T00:00:00.000Z",
      credits: 40,
      usd: 0,
      jobs: 2,
    };
    const inside = event({ timestamp: "2026-08-05T10:00:00.000Z" });
    expect(matchesPivotCell(inside, "project", "project_1", cellBucket)).toBe(true);
    expect(matchesPivotCell(inside, "project", "project_2", cellBucket)).toBe(false);
    expect(matchesPivotCell(inside, "user", "user_1", cellBucket)).toBe(true);
    expect(matchesPivotCell(inside, "model", "model_1", cellBucket)).toBe(true);
    // endAt is exclusive, so the first instant of the next bucket belongs there.
    expect(matchesPivotCell(event({ timestamp: "2026-08-10T00:00:00.000Z" }), "project", "project_1", cellBucket)).toBe(false);
    expect(matchesPivotCell(event({ timestamp: "2026-08-02T23:59:59.000Z" }), "project", "project_1", cellBucket)).toBe(false);
    expect(matchesPivotCell(event({ timestamp: "not-a-date" }), "project", "project_1", cellBucket)).toBe(false);
  });

  it("exports the on-screen grid, one column per bucket, with a totals footer", () => {
    const rows = [
      breakdownRow({ id: "p1", label: "Glass Tower", perBucket: [30, 5], percentage: 70, usd: 0.14 }),
      breakdownRow({ id: "p2", label: "Riverside", perBucket: [0, 15], percentage: 30, usd: 0.06 }),
    ];
    const lines = pivotCsv(buckets, rows, "project").split("\n");
    expect(lines[0]).toBe('"Project","Aug 01","Aug 02","Total","Share %","Cost"');
    expect(lines[1]).toBe('"Glass Tower","30","5","35","70","0.14"');
    expect(lines[3]).toBe('"Total","30","20","50","100","0"');
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
