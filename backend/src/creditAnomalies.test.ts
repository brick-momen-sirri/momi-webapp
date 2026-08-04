import test from "node:test";
import assert from "node:assert/strict";

import {
  addGroup,
  creditAnomalies,
  sortedGroups,
  type CreditDashboardDay,
  type CreditDashboardGroup,
  type CreditDashboardRecentJob,
} from "./creditDashboardService.js";

// The two functions in creditDashboardService that its first test pass skipped.
//
// creditAnomalies is the part of the dashboard someone will argue with: it is what
// says "this render cost more than it should have". A threshold that fires too
// eagerly gets the whole panel ignored; one that never fires is decoration.

function event(overrides: Partial<CreditDashboardRecentJob> = {}): CreditDashboardRecentJob {
  return {
    jobId: "job_1",
    projectId: "proj_1",
    projectName: "Tower",
    userId: "usr_a",
    userName: "a",
    modelId: "kling_v3",
    modelName: "Kling 3.0",
    status: "completed",
    credits: 10,
    usd: 0.4,
    expectedCredits: 0,
    source: "backend_job",
    resolution: "1080p",
    createdAt: "2026-08-01T10:00:00.000Z",
    timestamp: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function days(entries: Array<[string, number]>) {
  return new Map<string, CreditDashboardDay>(
    entries.map(([date, credits]) => [date, { date, credits, usd: credits / 25, jobs: 1 }]),
  );
}

const typesOf = (anomalies: ReturnType<typeof creditAnomalies>) => anomalies.map((item) => item.type);

test("nothing is flagged when there is no data", () => {
  assert.deepEqual(creditAnomalies([], new Map()), []);
});

test("a run in line with its model's average is not flagged", () => {
  const events = [event({ jobId: "a", credits: 10 }), event({ jobId: "b", credits: 12 }), event({ jobId: "c", credits: 11 })];
  assert.deepEqual(creditAnomalies(events, new Map()), []);
});

test("a run far above its model's average is flagged as run_high", () => {
  // Average across the four is ~33.75; the outlier must clear both 2x average and
  // average+25 to qualify.
  const events = [
    event({ jobId: "a", credits: 10 }),
    event({ jobId: "b", credits: 10 }),
    event({ jobId: "c", credits: 10 }),
    event({ jobId: "outlier", credits: 105 }),
  ];
  const anomalies = creditAnomalies(events, new Map());
  assert.deepEqual(typesOf(anomalies), ["run_high"]);
  assert.equal(anomalies[0].jobId, "outlier");
  assert.equal(anomalies[0].credits, 105);
});

test("the absolute floor stops cheap models producing noise", () => {
  // 3 credits against an average near 1 is 3x in relative terms, but the
  // average+25 floor means a model that always costs pennies never trips.
  const events = [event({ jobId: "a", credits: 1 }), event({ jobId: "b", credits: 1 }), event({ jobId: "c", credits: 3 })];
  assert.deepEqual(creditAnomalies(events, new Map()), []);
});

test("run_high escalates from warning to critical past 3x the average", () => {
  const cheap = [event({ jobId: "a", credits: 10 }), event({ jobId: "b", credits: 10 }), event({ jobId: "warn", credits: 60 })];
  const warned = creditAnomalies(cheap, new Map()).find((item) => item.type === "run_high");
  assert.equal(warned?.severity, "warning");

  const severe = [
    event({ jobId: "a", credits: 10 }),
    event({ jobId: "b", credits: 10 }),
    event({ jobId: "c", credits: 10 }),
    event({ jobId: "crit", credits: 400 }),
  ];
  const critical = creditAnomalies(severe, new Map()).find((item) => item.type === "run_high");
  assert.equal(critical?.severity, "critical");
});

test("averages are per model, so an expensive model does not incriminate a cheap one", () => {
  const events = [
    event({ jobId: "cheap_1", modelId: "nano", modelName: "Nano Banana", credits: 2 }),
    event({ jobId: "cheap_2", modelId: "nano", modelName: "Nano Banana", credits: 2 }),
    event({ jobId: "video_1", modelId: "kling_v3", credits: 200 }),
    event({ jobId: "video_2", modelId: "kling_v3", credits: 210 }),
  ];
  // Video runs cost 100x the stills, but each is normal for its own model.
  assert.deepEqual(creditAnomalies(events, new Map()), []);
});

test("zero-credit runs are excluded from the average rather than dragging it to zero", () => {
  // A queued or failed job contributes no credits; counting it would halve the
  // average and flag every real run.
  const events = [
    event({ jobId: "free_1", credits: 0, status: "failed" }),
    event({ jobId: "free_2", credits: 0, status: "queued" }),
    event({ jobId: "a", credits: 10 }),
    event({ jobId: "b", credits: 11 }),
  ];
  assert.deepEqual(creditAnomalies(events, new Map()), []);
});

test("a run above its own estimate is flagged as expected_overrun", () => {
  const anomalies = creditAnomalies([event({ jobId: "a", credits: 100, expectedCredits: 50 })], new Map());
  const overrun = anomalies.find((item) => item.type === "expected_overrun");
  assert.ok(overrun, "100 against an estimate of 50 is a 2x overrun");
  assert.equal(overrun?.jobId, "a");
  assert.equal(overrun?.threshold, 50);
  assert.equal(overrun?.severity, "critical", "past 1.75x the estimate");
});

test("expected_overrun tolerates a small overshoot", () => {
  // Estimates are approximate, so 20% of headroom before anything is said.
  assert.deepEqual(creditAnomalies([event({ credits: 55, expectedCredits: 50 })], new Map()), []);
  assert.deepEqual(creditAnomalies([event({ credits: 60, expectedCredits: 50 })], new Map()), []);
  const flagged = creditAnomalies([event({ credits: 61, expectedCredits: 50 })], new Map());
  assert.deepEqual(typesOf(flagged), ["expected_overrun"]);
  assert.equal(flagged[0].severity, "warning");
});

test("a job with no estimate is never flagged for overrunning one", () => {
  assert.deepEqual(creditAnomalies([event({ credits: 500, expectedCredits: 0 })], new Map()), []);
});

test("a day far above the daily average is flagged as daily_high", () => {
  const byDay = days([
    ["2026-08-01", 10],
    ["2026-08-02", 12],
    ["2026-08-03", 11],
    ["2026-08-04", 200],
  ]);
  const anomalies = creditAnomalies([], byDay);
  assert.deepEqual(typesOf(anomalies), ["daily_high"]);
  assert.equal(anomalies[0].date, "2026-08-04");
  assert.equal(anomalies[0].severity, "critical");
});

test("quiet days are excluded from the daily average", () => {
  // Zero-credit days would otherwise drag the average down and make an ordinary
  // day look like a spike.
  const byDay = days([
    ["2026-08-01", 0],
    ["2026-08-02", 0],
    ["2026-08-03", 0],
    ["2026-08-04", 40],
    ["2026-08-05", 45],
  ]);
  assert.deepEqual(creditAnomalies([], byDay), []);
});

test("the daily floor stops a low-spend week producing a spike", () => {
  // 3x the average, but only 15 credits above it -- under the +50 floor.
  const byDay = days([
    ["2026-08-01", 5],
    ["2026-08-02", 5],
    ["2026-08-03", 20],
  ]);
  assert.deepEqual(creditAnomalies([], byDay), []);
});

test("a single active day is never a spike against itself", () => {
  assert.deepEqual(creditAnomalies([], days([["2026-08-01", 5000]])), []);
});

test("anomaly ids are stable and distinct per finding", () => {
  const events = [
    event({ jobId: "a", credits: 10 }),
    event({ jobId: "b", credits: 10 }),
    event({ jobId: "c", credits: 10 }),
    event({ jobId: "outlier", credits: 200, expectedCredits: 20 }),
  ];
  const anomalies = creditAnomalies(
    events,
    days([
      ["2026-08-01", 10],
      ["2026-08-02", 10],
      ["2026-08-03", 10],
      ["2026-08-04", 1000],
    ]),
  );
  const ids = anomalies.map((item) => item.id);
  // Distinct, so the UI can key on them; prefixed, so the kind is readable.
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.some((id) => id.startsWith("run-high:")));
  assert.ok(ids.some((id) => id.startsWith("expected:")));
  assert.ok(ids.some((id) => id.startsWith("day-high:")));
});

test("the anomaly list is capped so one bad day cannot flood the panel", () => {
  const events = Array.from({ length: 200 }, (_, index) =>
    event({ jobId: `job_${index}`, credits: index === 0 ? 10 : 5000, expectedCredits: 1 }),
  );
  assert.ok(creditAnomalies(events, new Map()).length <= 50);
});

test("addGroup accumulates credits, usd, runs and the derived average", () => {
  const map = new Map<string, CreditDashboardGroup>();
  addGroup(map, "proj_1", "Tower", event({ credits: 10, usd: 0.4, expectedCredits: 8 }));
  addGroup(map, "proj_1", "Tower", event({ credits: 30, usd: 1.2, expectedCredits: 12 }));

  const group = map.get("proj_1");
  assert.equal(group?.credits, 40);
  assert.equal(group?.usd, 1.6);
  assert.equal(group?.jobs, 2);
  assert.equal(group?.averageCreditsPerRun, 20);
  assert.equal(group?.expectedCredits, 20);
  assert.equal(group?.actualVsExpectedCredits, 20, "40 spent against 20 expected");
});

test("addGroup tracks the min and max run within the group", () => {
  const map = new Map<string, CreditDashboardGroup>();
  for (const credits of [30, 5, 50, 20]) addGroup(map, "proj_1", "Tower", event({ credits }));

  assert.equal(map.get("proj_1")?.minCredits, 5);
  assert.equal(map.get("proj_1")?.maxCredits, 50);
});

test("a single-run group has a real minCredits, not Infinity", () => {
  const map = new Map<string, CreditDashboardGroup>();
  addGroup(map, "proj_1", "Tower", event({ credits: 7 }));
  // minCredits starts at Infinity as a running minimum; one run must replace it.
  assert.equal(map.get("proj_1")?.minCredits, 7);
  assert.equal(Number.isFinite(map.get("proj_1")?.minCredits ?? Infinity), true);
});

test("a group of only zero-credit runs still reports a finite minimum", () => {
  const map = new Map<string, CreditDashboardGroup>();
  addGroup(map, "proj_1", "Tower", event({ credits: 0 }));
  assert.equal(map.get("proj_1")?.minCredits, 0);
  // And sortedGroups must not leak Infinity into the response either way.
  assert.equal(sortedGroups(map)[0].minCredits, 0);
});

test("addGroup keeps the latest activity timestamp regardless of arrival order", () => {
  const map = new Map<string, CreditDashboardGroup>();
  addGroup(map, "proj_1", "Tower", event({ timestamp: "2026-08-02T10:00:00.000Z" }));
  addGroup(map, "proj_1", "Tower", event({ timestamp: "2026-08-01T10:00:00.000Z" }));
  // The older event arrived second and must not win.
  assert.equal(map.get("proj_1")?.lastActivityAt, "2026-08-02T10:00:00.000Z");

  addGroup(map, "proj_1", "Tower", event({ timestamp: "2026-08-05T10:00:00.000Z" }));
  assert.equal(map.get("proj_1")?.lastActivityAt, "2026-08-05T10:00:00.000Z");
});

test("addGroup records the most expensive workflow in the group", () => {
  const map = new Map<string, CreditDashboardGroup>();
  addGroup(map, "proj_1", "Tower", event({ modelName: "Nano Banana", credits: 5 }));
  addGroup(map, "proj_1", "Tower", event({ modelName: "Kling 3.0", credits: 90 }));
  addGroup(map, "proj_1", "Tower", event({ modelName: "Veo 3", credits: 40 }));

  assert.equal(map.get("proj_1")?.mostExpensiveWorkflow, "Kling 3.0");
  assert.equal(map.get("proj_1")?.mostExpensiveWorkflowCredits, 90);
});

test("addGroup keeps groups independent", () => {
  const map = new Map<string, CreditDashboardGroup>();
  addGroup(map, "proj_1", "Tower", event({ credits: 10 }));
  addGroup(map, "proj_2", "Cabin", event({ credits: 40 }));

  assert.equal(map.get("proj_1")?.credits, 10);
  assert.equal(map.get("proj_2")?.credits, 40);
  assert.equal(map.get("proj_2")?.label, "Cabin");
});

test("addGroup rounds as it accumulates rather than at the end", () => {
  const map = new Map<string, CreditDashboardGroup>();
  for (let i = 0; i < 3; i += 1) addGroup(map, "proj_1", "Tower", event({ credits: 0.1, usd: 0.0001 }));
  assert.equal(map.get("proj_1")?.credits, 0.3);
  assert.equal(map.get("proj_1")?.usd, 0.0003);
});
