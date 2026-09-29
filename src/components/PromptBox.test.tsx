import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ModelType } from "../types";
import { PromptBox } from "./PromptBox";

const klingVideo = {
  id: "brick_api_kling_v3_video",
  label: "Api Kling V3 Video",
  category: "video",
  backendCategory: "image_to_video",
  workflowPath: "i2v/Brick_api_kling_v3_video.json",
} as ModelType;

function renderPromptBox(overrides: Record<string, unknown> = {}) {
  const props = {
    value: "",
    onChange: vi.fn(),
    images: [],
    selectedModel: klingVideo,
    onCameraStabilizationChange: vi.fn(),
    ...overrides,
  };
  return { ...render(<PromptBox {...props} />), props };
}

describe("Stabilize camera", () => {
  // The panel passes undefined wherever the graph has no negative prompt to append to.
  it("is hidden when the model has nothing for it to affect", () => {
    renderPromptBox();
    expect(screen.queryByLabelText("Stabilize camera")).toBeNull();
  });

  it("shows the current state and reports a change", () => {
    const { props } = renderPromptBox({ cameraStabilization: true });
    const toggle = screen.getByLabelText("Stabilize camera") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(props.onCameraStabilizationChange).toHaveBeenCalledWith(false);
  });
});
