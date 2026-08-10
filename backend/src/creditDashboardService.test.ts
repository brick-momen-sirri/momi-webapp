import test from "node:test";
import assert from "node:assert/strict";

import {
  addDay,
  addDays,
  bucketStart,
  buildCreditBuckets,
  buildCreditPivot,
  creditDashboardGranularity,
  creditDashboardRange,
  dayKey,
  daysBetween,
  defaultGranularity,
  fillDailyRange,
  isoWeekKey,
  normalizeProjectStatName,
  parseDateOnly,
  projectStatNameCandidates,
  findCreditTrackerProjectStats,
  roundCredits,
  roundUsd,
  runDurationSeconds,
  sortedGroups,
  startOfDay,
  stringField,
  type CreditDashboardDay,
  type CreditDashboardGroup,
  type CreditDashboardRecentJob,
} from "./creditDashboardService.js";
import type { Job, Project } from "./types.js";
import type { CreditTrackerProjectStats } from "./creditUsageService.js";

// ~350 lines of date and credit arithmetic that reports what the company spent.
// It was untestable while it lived inside index.ts among the route handlers.

test("roundCredits keeps two decimals, roundUsd keeps four", () => {
  assert.equal(roundCredits(1.005), 1.0);
  assert.equal(roundCredits(1.006), 1.01);
  assert.equal(roundCredits(12.3456), 12.35);
  assert.equal(roundUsd(0.123456), 0.1235);
  assert.equal(roundUsd(0.00004), 0);
});

test("roundCredits does not accumulate float drift over a summed column", () => {
  // The dashboard adds these up per project and per day; 0.1 x 3 must not show
  // as 0.30000000000000004.
  let total = 0;
  for (let i = 0; i < 3; i += 1) total = roundCredits(total + 0.1);
  assert.equal(total, 0.3);
});

test("startOfDay drops the time component without shifting the date", () => {
  const midday = new Date(2026, 7, 4, 13, 45, 30, 123);
  const start = startOfDay(midday);
  assert.equal(dayKey(start), "2026-08-04");
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
  assert.equal(start.getSeconds(), 0);
  assert.equal(start.getMilliseconds(), 0);
});

test("addDays crosses month and year boundaries", () => {
  assert.equal(dayKey(addDays(new Date(2026, 7, 31), 1)), "2026-09-01");
  assert.equal(dayKey(addDays(new Date(2026, 11, 31), 1)), "2027-01-01");
  assert.equal(dayKey(addDays(new Date(2026, 0, 1), -1)), "2025-12-31");
  // Leap year, since a naive +86400000ms implementation gets this wrong.
  assert.equal(dayKey(addDays(new Date(2028, 1, 28), 1)), "2028-02-29");
});

test("addDays does not mutate its input", () => {
  const original = new Date(2026, 7, 4);
  addDays(original, 10);
  assert.equal(dayKey(original), "2026-08-04");
});

test("dayKey zero-pads month and day", () => {
  assert.equal(dayKey(new Date(2026, 0, 5)), "2026-01-05");
  assert.equal(dayKey(new Date(2026, 10, 25)), "2026-11-25");
});

test("daysBetween counts whole days and never returns zero", () => {
  const start = new Date(2026, 7, 1);
  assert.equal(daysBetween(start, addDays(start, 7)), 7);
  assert.equal(daysBetween(start, addDays(start, 1)), 1);
  // A same-instant or inverted range still yields at least one day, so callers
  // dividing by it cannot produce Infinity.
  assert.equal(daysBetween(start, start), 1);
  assert.equal(daysBetween(start, addDays(start, -5)), 1);
});

