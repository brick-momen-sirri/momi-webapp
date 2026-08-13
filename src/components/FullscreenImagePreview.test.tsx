import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FullscreenImagePreview } from "./FullscreenImagePreview";

// The whole point of this overlay is that opening it does NOT pull the original.
// A 4K-10K PNG result is 50-100+ MB on the wire and several hundred MB once
// decoded, so the original may only ever load because someone clicked for it.

const image = {
  previewUrl: "/api/media/thumbnail?path=out.png&w=1440",
  name: "shot.png",
  downloadUrl: "/api/jobs/job_1/result-file",
  originalUrl: "/api/media?path=out.png",
};

function sources() {
  return screen.getAllByRole("img").map((node) => node.getAttribute("src"));
}

describe("FullscreenImagePreview", () => {
  it("shows only the rendition until the original is asked for", () => {
    render(<FullscreenImagePreview image={image} onClose={() => {}} />);
    expect(sources()).toEqual([image.previewUrl]);
    expect(sources()).not.toContain(image.originalUrl);
  });

  it("loads the original only on an explicit click", async () => {
    render(<FullscreenImagePreview image={image} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /view full resolution/i }));

    // Both are mounted: the rendition stays visible underneath so the viewer is
    // not left staring at an empty frame while 100 MB arrives.
    expect(sources()).toEqual([image.previewUrl, image.originalUrl]);
    expect(screen.getByText(/loading full resolution/i)).toBeInTheDocument();
  });

  it("reports when the original cannot be loaded instead of leaving a blank frame", async () => {
    render(<FullscreenImagePreview image={image} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /view full resolution/i }));

    const original = screen.getAllByRole("img").find((node) => node.getAttribute("src") === image.originalUrl);
    original?.dispatchEvent(new Event("error"));

    expect(await screen.findByText(/could not load the original/i)).toBeInTheDocument();
    // The rendition is still on screen, so the overlay remains usable.
    expect(sources()).toContain(image.previewUrl);
  });

  it("offers no full-resolution button when there is no original to show", () => {
    render(<FullscreenImagePreview image={{ previewUrl: image.previewUrl, name: image.name }} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /view full resolution/i })).not.toBeInTheDocument();
  });

  it("downloads the untouched original rather than what is on screen", () => {
    render(<FullscreenImagePreview image={image} onClose={() => {}} />);
    const download = screen.getByRole("link", { name: /original/i });
    expect(download.getAttribute("href")).toBe(image.downloadUrl);
    expect(download).toHaveAttribute("download");
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<FullscreenImagePreview image={image} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
