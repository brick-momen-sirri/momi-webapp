// jsdom does no layout, so these fake the two widths the component compares.
// What is worth pinning: text that fits is left alone, text that does not is
// marked, told how far to slide, and titled with the whole line.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { slideDurationSeconds } from "../utils/slideDuration";
import { SlideOnHoverText } from "./SlideOnHoverText";

function fakeWidths(textWidth: number, boxWidth: number) {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(textWidth);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(boxWidth);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SlideOnHoverText", () => {
  it("leaves text that fits alone", () => {
    fakeWidths(120, 200);
    render(<SlideOnHoverText text="2345 · 9 jobs" />);

    const box = screen.getByText("2345 · 9 jobs").parentElement as HTMLElement;
    expect(box.dataset.overflowing).toBe("false");
    expect(box.title).toBe("");
  });

  it("marks text that is cut off, with the distance to slide and the whole line as its title", () => {
    fakeWidths(260, 180);
    render(<SlideOnHoverText text="2345 · 9 jobs · 1 member · 122 folders" />);

    const box = screen.getByText("2345 · 9 jobs · 1 member · 122 folders").parentElement as HTMLElement;
    expect(box.dataset.overflowing).toBe("true");
    // The 80 px that are hidden, plus the fade, so the last word stops clear of it.
    expect(box.style.getPropertyValue("--slide-distance")).toBe("-100px");
    expect(box.style.getPropertyValue("--slide-duration")).toBe(`${slideDurationSeconds(100)}s`);
    expect(box.title).toBe("2345 · 9 jobs · 1 member · 122 folders");
  });

  it("keeps the whole text in the page, so nothing is lost to an ellipsis", () => {
    fakeWidths(400, 100);
    render(<SlideOnHoverText text="8370_RIOS_The_United_Center_-_Additional_Still_Images_Phase_2" />);
    expect(screen.getByText("8370_RIOS_The_United_Center_-_Additional_Still_Images_Phase_2")).toBeInTheDocument();
  });
});

describe("slideDurationSeconds", () => {
  it("gives short overflows a calm minimum and caps long ones", () => {
    expect(slideDurationSeconds(10)).toBe(0.8);
    expect(slideDurationSeconds(90)).toBe(2);
    expect(slideDurationSeconds(5000)).toBe(4);
  });
});

describe("hover never changes what is measured", () => {
  // The flicker loop: a hover rule that changed the box's size re-ran the
  // measurement, which switched the rule off again, many times a second.
  it("leaves the element alone when a resize changes nothing, so a running slide is not restarted", () => {
    let notifyResize = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notifyResize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    fakeWidths(260, 180);
    render(<SlideOnHoverText text="a long line" />);
    const box = screen.getByText("a long line").parentElement as HTMLElement;
    const setProperty = vi.spyOn(box.style, "setProperty");

    notifyResize();
    expect(setProperty).not.toHaveBeenCalled();

    // A real change still lands.
    fakeWidths(300, 180);
    notifyResize();
    expect(box.style.getPropertyValue("--slide-distance")).toBe("-140px");
    vi.unstubAllGlobals();
  });
});
