import { describe, expect, it } from "vitest";

import {
  appendMaskStroke,
  brushRadiusInImagePixels,
  brushRadiusOnScreen,
  brushSettingsFromDrag,
  clearMaskStrokes,
  createMaskDrawing,
  fitMaskView,
  hasPaintedRegion,
  imagePointFromViewport,
  MAX_ZOOM,
  MIN_ZOOM,
  maskBlurPixels,
  panMaskView,
  retargetMaskDrawing,
  setMaskSoftness,
  simplifyStrokePoints,
  undoMaskStroke,
  viewportPointFromImage,
  zoomMaskView,
  type MaskStroke,
} from "./maskDrawing";

const brush = (points: Array<[number, number]>, radius = 10): MaskStroke => ({
  tool: "brush",
  radius,
  points: points.map(([x, y]) => ({ x, y })),
});

describe("stroke list", () => {
  it("appends, undoes and clears", () => {
    const empty = createMaskDrawing(100, 80);
    const one = appendMaskStroke(empty, brush([[1, 1]]));
    const two = appendMaskStroke(one, brush([[2, 2]]));

    expect(two.strokes).toHaveLength(2);
    expect(undoMaskStroke(two).strokes).toHaveLength(1);
    expect(clearMaskStrokes(two).strokes).toHaveLength(0);
    // The earlier values are untouched, which is what makes the editor's local
    // draft safe to hand back only on Done.
    expect(empty.strokes).toHaveLength(0);
    expect(one.strokes).toHaveLength(1);
  });

  it("ignores an empty stroke rather than recording a no-op undo step", () => {
    const drawing = createMaskDrawing(100, 80);
    expect(appendMaskStroke(drawing, brush([])).strokes).toHaveLength(0);
  });

  it("undo and clear on an empty drawing return the same object", () => {
    const drawing = createMaskDrawing(100, 80);
    expect(undoMaskStroke(drawing)).toBe(drawing);
    expect(clearMaskStrokes(drawing)).toBe(drawing);
  });

  it("clamps softness to a percentage", () => {
    const drawing = createMaskDrawing(100, 80);
    expect(setMaskSoftness(drawing, 250).softness).toBe(100);
    expect(setMaskSoftness(drawing, -20).softness).toBe(0);
    expect(setMaskSoftness(drawing, 42.4).softness).toBe(42);
  });
});

describe("retargetMaskDrawing", () => {
  it("keeps the strokes when the source is the same size", () => {
    const drawing = appendMaskStroke(createMaskDrawing(100, 80), brush([[1, 1]]));
    expect(retargetMaskDrawing(drawing, 100, 80)).toBe(drawing);
  });

  it("drops the strokes when the source changes, because they are in its pixels", () => {
    // A region painted on a 4K render would land in the corner of a 1K one, and a
    // mask that silently moved is worse than one the artist is asked to repaint.
    const drawing = appendMaskStroke(setMaskSoftness(createMaskDrawing(4000, 3000), 60), brush([[10, 10]]));
    const retargeted = retargetMaskDrawing(drawing, 1000, 750);

    expect(retargeted.strokes).toHaveLength(0);
    expect(retargeted.width).toBe(1000);
    // Softness is a preference rather than part of the drawing, so it survives.
    expect(retargeted.softness).toBe(60);
  });
});

describe("hasPaintedRegion", () => {
  it("is false for nothing, and for erasers alone", () => {
    const empty = createMaskDrawing(100, 80);
    expect(hasPaintedRegion(undefined)).toBe(false);
    expect(hasPaintedRegion(empty)).toBe(false);
    expect(hasPaintedRegion(appendMaskStroke(empty, { tool: "eraser", radius: 5, points: [{ x: 1, y: 1 }] }))).toBe(false);
  });

  it("is true once something is painted", () => {
    const drawing = appendMaskStroke(createMaskDrawing(100, 80), brush([[1, 1]]));
    expect(hasPaintedRegion(drawing)).toBe(true);
    expect(hasPaintedRegion(appendMaskStroke(drawing, { tool: "eraser", radius: 5, points: [{ x: 1, y: 1 }] }))).toBe(true);
  });
});

describe("maskBlurPixels", () => {
  it("scales with the image, so the same percentage feathers the same fraction", () => {
    expect(maskBlurPixels(0, 1000, 1000)).toBe(0);
    expect(maskBlurPixels(100, 1000, 1000)).toBe(30);
    // A fixed blur would be invisible here and would swallow small strokes above.
    expect(maskBlurPixels(50, 6000, 4000)).toBe(60);
    expect(maskBlurPixels(50, 400, 200)).toBe(3);
  });

  it("measures the short side, so a panorama does not over-feather", () => {
    expect(maskBlurPixels(100, 8000, 500)).toBe(maskBlurPixels(100, 500, 500));
  });
});

