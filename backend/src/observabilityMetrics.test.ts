import test from "node:test";
import assert from "node:assert/strict";

import { renderPrometheusMetrics, type ObservabilitySnapshot } from "./observabilityMetrics.js";

function snap(overrides: Partial<ObservabilitySnapshot> = {}): ObservabilitySnapshot {
  return {
    role: "dispatcher",
    pid: 4242,
    instance: null,
    uptimeSeconds: 120,
    nowMs: 10_000,
    queue: {
      queued: 3,
      active: 2,
      runpodActive: 2,
      capacity: 10,
      dispatcher: { enabled: true, active: true, heldByThisProcess: true, ownerId: "host:1:abc", heartbeatAt: 9_000, expiresAt: 25_000 },
    },
    mediaIndex: { dirtyRevision: 170, builtRevision: 168, cachedRevision: 167, cachedItems: 7491 },
    memory: { rssMiB: 398, heapUsedMiB: 70 },
    outputDiskFreeBytes: 35_751_124_992,
    ...overrides,
  };
}

test("renders gauges with role/pid labels and expected values", () => {
  const text = renderPrometheusMetrics(snap());
  assert.match(text, /# TYPE momi_queue_queued gauge/);
  assert.match(text, /momi_queue_queued\{role="dispatcher",pid="4242"\} 3/);
  assert.match(text, /momi_queue_capacity\{role="dispatcher",pid="4242"\} 10/);
  assert.match(text, /momi_dispatcher_lease_held\{role="dispatcher",pid="4242"\} 1/);
  assert.match(text, /momi_dispatcher_lease_active\{role="dispatcher",pid="4242"\} 1/);
  assert.match(text, /momi_output_disk_free_bytes\{role="dispatcher",pid="4242"\} 35751124992/);
  // Trailing newline so concatenated scrapes stay well-formed.
  assert.ok(text.endsWith("\n"));
});

test("lease_held is 0 on an API worker that does not own the lease", () => {
  const text = renderPrometheusMetrics(snap({ role: "api", pid: 7, queue: { ...snap().queue, dispatcher: { ...snap().queue.dispatcher, heldByThisProcess: false } } }));
  assert.match(text, /momi_dispatcher_lease_held\{role="api",pid="7"\} 0/);
});

test("lease expiry is emitted relative to now and can be negative when stale", () => {
  const text = renderPrometheusMetrics(snap({ nowMs: 30_000 }));
  // expiresAt 25000 - now 30000 = -5s
  assert.match(text, /momi_dispatcher_lease_expires_in_seconds\{role="dispatcher",pid="4242"\} -5/);
});

test("media-index lag is dirty minus cached", () => {
  const text = renderPrometheusMetrics(snap());
  assert.match(text, /momi_media_index_lag\{role="dispatcher",pid="4242"\} 3/); // 170 - 167
});

test("omits media-index and disk gauges when unavailable", () => {
  const text = renderPrometheusMetrics(snap({ mediaIndex: null, outputDiskFreeBytes: null }));
  assert.doesNotMatch(text, /momi_media_index_/);
  assert.doesNotMatch(text, /momi_output_disk_free_bytes/);
  // Core gauges still present.
  assert.match(text, /momi_up\{/);
  assert.match(text, /momi_memory_rss_mib\{role="dispatcher",pid="4242"\} 398/);
});