test("parseDateOnly accepts YYYY-MM-DD and falls back on anything else", () => {
  const fallback = new Date(2026, 0, 1);
  assert.equal(dayKey(parseDateOnly("2026-08-04", fallback)), "2026-08-04");
  for (const bad of ["", "2026-8-4", "04-08-2026", "2026-08-04T10:00:00Z", "not a date", "20260804"]) {
    assert.equal(dayKey(parseDateOnly(bad, fallback)), "2026-01-01", `expected fallback for ${JSON.stringify(bad)}`);
  }
});

test("parseDateOnly returns a local midnight, not a UTC instant", () => {
  // Off-by-one-day bugs in the dashboard come from parsing as UTC and then
  // formatting locally.
  const parsed = parseDateOnly("2026-08-04", new Date(2026, 0, 1));
  assert.equal(parsed.getHours(), 0);
  assert.equal(dayKey(parsed), "2026-08-04");
});

test("creditDashboardRange: today is a single half-open day", () => {
  const now = new Date(2026, 7, 4, 15, 0, 0);
  const range = creditDashboardRange({ range: "today" }, now);
  assert.equal(range.preset, "today");
  assert.equal(dayKey(range.startAt), "2026-08-04");
  assert.equal(dayKey(range.endAt), "2026-08-05");
  assert.equal(daysBetween(range.startAt, range.endAt), 1);
});

test("creditDashboardRange: last7 and the last30 default are inclusive of today", () => {
  const now = new Date(2026, 7, 10, 9, 0, 0);

  const last7 = creditDashboardRange({ range: "last7" }, now);
  assert.equal(dayKey(last7.startAt), "2026-08-04", "6 days back, plus today, is 7");
  assert.equal(dayKey(last7.endAt), "2026-08-11");
  assert.equal(daysBetween(last7.startAt, last7.endAt), 7);

  const fallback = creditDashboardRange({}, now);
  assert.equal(fallback.preset, "last30");
  assert.equal(daysBetween(fallback.startAt, fallback.endAt), 30);
  // An unrecognised preset must land on the same default rather than an empty range.
  assert.equal(creditDashboardRange({ range: "nonsense" }, now).preset, "last30");
});

test("creditDashboardRange: lastMonth is the previous calendar month", () => {
  const range = creditDashboardRange({ range: "lastMonth" }, new Date(2026, 0, 15));
  assert.equal(range.label, "2025-12");
  assert.equal(dayKey(range.startAt), "2025-12-01", "crosses the year boundary");
  assert.equal(dayKey(range.endAt), "2026-01-01");
});

test("creditDashboardRange: custom uses the given dates, end-inclusive", () => {
  const now = new Date(2026, 7, 20);
  const range = creditDashboardRange({ range: "custom", from: "2026-08-01", to: "2026-08-05" }, now);
  assert.equal(dayKey(range.startAt), "2026-08-01");
  // endAt is exclusive, so an inclusive 1st-5th selection ends at the 6th.
  assert.equal(dayKey(range.endAt), "2026-08-06");
  assert.equal(range.label, "2026-08-01 to 2026-08-05");
});

test("creditDashboardRange: a custom range with from after to falls back instead of inverting", () => {
  const now = new Date(2026, 7, 20);
  const range = creditDashboardRange({ range: "custom", from: "2026-08-10", to: "2026-08-01" }, now);
  // An inverted range would make every downstream filter return nothing, so it
  // is replaced with the 30-day window.
  assert.ok(range.startAt < range.endAt, "range must never be inverted");
  assert.equal(daysBetween(range.startAt, range.endAt), 30);
});

test("fillDailyRange emits every day in the window, zero-filling the gaps", () => {
  const startAt = new Date(2026, 7, 1);
  const endAt = addDays(startAt, 5);
  const rows = new Map<string, CreditDashboardDay>([["2026-08-03", { date: "2026-08-03", credits: 12, usd: 1.5, jobs: 2 }]]);

  const filled = fillDailyRange(startAt, endAt, rows);
  assert.deepEqual(
    filled.map((row) => row.date),
    ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"],
  );
  assert.deepEqual(filled[2], { date: "2026-08-03", credits: 12, usd: 1.5, jobs: 2 });
  // A day with no jobs must appear as a zero, not be omitted -- otherwise the
  // chart silently compresses quiet days out of the x-axis.
  assert.deepEqual(filled[0], { date: "2026-08-01", credits: 0, usd: 0, jobs: 0 });
});

