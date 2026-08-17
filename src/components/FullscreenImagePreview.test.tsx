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

  // Compare is the other half of judging a still: the rendition question ("did
  // this pass do what I wanted") rather than the pixel question the original
  // answers. The two are deliberately separate modes.
  describe("comparing against the input", () => {
    const comparable = { ...image, beforeUrl: "/api/media/thumbnail?path=in.png&w=1440" };

    it("offers no compare control when there is nothing to compare against", () => {
      render(<FullscreenImagePreview image={image} onClose={() => {}} />);
      expect(screen.queryByRole("button", { name: /compare/i })).not.toBeInTheDocument();
    });

    it("shows the result alone until compare is asked for", () => {
      render(<FullscreenImagePreview image={comparable} onClose={() => {}} />);
      expect(sources()).toEqual([comparable.previewUrl]);
      expect(sources()).not.toContain(comparable.beforeUrl);
    });

    it("brings in the input, and puts it back away", async () => {
      render(<FullscreenImagePreview image={comparable} onClose={() => {}} />);

      await userEvent.click(screen.getByRole("button", { name: "Compare" }));
      // Both renditions, never an original: comparing is a question about the
      // pass, not about pixels.
      expect(sources()).toContain(comparable.beforeUrl);
      expect(sources()).toContain(comparable.previewUrl);
      expect(sources()).not.toContain(comparable.originalUrl);

      await userEvent.click(screen.getByRole("button", { name: "Exit compare" }));
      expect(sources()).toEqual([comparable.previewUrl]);
    });

    it("hides the full-resolution control while comparing, and restores it after", async () => {
      // The two modes answer different questions, and stacking a 100 MB original
      // inside a clipped comparison would lose the progressive load the stack
      // exists for.
      render(<FullscreenImagePreview image={comparable} onClose={() => {}} />);

      await userEvent.click(screen.getByRole("button", { name: "Compare" }));
      expect(screen.queryByRole("button", { name: /view full resolution/i })).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Exit compare" }));
      expect(screen.getByRole("button", { name: /view full resolution/i })).toBeInTheDocument();
    });

    it("keeps an already-loaded original on the way back from comparing", async () => {
      render(<FullscreenImagePreview image={comparable} onClose={() => {}} />);
      await userEvent.click(screen.getByRole("button", { name: /view full resolution/i }));
      expect(sources()).toContain(comparable.originalUrl);

      await userEvent.click(screen.getByRole("button", { name: "Compare" }));
      await userEvent.click(screen.getByRole("button", { name: "Exit compare" }));

      // Not re-fetched and not thrown away -- the viewer already paid for it.
      expect(sources()).toContain(comparable.originalUrl);
    });

    it("still closes on Escape while comparing", async () => {
      const onClose = vi.fn();
      render(<FullscreenImagePreview image={comparable} onClose={onClose} />);
      await userEvent.click(screen.getByRole("button", { name: "Compare" }));
      await userEvent.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<FullscreenImagePreview image={image} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
