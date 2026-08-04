// CropModal decides the pixel dimensions a job is submitted at. It hands the
// actual pixel work to utils/imageCrop, so what is testable here is the contract:
// what it reports back on save, and that cancelling reports nothing.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UploadedImage } from "../types";
import { CropModal } from "./CropModal";

// Only the two functions that need a real canvas/Image are replaced; the pure
// geometry (outputSizeForResolution, isNearAspectRatio) stays real, so the test
// exercises the actual sizing rules rather than a fiction.
vi.mock("../utils/imageCrop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/imageCrop")>()),
  cropImageToDataUrl: vi.fn(async () => "data:image/png;base64,cropped"),
  getImageSize: vi.fn(async () => ({ width: 3000, height: 2000 })),
}));

function image(overrides: Partial<UploadedImage> = {}): UploadedImage {
  return { id: "img_1", name: "shot.png", url: "blob:shot", ...overrides } as UploadedImage;
}

// Buttons here are often icon-only, so the accessible name can live in
// aria-label or title rather than in the text.
function describeButton(button: HTMLElement) {
  return [button.textContent, button.getAttribute("aria-label"), button.getAttribute("title")].filter(Boolean).join(" ");
}

function renderModal(overrides: Record<string, unknown> = {}) {
  const props = {
    image: image(),
    selectedResolution: "1080p",
    onCancel: vi.fn(),
    onSave: vi.fn(),
    ...overrides,
  };
  return { ...render(<CropModal {...props} />), props };
}

describe("rendering", () => {
  it("shows the image being cropped", () => {
    renderModal();
    // Queried off document.body rather than the render container: the modal is
    // portalled, so nothing lands inside the container. And queried as an element
    // rather than by role, because the preview img has no alt text and is
    // therefore exposed as presentational.
    const preview = document.body.querySelector("img");
    expect(preview).not.toBeNull();
    expect(preview?.getAttribute("src")).toBe("blob:shot");
  });

  it("renders without a canvas implementation present", () => {
    // jsdom has no 2D context; the modal must still mount.
    expect(() => renderModal()).not.toThrow();
  });
});

describe("cancelling", () => {
  it("reports the cancel upward and saves nothing", async () => {
    const user = userEvent.setup();
    const { props } = renderModal();

    const cancel = screen.getAllByRole("button").find((button) => /cancel|close/i.test(describeButton(button)));
    expect(cancel, "a cancel affordance must exist").toBeTruthy();
    await user.click(cancel as HTMLElement);

    expect(props.onCancel).toHaveBeenCalled();
    expect(props.onSave).not.toHaveBeenCalled();
  });
});

describe("saving", () => {
  it("reports dimensions and whether the original was used", async () => {
    const user = userEvent.setup();
    const { props } = renderModal();

    const save = screen.getAllByRole("button").find((button) => /save|apply|use/i.test(describeButton(button)));
    expect(save, "a save affordance must exist").toBeTruthy();
    await user.click(save as HTMLElement);

    // The shape of this callback is what App.tsx builds the job from, so the
    // fields matter more than the values.
    expect(props.onSave).toHaveBeenCalledTimes(1);
    const result = props.onSave.mock.calls[0][0];
    expect(result).toHaveProperty("width");
    expect(result).toHaveProperty("height");
    expect(result).toHaveProperty("usedOriginal");
    expect(typeof result.width).toBe("number");
    expect(typeof result.height).toBe("number");
    expect(typeof result.usedOriginal).toBe("boolean");
  });

  it("does not cancel as a side effect of saving", async () => {
    const user = userEvent.setup();
    const { props } = renderModal();

    const save = screen.getAllByRole("button").find((button) => /save|apply|use/i.test(describeButton(button)));
    await user.click(save as HTMLElement);
    expect(props.onCancel).not.toHaveBeenCalled();
  });
});
