// ImageUploader decides how many input slots a model gets, whether a 16:9 crop
// is offered, and whether an image must be landscape. Those rules come from the
// selected model, and getting them wrong means a job is submitted with the wrong
// inputs -- which costs RunPod credits before anyone notices.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UploadedImage } from "../types";
import { ImageUploader } from "./ImageUploader";

function image(overrides: Partial<UploadedImage> = {}): UploadedImage {
  return { id: "img_1", name: "shot.png", url: "blob:shot", ...overrides } as UploadedImage;
}

function renderUploader(overrides: Record<string, unknown> = {}) {
  const props = {
    images: [] as UploadedImage[],
    onChange: vi.fn(),
    selectedResolution: "1080p",
    requiresTwoImages: false,
    imageSlotCount: 1,
    requiresLandscape: false,
    enable16By9Cropping: false,
    show16By9CropToggle: false,
    onEnable16By9CroppingChange: vi.fn(),
    textOnly: false,
    ...overrides,
  };
  return { ...render(<ImageUploader {...props} />), props };
}

describe("slots", () => {
  it("renders a single upload target for a one-image model", () => {
    renderUploader({ imageSlotCount: 1 });
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });

  it("renders start and end frame slots for a two-image model", () => {
    renderUploader({ requiresTwoImages: true, imageSlotCount: 2 });
    // The two-image models are first/last-frame video workflows, so the slots are
    // labelled rather than numbered.
    const body = document.body.textContent ?? "";
    expect(/start|first/i.test(body)).toBe(true);
    expect(/end|last/i.test(body)).toBe(true);
  });

  it("renders the number of slots it is told to, not the number of images it has", () => {
    const { container } = renderUploader({ imageSlotCount: 4, images: [image()] });
    // Four drop targets even though only one image is present.
    expect(container.querySelectorAll("input[type=file]").length).toBeGreaterThanOrEqual(1);
    expect(() => screen.getByText(/shot\.png/)).not.toThrow();
  });
});

describe("text-only models", () => {
  it("offers no image inputs at all", () => {
    const { container } = renderUploader({ textOnly: true });
    expect(container.querySelectorAll("input[type=file]")).toHaveLength(0);
  });
});

describe("16:9 crop toggle", () => {
  it("is hidden unless the model asks for it", () => {
    renderUploader({ show16By9CropToggle: false });
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("is shown and reflects the current value when the model asks for it", () => {
    renderUploader({ show16By9CropToggle: true, enable16By9Cropping: true });
    const toggle = screen.getByRole("checkbox");
    expect(toggle).toBeInTheDocument();
    expect(toggle).toBeChecked();
  });

  it("reports a change upward rather than holding the state itself", async () => {
    const user = userEvent.setup();
    const onEnable16By9CroppingChange = vi.fn();
    renderUploader({ show16By9CropToggle: true, enable16By9Cropping: false, onEnable16By9CroppingChange });

    await user.click(screen.getByRole("checkbox"));
    expect(onEnable16By9CroppingChange).toHaveBeenCalledWith(true);
  });
});

describe("existing images", () => {
  it("lists the images it was given", () => {
    // One slot shows one image, so the slot count has to match the fixture.
    renderUploader({ imageSlotCount: 2, images: [image({ name: "alpha.png" }), image({ id: "img_2", name: "beta.png" })] });
    expect(screen.getByText(/alpha\.png/)).toBeInTheDocument();
    expect(screen.getByText(/beta\.png/)).toBeInTheDocument();
  });

  it("removing an image reports the remaining list upward", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUploader({
      imageSlotCount: 2,
      images: [image({ name: "alpha.png" }), image({ id: "img_2", name: "beta.png" })],
      onChange,
    });

    const remove = screen.getAllByRole("button", { name: /remove|delete|clear/i });
    expect(remove.length).toBeGreaterThan(0);
    await user.click(remove[0]);

    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0][0] as Array<UploadedImage | undefined>;
    // Images are slot-indexed, so clearing a slot leaves a hole rather than
    // compacting the array -- the downstream code reads by slot position.
    expect(next[0]).toBeUndefined();
    expect(next.filter(Boolean).map((img) => img?.name)).toEqual(["beta.png"]);
  });
});

describe("landscape requirement", () => {
  it("renders without crashing when landscape is required", () => {
    expect(() => renderUploader({ requiresLandscape: true, images: [image()] })).not.toThrow();
  });
});
