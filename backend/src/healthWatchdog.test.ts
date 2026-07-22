import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateAlerts,
  initialWatchdogState,
  buildWebhookPayload,
  type WatchdogState,
  type WatchdogThresholds,
  type WatchdogFlags,
} from "./healthWatchdog.js";
import type { ObservabilitySnapshot as MetricsSnapshot } from "./observabilityMetrics.js";

const THRESHOLDS: WatchdogThresholds = {
  queueStallEvals: 3,
  diskFreeMinBytes: 5 * 1024 * 1024 * 1024,
  memoryHighMiB: 1275,
};
const DISPATCHER: WatchdogFlags = { evaluatesQueueStall: true, evaluatesOutage: false };
const API: WatchdogFlags = { evaluatesQueueStall: false, evaluatesOutage: true };

function makeSnap(o: {
  queued?: number;
  runpodActive?: number;
  capacity?: number;
  leaseActive?: boolean;
  expiresAt?: number | null;
  rssMiB?: number;
  diskFreeBytes?: number | null;
  role?: string;
  nowMs?: number;
} = {}): MetricsSnapshot {
  return {
    role: o.role ?? "dispatcher",
    pid: 1,
    instance: null,
    uptimeSeconds: 100,
    nowMs: o.nowMs ?? 1000,
    queue: {
      queued: o.queued ?? 0,
      active: 0,
      runpodActive: o.runpodActive ?? 0,
      capacity: o.capacity ?? 10,
      dispatcher: {
        enabled: true,
        active: o.leaseActive ?? true,
        heldByThisProcess: false,
        ownerId: "host:1:abc",
        heartbeatAt: 900,
        expiresAt: o.expiresAt === undefined ? 5000 : o.expiresAt,
      },
    },
    mediaIndex: { dirtyRevision: 5, builtRevision: 5, cachedRevision: 5, cachedItems: 100 },
    memory: { rssMiB: o.rssMiB ?? 400, heapUsedMiB: 70 },
    outputDiskFreeBytes: o.diskFreeBytes === undefined ? 50 * 1024 * 1024 * 1024 : o.diskFreeBytes,
  };
}

test("queue_stall fires only after N non-draining evals, then resolves once", () => {
  let state: WatchdogState = initialWatchdogState();
  const stalled = makeSnap({ queued: 5, runpodActive: 2, capacity: 10 });

  // Ticks 1-2: below threshold, no event.
  for (let i = 0; i < 2; i += 1) {
    const r = evaluateAlerts({ ...stalled, nowMs: 1000 + i }, state, THRESHOLDS, DISPATCHER, 1000 + i);
    state = r.state;
    assert.equal(r.events.length, 0, `tick ${i + 1} should not fire yet`);
  }
  // Tick 3: threshold reached -> one firing event.
  const fire = evaluateAlerts({ ...stalled, nowMs: 1003 }, state, THRESHOLDS, DISPATCHER, 1003);
  state = fire.state;
  assert.equal(fire.events.length, 1);
  assert.equal(fire.events[0].rule, "queue_stall");
  assert.equal(fire.events[0].phase, "firing");
  assert.equal(fire.events[0].severity, "critical");

  // Tick 4: still stalled -> no duplicate event (no spam).
  const again = evaluateAlerts({ ...stalled, nowMs: 1004 }, state, THRESHOLDS, DISPATCHER, 1004);
  state = again.state;
  assert.equal(again.events.length, 0);

  // Queue drains -> resolved event exactly once.
  const drained = evaluateAlerts(makeSnap({ queued: 0 }), state, THRESHOLDS, DISPATCHER, 1005);
  state = drained.state;
  assert.equal(drained.events.length, 1);
  assert.equal(drained.events[0].rule, "queue_stall");
  assert.equal(drained.events[0].phase, "resolved");
});

test("queue_stall does not fire while the backlog is actually draining", () => {
  let state = initialWatchdogState();
  for (const queued of [5, 4, 3, 2, 1]) {
    const r = evaluateAlerts(makeSnap({ queued, runpodActive: 2, capacity: 10 }), state, THRESHOLDS, DISPATCHER, 1000);
    state = r.state;
    assert.equal(r.events.length, 0);
  }
});