describe("brush sizing", () => {
  it("records image-sized brushes at the slider value, whatever the zoom", () => {
    expect(brushRadiusInImagePixels(40, "image", 0.25)).toBe(40);
    expect(brushRadiusInImagePixels(40, "image", 8)).toBe(40);
  });

  it("divides a screen-sized brush back out by the zoom it was drawn at", () => {
    // Otherwise the same gesture would cover four times as much of the image at
    // 4x as it did at 1x, and the stroke would not be reproducible.
    expect(brushRadiusInImagePixels(40, "screen", 4)).toBe(10);
    expect(brushRadiusInImagePixels(40, "screen", 0.5)).toBe(80);
  });

  it("draws the cursor at the size the stroke will actually be", () => {
    expect(brushRadiusOnScreen(40, "image", 2)).toBe(80);
    expect(brushRadiusOnScreen(40, "screen", 2)).toBe(40);
  });

  it("never records a zero or runaway radius", () => {
    expect(brushRadiusInImagePixels(40, "screen", 100000)).toBe(1);
    expect(brushRadiusInImagePixels(4000, "screen", 0.001)).toBe(2000);
  });

  it("adjusts size horizontally and softness vertically during Alt + right-drag", () => {
    const largerAndSofter = brushSettingsFromDrag(80, 35, 120, 50, 400);
    const smallerAndHarder = brushSettingsFromDrag(80, 35, -120, -50, 400);

    expect(largerAndSofter.radius).toBeGreaterThan(80);
    expect(largerAndSofter.softness).toBe(60);
    expect(smallerAndHarder.radius).toBeLessThan(80);
    expect(smallerAndHarder.softness).toBe(10);
  });

  it("clamps fast brush adjustments to usable values", () => {
    expect(brushSettingsFromDrag(20, 50, -10_000, -10_000, 300)).toEqual({ radius: 1, softness: 0 });
    expect(brushSettingsFromDrag(20, 50, 10_000, 10_000, 300)).toEqual({ radius: 300, softness: 100 });
  });
});

describe("the view", () => {
  it("fits the whole image and centres it", () => {
    const view = fitMaskView({ width: 1000, height: 500 }, { width: 600, height: 600 }, 0);

    expect(view.scale).toBeCloseTo(0.6);
    expect(view.offsetX).toBeCloseTo(0);
    expect(view.offsetY).toBeCloseTo(150);
  });

  it("keeps the point under the cursor still while zooming", () => {
    // The whole reason to anchor: zooming on the middle would move whatever the
    // artist was working on off under their hand.
    const view = { scale: 1, offsetX: 30, offsetY: 20 };
    const anchor = { x: 200, y: 140 };
    const before = imagePointFromViewport(view, anchor);

    const zoomed = zoomMaskView(view, anchor, 3.5);
    const after = viewportPointFromImage(zoomed, before);

    expect(zoomed.scale).toBe(3.5);
    expect(after.x).toBeCloseTo(anchor.x);
    expect(after.y).toBeCloseTo(anchor.y);
  });

  it("clamps the zoom at both ends", () => {
    const view = { scale: 1, offsetX: 0, offsetY: 0 };
    expect(zoomMaskView(view, { x: 0, y: 0 }, 1e6).scale).toBe(MAX_ZOOM);
    expect(zoomMaskView(view, { x: 0, y: 0 }, 1e-6).scale).toBe(MIN_ZOOM);
  });

  it("pans without changing the zoom", () => {
    const panned = panMaskView({ scale: 2, offsetX: 10, offsetY: 10 }, -40, 15);
    expect(panned).toEqual({ scale: 2, offsetX: -30, offsetY: 25 });
  });
});

describe("simplifyStrokePoints", () => {
  it("drops points that cannot change the painted shape", () => {
    const dense = Array.from({ length: 20 }, (_, index) => ({ x: index * 0.5, y: 0 }));
    const simplified = simplifyStrokePoints(dense, 30);

    expect(simplified.length).toBeLessThan(dense.length);
    expect(simplified[0]).toEqual(dense[0]);
    // The last point is where the artist let go, so it is never dropped even
    // though it is well inside the step threshold.
    expect(simplified[simplified.length - 1]).toEqual(dense[dense.length - 1]);
  });

  it("keeps points that are far enough apart to matter", () => {
    const spread = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 200, y: 0 },
    ];
    expect(simplifyStrokePoints(spread, 10)).toEqual(spread);
  });

  it("leaves a tap alone", () => {
    const tap = [{ x: 5, y: 5 }];
    expect(simplifyStrokePoints(tap, 40)).toEqual(tap);
  });
});
