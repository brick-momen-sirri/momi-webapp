import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  appendMaskStroke,
  createMaskDrawing,
  setMaskRectangleSelection,
  transformReadout,
  type MaskDrawing,
} from "../features/still-images/maskDrawing";

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
    expect(document.body.style.overflow).toBe("hidden");
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
    const softness = screen.getByRole("slider", { name: "Mask softness" }) as HTMLInputElement;
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
    expect(screen.queryByRole("slider", { name: "Mask softness" })).not.toBeInTheDocument();

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
