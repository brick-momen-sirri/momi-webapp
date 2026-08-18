// Rates are read from the environment once, at module load, like the rest of config
// -- so the override is set before the import rather than per test.
process.env.RUNPOD_GPU_USD_PER_SECOND =
  "NVIDIA A40=0.001;NVIDIA Fictional 9000=0.002;   ;NVIDIA Broken=notanumber;NVIDIA Negative=-1";
process.env.RUNPOD_API_KEY = "runpod-key-test";

import assert from "node:assert/strict";
import test from "node:test";

const {
  POD_RUNTIME_SOURCE,
  gpuUsdPerSecondFor,
  hasMeasuredPodRuntimeCost,
  mergeRunpodTiming,
  podRuntimeCost,
  podRuntimeCredits,
  podRuntimePricingConfigured,
  pricedGpuTypeIds,
} = await import("./podRuntimeCost.js");

function stillJob(timing?: { executionMs?: number; delayMs?: number; gpuTypeId?: string }) {
  return {
    workflowOptions: { stillImage: { categoryId: "general-enhancement" as const, settings: {} } },
    runpodTiming: timing,
  };
}

// The measured rates come straight off the account's own invoices. A preset is not
// one price: its endpoint accepts several GPU classes and the worker decides, which
// is why these are keyed by GPU and not by preset.
test("prices worker seconds at the rate of the GPU that ran them", () => {
  // 100s on the PRO 6000 at $0.0009215/s = $0.09215, and credits are pegged at 211
  // per USD.
  const onProSix = podRuntimeCost(
    stillJob({ executionMs: 100_000, gpuTypeId: "NVIDIA RTX PRO 6000 Blackwell Server Edition" }),
  );
  assert.equal(onProSix?.credits, 19);
  assert.equal(onProSix?.usdPerSecond, 0.0009215);

  // The same run on the 5090 the same endpoint also accepts: 2.2x cheaper, which is
  // the whole reason a per-endpoint rate could not express this.
  const onFiftyNinety = podRuntimeCost(stillJob({ executionMs: 100_000, gpuTypeId: "NVIDIA GeForce RTX 5090" }));
  assert.equal(onFiftyNinety?.credits, 9);
});

test("an environment override wins over the measured rate, and can add a GPU", () => {
  // A40 is in the built-in table at 0.0003221; the override says 0.001.
  assert.equal(gpuUsdPerSecondFor("NVIDIA A40"), 0.001);
  assert.equal(gpuUsdPerSecondFor("NVIDIA Fictional 9000"), 0.002);
  // Spaces in a gpuTypeId are why the separator is a semicolon and the pair splits
  // on its last '=' rather than its first.
  assert.ok(pricedGpuTypeIds().includes("NVIDIA Fictional 9000"));
});

test("an unparseable override leaves that GPU unpriced rather than zeroed elsewhere", () => {
  assert.equal(gpuUsdPerSecondFor("NVIDIA Broken"), 0);
  assert.equal(gpuUsdPerSecondFor("NVIDIA Negative"), 0);
  // And the built-in rates survive a bad entry elsewhere in the list.
  assert.equal(gpuUsdPerSecondFor("NVIDIA GeForce RTX 5090"), 0.0004174);
});

test("a run too short to round up still costs one credit, not zero", () => {
  // 0.5s on the 5090 is worth 0.04 credits. Rounding to 0 would read as "not
  // costed" rather than "cost almost nothing", which is a different claim.
  assert.equal(podRuntimeCredits(stillJob({ executionMs: 500, gpuTypeId: "NVIDIA GeForce RTX 5090" })), 1);
});

test("queue time is not billed", () => {
  // delayTime is how long RunPod held the job before a worker took it. Nobody pays
  // for that, so a job that waited ten minutes and never ran costs nothing.
  assert.equal(podRuntimeCredits(stillJob({ delayMs: 600_000, gpuTypeId: "NVIDIA GeForce RTX 5090" })), undefined);
});

test("leaves a job uncosted when there is nothing to measure", () => {
  const gpu = "NVIDIA GeForce RTX 5090";
  // No timing at all: a job that failed before a worker picked it up.
  assert.equal(podRuntimeCredits(stillJob()), undefined);
  assert.equal(podRuntimeCredits(stillJob({ executionMs: 0, gpuTypeId: gpu })), undefined);

  // Ran, but the worker was gone before its GPU could be resolved. This is the gap
  // that must not fall back to a per-endpoint average: that would be a guess wearing
  // a measurement's label.
  assert.equal(podRuntimeCredits(stillJob({ executionMs: 100_000 })), undefined);

  // Ran on a GPU nobody has priced -- an endpoint newly scheduling onto a class the
  // rate table has never seen.
  assert.equal(podRuntimeCredits(stillJob({ executionMs: 100_000, gpuTypeId: "NVIDIA Unpriced 42" })), undefined);

  // Not a still image job: Animation models bill at provider list prices and their
  // spend comes back with the result.
  assert.equal(
    podRuntimeCredits({
      workflowOptions: { save: { cameraNumber: "0001" } },
      runpodTiming: { executionMs: 5000, gpuTypeId: gpu },
    }),
    undefined,
  );
});

// The poller reports each figure when RunPod has one, and RunPod does not repeat
// itself: delayTime appears only once a worker has taken the job, and the terminal
// poll -- the one carrying the final executionTime -- need not restate the rest.
test("timing merges across polls instead of blanking what a poll omits", () => {
  const queued = mergeRunpodTiming(undefined, { delayMs: 4_000 });
  assert.equal(queued?.delayMs, 4_000);

  const running = mergeRunpodTiming(queued, { workerId: "wrk_1", executionMs: 12_000 });
  assert.equal(running?.workerId, "wrk_1");
  assert.equal(running?.delayMs, 4_000);

  // The GPU arrives from a separate lookup rather than from a poll, so it must not be
  // lost by the next poll, which knows nothing about it.
  const identified = mergeRunpodTiming(running, { gpuTypeId: "NVIDIA A40", gpuCostPerHr: 0.59 });
  const finished = mergeRunpodTiming(identified, { executionMs: 98_000 });
  assert.deepEqual(finished, {
    executionMs: 98_000,
    delayMs: 4_000,
    workerId: "wrk_1",
    gpuTypeId: "NVIDIA A40",
    gpuCostPerHr: 0.59,
    usdPerSecond: undefined,
  });
});

test("timing stays absent until RunPod has something to report", () => {
  assert.equal(mergeRunpodTiming(undefined, {}), undefined);
  // Zero is RunPod's "not applicable", not a measurement of no time.
  assert.equal(mergeRunpodTiming(undefined, { executionMs: 0, delayMs: 0 }), undefined);
});

test("hasMeasuredPodRuntimeCost recognises only a positive pod-runtime figure", () => {
  assert.equal(hasMeasuredPodRuntimeCost({ creditsActual: 21, creditsActualSource: POD_RUNTIME_SOURCE }), true);
  assert.equal(hasMeasuredPodRuntimeCost({ creditsActual: 0, creditsActualSource: POD_RUNTIME_SOURCE }), false);
  assert.equal(hasMeasuredPodRuntimeCost({ creditsActual: 21, creditsActualSource: "local_estimate" }), false);
  assert.equal(hasMeasuredPodRuntimeCost({}), false);
});

test("pricing needs a key, because the GPU behind a worker has to be asked for", () => {
  assert.equal(podRuntimePricingConfigured(), true);
});
