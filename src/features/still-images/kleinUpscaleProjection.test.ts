import { describe, expect, it } from "vitest";

import { formatProjectedWait, kleinUpscaleProjection } from "./kleinUpscaleProjection";

describe("kleinUpscaleProjection", () => {
  it("quotes the run from its output area, not from a flat number", () => {
    // 1086x1448 is the source behind the one Klein run that has succeeded.
    const x2 = kleinUpscaleProjection({ width: 1086, height: 1448 }, { upscale: "x2", mode: "with-seedvr" });
    // The x4 of this same source quoted 25 and the run came back at $0.123 -- 26.
    expect(x2).toMatchObject({ outputWidth: 2172, outputHeight: 2896, credits: 7 });
    expect(x2?.megapixels).toBeCloseTo(6.29, 1);
    expect(x2?.exceedsRenderWindow).toBe(false);
  });

  it("charges four times the pixels for twice the factor", () => {
    const source = { width: 1000, height: 1000 };
    const x2 = kleinUpscaleProjection(source, { upscale: "x2" });
    const x4 = kleinUpscaleProjection(source, { upscale: "x4" });

    // The graph tiles the output, so work scales with area rather than side.
    expect(x2?.megapixels).toBe(4);
    expect(x4?.megapixels).toBe(16);

    // And close to four times over, because the rate is proportional. An earlier
    // fit carried a fixed staging cost, but a line through the two measured runs
    // put that intercept within noise of zero, and it over-quoted the smaller of
    // them by 1.8x -- it had been absorbing the 2.2x spread between GPU rates
    // rather than describing any real per-run overhead.
    expect(x4!.credits).toBeGreaterThan(x2!.credits * 3.5);
    expect(x4!.credits).toBeLessThan(x2!.credits * 4.5);
  });

  it("flags the source that actually timed out", () => {
    // 4096x5120 at x4 is 335MP of tiles. Two runs at these settings were killed
    // at the endpoint's 600s ceiling after billing 117 credits and returning
    // nothing, which is the case this warning exists to pre-empt.
    const projection = kleinUpscaleProjection({ width: 4096, height: 5120 }, { upscale: "x4", mode: "with-seedvr" });
    expect(projection?.exceedsRenderWindow).toBe(true);
    expect(projection!.seconds).toBeGreaterThan(600);
    expect(projection!.credits).toBeGreaterThan(200);
  });

  it("treats SeedVR as the slower, dearer mode", () => {
    const source = { width: 2000, height: 2000 };
    const on = kleinUpscaleProjection(source, { upscale: "x2", mode: "with-seedvr" })!;
    const off = kleinUpscaleProjection(source, { upscale: "x2", mode: "without-seedvr" })!;

    expect(on.credits).toBeGreaterThan(off.credits);
    expect(on.seconds).toBeGreaterThan(off.seconds);
    // Same pixels either way -- the mode changes the work per tile, not the output.
    expect(on.megapixels).toBe(off.megapixels);
  });

  it("has nothing to say until the source is measured", () => {
    expect(kleinUpscaleProjection(undefined, { upscale: "x4" })).toBeUndefined();
    expect(kleinUpscaleProjection({}, { upscale: "x4" })).toBeUndefined();
    expect(kleinUpscaleProjection({ width: 0, height: 0 }, { upscale: "x4" })).toBeUndefined();
  });
});

describe("formatProjectedWait", () => {
  it("reads as a wait rather than a duration", () => {
    expect(formatProjectedWait(45)).toBe("45 sec");
    expect(formatProjectedWait(186)).toBe("3 min");
    expect(formatProjectedWait(4694)).toBe("1 h 18 min");
    expect(formatProjectedWait(7200)).toBe("2 h");
  });
});
