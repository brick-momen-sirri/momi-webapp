// The rate is read from the environment once, at module load, like the rest of
// config -- so it is set before the import rather than per test.
process.env.STILL_IMAGE_POD_USD_PER_SECOND = "0.001";
process.env.STILL_IMAGE_POD_USD_PER_SECOND_PRO_UPSCALER = "0.002";
process.env.STILL_IMAGE_POD_USD_PER_SECOND_QWEN_EDIT = "";

import assert from "node:assert/strict";
import test from "node:test";

const { POD_RUNTIME_SOURCE, hasMeasuredPodRuntimeCost, mergeRunpodTiming, podRuntimeCredits, podUsdPerSecondForCategory } =
  await import("./podRuntimeCost.js");

function stillJob(categoryId: string, timing?: { executionMs?: number; delayMs?: number }) {
  return {
    workflowOptions: { stillImage: { categoryId: categoryId as never, settings: {} } },
    runpodTiming: timing,
  };
}

test("prices worker seconds at the preset's own rate", () => {
  // 100s at $0.001/s = $0.10, and credits are pegged at 211 per USD.
  assert.equal(podRuntimeCredits(stillJob("general-enhancement", { executionMs: 100_000 })), 21);

  // Same run on the heavier pod costs double, because its rate is set separately.
  assert.equal(podRuntimeCredits(stillJob("pro-upscaler", { executionMs: 100_000 })), 42);
});

test("an empty per-preset override falls back to the shared rate", () => {
  assert.equal(podUsdPerSecondForCategory("qwen-edit"), 0.001);
});

test("a run too short to round up still costs one credit, not zero", () => {
  // 0.5s is worth 0.1 credits. Rounding it to 0 would read as "not costed" rather
  // than "cost almost nothing", which is a different claim entirely.
  assert.equal(podRuntimeCredits(stillJob("general-enhancement", { executionMs: 500 })), 1);
});

test("queue time is not billed", () => {
  // delayTime is how long RunPod held the job before a worker took it. Nobody pays
  // for that, so a job that waited ten minutes and never ran costs nothing.
  assert.equal(podRuntimeCredits(stillJob("general-enhancement", { delayMs: 600_000 })), undefined);
});

test("leaves a job uncosted when there is nothing to measure", () => {
  // No timing at all: a job that failed before a worker picked it up.
  assert.equal(podRuntimeCredits(stillJob("general-enhancement")), undefined);
  assert.equal(podRuntimeCredits(stillJob("general-enhancement", { executionMs: 0 })), undefined);

  // Not a still image job: Animation models bill at provider list prices and their
  // spend comes back with the result.
  assert.equal(podRuntimeCredits({ workflowOptions: { save: { cameraNumber: "0001" } }, runpodTiming: { executionMs: 5000 } }), undefined);
});

test("a preset with no configured rate stays uncosted rather than guessing one", () => {
  // The whole reason these runs were exempt is that an invented figure is worse
  // than none, so an unpriced endpoint must produce nothing at all.
  assert.equal(podUsdPerSecondForCategory("not-a-preset"), 0);
  assert.equal(podRuntimeCredits(stillJob("not-a-preset", { executionMs: 100_000 })), undefined);
});

test("hasMeasuredPodRuntimeCost recognises only a positive pod-runtime figure", () => {
  assert.equal(hasMeasuredPodRuntimeCost({ creditsActual: 21, creditsActualSource: POD_RUNTIME_SOURCE }), true);
  assert.equal(hasMeasuredPodRuntimeCost({ creditsActual: 0, creditsActualSource: POD_RUNTIME_SOURCE }), false);
  assert.equal(hasMeasuredPodRuntimeCost({ creditsActual: 21, creditsActualSource: "local_estimate" }), false);
  assert.equal(hasMeasuredPodRuntimeCost({}), false);
});

// The poller reports each figure when RunPod has one, and RunPod does not repeat
// itself: delayTime appears only once a worker has taken the job, and the terminal
// poll -- the one carrying the final executionTime -- need not restate the rest.
test("timing merges across polls instead of blanking what a poll omits", () => {
  const queued = mergeRunpodTiming(undefined, { delayMs: 4_000 });
  assert.deepEqual(queued, { executionMs: undefined, delayMs: 4_000, workerId: undefined });

  const running = mergeRunpodTiming(queued, { workerId: "wrk_1", executionMs: 12_000 });
  assert.deepEqual(running, { executionMs: 12_000, delayMs: 4_000, workerId: "wrk_1" });

  // The terminal poll's executionTime is the final one, and the delay it leaves out
  // is still the delay this job waited.
  const finished = mergeRunpodTiming(running, { executionMs: 98_000 });
  assert.deepEqual(finished, { executionMs: 98_000, delayMs: 4_000, workerId: "wrk_1" });
});

test("timing stays absent until RunPod has something to report", () => {
  assert.equal(mergeRunpodTiming(undefined, {}), undefined);
  // Zero is RunPod's "not applicable", not a measurement of no time.
  assert.equal(mergeRunpodTiming(undefined, { executionMs: 0, delayMs: 0 }), undefined);
});
