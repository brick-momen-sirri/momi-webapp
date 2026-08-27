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
  maskCropAspect,
  maskCropMargin,
  maskRectangleFromPoints,
  panMaskView,
  retargetMaskDrawing,
  setMaskCropAspect,
  setMaskCropMargin,
  setMaskRectangleSelection,
  setMaskSoftness,
  simplifyStrokePoints,
  undoMaskStroke,
  viewportPointFromImage,
  zoomMaskView,
  type MaskStroke,
  marqueeSelection,
  translateMaskDrawing,
  invertMaskDrawing,
  maskInverted,
  boxCorners,
  composeTransforms,
  conjugateTransform,
  IDENTITY_TRANSFORM,
  invertTransform,
  isIdentityTransform,
  maskGeometryBounds,
  maskTransform,
  resetMaskTransform,
  rotationTransform,
  scaleTransform,
  setMaskTransform,
  transformFromHandleDrag,
  transformPoint,
  transformReadout,
  translationTransform,
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

  it("stores crop margin and aspect preferences with safe defaults", () => {
    const drawing = createMaskDrawing(100, 80);
    expect(maskCropMargin(drawing)).toBe(0);
    expect(maskCropAspect(drawing)).toBe("1:1");
    expect(maskCropMargin(setMaskCropMargin(drawing, 250))).toBe(100);
    expect(maskCropMargin(setMaskCropMargin(drawing, -20))).toBe(0);
    expect(maskCropAspect(setMaskCropAspect(drawing, "16:9"))).toBe("16:9");
  });

  it("adapts a widescreen selection between landscape and portrait", () => {
    const adaptive = setMaskCropAspect(createMaskDrawing(1000, 1000), "16:9");
    const portrait = setMaskRectangleSelection(adaptive, { x: 100, y: 100, width: 180, height: 320 });
    const landscape = setMaskRectangleSelection(portrait, { x: 100, y: 100, width: 320, height: 180 });

    expect(maskCropAspect(portrait)).toBe("9:16");
    expect(maskCropAspect(landscape)).toBe("16:9");
  });

  it("normalizes a rectangle drag and keeps it mutually exclusive with brush strokes", () => {
    expect(maskRectangleFromPoints({ x: 90.2, y: 70.8 }, { x: -10, y: 10.2 }, 100, 80)).toEqual({
      x: 0,
      y: 10,
      width: 91,
      height: 61,
    });
    expect(maskRectangleFromPoints({ x: 10, y: 10 }, { x: 10, y: 20 }, 100, 80)).toBeUndefined();

    const painted = appendMaskStroke(createMaskDrawing(100, 80), brush([[20, 20]]));
    const selected = setMaskRectangleSelection(painted, { x: 10, y: 15, width: 30, height: 20 });
    expect(selected.strokes).toHaveLength(0);
    expect(hasPaintedRegion(selected)).toBe(true);
    expect(appendMaskStroke(selected, brush([[50, 50]])).selection).toBeUndefined();
    expect(clearMaskStrokes(selected).selection).toBeUndefined();
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
    const drawing = appendMaskStroke(
      setMaskCropAspect(setMaskCropMargin(setMaskSoftness(createMaskDrawing(4000, 3000), 60), 75), "16:9"),
      brush([[10, 10]]),
    );
    const retargeted = retargetMaskDrawing(drawing, 1000, 750);

    expect(retargeted.strokes).toHaveLength(0);
    expect(retargeted.width).toBe(1000);
    // Softness is a preference rather than part of the drawing, so it survives.
    expect(retargeted.softness).toBe(60);
    expect(retargeted.cropMargin).toBe(75);
    expect(retargeted.cropAspect).toBe("16:9");
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

  it("is true for a rectangle selection without painted strokes", () => {
    const drawing = setMaskRectangleSelection(createMaskDrawing(100, 80), { x: 10, y: 15, width: 30, height: 20 });
    expect(drawing.strokes).toHaveLength(0);
    expect(hasPaintedRegion(drawing)).toBe(true);
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

describe("the rectangle marquee", () => {
  const drag = (over: Partial<Parameters<typeof marqueeSelection>[0]> = {}) =>
    marqueeSelection({ origin: { x: 100, y: 100 }, current: { x: 160, y: 140 }, ...over }, 400, 300);

  it("draws from the mouse-down corner by default", () => {
    expect(drag()).toEqual({ x: 100, y: 100, width: 60, height: 40 });
  });

  it("draws outward from the mouse-down point when Alt is held", () => {
    // Photoshop keeps the anchor at the centre and mirrors the drag, so the
    // rectangle is twice the size of the plain drag and stays centred on 100,100.
    expect(drag({ fromCentre: true })).toEqual({ x: 40, y: 60, width: 120, height: 80 });
  });

  it("constrains to a square while keeping the drag direction", () => {
    // Dragging left and down by 60x30: the longer axis wins and the shorter one
    // is extended in the direction it was already going, not mirrored.
    expect(drag({ current: { x: 40, y: 130 }, square: true })).toEqual({ x: 40, y: 100, width: 60, height: 60 });
  });

  it("carries the rectangle without resizing it while Space is held", () => {
    const before = drag();
    const carried = drag({ shift: { x: 25, y: -30 } });

    expect(carried).toEqual({ x: 125, y: 70, width: 60, height: 40 });
    expect(carried?.width).toBe(before?.width);
    expect(carried?.height).toBe(before?.height);
  });

  it("combines a carry with drawing from the centre", () => {
    expect(drag({ shift: { x: 10, y: 10 }, fromCentre: true })).toEqual({ x: 50, y: 70, width: 120, height: 80 });
  });

  it("clips to the image and refuses a drag with no area", () => {
    expect(drag({ current: { x: 900, y: 900 } })).toEqual({ x: 100, y: 100, width: 300, height: 200 });
    expect(drag({ current: { x: 100, y: 100 } })).toBeUndefined();
  });
});

describe("moving and inverting a mask", () => {
  it("translates strokes and a selection without clamping them to the frame", () => {
    const drawing = appendMaskStroke(
      setMaskRectangleSelection(createMaskDrawing(400, 300), { x: 10, y: 10, width: 20, height: 20 }),
      { tool: "brush", radius: 4, points: [{ x: 50, y: 50 }] },
    );
    const moved = translateMaskDrawing(drawing, -80, 5);

    // The selection is dropped by appendMaskStroke, so only the stroke survives --
    // and it keeps its negative coordinate rather than being pinned to the edge.
    expect(moved.strokes[0].points).toEqual([{ x: -30, y: 55 }]);
    expect(translateMaskDrawing(drawing, 0, 0)).toBe(drawing);
  });

  it("moves a rectangle selection with the mask", () => {
    const drawing = setMaskRectangleSelection(createMaskDrawing(400, 300), { x: 10, y: 10, width: 20, height: 20 });
    expect(translateMaskDrawing(drawing, 5, -5).selection).toEqual({ x: 15, y: 5, width: 20, height: 20 });
  });

  it("inverts reversibly and counts an inverted empty mask as covering the frame", () => {
    const drawing = createMaskDrawing(400, 300);
    expect(hasPaintedRegion(drawing)).toBe(false);

    const inverted = invertMaskDrawing(drawing);
    expect(maskInverted(inverted)).toBe(true);
    expect(hasPaintedRegion(inverted)).toBe(true);

    const back = invertMaskDrawing(inverted);
    expect(maskInverted(back)).toBe(false);
    expect(back.strokes).toEqual(drawing.strokes);
  });
});

describe("the free transform", () => {
  /** A quarter turn about the origin, as the composition tests keep needing one. */
  const quarterTurn = { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 };

  /** Signed zero falls out of the arithmetic and is not a distinction any of this makes. */
  const plain = (transform: ReturnType<typeof maskTransform>) => ({
    a: transform.a + 0,
    b: transform.b + 0,
    c: transform.c + 0,
    d: transform.d + 0,
    e: transform.e + 0,
    f: transform.f + 0,
  });

  it("stores identity as absence, so an untransformed mask serialises unchanged", () => {
    const drawing = createMaskDrawing(400, 300);
    expect(setMaskTransform(drawing, IDENTITY_TRANSFORM)).toBe(drawing);
    expect(maskTransform(drawing)).toEqual(IDENTITY_TRANSFORM);
    expect(isIdentityTransform(maskTransform(drawing))).toBe(true);

    const scaled = setMaskTransform(drawing, scaleTransform({ x: 0, y: 0 }, 2, 2));
    expect(plain(scaled.transform as ReturnType<typeof maskTransform>)).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 });
    expect(resetMaskTransform(scaled).transform).toBeUndefined();
  });

  it("scales and rotates about a pivot, leaving the pivot where it was", () => {
    const pivot = { x: 100, y: 100 };
    expect(transformPoint(scaleTransform(pivot, 2, 3), pivot)).toEqual(pivot);
    expect(transformPoint(scaleTransform(pivot, 2, 3), { x: 150, y: 200 })).toEqual({ x: 200, y: 400 });

    const turned = transformPoint(rotationTransform(pivot, Math.PI / 2), { x: 200, y: 100 });
    expect(turned.x).toBeCloseTo(100, 9);
    expect(turned.y).toBeCloseTo(200, 9);
  });

  it("inverts, and reports scale and angle back", () => {
    const inverse = invertTransform(quarterTurn);
    expect(plain(inverse as ReturnType<typeof maskTransform>)).toEqual({ a: 0, b: -1, c: 1, d: 0, e: 0, f: 0 });
    expect(invertTransform({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 })).toBeUndefined();

    const readout = transformReadout(composeTransforms(quarterTurn, scaleTransform({ x: 0, y: 0 }, 2, 2)));
    expect(readout.scaleX).toBeCloseTo(2, 9);
    expect(readout.scaleY).toBeCloseTo(2, 9);
    expect(readout.degrees).toBeCloseTo(90, 9);
  });

  it("re-expresses itself when the coordinates around it change", () => {
    // Conjugating by a shift is what a crop does to a transform: the rasterised
    // point has to land in the same place, one crop origin further left.
    const transform = scaleTransform({ x: 100, y: 100 }, 2, 2);
    const shift = translationTransform(-40, -25);
    const conjugated = conjugateTransform(transform, shift);

    const point = { x: 160, y: 140 };
    const before = transformPoint(transform, point);
    const after = transformPoint(conjugated, { x: point.x - 40, y: point.y - 25 });
    expect(after).toEqual({ x: before.x - 40, y: before.y - 25 });
  });

  it("measures the box the strokes occupy, before any transform", () => {
    const painted = appendMaskStroke(createMaskDrawing(400, 300), {
      tool: "brush",
      radius: 10,
      points: [{ x: 100, y: 100 }],
    });
    expect(maskGeometryBounds(painted)).toEqual({ left: 90, top: 90, right: 110, bottom: 110 });
    expect(maskGeometryBounds(createMaskDrawing(400, 300))).toBeUndefined();
    expect(boxCorners({ left: 0, top: 0, right: 2, bottom: 1 })).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 0, y: 1 },
    ]);
  });

  it("moves a rotated mask along the drag rather than along its own axes", () => {
    const rotated = setMaskTransform(
      appendMaskStroke(createMaskDrawing(400, 300), { tool: "brush", radius: 4, points: [{ x: 0, y: 0 }] }),
      quarterTurn,
    );
    const moved = translateMaskDrawing(rotated, 10, 0);

    // The point itself moves against the turn...
    expect(moved.strokes[0].points[0].x).toBeCloseTo(0, 9);
    expect(moved.strokes[0].points[0].y).toBeCloseTo(-10, 9);
    // ...so that where it lands on the image is exactly the 10px the artist dragged.
    const landed = transformPoint(maskTransform(moved), moved.strokes[0].points[0]);
    expect(landed.x).toBeCloseTo(10, 9);
    expect(landed.y).toBeCloseTo(0, 9);
  });

  describe("handle drags", () => {
    const box = { left: 0, top: 0, right: 100, bottom: 100 };

    it("scales a corner about the opposite corner", () => {
      const next = transformFromHandleDrag({
        handle: "se",
        box,
        base: IDENTITY_TRANSFORM,
        from: { x: 100, y: 100 },
        to: { x: 200, y: 150 },
      });
      expect(plain(next)).toEqual({ a: 2, b: 0, c: 0, d: 1.5, e: 0, f: 0 });
      // The anchored corner has not moved.
      expect(transformPoint(next, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    });

    it("scales an edge on one axis only", () => {
      const next = transformFromHandleDrag({
        handle: "e",
        box,
        base: IDENTITY_TRANSFORM,
        from: { x: 100, y: 50 },
        to: { x: 250, y: 400 },
      });
      expect(next).toMatchObject({ a: 2.5, d: 1 });
    });

    it("scales from the centre when Alt is held", () => {
      const next = transformFromHandleDrag({
        handle: "se",
        box,
        base: IDENTITY_TRANSFORM,
        from: { x: 100, y: 100 },
        to: { x: 150, y: 150 },
        fromCentre: true,
      });
      // 50 from the centre became 100, and the centre stayed put.
      expect(transformPoint(next, { x: 50, y: 50 })).toEqual({ x: 50, y: 50 });
      expect(transformPoint(next, { x: 100, y: 100 })).toEqual({ x: 150, y: 150 });
    });

    it("keeps a corner proportional when Shift is held", () => {
      const next = transformFromHandleDrag({
        handle: "se",
        box,
        base: IDENTITY_TRANSFORM,
        from: { x: 100, y: 100 },
        to: { x: 300, y: 110 },
        proportional: true,
      });
      expect(next.a).toBe(3);
      expect(next.d).toBe(3);
    });

    it("pulls along the box's own axes once the box has been turned", () => {
      // A quarter turn, then the same south-east drag: the scale has to compose
      // inside the rotation, or the grip would stretch the mask across the screen
      // instead of along the box the artist can see.
      const next = transformFromHandleDrag({
        handle: "se",
        box,
        base: quarterTurn,
        from: { x: -100, y: 100 },
        to: { x: -200, y: 200 },
      });
      expect(next.a).toBeCloseTo(0, 9);
      expect(next.b).toBeCloseTo(2, 9);
      expect(next.c).toBeCloseTo(-2, 9);
      expect(next.d).toBeCloseTo(0, 9);
    });

    it("rotates about the box centre, and snaps to 15 degrees with Shift", () => {
      const next = transformFromHandleDrag({
        handle: "rotate",
        box,
        base: IDENTITY_TRANSFORM,
        from: { x: 50, y: -20 },
        to: { x: 120, y: 50 },
      });
      expect(transformReadout(next).degrees).toBeCloseTo(90, 9);
      expect(transformPoint(next, { x: 50, y: 50 })).toEqual({ x: 50, y: 50 });

      const snapped = transformFromHandleDrag({
        handle: "rotate",
        box,
        base: IDENTITY_TRANSFORM,
        from: { x: 50, y: -20 },
        to: { x: 55, y: -20 },
        proportional: true,
      });
      expect(transformReadout(snapped).degrees).toBe(0);
    });

    it("refuses to collapse the mask to nothing", () => {
      const next = transformFromHandleDrag({
        handle: "se",
        box,
        base: IDENTITY_TRANSFORM,
        from: { x: 100, y: 100 },
        to: { x: 0, y: 0 },
      });
      // Clamped rather than zero, so the mask can always be dragged back out.
      expect(Math.abs(next.a)).toBeGreaterThan(0);
      expect(Math.abs(next.d)).toBeGreaterThan(0);
      expect(invertTransform(next)).toBeDefined();
    });
  });
});
