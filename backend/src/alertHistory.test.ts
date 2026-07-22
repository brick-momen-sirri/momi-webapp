import test from "node:test";
import assert from "node:assert/strict";

import { recordAlert, getRecentAlerts, _resetAlertHistoryForTests } from "./alertHistory.js";

function event(overrides: Partial<Parameters<typeof recordAlert>[0]> = {}) {
  return { rule: "queue_stall", phase: "firing", severity: "critical", detail: "d", role: "dispatcher", pid: 1, atMs: 0, ...overrides };
}

test("getRecentAlerts returns events newest-first", () => {
  _resetAlertHistoryForTests();
  recordAlert(event({ atMs: 1, detail: "first" }));
  recordAlert(event({ atMs: 2, detail: "second" }));
  recordAlert(event({ atMs: 3, detail: "third" }));

  const recent = getRecentAlerts();
  assert.deepEqual(recent.map((e) => e.detail), ["third", "second", "first"]);
});

test("getRecentAlerts honors an explicit limit", () => {
  _resetAlertHistoryForTests();
  for (let i = 0; i < 10; i += 1) recordAlert(event({ atMs: i, detail: String(i) }));
  const recent = getRecentAlerts(3);
  assert.deepEqual(recent.map((e) => e.detail), ["9", "8", "7"]);
});

test("history is capped so an alert storm cannot grow memory unbounded", () => {
  _resetAlertHistoryForTests();
  for (let i = 0; i < 500; i += 1) recordAlert(event({ atMs: i, detail: String(i) }));
  const recent = getRecentAlerts(1000); // ask for more than the cap
  assert.equal(recent.length, 200);
  // The newest 200 must survive, oldest 300 dropped.
  assert.deepEqual(recent.map((e) => e.detail), Array.from({ length: 200 }, (_, i) => String(499 - i)));
});

test("getRecentAlerts on an empty history returns an empty array, not an error", () => {
  _resetAlertHistoryForTests();
  assert.deepEqual(getRecentAlerts(), []);
  assert.deepEqual(getRecentAlerts(50), []);
});
