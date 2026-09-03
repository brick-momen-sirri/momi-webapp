import assert from "node:assert/strict";
import test from "node:test";

import { gptImageCustomSize } from "./gptImageCustomSize.js";

/**
 * The rules the node enforces. A size that breaks one fails the whole prompt.
 *
 * These are the input schema's own numbers -- min/max/step on custom_width and
 * custom_height, read from /object_info -- not the looser set in the node's
 * runtime body. The first version of this file asserted only the runtime set
 * and so agreed with a function that shipped 816x816, which ComfyUI rejects at
 * validation before the node ever runs. Both sides were wrong together, which
 * is exactly what a test written from the same premise as the code cannot catch.
 */
function assertLegal(size: { width: number; height: number }) {
  const { width, height } = size;
  const longest = Math.max(width, height);
  const shortest = Math.min(width, height);
  assert.equal(width % 16, 0, `width ${width} is not a multiple of 16`);
  assert.equal(height % 16, 0, `height ${height} is not a multiple of 16`);
  assert.ok(shortest >= 1024, `shortest edge ${shortest} is under the 1024 minimum`);
  assert.ok(longest <= 3840, `longest edge ${longest} exceeds 3840`);
  assert.ok(longest / shortest <= 3, `aspect ${longest / shortest} exceeds 3:1`);
  assert.ok(width * height <= 8_294_400, `${width}x${height} is over the pixel ceiling`);
}

test("a crop that is already legal keeps its own shape", () => {
  const size = gptImageCustomSize(1024, 1024);
  assertLegal(size);
  assert.equal(size.width, size.height);
});

test("the source aspect survives, which is the whole point of Custom", () => {
  // 3:2. Scaled to meet the pixel floor, but the shape has to come back intact
  // or the edited region returns distorted after the scale-back and composite.
  const size = gptImageCustomSize(1200, 800);
  assertLegal(size);
  assert.ok(Math.abs(size.width / size.height - 1.5) < 0.02, `${size.width}x${size.height} is not 3:2`);
});

test("a small square region is scaled up to the per-edge minimum", () => {
  // The case that shipped broken: scaling only to the provider's 655,360 pixel
  // floor gives 816x816, which clears the floor and still fails validation
  // against the schema's min of 1024. This is also why a tiny touch-up costs
  // what a large one does.
  const size = gptImageCustomSize(400, 400);
  assertLegal(size);
  assert.equal(size.width, 1024);
  assert.equal(size.height, 1024);
});

test("a small non-square region keeps its shape while clearing the minimum", () => {
  const size = gptImageCustomSize(600, 450);
  assertLegal(size);
  assert.ok(Math.abs(size.width / size.height - 4 / 3) < 0.03, `${size.width}x${size.height} lost its 4:3 shape`);
});

test("an oversized source is brought down by the pixel ceiling", () => {
  // 8000x6000 is 48MP. The ceiling binds long before the 3840 edge limit does,
  // so the result lands just under 8.29MP with the 4:3 shape intact.
  const size = gptImageCustomSize(8000, 6000);
  assertLegal(size);
  assert.ok(size.width * size.height > 7_500_000, "should sit near the ceiling, not far below it");
  assert.ok(Math.abs(size.width / size.height - 4 / 3) < 0.02, `${size.width}x${size.height} is not 4:3`);
});

test("an elongated source is brought down by the edge limit instead", () => {
  // At 3:1 the pixel ceiling allows 3840x1280, so here it is the long edge that
  // binds -- the other half of the interaction the previous test does not reach.
  const size = gptImageCustomSize(9000, 3000);
  assertLegal(size);
  assert.equal(Math.max(size.width, size.height), 3840);
});

test("a panorama is cut to 3:1, the one case the source shape cannot survive", () => {
  const size = gptImageCustomSize(6000, 500);
  assertLegal(size);
  assert.ok(Math.max(size.width, size.height) / Math.min(size.width, size.height) <= 3);
});

test("portrait and landscape are handled the same way round", () => {
  const landscape = gptImageCustomSize(1600, 900);
  const portrait = gptImageCustomSize(900, 1600);
  assertLegal(landscape);
  assertLegal(portrait);
  assert.equal(landscape.width, portrait.height);
  assert.equal(landscape.height, portrait.width);
});

test("garbage dimensions give a legal size instead of failing at the provider", () => {
  // These reach us off the wire. A zero or a NaN sent to the node fails the job
  // remotely, after the artist has waited, so it is corrected here.
  for (const [width, height] of [
    [0, 0],
    [-100, 200],
    [Number.NaN, 1024],
    [Number.POSITIVE_INFINITY, 1024],
  ]) {
    assertLegal(gptImageCustomSize(width, height));
  }
});

test("every size in a wide sweep of real crop shapes is legal", () => {
  // The rules interact -- the aspect clamp changes the pixel count, the pixel
  // scale changes the longest edge, and rounding to 16 moves both again. One
  // worked example proves nothing about that, so this sweeps the space.
  for (let width = 16; width <= 6000; width += 71) {
    for (let height = 16; height <= 6000; height += 83) {
      assertLegal(gptImageCustomSize(width, height));
    }
  }
});
