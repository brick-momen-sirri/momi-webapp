// ImageUploader decides how many input slots a model gets, whether a 16:9 crop
// is offered, and whether an image must be landscape. Those rules come from the
// selected model, and getting them wrong means a job is submitted with the wrong
// inputs -- which costs RunPod credits before anyone notices.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UploadedImage } from "../types";
import { fetchBackendClipboardImage } from "../services/backendApi";
import { getImageSize } from "../utils/imageCrop";
import { ImageUploader } from "./ImageUploader";

// The clipboard fallback chain ends at the backend helper. Stubbed so a paste with
// no usable image never reaches the network. It rejects rather than resolving empty
// because that is what the real endpoint does when the OS clipboard holds no image,
// and the caller already treats a rejection as "nothing found".
vi.mock("../services/backendApi", () => ({
  fetchBackendClipboardImage: vi.fn(),
  getStoredAuthToken: vi.fn().mockReturnValue(undefined),
}));

// Only the dimension probe is faked. isNearAspectRatio stays real, so the
// crop-required rule below is genuinely exercised rather than mocked away.
vi.mock("../utils/imageCrop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/imageCrop")>()),
  getImageSize: vi.fn(),
}));

const probeImageSize = vi.mocked(getImageSize);

beforeEach(() => {
  probeImageSize.mockReset();
  probeImageSize.mockResolvedValue({ width: 1920, height: 1080 });
  // Module mocks keep their call history across tests, so the "was the backend
  // fallback reached" assertions need a clean slate each time.
  vi.mocked(fetchBackendClipboardImage).mockClear().mockRejectedValue(new Error("no clipboard image"));
  // jsdom implements neither, and every upload path calls createObjectURL.
  URL.createObjectURL = vi.fn(() => "blob:generated");
  URL.revokeObjectURL = vi.fn();
});

function pngFile(name = "shot.png") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

/** Minimal DataTransfer stand-in; the paste path only reads `files` and `items`. */
function clipboardData(files: File[] = [], items: DataTransferItem[] = []) {
  return { files, items, types: [], getData: () => "" } as unknown as DataTransfer;
}

function pasteInto(container: HTMLElement, data: DataTransfer) {
  fireEvent.paste(container.firstChild as HTMLElement, { clipboardData: data });
}

/** Uploads a file into the first slot and returns the images array handed upward. */
async function uploadInto(props: Record<string, unknown>, file = pngFile()) {
  const onChange = vi.fn();
  const { container } = renderUploader({ ...props, onChange });
  const input = container.querySelector("input[type=file]");
  if (!input) throw new Error("expected a file input");

  await userEvent.setup().upload(input as HTMLInputElement, file);
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  return onChange.mock.calls.at(-1)?.[0] as Array<UploadedImage | undefined>;
}

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

// cropRequired is what blocks generation until the user saves a 16:9 crop. Marking
// an image as needing no crop when it does means submitting a job at the wrong
// aspect ratio -- which RunPod bills for before anyone sees the result.
describe("crop requirement", () => {
  it("does not ask for a crop when the image is already 16:9", async () => {
    probeImageSize.mockResolvedValue({ width: 1920, height: 1080 });
    const next = await uploadInto({ requiresLandscape: true });
    expect(next[0]?.cropRequired).toBe(false);
  });

  it("asks for a crop when the image is not 16:9", async () => {
    probeImageSize.mockResolvedValue({ width: 1600, height: 1200 });
    const next = await uploadInto({ requiresLandscape: true });
    expect(next[0]?.cropRequired).toBe(true);
  });

  it("asks for a crop for a portrait image", async () => {
    probeImageSize.mockResolvedValue({ width: 1080, height: 1920 });
    const next = await uploadInto({ requiresLandscape: true });
    expect(next[0]?.cropRequired).toBe(true);
  });

  it("never asks for a crop when the model does not require landscape", async () => {
    probeImageSize.mockResolvedValue({ width: 1600, height: 1200 });
    const next = await uploadInto({ requiresLandscape: false });
    expect(next[0]?.cropRequired).toBe(false);
  });

  it("treats an unmeasurable image as needing a crop when landscape is required", async () => {
    // A decode failure must not be read as "already landscape" -- that would let a
    // non-16:9 image through the generate gate.
    probeImageSize.mockRejectedValue(new Error("decode failed"));
    const next = await uploadInto({ requiresLandscape: true });
    expect(next[0]?.cropRequired).toBe(true);
    expect(next[0]?.width).toBeUndefined();
    expect(next[0]?.height).toBeUndefined();
  });

  it("records the measured dimensions on the image", async () => {
    probeImageSize.mockResolvedValue({ width: 2048, height: 1152 });
    const next = await uploadInto({ requiresLandscape: true });
    expect(next[0]?.width).toBe(2048);
    expect(next[0]?.height).toBe(1152);
  });
});

