import test from "node:test";
import assert from "node:assert/strict";

import {
  isStillImageSeed,
  randomStillImageSeed,
  STILL_IMAGE_MAX_SEED,
  stillImageSeedSequence,
} from "./stillImageSeed.js";

// The point of the whole module is that one persisted number reproduces a render.
// If the sequence is not stable, the seed on a job card is a lie.

test("the same master seed produces the same draws", () => {
  const first = stillImageSeedSequence(12345);
  const second = stillImageSeedSequence(12345);
  const draws = Array.from({ length: 8 }, () => first());
  assert.deepEqual(draws, Array.from({ length: 8 }, () => second()));
});

test("draws within one sequence differ", () => {
  // General Enhancement takes four seeds and hands them to four different
  // samplers; the same number in all four is not what a seeded run means.
  const next = stillImageSeedSequence(7);
  const draws = Array.from({ length: 4 }, () => next());
  assert.equal(new Set(draws).size, 4, `expected four distinct draws, got ${draws.join(", ")}`);
});

test("different master seeds diverge from the first draw", () => {
  // Pressing Clear and generating again has to actually change the render, so
  // neighbouring seeds must not share a prefix.
  for (const seed of [0, 1, 2, 1000, STILL_IMAGE_MAX_SEED]) {
    assert.notEqual(stillImageSeedSequence(seed)(), stillImageSeedSequence(seed + 1)(), `seeds ${seed} and ${seed + 1} agree`);
  }
});

test("every draw is a seed the graph and this module both accept", () => {
  // Draws are written straight into ComfyUI seed inputs, and a resubmitted job
  // sends its master seed back through isStillImageSeed.
  const next = stillImageSeedSequence(STILL_IMAGE_MAX_SEED);
  for (let index = 0; index < 200; index += 1) {
    const draw = next();
    assert.equal(isStillImageSeed(draw), true, `draw ${index} out of range: ${draw}`);
  }
});

test("minted seeds are in range", () => {
  for (let index = 0; index < 200; index += 1) {
    const seed = randomStillImageSeed();
    assert.equal(isStillImageSeed(seed), true, `minted ${seed}`);
  }
});

test("rejects values that are not seeds", () => {
  for (const value of [-1, 0.5, STILL_IMAGE_MAX_SEED + 1, Number.NaN, Infinity, "5", null, undefined, {}]) {
    assert.equal(isStillImageSeed(value), false, `accepted ${JSON.stringify(value)}`);
  }
});
