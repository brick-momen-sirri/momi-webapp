import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  appendMaskStroke,
  createMaskDrawing,
  setMaskRectangleSelection,
  transformReadout,
  type MaskDrawing,
} from "../features/still-images/maskDrawing";

vi.mock("../services/api/mediaAccess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/api/mediaAccess")>();
  return {
    ...actual,
    // Stands in for the media credential the real one appends when there is no
    // cookie, so a test can tell a resolved URL from a raw one.
    resolveMediaUrl: (url: string) => (url.startsWith("/api/") ? `${url}&access_token=test` : url),
  };
});

vi.mock("../features/still-images/maskRaster", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../features/still-images/maskRaster")>();
  return {
    ...actual,
    loadImageElement: vi.fn(async () => {
      const image = document.createElement("img");
      Object.defineProperty(image, "naturalWidth", { value: 1200 });
      Object.defineProperty(image, "naturalHeight", { value: 800 });
      return image;
    }),
  };
});

import { MaskRegionField } from "./MaskRegionField";

describe("MaskRegionField", () => {
  it("automatically opens the portal editor for an upload/drop request", async () => {
    render(
      <MaskRegionField
        image={{ id: "uploaded-1", name: "source.png", url: "blob:source" }}
        onChange={() => undefined}
        openRequest={1}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: /choose the region to edit on source\.png/i });
    expect(dialog.parentElement).toBe(document.body);
    // The scroll lock is a passive effect, so finding the dialog does not mean it
    // has run yet -- asserting it in the same tick is what made this flake under
    // a loaded full-suite run while passing alone.
    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));
    expect(screen.getByTestId("mask-editor-viewport")).toHaveAttribute("data-mask-visualization", "highlight");
  });

  it("does not reopen merely because the field renders with an existing image", async () => {
    render(
      <MaskRegionField image={{ id: "existing-1", name: "existing.png", url: "blob:existing" }} onChange={() => undefined} />,
    );
    expect(await screen.findByRole("button", { name: /choose region/i })).toBeEnabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("adjusts brush size and softness with Alt + right-drag", async () => {
    render(
      <MaskRegionField
        image={{ id: "uploaded-2", name: "source.png", url: "blob:source" }}
        onChange={() => undefined}
        openRequest={1}
      />,
    );

    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Brush" }));
    const viewport = screen.getByTestId("mask-editor-viewport");
    const size = screen.getByRole("slider", { name: "Brush size" }) as HTMLInputElement;
    const softness = screen.getByRole("slider", { name: "Brush softness" }) as HTMLInputElement;
    const originalSize = Number(size.value);

    fireEvent.pointerDown(viewport, { button: 2, buttons: 2, altKey: true, pointerId: 7, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(viewport, { buttons: 2, altKey: true, pointerId: 7, clientX: 220, clientY: 150 });

    expect(Number(size.value)).toBeGreaterThan(originalSize);
    expect(softness.value).toBe("60");
    expect(viewport).toHaveAttribute("data-adjusting-brush", "true");
    expect(viewport).toHaveAttribute("data-brush-preview-x", "100");
    expect(viewport).toHaveAttribute("data-brush-preview-y", "100");

    fireEvent.pointerUp(viewport, { button: 2, pointerId: 7, clientX: 220, clientY: 150 });
    expect(viewport).not.toHaveAttribute("data-adjusting-brush");
    expect(viewport).toHaveAttribute("data-brush-preview-x", "220");
    expect(viewport).toHaveAttribute("data-brush-preview-y", "150");
  });

  it("starts with no margin and adapts widescreen crops to the selection orientation", async () => {
    const onDraftChange = vi.fn();
    render(
      <MaskRegionField
        image={{ id: "uploaded-crop-controls", name: "source.png", url: "blob:source" }}
        onChange={() => undefined}
        onEditorDraftChange={onDraftChange}
        openRequest={1}
      />,
    );

    await screen.findByRole("dialog");
    const square = screen.getByRole("button", { name: "1:1 crop" });
    const widescreen = screen.getByRole("button", { name: "Adaptive 16:9 or 9:16 crop" });
    const margin = screen.getByRole("slider", { name: "Crop margin" });
    expect(square).toHaveAttribute("aria-pressed", "true");
    expect(widescreen).toHaveAttribute("aria-pressed", "false");
    expect(margin).toHaveValue("0");

    fireEvent.change(margin, { target: { value: "75" } });
    fireEvent.click(widescreen);

    await waitFor(() => {
      const latest = onDraftChange.mock.calls.at(-1)?.[0];
      expect(latest?.cropMargin).toBe(75);
      expect(latest?.cropAspect).toBe("16:9");
    });
    expect(widescreen).toHaveAttribute("aria-pressed", "true");

    const viewport = screen.getByTestId("mask-editor-viewport");
    fireEvent.pointerDown(viewport, { button: 0, buttons: 1, pointerId: 12, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(viewport, { buttons: 1, pointerId: 12, clientX: 200, clientY: 400 });
    fireEvent.pointerUp(viewport, { button: 0, pointerId: 12, clientX: 200, clientY: 400 });
    await waitFor(() => expect(onDraftChange.mock.calls.at(-1)?.[0]?.cropAspect).toBe("9:16"));
    expect(widescreen).toHaveTextContent("9:16 Auto");
  });

  it("draws a source-coordinate rectangle selection without painted strokes", async () => {
    const onDraftChange = vi.fn();
    render(
      <MaskRegionField
        image={{ id: "uploaded-selection", name: "source.png", url: "blob:source" }}
        onChange={() => undefined}
        onEditorDraftChange={onDraftChange}
        openRequest={1}
      />,
    );

    await screen.findByRole("dialog");
    expect(screen.getByRole("button", { name: "Rectangle selection" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/alt draws from the centre, space repositions it/i)).toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Brush size" })).not.toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Brush softness" })).not.toBeInTheDocument();

    const viewport = screen.getByTestId("mask-editor-viewport");
    fireEvent.pointerDown(viewport, { button: 0, buttons: 1, pointerId: 11, clientX: 100, clientY: 120 });
    fireEvent.pointerMove(viewport, { buttons: 1, pointerId: 11, clientX: 300, clientY: 270 });
    expect(viewport).toHaveAttribute("data-selection-x", "100");
    expect(viewport).toHaveAttribute("data-selection-y", "120");
    expect(viewport).toHaveAttribute("data-selection-width", "200");
    expect(viewport).toHaveAttribute("data-selection-height", "150");
    fireEvent.pointerUp(viewport, { button: 0, pointerId: 11, clientX: 300, clientY: 270 });

    await waitFor(() => {
      const latest = onDraftChange.mock.calls.at(-1)?.[0];
      expect(latest?.selection).toEqual({ x: 100, y: 120, width: 200, height: 150 });
      expect(latest?.strokes).toEqual([]);
    });
  });

  it("draws the marquee outward from the mouse-down point while Alt is held", async () => {
    render(
      <MaskRegionField
        image={{ id: "uploaded-alt", name: "source.png", url: "blob:source" }}
        onChange={() => undefined}
        openRequest={1}
      />,
    );

    await screen.findByRole("dialog");
    const viewport = screen.getByTestId("mask-editor-viewport");
    fireEvent.pointerDown(viewport, { button: 0, buttons: 1, pointerId: 21, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(viewport, { buttons: 1, pointerId: 21, clientX: 260, clientY: 240, altKey: true });

    // Mirrored around 200,200 rather than anchored at it, so the rectangle is
    // twice the size the same drag would produce from a corner.
    expect(viewport).toHaveAttribute("data-selection-x", "140");
    expect(viewport).toHaveAttribute("data-selection-y", "160");
    expect(viewport).toHaveAttribute("data-selection-width", "120");
    expect(viewport).toHaveAttribute("data-selection-height", "80");

    // Letting go of Alt mid-drag goes back to a corner drag from the same point.
    fireEvent.pointerMove(viewport, { buttons: 1, pointerId: 21, clientX: 260, clientY: 240 });
    expect(viewport).toHaveAttribute("data-selection-x", "200");
    expect(viewport).toHaveAttribute("data-selection-width", "60");
  });

  it("carries the marquee with Space and resumes resizing it when Space is released", async () => {
    const onDraftChange = vi.fn();
    render(
      <MaskRegionField
        image={{ id: "uploaded-space", name: "source.png", url: "blob:source" }}
        onChange={() => undefined}
        onEditorDraftChange={onDraftChange}
        openRequest={1}
      />,
    );

    await screen.findByRole("dialog");
    const viewport = screen.getByTestId("mask-editor-viewport");
    fireEvent.pointerDown(viewport, { button: 0, buttons: 1, pointerId: 22, clientX: 100, clientY: 120 });
    fireEvent.pointerMove(viewport, { buttons: 1, pointerId: 22, clientX: 300, clientY: 270 });
    expect(viewport).toHaveAttribute("data-selection-width", "200");

    fireEvent.keyDown(window, { key: " " });
    fireEvent.pointerMove(viewport, { buttons: 1, pointerId: 22, clientX: 350, clientY: 300 });

    // Moved by exactly the pointer delta, and not resized by a single pixel.
    expect(viewport).toHaveAttribute("data-selection-x", "150");
    expect(viewport).toHaveAttribute("data-selection-y", "150");
    expect(viewport).toHaveAttribute("data-selection-width", "200");
    expect(viewport).toHaveAttribute("data-selection-height", "150");

    fireEvent.keyUp(window, { key: " " });
    fireEvent.pointerMove(viewport, { buttons: 1, pointerId: 22, clientX: 400, clientY: 320 });

    // The corner is back under the pointer rather than a carry-worth away from it.
    expect(viewport).toHaveAttribute("data-selection-x", "150");
    expect(viewport).toHaveAttribute("data-selection-width", "250");
    expect(viewport).toHaveAttribute("data-selection-height", "170");

    fireEvent.pointerUp(viewport, { button: 0, pointerId: 22, clientX: 400, clientY: 320 });
    await waitFor(() =>
      expect(onDraftChange.mock.calls.at(-1)?.[0]?.selection).toEqual({ x: 150, y: 150, width: 250, height: 170 }),
    );
  });

  it("undoes and redoes what was done in this editor session", async () => {
    const onDraftChange = vi.fn();
    render(
      <MaskRegionField
        image={{ id: "uploaded-undo", name: "source.png", url: "blob:source" }}
        onChange={() => undefined}
        onEditorDraftChange={onDraftChange}
        openRequest={1}
      />,
    );

    await screen.findByRole("dialog");
    // Nothing has happened yet, so there is nothing to wind back.
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();

    const viewport = screen.getByTestId("mask-editor-viewport");
    fireEvent.pointerDown(viewport, { button: 0, buttons: 1, pointerId: 41, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(viewport, { buttons: 1, pointerId: 41, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(viewport, { button: 0, pointerId: 41, clientX: 200, clientY: 200 });
    await waitFor(() => expect(onDraftChange.mock.calls.at(-1)?.[0]?.selection).toBeDefined());

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(onDraftChange.mock.calls.at(-1)?.[0]?.selection).toBeUndefined());
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();

    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() =>
      expect(onDraftChange.mock.calls.at(-1)?.[0]?.selection).toEqual({ x: 100, y: 100, width: 100, height: 100 }),
    );

    // Ctrl+D drops the marquee and is itself undoable.
    fireEvent.keyDown(window, { key: "d", ctrlKey: true });
    await waitFor(() => expect(onDraftChange.mock.calls.at(-1)?.[0]?.selection).toBeUndefined());
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(onDraftChange.mock.calls.at(-1)?.[0]?.selection).toBeDefined());
  });

  it("moves a selected layer once per drag and says what it is about to change", async () => {
    const onMoveBy = vi.fn();
    const onTargetChange = vi.fn();
    render(
      <MaskRegionField
        image={{ id: "uploaded-move", name: "source.png", url: "blob:source" }}
        onChange={() => undefined}
        openRequest={1}
        layerContext={{
          layerId: "edit_1",
          name: "Edit Layer 03",
          target: "content",
          crop: { x: 40, y: 40, size: 100, width: 100, height: 100, sourceWidth: 1200, sourceHeight: 800 },
          opacity: 70,
          visible: true,
          maskEnabled: true,
          maskLinked: true,
          offset: { x: 0, y: 0 },
          onTargetChange,
          onMoveBy,
        }}
      />,
    );

    await screen.findByRole("dialog");
    const viewport = screen.getByTestId("mask-editor-viewport");
    // Arming the pixels puts the Move tool up, because nothing else can act on them.
    expect(viewport).toHaveAttribute("data-tool", "move");
    expect(viewport).toHaveAttribute("data-edit-target", "content");
    expect(viewport).toHaveAttribute("data-mask-visualization", "none");

    const context = screen.getByTestId("mask-editor-context");
    expect(context).toHaveTextContent("Edit Layer 03");
    expect(context).toHaveTextContent("Layer content");
    expect(context).toHaveTextContent("70%");

    fireEvent.pointerDown(viewport, { button: 0, buttons: 1, pointerId: 31, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(viewport, { buttons: 1, pointerId: 31, clientX: 130, clientY: 80 });
    expect(viewport).toHaveAttribute("data-move-x", "30");
    expect(viewport).toHaveAttribute("data-move-y", "-20");
    // Still nothing committed: the document is recomposited once, on release.
    expect(onMoveBy).not.toHaveBeenCalled();

    fireEvent.pointerUp(viewport, { button: 0, pointerId: 31, clientX: 140, clientY: 75 });
    expect(onMoveBy).toHaveBeenCalledTimes(1);
    expect(onMoveBy).toHaveBeenCalledWith({ x: 40, y: -25 });

    // Reaching for a paint tool means the mask, and the panel is told so rather
    // than the stroke being silently refused.
    fireEvent.click(screen.getByRole("button", { name: "Brush" }));
    expect(onTargetChange).toHaveBeenCalledWith("mask");
  });

  it("shows the quiet mask edge only after an existing layer mask is explicitly targeted", async () => {
    const selected = setMaskRectangleSelection(createMaskDrawing(1200, 800), {
      x: 100,
      y: 100,
      width: 160,
      height: 120,
    });
    render(
      <MaskRegionField
        image={{ id: "uploaded-mask-target", name: "source.png", url: "blob:source" }}
        drawing={selected}
        onChange={() => undefined}
        openRequest={1}
        layerContext={{
          layerId: "edit_mask",
          name: "Edit Layer 04",
          target: "mask",
          crop: { x: 80, y: 80, size: 200, width: 200, height: 200, sourceWidth: 1200, sourceHeight: 800 },
          opacity: 100,
          visible: true,
          maskEnabled: true,
          maskLinked: true,
          offset: { x: 0, y: 0 },
          onTargetChange: () => undefined,
          onMoveBy: () => undefined,
        }}
      />,
    );

    await screen.findByRole("dialog");
    const viewport = screen.getByTestId("mask-editor-viewport");
    expect(viewport).toHaveAttribute("data-edit-target", "mask");
    expect(viewport).toHaveAttribute("data-mask-visualization", "edge-only");
  });

  describe("free transform", () => {
    // A 100px square selection at 100,100 on the 1200x800 source. The editor opens
    // unzoomed and unpanned in jsdom, so image pixels and client pixels line up
    // and the grips sit exactly on the corners of that square.
    const selected = setMaskRectangleSelection(createMaskDrawing(1200, 800), {
      x: 100,
      y: 100,
      width: 100,
      height: 100,
    });

    async function openTransform(onDraftChange: (drawing: MaskDrawing) => void) {
      render(
        <MaskRegionField
          image={{ id: "uploaded-transform", name: "source.png", url: "blob:source" }}
          drawing={selected}
          onChange={() => undefined}
          onEditorDraftChange={onDraftChange}
          openRequest={1}
        />,
      );
      await screen.findByRole("dialog");
      fireEvent.click(screen.getByRole("button", { name: "Free transform" }));
      return screen.getByTestId("mask-editor-viewport");
    }

    it("scales the mask from the grip's opposite corner", async () => {
      const onDraftChange = vi.fn();
      const viewport = await openTransform(onDraftChange);
      expect(viewport).toHaveAttribute("data-tool", "transform");

      // The bottom-right grip, and the editor says so before anything is dragged.
      fireEvent.pointerMove(viewport, { pointerId: 51, clientX: 200, clientY: 200 });
      expect(viewport).toHaveAttribute("data-transform-handle", "se");

      fireEvent.pointerDown(viewport, { button: 0, buttons: 1, pointerId: 51, clientX: 200, clientY: 200 });
      fireEvent.pointerMove(viewport, { buttons: 1, pointerId: 51, clientX: 300, clientY: 300 });
      fireEvent.pointerUp(viewport, { button: 0, pointerId: 51, clientX: 300, clientY: 300 });

      await waitFor(() => expect(onDraftChange.mock.calls.at(-1)?.[0]?.transform).toBeDefined());
      const transform = onDraftChange.mock.calls.at(-1)?.[0]?.transform;
      // Twice the size, anchored on the corner opposite the grip.
      expect(transform.a).toBeCloseTo(2, 6);
      expect(transform.d).toBeCloseTo(2, 6);
      expect(transform.e).toBeCloseTo(-100, 6);
      expect(transform.f).toBeCloseTo(-100, 6);
      // Non-destructive: the selection is still the square that was drawn.
      expect(onDraftChange.mock.calls.at(-1)?.[0]?.selection).toEqual({ x: 100, y: 100, width: 100, height: 100 });
    });

    it("rotates about the box centre from the knob above it", async () => {
      const onDraftChange = vi.fn();
      const viewport = await openTransform(onDraftChange);

      // The knob sits 28px beyond the middle of the top edge.
      fireEvent.pointerMove(viewport, { pointerId: 52, clientX: 150, clientY: 72 });
      expect(viewport).toHaveAttribute("data-transform-handle", "rotate");

      fireEvent.pointerDown(viewport, { button: 0, buttons: 1, pointerId: 52, clientX: 150, clientY: 72 });
      // A quarter turn clockwise around the centre at 150,150.
      fireEvent.pointerMove(viewport, { buttons: 1, pointerId: 52, clientX: 228, clientY: 150 });
      fireEvent.pointerUp(viewport, { button: 0, pointerId: 52, clientX: 228, clientY: 150 });

      await waitFor(() => expect(onDraftChange.mock.calls.at(-1)?.[0]?.transform).toBeDefined());
      const readout = transformReadout(onDraftChange.mock.calls.at(-1)?.[0]?.transform);
      expect(readout.degrees).toBeCloseTo(90, 4);
      expect(readout.scaleX).toBeCloseTo(1, 6);
    });

    it("abandons the drag on Escape without closing the editor or changing the mask", async () => {
      const onDraftChange = vi.fn();
      const viewport = await openTransform(onDraftChange);
      onDraftChange.mockClear();

      fireEvent.pointerDown(viewport, { button: 0, buttons: 1, pointerId: 53, clientX: 200, clientY: 200 });
      fireEvent.pointerMove(viewport, { buttons: 1, pointerId: 53, clientX: 400, clientY: 400 });
      fireEvent.keyDown(window, { key: "Escape" });

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      fireEvent.pointerUp(viewport, { button: 0, pointerId: 53, clientX: 400, clientY: 400 });
      expect(onDraftChange).not.toHaveBeenCalled();
    });

    it("says there is nothing to transform when nothing has been painted", async () => {
      render(
        <MaskRegionField
          image={{ id: "uploaded-empty-transform", name: "source.png", url: "blob:source" }}
          onChange={() => undefined}
          openRequest={1}
        />,
      );
      await screen.findByRole("dialog");
      fireEvent.click(screen.getByRole("button", { name: "Free transform" }));
      expect(screen.getByText(/nothing to transform yet/i)).toBeInTheDocument();
    });
  });

  it("keeps the zoom when the selected layer changes, and refits only for a new document", async () => {
    const crop = { x: 40, y: 40, size: 100, width: 100, height: 100, sourceWidth: 1200, sourceHeight: 800 };
    const context = (layerId: string, name: string) => ({
      layerId,
      name,
      target: "mask" as const,
      crop,
      opacity: 100,
      visible: true,
      maskEnabled: true,
      maskLinked: true,
      offset: { x: 0, y: 0 },
      onTargetChange: () => undefined,
      onMoveBy: () => undefined,
    });
    const maskA = setMaskRectangleSelection(createMaskDrawing(1200, 800), { x: 10, y: 10, width: 50, height: 50 });
    const maskB = setMaskRectangleSelection(createMaskDrawing(1200, 800), { x: 300, y: 300, width: 80, height: 80 });

    const { rerender } = render(
      <MaskRegionField
        image={{ id: "uploaded-zoom", name: "source.png", url: "blob:source" }}
        drawing={maskA}
        onChange={() => undefined}
        openRequest={1}
        editorKey="editdoc_1"
        layerContext={context("edit_a", "Edit Layer 01")}
      />,
    );

    await screen.findByRole("dialog");
    const viewport = screen.getByTestId("mask-editor-viewport");
    fireEvent.wheel(viewport, { deltaY: -100, clientX: 200, clientY: 200 });
    const zoomed = viewport.getAttribute("data-zoom");
    expect(Number(zoomed)).toBeGreaterThan(100);

    // Selecting another layer swaps the drawing and the context but must not
    // throw away the zoom the artist set to do the work they are selecting for.
    rerender(
      <MaskRegionField
        image={{ id: "uploaded-zoom", name: "source.png", url: "blob:source" }}
        drawing={maskB}
        onChange={() => undefined}
        openRequest={1}
        editorKey="editdoc_1"
        layerContext={context("edit_b", "Edit Layer 02")}
      />,
    );

    expect(screen.getByTestId("mask-editor-viewport")).toHaveAttribute("data-zoom", zoomed as string);
    expect(screen.getByTestId("mask-editor-context")).toHaveTextContent("Edit Layer 02");
    // The swap still landed: the editor adopted the new layer's mask on its own,
    // which is why the remount was never needed for correctness.
    expect(screen.getByTestId("mask-editor-viewport")).toHaveAttribute("data-selection-x", "300");

    // A different document is a different picture, so that one does refit.
    rerender(
      <MaskRegionField
        image={{ id: "uploaded-zoom", name: "source.png", url: "blob:source" }}
        drawing={maskB}
        onChange={() => undefined}
        openRequest={1}
        editorKey="editdoc_2"
        layerContext={context("edit_b", "Edit Layer 02")}
      />,
    );
    expect(screen.getByTestId("mask-editor-viewport")).toHaveAttribute("data-zoom", "100");
  });

  it("resizes the layers rail by dragging its edge, within bounds, and remembers it", async () => {
    const { unmount } = render(
      <MaskRegionField
        image={{ id: "uploaded-rail", name: "source.png", url: "blob:source" }}
        onChange={() => undefined}
        openRequest={1}
        leftPanel={<div>Layers</div>}
      />,
    );

    await screen.findByRole("dialog");
    const rail = screen.getByTestId("mask-editor-layers-rail");
    const handle = screen.getByTestId("mask-editor-rail-handle");
    expect(rail).toHaveAttribute("data-width", "288");

    fireEvent.pointerDown(handle, { button: 0, pointerId: 90, clientX: 288 });
    fireEvent.pointerMove(handle, { pointerId: 90, clientX: 420 });
    expect(rail).toHaveAttribute("data-width", "420");

    // Past either bound it stops rather than breaking the layout.
    fireEvent.pointerMove(handle, { pointerId: 90, clientX: 4000 });
    expect(rail).toHaveAttribute("data-width", "560");
    fireEvent.pointerMove(handle, { pointerId: 90, clientX: 10 });
    expect(rail).toHaveAttribute("data-width", "220");

    fireEvent.pointerMove(handle, { pointerId: 90, clientX: 360 });
    fireEvent.pointerUp(handle, { button: 0, pointerId: 90, clientX: 360 });
    unmount();

    // A width is a workspace preference, so the next document opens at it.
    render(
      <MaskRegionField
        image={{ id: "uploaded-rail-2", name: "source.png", url: "blob:source" }}
        onChange={() => undefined}
        openRequest={1}
        leftPanel={<div>Layers</div>}
      />,
    );
    await screen.findByRole("dialog");
    expect(screen.getByTestId("mask-editor-layers-rail")).toHaveAttribute("data-width", "360");
  });

  it("resizes the rail from the keyboard and reports its range", async () => {
    render(
      <MaskRegionField
        image={{ id: "uploaded-rail-keys", name: "source.png", url: "blob:source" }}
        onChange={() => undefined}
        openRequest={1}
        leftPanel={<div>Layers</div>}
      />,
    );

    await screen.findByRole("dialog");
    const handle = screen.getByRole("separator", { name: "Resize the layers panel" });
    expect(handle).toHaveAttribute("aria-valuemin", "220");
    expect(handle).toHaveAttribute("aria-valuemax", "560");
    const before = Number(screen.getByTestId("mask-editor-layers-rail").getAttribute("data-width"));

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(Number(screen.getByTestId("mask-editor-layers-rail").getAttribute("data-width"))).toBe(before + 10);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(screen.getByTestId("mask-editor-layers-rail")).toHaveAttribute("data-width", "220");
  });

  it("resolves saved project media before decoding it, and leaves an upload alone", async () => {
    const { loadImageElement } = await import("../features/still-images/maskRaster");
    const decode = vi.mocked(loadImageElement);

    // A document reopened from its jobs, or a chained result: saved media, which
    // needs the media credential before the browser will decode it.
    decode.mockClear();
    const saved = render(
      <MaskRegionField
        image={{ id: "saved", name: "original.png", url: "/api/media?path=original.png" }}
        onChange={() => undefined}
        openRequest={1}
      />,
    );
    await screen.findByRole("dialog");
    expect(decode).toHaveBeenCalledWith("/api/media?path=original.png&access_token=test");
    expect(screen.queryByText(/could not be opened for painting/i)).not.toBeInTheDocument();
    saved.unmount();

    // An ordinary upload is a blob: URL and must pass through untouched.
    decode.mockClear();
    render(
      <MaskRegionField
        image={{ id: "uploaded", name: "source.png", url: "blob:source" }}
        onChange={() => undefined}
        openRequest={1}
      />,
    );
    await screen.findByRole("dialog");
    expect(decode).toHaveBeenCalledWith("blob:source");
  });

  it("keeps the canvas visibly busy and read-only for the real processing lifecycle", async () => {
    const onChange = vi.fn();
    const drawing = appendMaskStroke(createMaskDrawing(1200, 800), {
      tool: "brush",
      radius: 40,
      points: [{ x: 300, y: 250 }],
    });
    render(
      <MaskRegionField
        image={{ id: "uploaded-3", name: "source.png", url: "blob:source" }}
        drawing={drawing}
        onChange={onChange}
        openRequest={1}
        processing
        processingLabel="Inpainting selected region"
      />,
    );

    await screen.findByRole("dialog");
    const viewport = screen.getByTestId("mask-editor-viewport");
    expect(viewport).toHaveAttribute("data-processing", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Inpainting selected region");
    expect(screen.getByRole("slider", { name: "Crop margin" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "1:1 crop" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Adaptive 16:9 or 9:16 crop" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rectangle selection" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Brush" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear region" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();

    fireEvent.pointerDown(viewport, { button: 0, buttons: 1, pointerId: 9, clientX: 300, clientY: 250 });
    fireEvent.pointerUp(viewport, { button: 0, pointerId: 9, clientX: 300, clientY: 250 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clears the mounted editor draft when a completed generation resets the mask", async () => {
    const onChange = vi.fn();
    const onDraftChange = vi.fn();
    const drawing = appendMaskStroke(createMaskDrawing(1200, 800), {
      tool: "brush",
      radius: 40,
      points: [{ x: 300, y: 250 }],
    });
    const view = render(
      <MaskRegionField
        image={{ id: "uploaded-4", name: "source.png", url: "blob:source" }}
        drawing={drawing}
        onChange={onChange}
        onEditorDraftChange={onDraftChange}
        openRequest={1}
      />,
    );
    await screen.findByRole("dialog");

    view.rerender(
      <MaskRegionField
        image={{ id: "uploaded-4", name: "source.png", url: "blob:source" }}
        drawing={undefined}
        onChange={onChange}
        onEditorDraftChange={onDraftChange}
        openRequest={1}
      />,
    );
    await waitFor(() => expect(screen.queryByText(/edit region:/i)).not.toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
    expect(onDraftChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
