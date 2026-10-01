import assert from "node:assert/strict";
import test from "node:test";

import { staleWhileRevalidate } from "./creditService.js";

function harness(isUsable?: (value: number | null) => boolean) {
  let clock = 0;
  let next: number | null = 100;
  let fail = false;
  let loads = 0;
  const pending: Array<() => void> = [];
  const read = staleWhileRevalidate<number | null>(
    () => {
      loads += 1;
      const value = next;
      const shouldFail = fail;
      return new Promise((resolve, reject) => pending.push(() => (shouldFail ? reject(new Error("tracker down")) : resolve(value))));
    },
    { ttlMs: 30_000, maxStaleMs: 300_000, isUsable, now: () => clock },
  );
  return {
    read,
    advance: (ms: number) => {
      clock += ms;
    },
    setNext: (value: number | null) => {
      next = value;
    },
    setFail: (value: boolean) => {
      fail = value;
    },
    /** Settles every read the tracker is working on. */
    settle: async () => {
      while (pending.length) pending.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
    },
    loads: () => loads,
  };
}

test("concurrent first reads share one tracker read, and later reads within the period cost none", async () => {
  const h = harness();
  const first = Promise.all([h.read(), h.read(), h.read()]);
  await h.settle();
  assert.deepEqual(await first, [100, 100, 100]);
  h.advance(29_000);
  assert.equal(await h.read(), 100);
  assert.equal(h.loads(), 1);
});

test("after the period the last value is answered at once while one refresh runs behind it", async () => {
  const h = harness();
  const first = h.read();
  await h.settle();
  await first;

  h.advance(31_000);
  h.setNext(90);
  assert.equal(await h.read(), 100, "stale value, no wait");
  assert.equal(await h.read(), 100, "a second caller joins the same refresh");
  assert.equal(h.loads(), 2);
  await h.settle();
  assert.equal(await h.read(), 90, "the refreshed value");
  assert.equal(h.loads(), 2);
});

test("a value too old to serve, or one the tracker could not give, makes the caller wait", async () => {
  const h = harness((value) => typeof value === "number");
  const first = h.read();
  await h.settle();
  await first;

  h.advance(301_000);
  h.setNext(80);
  const late = h.read();
  await h.settle();
  assert.equal(await late, 80, "past the stale limit: fresh");

  h.setNext(null);
  h.advance(31_000);
  const stale = h.read();
  assert.equal(await stale, 80);
  await h.settle();
  // An unavailable reading is kept only for the period and is never served stale.
  h.advance(31_000);
  h.setNext(70);
  const recovered = h.read();
  await h.settle();
  assert.equal(await recovered, 70);
});

test("a refresh that fails behind a stale value leaves the value in place and is retried", async () => {
  const h = harness();
  const first = h.read();
  await h.settle();
  await first;

  h.advance(31_000);
  h.setFail(true);
  assert.equal(await h.read(), 100);
  await h.settle();
  h.setFail(false);
  h.setNext(95);
  // The failed refresh cached nothing, so the next read answers stale and tries again.
  assert.equal(await h.read(), 100, "still the last good value");
  assert.equal(h.loads(), 3);
  await h.settle();
  assert.equal(await h.read(), 95);
});
