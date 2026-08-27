import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EditLayersPanel } from "./EditLayersPanel";
import {
  createMaskDrawing,
  scaleTransform,
  setMaskRectangleSelection,
  setMaskTransform,
} from "../features/still-images/maskDrawing";
import type { StillImageEditLayer } from "../features/still-images/stillImageCategories";

function layer(id: string, order: number, overrides: Partial<StillImageEditLayer> = {}): StillImageEditLayer {
  return {
    id,
    name: `Edit Layer 0${order + 1}`,
    mask: setMaskRectangleSelection(createMaskDrawing(400, 300), { x: 10, y: 20, width: 40, height: 30 }),
    crop: { x: 0, y: 0, size: 80, width: 80, height: 80, sourceWidth: 400, sourceHeight: 300 },
    prompt: "a prompt",
    mode: "inpaint",
    references: [],
    documentId: "editdoc_test",
    jobId: `job_${id}`,
    createdAt: "2026-08-27T09:00:00.000Z",
    updatedAt: "2026-08-27T09:00:00.000Z",
    visible: true,
    order,
    revision: 1,
    status: "completed",
    generatedCropSourceUrl: `/api/media?path=${id}.png`,
    ...overrides,
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof EditLayersPanel>> = {}) {
  const handlers = {
    onNew: vi.fn(),
    onSelect: vi.fn(),
    onToggle: vi.fn(),
    onDelete: vi.fn(),
    onDuplicate: vi.fn(),
    onMove: vi.fn(),
    onRename: vi.fn(),
    onOpacityChange: vi.fn(),
    onMaskEnabledChange: vi.fn(),
    onMaskLinkedChange: vi.fn(),
    onResetOffset: vi.fn(),
  };
  render(
    <EditLayersPanel layers={[layer("a", 0), layer("b", 1)]} activeLayerId="b" activeTarget="content" {...handlers} {...props} />,
  );
  return handlers;
}

describe("EditLayersPanel", () => {
  it("rings exactly one of the two thumbnails so the armed half is never in doubt", () => {
    renderPanel();

    expect(screen.getByRole("button", { name: "Edit Edit Layer 02 content" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Edit Edit Layer 02 mask" })).toHaveAttribute("aria-pressed", "false");
    // The unselected layer has neither half armed.
    expect(screen.getByRole("button", { name: "Edit Edit Layer 01 content" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Edit Edit Layer 01 mask" })).toHaveAttribute("aria-pressed", "false");
  });

  it("selects the layer and the half that was clicked", () => {
    const handlers = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Edit Edit Layer 01 mask" }));
    expect(handlers.onSelect).toHaveBeenCalledWith("a", "mask");

    fireEvent.click(screen.getByRole("button", { name: "Edit Edit Layer 01 content" }));
    expect(handlers.onSelect).toHaveBeenCalledWith("a", "content");
  });

  it("shows the mask controls and opacity for the selected layer only", () => {
    const handlers = renderPanel();

    const opacity = screen.getByRole("slider", { name: "Edit Layer 02 opacity" });
    expect(screen.queryByRole("slider", { name: "Edit Layer 01 opacity" })).not.toBeInTheDocument();

    fireEvent.change(opacity, { target: { value: "55" } });
    expect(handlers.onOpacityChange).toHaveBeenCalledWith("b", 55);

    fireEvent.click(screen.getByRole("button", { name: /disable mask/i }));
    expect(handlers.onMaskEnabledChange).toHaveBeenCalledWith("b", false);

    fireEvent.click(screen.getByRole("button", { name: /linked/i }));
    expect(handlers.onMaskLinkedChange).toHaveBeenCalledWith("b", false);
  });

  it("summarises what has been done to a layer without opening it", () => {
    renderPanel({
      layers: [layer("a", 0, { opacity: 50, maskEnabled: false, offset: { x: 4, y: 0 } }), layer("b", 1)],
    });

    expect(screen.getByText("50% · mask off · moved")).toBeInTheDocument();
  });

  it("offers a reset only for a mask that has actually been transformed", () => {
    const onResetMaskTransform = vi.fn();
    const transformed = layer("b", 1);
    transformed.mask = setMaskTransform(transformed.mask, scaleTransform({ x: 100, y: 100 }, 1.5, 1.5));
    renderPanel({ layers: [layer("a", 0), transformed], onResetMaskTransform });

    expect(screen.getByText(/mask transformed/)).toBeInTheDocument();
    const reset = screen.getByRole("button", { name: /reset transform/i });
    expect(reset).toHaveAttribute("title", expect.stringContaining("150% × 150%"));
    fireEvent.click(reset);
    expect(onResetMaskTransform).toHaveBeenCalled();
  });

  it("hides the transform reset while the mask sits where it was painted", () => {
    renderPanel({ onResetMaskTransform: vi.fn() });
    expect(screen.queryByRole("button", { name: /reset transform/i })).not.toBeInTheDocument();
  });

  it("renames on a double-click and refuses to commit nothing", () => {
    const handlers = renderPanel();

    fireEvent.doubleClick(screen.getByText("Edit Layer 01"));
    const field = screen.getByRole("textbox", { name: "Rename Edit Layer 01" });
    fireEvent.change(field, { target: { value: "Sky" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(handlers.onRename).toHaveBeenCalledWith("a", "Sky");
  });

  it("duplicates, reorders and deletes from the row", () => {
    const handlers = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Duplicate Edit Layer 01" }));
    expect(handlers.onDuplicate).toHaveBeenCalledWith("a");

    fireEvent.click(screen.getByRole("button", { name: "Delete Edit Layer 02" }));
    expect(handlers.onDelete).toHaveBeenCalledWith("b");

    // Top of the stack cannot go up, bottom cannot go down.
    expect(screen.getByRole("button", { name: "Move Edit Layer 02 up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Edit Layer 01 down" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Move Edit Layer 01 up" }));
    expect(handlers.onMove).toHaveBeenCalledWith("a", 1);
  });

  it("keeps the original image in the stack as a locked row", () => {
    renderPanel();
    const original = screen.getByRole("listitem", { name: "Original image, locked" });
    expect(within(original).getByText("Locked")).toBeInTheDocument();
    expect(within(original).queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers the regeneration the layer needs, and says why when it cannot run", () => {
    const onRegenerate = vi.fn();
    renderPanel({ onRegenerate, canRegenerate: false, regenerateHint: "Describe the edit first." });

    const button = screen.getByRole("button", { name: /regenerate this layer/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Describe the edit first.");
  });
});