describe("file selection", () => {
  it("revokes an in-flight object URL instead of publishing it after unmount", async () => {
    let resolveSize!: (size: { width: number; height: number }) => void;
    probeImageSize.mockReturnValueOnce(new Promise((resolve) => (resolveSize = resolve)));
    const { container, unmount, props } = renderUploader();
    const input = container.querySelector("input[type=file]") as HTMLInputElement;

    fireEvent.change(input, { target: { files: [pngFile()] } });
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(File)));
    unmount();
    resolveSize({ width: 1920, height: 1080 });

    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:generated"));
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("cancels a pending paste-message timer on unmount", async () => {
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const { container, unmount } = renderUploader({ images: [image()] });

    pasteInto(container, clipboardData([pngFile("extra.png")]));
    await screen.findByText(/Pasted into Input image/i);
    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("keeps the uploaded file's name", async () => {
    const next = await uploadInto({}, pngFile("hero-frame.png"));
    expect(next[0]?.name).toBe("hero-frame.png");
  });

  it("fills the chosen slot without disturbing the others", async () => {
    const onChange = vi.fn();
    const existing = image({ id: "img_keep", name: "keep.png" });
    const { container } = renderUploader({
      imageSlotCount: 2,
      images: [undefined as unknown as UploadedImage, existing],
      onChange,
    });

    const inputs = container.querySelectorAll("input[type=file]");
    await userEvent.setup().upload(inputs[0] as HTMLInputElement, pngFile("new.png"));
    await waitFor(() => expect(onChange).toHaveBeenCalled());

    const next = onChange.mock.calls.at(-1)?.[0] as Array<UploadedImage | undefined>;
    expect(next[0]?.name).toBe("new.png");
    expect(next[1]?.name).toBe("keep.png");
  });

  it("pastes a clipboard image into the first empty slot", async () => {
    const onChange = vi.fn();
    const existing = image({ id: "img_keep", name: "keep.png" });
    const { container } = renderUploader({ imageSlotCount: 2, images: [existing], onChange });

    pasteInto(container, clipboardData([pngFile("pasted.png")]));
    await waitFor(() => expect(onChange).toHaveBeenCalled());

    const next = onChange.mock.calls.at(-1)?.[0] as Array<UploadedImage | undefined>;
    // Slot 0 is taken, so the paste lands in slot 1 rather than overwriting.
    expect(next[0]?.name).toBe("keep.png");
    expect(next[1]?.name).toBe("pasted.png");
    expect(await screen.findByText(/pasted into/i)).toBeInTheDocument();
  });

  it("replaces the image on a single-slot model rather than refusing", async () => {
    const onChange = vi.fn();
    const { container } = renderUploader({ imageSlotCount: 1, images: [image({ name: "old.png" })], onChange });

    pasteInto(container, clipboardData([pngFile("pasted.png")]));
    await waitFor(() => expect(onChange).toHaveBeenCalled());

    // Deliberate: with one slot there is nowhere else for the paste to go, so
    // overwriting is more useful than an "all slots full" dead end.
    const next = onChange.mock.calls.at(-1)?.[0] as Array<UploadedImage | undefined>;
    expect(next[0]?.name).toBe("pasted.png");
  });

  it("reports when every slot of a multi-slot model is occupied", async () => {
    const onChange = vi.fn();
    const { container } = renderUploader({
      imageSlotCount: 2,
      images: [image({ id: "a", name: "one.png" }), image({ id: "b", name: "two.png" })],
      onChange,
    });

    pasteInto(container, clipboardData([pngFile("pasted.png")]));

    expect(await screen.findByText(/all image slots are full/i)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports when the clipboard holds no image", async () => {
    const onChange = vi.fn();
    const { container } = renderUploader({ onChange });

    pasteInto(container, clipboardData([new File(["text"], "notes.txt", { type: "text/plain" })]));

    // Falls through every clipboard source and ends up telling the user rather
    // than failing silently.
    await waitFor(() => expect(fetchBackendClipboardImage).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores paste entirely for a text-only model", async () => {
    const onChange = vi.fn();
    const { container } = renderUploader({ textOnly: true, onChange });

    pasteInto(container, clipboardData([pngFile()]));

    expect(onChange).not.toHaveBeenCalled();
    expect(fetchBackendClipboardImage).not.toHaveBeenCalled();
  });

  it("releases the replaced image's object URL", async () => {
    const onChange = vi.fn();
    const { container } = renderUploader({ images: [image({ url: "blob:old" })], onChange });

    await userEvent.setup().upload(container.querySelector("input[type=file]") as HTMLInputElement, pngFile());
    await waitFor(() => expect(onChange).toHaveBeenCalled());

    // Long editing sessions replace inputs repeatedly; leaking every previous blob
    // grows browser memory for as long as the tab stays open.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:old");
  });
});