test("fillDailyRange caps the series at 120 days", () => {
  const endAt = new Date(2026, 7, 1);
  const startAt = addDays(endAt, -365);
  assert.equal(fillDailyRange(startAt, endAt, new Map()).length, 120);
});

test("addDay accumulates credits, usd and a job count per day", () => {
  const map = new Map<string, CreditDashboardDay>();
  addDay(map, "2026-08-04", 1.5, 0.02);
  addDay(map, "2026-08-04", 2.25, 0.03);
  addDay(map, "2026-08-05", 1, 0.01);

  assert.deepEqual(map.get("2026-08-04"), { date: "2026-08-04", credits: 3.75, usd: 0.05, jobs: 2 });
  assert.deepEqual(map.get("2026-08-05"), { date: "2026-08-05", credits: 1, usd: 0.01, jobs: 1 });
});

test("sortedGroups ranks by credits and computes percentages that sum to ~100", () => {
  const map = new Map<string, CreditDashboardGroup>([
    ["a", { id: "a", label: "Alpha", credits: 25, usd: 1, jobs: 1, minCredits: 5 } as CreditDashboardGroup],
    ["b", { id: "b", label: "Beta", credits: 75, usd: 3, jobs: 2, minCredits: 10 } as CreditDashboardGroup],
  ]);

  const rows = sortedGroups(map);
  assert.deepEqual(
    rows.map((row) => row.label),
    ["Beta", "Alpha"],
  );
  assert.equal(rows[0].percentage, 75);
  assert.equal(rows[1].percentage, 25);
});

test("sortedGroups reports 0% rather than NaN when nothing was spent", () => {
  const map = new Map<string, CreditDashboardGroup>([
    ["a", { id: "a", label: "Alpha", credits: 0, usd: 0, jobs: 0, minCredits: Infinity } as CreditDashboardGroup],
  ]);
  const rows = sortedGroups(map);
  assert.equal(rows[0].percentage, 0);
  // minCredits starts at Infinity as a running minimum; it must not leak out.
  assert.equal(rows[0].minCredits, 0);
});

test("sortedGroups breaks credit ties on usd, then alphabetically", () => {
  const group = (id: string, label: string, credits: number, usd: number) =>
    [id, { id, label, credits, usd, jobs: 1, minCredits: 1 } as CreditDashboardGroup] as const;
  const rows = sortedGroups(
    new Map<string, CreditDashboardGroup>([group("a", "Zulu", 10, 1), group("b", "Alpha", 10, 1), group("c", "Mike", 10, 5)]),
  );
  assert.deepEqual(
    rows.map((row) => row.label),
    ["Mike", "Alpha", "Zulu"],
  );
});

test("stringField coerces without producing the string 'null' or 'undefined'", () => {
  assert.equal(stringField("x"), "x");
  assert.equal(stringField(null), "");
  assert.equal(stringField(undefined), "");
  assert.equal(stringField(0), "0");
  assert.equal(stringField(12.5), "12.5");
  assert.equal(stringField(false), "false");
});

test("runDurationSeconds needs a completed run with a forward-moving clock", () => {
  const at = (iso: string) => iso;
  assert.equal(
    runDurationSeconds({ startedAt: at("2026-08-04T10:00:00Z"), completedAt: at("2026-08-04T10:02:30Z") } as Job),
    150,
  );
  // Missing either end, or a clock that went backwards, yields no duration
  // rather than a negative or absurd one.
  assert.equal(runDurationSeconds({ completedAt: at("2026-08-04T10:00:00Z") } as Job), undefined);
  assert.equal(runDurationSeconds({ startedAt: at("2026-08-04T10:00:00Z") } as Job), undefined);
  assert.equal(
    runDurationSeconds({ startedAt: at("2026-08-04T10:05:00Z"), completedAt: at("2026-08-04T10:00:00Z") } as Job),
    undefined,
  );
  assert.equal(runDurationSeconds({ startedAt: "not a date", completedAt: "also not" } as Job), undefined);
});

