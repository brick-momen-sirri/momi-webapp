// DurationSelector decides the requested video length, which decides the credits
// a render costs. These tests exist because the component was about to be
// refactored and had no coverage at all -- they pin the current behaviour first so
// the refactor has something to be wrong against.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ModelType } from "../types";
import { DurationSelector } from "./DurationSelector";

function model(overrides: Partial<ModelType> = {}): ModelType {
  return {
    id: "kling_v3",
    label: "Kling 3.0",
    category: "video",
    supportedDurations: [5, 10],
    defaultDurationSeconds: 5,
    ...overrides,
  } as ModelType;
}

function renderSelector(overrides: Record<string, unknown> = {}) {
  const props = { selectedModel: model(), value: 5, onChange: vi.fn(), ...overrides };
  return { ...render(<DurationSelector {...props} />), props };
}

describe("visibility", () => {
  it("renders nothing for a non-video model", () => {
    const { container } = renderSelector({ selectedModel: model({ category: "image" }) });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the supported durations for a video model", () => {
    renderSelector({ selectedModel: model({ supportedDurations: [4, 6, 8] }) });
    const body = document.body.textContent ?? "";
    for (const seconds of [4, 6, 8]) expect(body).toContain(String(seconds));
  });
});

describe("selection", () => {
  it("reports a chosen duration upward", () => {
    const onChange = vi.fn();
    renderSelector({ selectedModel: model({ supportedDurations: [5, 10] }), value: 5, onChange });

    // Durations are a range input, not buttons: the slider indexes into the
    // supported list rather than carrying seconds directly.
    const slider = screen.getByRole("slider") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "1" } });
    expect(onChange).toHaveBeenCalledWith(10);
  });

  it("indexes the slider into the supported list rather than using raw seconds", () => {
    const onChange = vi.fn();
    renderSelector({ selectedModel: model({ supportedDurations: [4, 6, 8] }), value: 4, onChange });

    const slider = screen.getByRole("slider") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "2" } });
    // Index 2 of [4,6,8] is 8 seconds. A slider reporting raw seconds would have
    // charged for 2s here.
    expect(onChange).toHaveBeenCalledWith(8);
  });
});

describe("normalising against the model", () => {
  it("falls back to the model default when the incoming value is unsupported", () => {
    // 7s is not offered by this model; the default must win rather than 7 being
    // silently submitted and charged for.
    renderSelector({ selectedModel: model({ supportedDurations: [5, 10], defaultDurationSeconds: 10 }), value: 7 });
    const body = document.body.textContent ?? "";
    expect(body).toContain("10");
  });

  it("re-normalises when the model changes to one with different durations", () => {
    const { rerender, props } = renderSelector({
      selectedModel: model({ id: "a", supportedDurations: [5, 10], defaultDurationSeconds: 5 }),
      value: 10,
    });

    // Switching to a model that does not offer 10s must not leave 10 selected.
    rerender(
      <DurationSelector
        {...props}
        selectedModel={model({ id: "b", supportedDurations: [4, 6], defaultDurationSeconds: 6 })}
        value={10}
      />,
    );
    const body = document.body.textContent ?? "";
    expect(body).toContain("6");
    expect(body).not.toContain("10");
  });

  it("keeps a supported value when the model changes but still offers it", () => {
    const { rerender, props } = renderSelector({
      selectedModel: model({ id: "a", supportedDurations: [5, 10] }),
      value: 10,
    });
    rerender(<DurationSelector {...props} selectedModel={model({ id: "b", supportedDurations: [5, 10] })} value={10} />);
    expect(document.body.textContent ?? "").toContain("10");
  });

  it("handles a model that declares no durations at all", () => {
    expect(() =>
      renderSelector({ selectedModel: model({ supportedDurations: undefined, defaultDurationSeconds: undefined }), value: 5 }),
    ).not.toThrow();
  });
});
