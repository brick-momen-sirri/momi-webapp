import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { appendMaskStroke, createMaskDrawing } from "../features/still-images/maskDrawing";

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

    const dialog = await screen.findByRole("dialog", { name: /paint the region to edit on source\.png/i });
    expect(dialog.parentElement).toBe(document.body);
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("does not reopen merely because the field renders with an existing image", async () => {
    render(
      <MaskRegionField image={{ id: "existing-1", name: "existing.png", url: "blob:existing" }} onChange={() => undefined} />,
    );
    expect(await screen.findByRole("button", { name: /paint region/i })).toBeEnabled();
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
    expect(screen.getByRole("slider", { name: "Brush size" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "Mask softness" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Brush" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear mask" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();

    fireEvent.pointerDown(viewport, { button: 0, buttons: 1, pointerId: 9, clientX: 300, clientY: 250 });
    fireEvent.pointerUp(viewport, { button: 0, pointerId: 9, clientX: 300, clientY: 250 });
    expect(onChange).not.toHaveBeenCalled();
  });
});