test("queue_stall does not fire when RunPod capacity is fully used (legit wait)", () => {
  let state = initialWatchdogState();
  for (let i = 0; i < 5; i += 1) {
    const r = evaluateAlerts(makeSnap({ queued: 5, runpodActive: 10, capacity: 10 }), state, THRESHOLDS, DISPATCHER, 1000 + i);
    state = r.state;
    assert.equal(r.events.length, 0);
  }
});

test("a dispatcher does not evaluate the outage rule (it cannot watch its own death)", () => {
  const state = initialWatchdogState();
  const r = evaluateAlerts(makeSnap({ queued: 5, leaseActive: false, expiresAt: 0 }), state, THRESHOLDS, DISPATCHER, 10_000);
  assert.equal(r.events.length, 0);
});

test("dispatch_outage fires on an API worker when the lease is stale with queued work", () => {
  let state = initialWatchdogState();
  const dead = makeSnap({ role: "api", queued: 5, leaseActive: false, expiresAt: 0, nowMs: 10_000 });
  const fire = evaluateAlerts(dead, state, THRESHOLDS, API, 10_000);
  state = fire.state;
  assert.equal(fire.events.length, 1);
  assert.equal(fire.events[0].rule, "dispatch_outage");
  assert.equal(fire.events[0].phase, "firing");

  // Lease restored -> resolved.
  const healthy = makeSnap({ role: "api", queued: 5, leaseActive: true, expiresAt: 20_000, nowMs: 11_000 });
  const resolve = evaluateAlerts(healthy, state, THRESHOLDS, API, 11_000);
  assert.equal(resolve.events.length, 1);
  assert.equal(resolve.events[0].phase, "resolved");
});

test("dispatch_outage does not fire when there is no queued work", () => {
  const state = initialWatchdogState();
  const r = evaluateAlerts(makeSnap({ role: "api", queued: 0, leaseActive: false, expiresAt: 0, nowMs: 10_000 }), state, THRESHOLDS, API, 10_000);
  assert.equal(r.events.length, 0);
});

test("memory_high fires above threshold and resolves below it", () => {
  let state = initialWatchdogState();
  const hot = evaluateAlerts(makeSnap({ rssMiB: 1300 }), state, THRESHOLDS, DISPATCHER, 1000);
  state = hot.state;
  assert.equal(hot.events.length, 1);
  assert.equal(hot.events[0].rule, "memory_high");
  assert.equal(hot.events[0].severity, "warning");

  const cool = evaluateAlerts(makeSnap({ rssMiB: 400 }), state, THRESHOLDS, DISPATCHER, 2000);
  assert.equal(cool.events.length, 1);
  assert.equal(cool.events[0].phase, "resolved");
});

test("disk_low fires below the floor and never fires when disk is unknown", () => {
  let state = initialWatchdogState();
  const low = evaluateAlerts(makeSnap({ diskFreeBytes: 1 * 1024 * 1024 * 1024 }), state, THRESHOLDS, DISPATCHER, 1000);
  state = low.state;
  assert.equal(low.events.length, 1);
  assert.equal(low.events[0].rule, "disk_low");

  const unknown = evaluateAlerts(makeSnap({ diskFreeBytes: null }), initialWatchdogState(), THRESHOLDS, DISPATCHER, 1000);
  assert.equal(unknown.events.length, 0);
});

test("independent rules fire together and are tracked separately", () => {
  const state = initialWatchdogState();
  const r = evaluateAlerts(makeSnap({ rssMiB: 1300, diskFreeBytes: 1 * 1024 * 1024 * 1024 }), state, THRESHOLDS, DISPATCHER, 1000);
  const rules = r.events.map((e) => e.rule).sort();
  assert.deepEqual(rules, ["disk_low", "memory_high"]);
});

test("slack webhook payload is a single text field; json payload is structured", () => {
  const event = { rule: "queue_stall" as const, phase: "firing" as const, severity: "critical" as const, detail: "stuck", role: "dispatcher", pid: 1, atMs: 5 };
  const slack = buildWebhookPayload(event, "slack");
  assert.equal(Object.keys(slack).join(","), "text");
  assert.match(String(slack.text), /queue_stall firing on dispatcher/);
  const json = buildWebhookPayload(event, "json");
  assert.equal(json.rule, "queue_stall");
  assert.equal(json.severity, "critical");
});