test("normalizeProjectStatName folds the spellings a folder name arrives in", () => {
  assert.equal(normalizeProjectStatName("  TWR Glass Tower  "), "twr_glass_tower");
  assert.equal(normalizeProjectStatName("TWR-Glass-Tower"), "twr_glass_tower");
  assert.equal(normalizeProjectStatName("TWR__Glass___Tower"), "twr_glass_tower");
  assert.equal(normalizeProjectStatName("__TWR_Tower__"), "twr_tower");
  // The whole point: these three must collapse to one key.
  const spellings = ["TWR Glass Tower", "twr-glass-tower", "TWR_Glass_Tower"].map(normalizeProjectStatName);
  assert.equal(new Set(spellings).size, 1);
});

test("findCreditTrackerProjectStats matches a project across name spellings", () => {
  const project = { id: "p", name: "Glass Tower", shortName: "TWR", folderName: "TWR_Glass_Tower" } as Project;
  const stats = { totalCredits: 42 } as unknown as CreditTrackerProjectStats;

  // Tracker reports the folder with different separators and casing.
  assert.equal(findCreditTrackerProjectStats(project, new Map([["twr-glass-tower", stats]])), stats);
  assert.equal(findCreditTrackerProjectStats(project, new Map([["TWR Glass Tower", stats]])), stats);
  assert.equal(findCreditTrackerProjectStats(project, new Map([["Glass Tower", stats]])), stats, "bare project name");
  assert.equal(findCreditTrackerProjectStats(project, new Map([["TWR", stats]])), stats, "bare short name");
});

test("findCreditTrackerProjectStats returns undefined rather than a wrong project's numbers", () => {
  const project = { id: "p", name: "Glass Tower", shortName: "TWR", folderName: "TWR_Glass_Tower" } as Project;
  const stats = { totalCredits: 42 } as unknown as CreditTrackerProjectStats;
  assert.equal(findCreditTrackerProjectStats(project, new Map()), undefined, "no stats at all");
  assert.equal(findCreditTrackerProjectStats(project, new Map([["OTH_Other_Project", stats]])), undefined);
});

test("projectStatNameCandidates offers the folder name first and drops empties", () => {
  const candidates = projectStatNameCandidates({
    id: "p",
    name: "Glass Tower",
    shortName: "TWR",
    folderName: "TWR_Glass_Tower",
  } as Project);
  assert.equal(candidates[0], "TWR_Glass_Tower");
  assert.ok(candidates.includes("Glass Tower"));
  assert.ok(candidates.includes("TWR"));
  assert.ok(
    candidates.every((candidate) => Boolean(candidate)),
    "an empty candidate would match an empty tracker key",
  );
});

// Day/week/month bucketing and the spend pivot. These replace the old
// client-side grouping, which derived its stacked segments from the recent-event
// list the route caps at 500 rows and so under-reported on busy ranges.

function pivotEvent(overrides: Partial<CreditDashboardRecentJob> & { timestamp: string }): CreditDashboardRecentJob {
  return {
    jobId: `job-${overrides.timestamp}-${overrides.modelId ?? "m"}`,
    projectId: "p1",
    projectName: "Tower A",
    userId: "u1",
    userName: "Momen",
    modelId: "m1",
    modelName: "Veo 3",
    status: "completed",
    credits: 10,
    usd: 0.05,
    expectedCredits: 10,
    source: "tracker",
    resolution: "1080p",
    createdAt: overrides.timestamp,
    ...overrides,
  };
}

