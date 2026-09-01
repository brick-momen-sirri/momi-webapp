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
    onDeselect: vi.fn(),
    onSelect: vi.fn(),
    onToggle: vi.fn(),
    onDelete: vi.fn(),
    onDuplicate: vi.fn(),
    onMove: vi.fn(),
    onRename: vi.fn(),
    onOpacityChange: vi.fn(),
    onMaskFeatherChange: vi.fn(),
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

  it("deselects from empty panel space without treating rows or controls as empty", () => {
    const handlers = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Edit Edit Layer 01 content" }));
    expect(handlers.onDeselect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("list", { name: "Image edit layers" }));
    expect(handlers.onDeselect).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("edit-layers-panel"));
    expect(handlers.onDeselect).toHaveBeenCalledTimes(2);
  });

  it("shows the mask controls and opacity for the selected layer only", () => {
    const handlers = renderPanel();

    const opacity = screen.getByRole("slider", { name: "Edit Layer 02 opacity" });
    expect(screen.queryByRole("slider", { name: "Edit Layer 01 opacity" })).not.toBeInTheDocument();

    fireEvent.change(opacity, { target: { value: "55" } });
    expect(handlers.onOpacityChange).toHaveBeenCalledWith("b", 55);

    const feather = screen.getByRole("slider", { name: "Edit Layer 02 mask feather" });
    fireEvent.change(feather, { target: { value: "12" } });
    expect(handlers.onMaskFeatherChange).toHaveBeenCalledWith("b", 12);

    fireEvent.click(screen.getByRole("button", { name: /disable mask/i }));
    expect(handlers.onMaskEnabledChange).toHaveBeenCalledWith("b", false);

    fireEvent.click(screen.getByRole("button", { name: "Mask linked — unlink Edit Layer 02" }));
    expect(handlers.onMaskLinkedChange).toHaveBeenCalledWith("b", false);
  });

  it("identifies a layer by its prompt rather than by its settings", () => {
    renderPanel({
      layers: [layer("a", 0, { prompt: "replace the sky with dusk" }), layer("b", 1, { prompt: "remove the cable" })],
    });

    expect(screen.getByText("replace the sky with dusk")).toBeInTheDocument();
    expect(screen.getByText("remove the cable")).toBeInTheDocument();
  });

  it("marks an adjusted layer without spending the row on the numbers", () => {
    renderPanel({
      layers: [layer("a", 0, { opacity: 50, maskEnabled: false, offset: { x: 4, y: 0 } }), layer("b", 1)],
    });

    // One dot for the adjusted layer, none for the untouched one, and the detail
    // available to a hover and to a screen reader rather than printed on the row.
    expect(document.querySelectorAll("[data-adjusted-marker]")).toHaveLength(1);
    const adjusted = document.querySelector('[data-layer-id="a"]') as HTMLElement;
    expect(within(adjusted).getByText("50% opacity · mask off · moved")).toHaveClass("sr-only");
    expect(within(adjusted).getByRole("button", { name: /^Edit Layer 01/ })).toHaveAttribute(
      "title",
      expect.stringContaining("50% opacity · mask off · moved"),
    );
  });

  it("says a layer is completed when it was generated without a prompt", () => {
    renderPanel({ layers: [layer("a", 0, { prompt: "  " })] });
    expect(screen.getByText("Completed edit")).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    expect(handlers.onDuplicate).toHaveBeenCalledWith("b");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(handlers.onDelete).toHaveBeenCalledWith("b");

    // Top of the stack cannot go up, bottom cannot go down.
    expect(screen.getByRole("button", { name: "Move Edit Layer 02 up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Edit Layer 01 down" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Move Edit Layer 01 up" }));
    expect(handlers.onMove).toHaveBeenCalledWith("a", 1);
  });

  /** Three runs, two surviving layers: pod rental and Comfy credits kept apart. */
  const threeRuns = {
    generations: 3,
    layers: 2,
    podUsd: 0.016596,
    podCredits: 3,
    comfyUsd: 0.2463,
    comfyCredits: 51.96,
    usd: 0.262896,
    credits: 54.96,
    unmeasured: 0,
  };

  it("shows what the session has cost, and names the redone work", () => {
    // The gap between runs and layers is the regeneration, and it is the only
    // part of the bill with nothing on screen to represent it.
    renderPanel({ sessionCost: threeRuns });

    const total = screen.getByTestId("edit-session-cost");
    expect(total).toHaveTextContent("$0.263");
    expect(total).toHaveTextContent("3 runs · 1 redone");
    expect(within(total).getByTitle(/54.96 credits across 3 generations/)).toBeInTheDocument();
  });

  it("keeps the two vendors apart, because only one of them is the artist's to change", () => {
    renderPanel({ sessionCost: threeRuns });

    // Almost all of this session is Comfy credits, which no faster GPU helps.
    expect(screen.getByTestId("session-pod-cost")).toHaveTextContent("Pod $0.017");
    expect(screen.getByTestId("session-comfy-cost")).toHaveTextContent("Comfy $0.246");
  });

  it("marks a session containing an unpriceable run as a floor", () => {
    renderPanel({
      sessionCost: { ...threeRuns, generations: 2, layers: 2, podUsd: 0.0055, comfyUsd: 0.0821, usd: 0.0876, unmeasured: 1 },
    });
    const total = screen.getByTestId("edit-session-cost");
    expect(total).toHaveTextContent("≥ $0.088");
    expect(within(total).getByTitle(/could not be priced, so this is a floor/)).toBeInTheDocument();
  });

  it("says nothing about cost before anything has been generated", () => {
    renderPanel({
      sessionCost: {
        generations: 0,
        layers: 0,
        podUsd: 0,
        podCredits: 0,
        comfyUsd: 0,
        comfyCredits: 0,
        usd: 0,
        credits: 0,
        unmeasured: 0,
      },
    });
    expect(screen.queryByTestId("edit-session-cost")).not.toBeInTheDocument();
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
