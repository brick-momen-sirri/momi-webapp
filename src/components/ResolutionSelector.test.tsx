import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { seedanceEffectiveModel } from "../features/generation/seedanceVersions";
import type { ModelType } from "../types";
import { ResolutionSelector } from "./ResolutionSelector";

function seedanceModel(overrides: Partial<ModelType> = {}): ModelType {
  return {
    id: "brick_api_seedance2_0_i2v",
    label: "Api Seedance2 0 I2v",
    description: "Loaded from i2v.",
    category: "video",
    backendCategory: "image_to_video",
    workflowPath: "C:/Momi-Animation/workflow/i2v/Brick_api_seedance2_0_i2v .json",
    cost: 560,
    estimatedTime: "2-5 min",
    supportedResolutions: ["720p", "1080p", "4K"],
    supportedDurations: [4, 5, 6],
    defaultDurationSeconds: 5,
    ...overrides,
  };
}

function renderFor(model: ModelType, version: "2.0" | "2.5", value = "1080p") {
  return render(
    <ResolutionSelector
      selectedModel={seedanceEffectiveModel(model, version)}
      value={value}
      onChange={vi.fn()}
      allowSeedance4K
      seedanceRatio="16:9"
      onSeedanceRatioChange={vi.fn()}
      seedanceVersionId={version}
    />,
  );
}

function resolutionValues() {
  return Array.from(screen.getByRole("combobox", { name: "Resolution" }).querySelectorAll("option")).map(
    (option) => option.value,
  );
}

describe("Seedance resolution and ratio follow the picked version", () => {
  it("offers 4K on 2.0 and withdraws it on 2.5, keeping 480p on both", () => {
    const { unmount } = renderFor(seedanceModel(), "2.0");
    expect(resolutionValues()).toEqual(["480p", "720p", "1080p", "4K"]);
    unmount();

    renderFor(seedanceModel(), "2.5");
    expect(resolutionValues()).toEqual(["480p", "720p", "1080p"]);
  });

  const LOW_WARNING = /low for the selected model/i;

  it("does not call 480p low when the model offers it", () => {
    const { unmount } = renderFor(seedanceModel(), "2.0", "480p");
    expect(screen.queryByText(LOW_WARNING)).toBeNull();
    unmount();

    renderFor(seedanceModel(), "2.5", "480p");
    expect(screen.queryByText(LOW_WARNING)).toBeNull();
  });

  // The warning still earns its place: a low value can arrive from a reused job or a
  // stored preference for a model whose own list stops at 720p.
  it("still warns about a low resolution the model does not offer", () => {
    render(
      <ResolutionSelector
        selectedModel={seedanceModel({ supportedResolutions: ["720p", "1080p"] })}
        value="480p"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText(LOW_WARNING)).toBeInTheDocument();
  });

  it("keeps the ratio picker on the reference node in both versions", () => {
    const { unmount } = renderFor(seedanceModel(), "2.0");
    expect(screen.getByRole("combobox", { name: "Aspect ratio" })).toBeInTheDocument();
    unmount();

    renderFor(seedanceModel(), "2.5");
    expect(screen.getByRole("combobox", { name: "Aspect ratio" })).toBeInTheDocument();
  });

  // 2.5's first-last-frame option declares no ratio input, so a control here would
  // be a setting ComfyUI drops without saying so.
  it("hides the ratio picker for 2.5 first-last-frame only", () => {
    const firstLast = seedanceModel({
      id: "brick_api_seedance_2_0flf2v",
      label: "Api Seedance 2.0flf2v",
      backendCategory: "first_last_frame_to_video",
      workflowPath: "C:/Momi-Animation/workflow/flf2v/Brick_api_Seedance 2.0flf2v.json",
    });

    const { unmount } = renderFor(firstLast, "2.0");
    expect(screen.getByRole("combobox", { name: "Aspect ratio" })).toBeInTheDocument();
    unmount();

    renderFor(firstLast, "2.5");
    expect(screen.queryByRole("combobox", { name: "Aspect ratio" })).toBeNull();
  });
});