test("defaultGranularity widens the bucket as the range grows", () => {
  const endAt = new Date(2026, 7, 8);
  assert.equal(defaultGranularity(addDays(endAt, -1), endAt), "day");
  assert.equal(defaultGranularity(addDays(endAt, -14), endAt), "day");
  assert.equal(defaultGranularity(addDays(endAt, -30), endAt), "week");
  assert.equal(defaultGranularity(addDays(endAt, -92), endAt), "week");
  assert.equal(defaultGranularity(addDays(endAt, -365), endAt), "month");
});

test("creditDashboardGranularity honours an explicit param and ignores junk", () => {
  const endAt = new Date(2026, 7, 8);
  const startAt = addDays(endAt, -30);
  assert.equal(creditDashboardGranularity({ granularity: "day" }, startAt, endAt), "day");
  assert.equal(creditDashboardGranularity({ granularity: "month" }, startAt, endAt), "month");
  // Anything unrecognised falls back to the range-derived default rather than
  // producing an unbucketable series.
  assert.equal(creditDashboardGranularity({ granularity: "hour" }, startAt, endAt), "week");
  assert.equal(creditDashboardGranularity({}, startAt, endAt), "week");
});

test("bucketStart snaps to the Monday of the ISO week and the first of the month", () => {
  const saturday = new Date(2026, 7, 8);
  assert.equal(dayKey(bucketStart(saturday, "day")), "2026-08-08");
  assert.equal(dayKey(bucketStart(saturday, "week")), "2026-08-03");
  assert.equal(dayKey(bucketStart(saturday, "month")), "2026-08-01");
  // A Monday is already its own week start.
  assert.equal(dayKey(bucketStart(new Date(2026, 7, 3), "week")), "2026-08-03");
  // Sunday belongs to the week that began the previous Monday, not the next one.
  assert.equal(dayKey(bucketStart(new Date(2026, 7, 9), "week")), "2026-08-03");
});

test("isoWeekKey puts early-January days in the previous ISO year when the week straddles", () => {
  // 2027-01-01 is a Friday, so its ISO week is 2026-W53.
  assert.equal(isoWeekKey(new Date(2027, 0, 1)), "2026-W53");
  assert.equal(isoWeekKey(new Date(2026, 0, 1)), "2026-W01");
  assert.equal(isoWeekKey(new Date(2026, 7, 8)), "2026-W32");
});

test("buildCreditBuckets covers the range at each granularity and zero-fills quiet buckets", () => {
  const startAt = new Date(2026, 7, 1);
  const endAt = new Date(2026, 7, 15);

  const days = buildCreditBuckets(startAt, endAt, "day");
  assert.equal(days.length, 14);
  assert.equal(days[0].key, "2026-08-01");
  assert.equal(days[0].label, "Aug 01");
  assert.deepEqual([days[0].credits, days[0].usd, days[0].jobs], [0, 0, 0]);

  // The window starts mid-week, so the first bucket reaches back to Jul 27.
  const weeks = buildCreditBuckets(startAt, endAt, "week");
  assert.deepEqual(
    weeks.map((bucket) => bucket.key),
    ["2026-W31", "2026-W32", "2026-W33"],
  );
  assert.equal(weeks[0].label, "Jul 27 - Aug 2");

  const months = buildCreditBuckets(new Date(2026, 5, 10), endAt, "month");
  assert.deepEqual(
    months.map((bucket) => bucket.key),
    ["2026-06", "2026-07", "2026-08"],
  );
  assert.equal(months[2].label, "Aug 2026");
});

test("buildCreditBuckets caps the series and keeps the most recent buckets", () => {
  const endAt = new Date(2026, 7, 1);
  const buckets = buildCreditBuckets(addDays(endAt, -3650), endAt, "day");
  assert.equal(buckets.length, 120);
  // Truncation drops the oldest end, matching fillDailyRange.
  assert.equal(buckets[buckets.length - 1].key, "2026-07-31");
});

test("buildCreditPivot totals each bucket and splits it by project, user and model", () => {
  const startAt = new Date(2026, 7, 3);
  const endAt = new Date(2026, 7, 17);
  const events = [
    pivotEvent({ timestamp: "2026-08-04T10:00:00.000Z", credits: 30, usd: 0.15 }),
    pivotEvent({
      timestamp: "2026-08-05T10:00:00.000Z",
      credits: 20,
      usd: 0.1,
      projectId: "p2",
      projectName: "Riverside",
      modelId: "m2",
      modelName: "Seedance",
    }),
    pivotEvent({ timestamp: "2026-08-12T10:00:00.000Z", credits: 50, usd: 0.25, userId: "u2", userName: "Sara" }),
  ];

  const { buckets, breakdown } = buildCreditPivot(events, startAt, endAt, "week");
  assert.deepEqual(
    buckets.map((bucket) => bucket.key),
    ["2026-W32", "2026-W33"],
  );
  assert.deepEqual(
    buckets.map((bucket) => bucket.credits),
    [50, 50],
  );
  assert.deepEqual(
    buckets.map((bucket) => bucket.jobs),
    [2, 1],
  );

  // perBucket is index-aligned with buckets, so the pivot's row and column
  // totals are the same numbers read two ways.
  const towerA = breakdown.project.find((row) => row.id === "p1");
  assert.deepEqual(towerA?.perBucket, [30, 50]);
  assert.equal(towerA?.credits, 80);
  assert.equal(towerA?.percentage, 80);
  assert.deepEqual(
    breakdown.model.map((row) => [row.label, row.credits]),
    [
      ["Veo 3", 80],
      ["Seedance", 20],
    ],
  );
  assert.deepEqual(
    breakdown.user.find((row) => row.id === "u2")?.perBucket,
    [0, 50],
  );
});

test("buildCreditPivot ignores events that fall outside the bucket window", () => {
  const startAt = new Date(2026, 7, 10);
  const endAt = new Date(2026, 7, 17);
  const { buckets, breakdown } = buildCreditPivot(
    [
      pivotEvent({ timestamp: "2026-08-01T10:00:00.000Z", credits: 99 }),
      pivotEvent({ timestamp: "2026-08-11T10:00:00.000Z", credits: 7 }),
      pivotEvent({ timestamp: "not-a-date", credits: 5 }),
    ],
    startAt,
    endAt,
    "day",
  );
  assert.equal(
    buckets.reduce((sum, bucket) => sum + bucket.credits, 0),
    7,
  );
  assert.equal(breakdown.project[0].credits, 7);
});

test("buildCreditPivot folds everything past the top rows into one Other series", () => {
  const startAt = new Date(2026, 7, 3);
  const endAt = new Date(2026, 7, 5);
  // Twelve models, descending spend: eight survive as rows, four collapse.
  const events = Array.from({ length: 12 }, (_, index) =>
    pivotEvent({
      timestamp: index % 2 === 0 ? "2026-08-03T10:00:00.000Z" : "2026-08-04T10:00:00.000Z",
      credits: 100 - index,
      modelId: `m${index}`,
      modelName: `Model ${index}`,
    }),
  );

  const { breakdown } = buildCreditPivot(events, startAt, endAt, "day");
  assert.equal(breakdown.model.length, 9);
  assert.equal(breakdown.model[8].label, "Other (4)");
  // The four cheapest are indices 8-11 (92, 91, 90, 89); the even-indexed ones
  // land in the first bucket.
  assert.deepEqual(breakdown.model[8].perBucket, [182, 180]);
  assert.equal(breakdown.model[8].credits, 362);
  assert.equal(
    Math.round(breakdown.model.reduce((sum, row) => sum + row.percentage, 0)),
    100,
  );
});
